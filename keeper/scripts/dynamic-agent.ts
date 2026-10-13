// pnpm dynamic:agent <step> — moves agent leader #2209's trading key onto a Dynamic agent wallet.
//   setup   sign in as the agent (SIWE with its ERC-8004 key) and create a 2-of-2 MPC wallet
//   link    the MPC wallet signs ERC-8004 AgentWalletSet (EIP-712); the owner points the identity and LeaderBook.operator at it
//   policy  wallet-layer Dynamic policy: allow only the agent's LeaderBook on testnet (trade/checkpoint/rollEpoch)
//   trade   the agent trades through LeaderBook.trade from the MPC wallet (args: open|close [lot])
//   checkpoint  LeaderBook.checkpoint() from the MPC wallet
//   deny    tries AUSD approve from the MPC wallet; the policy must refuse it -> logs/dynamic-deny.json (shown on /proof)
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi, parseEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ThresholdSignatureScheme } from '@dynamic-labs-wallet/node';
import { ABI, cfg, loadDeployments } from '../src/config.js';
import { AGENT_WALLET_FILE, DYN_ENV, agentClient, agentWallet } from '../src/dynamicAgent.js';

const CONTRACTS_ENV = resolve(cfg.ROOT, '../contracts/.env');
const contractsEnv = (k: string) => {
  const line = readFileSync(CONTRACTS_ENV, 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${k}=`));
  if (!line) throw new Error(`${k} missing in contracts/.env`);
  return line.slice(k.length + 1).replace(/^"|"$/g, '').trim() as Hex;
};
const agentState = JSON.parse(readFileSync(resolve(cfg.ROOT, '../contracts/deployments/agent-10143.json'), 'utf8')) as {
  agentId: number; leaderBook: Address; owner: Address; agent: Address;
};
const dep = loadDeployments();
const chain = { id: 10143, name: 'Monad Testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } } as const;
const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
const LB = parseAbi([
  'function trade(uint256 perpId, uint8 orderType, uint256 lot, uint256 price, uint256 leverageHdths) returns (uint256)',
  'function checkpoint()',
  'function rollEpoch()',
  'function setOperator(address op)',
  'function operator() view returns (address)',
]);
const ID = parseAbi([
  'function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
]);
const step = process.argv[2];
const explorer = (h: string) => `https://testnet.monadscan.com/tx/${h}`;

async function waitOk(hash: Hex, what: string) {
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`${what}: ${r.status} ${explorer(hash)}`);
  if (r.status !== 'success') throw new Error(`${what} reverted`);
  return hash;
}

if (step === 'setup') {
  // The agent signing token is the ERC-8004 agent key: the Dynamic user is keyed to the agent's own address.
  process.env.DYNAMIC_AGENT_SIGNING_TOKEN ??= contractsEnv('AGENT_KEY');
  const { client, signer } = await agentClient();
  console.log('signed in to Dynamic as agent', signer);
  const { walletMetadata, externalServerKeyShares } = await client.createWalletAccount({
    thresholdSignatureScheme: ThresholdSignatureScheme.TWO_OF_TWO,
    // ponytail: SDK 1.1.22 backs up via a /server endpoint that refuses user JWTs (401), so the share stays with us only.
    backUpToDynamic: false,
  });
  mkdirSync(resolve(cfg.ROOT, 'dynamic'), { recursive: true });
  writeFileSync(AGENT_WALLET_FILE, JSON.stringify({ environmentId: DYN_ENV, agentId: agentState.agentId, signer, walletMetadata }, null, 2));
  appendFileSync(
    resolve(cfg.ROOT, '.env'),
    `\n# Dynamic agent wallet (pnpm dynamic:agent setup, ${new Date().toISOString()})\n` +
      `DYNAMIC_AGENT_SIGNING_TOKEN=${process.env.DYNAMIC_AGENT_SIGNING_TOKEN}\n` +
      `DYNAMIC_AGENT_KEYSHARES=${Buffer.from(JSON.stringify(externalServerKeyShares)).toString('base64')}\n`,
  );
  console.log('agent MPC wallet:', walletMetadata.accountAddress, 'walletId', walletMetadata.walletId);
} else {
  const { client } = await agentClient();
  const w = agentWallet();
  const address = w.walletMetadata.accountAddress as Address;
  const send = async (to: Address, data: Hex, what: string) => {
    const wc = await client.getWalletClient({ ...w, chain, rpcUrl: cfg.rpcUrl });
    return waitOk(await wc.sendTransaction({ to, data, chain }), what);
  };

  if (step === 'link') {
    const owner = privateKeyToAccount(contractsEnv('AGENT_OWNER_KEY'));
    const deployer = privateKeyToAccount(contractsEnv('DEPLOYER_KEY'));
    if ((await pub.getBalance({ address })) < parseEther('0.2')) {
      const wc = createWalletClient({ account: deployer, chain, transport: http(cfg.rpcUrl) });
      await waitOk(await wc.sendTransaction({ to: address, value: parseEther('0.5') }), 'fund agent MPC wallet 0.5 MON');
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 200);
    const signature = await client.signTypedData({
      ...w,
      typedData: {
        domain: { name: 'ERC8004IdentityRegistry', version: '1', chainId: 10143, verifyingContract: dep.identity8004 },
        types: { AgentWalletSet: [{ name: 'agentId', type: 'uint256' }, { name: 'newWallet', type: 'address' }, { name: 'owner', type: 'address' }, { name: 'deadline', type: 'uint256' }] },
        primaryType: 'AgentWalletSet',
        message: { agentId: BigInt(agentState.agentId), newWallet: address, owner: owner.address, deadline },
      } as never, // the SDK types this as viem's TypedData map; it takes a full typed-data request
    });
    const ownerWc = createWalletClient({ account: owner, chain, transport: http(cfg.rpcUrl) });
    await waitOk(
      await ownerWc.writeContract({ address: dep.identity8004, abi: ID, functionName: 'setAgentWallet', args: [BigInt(agentState.agentId), address, deadline, signature as Hex] }),
      'ERC-8004 setAgentWallet (signed by the Dynamic MPC wallet)',
    );
    await waitOk(await ownerWc.writeContract({ address: agentState.leaderBook, abi: LB, functionName: 'setOperator', args: [address] }), 'LeaderBook.setOperator');
    console.log('identity wallet:', await pub.readContract({ address: dep.identity8004, abi: ID, functionName: 'getAgentWallet', args: [BigInt(agentState.agentId)] }));
    console.log('book operator:', await pub.readContract({ address: agentState.leaderBook, abi: LB, functionName: 'operator' }));
  } else if (step === 'policy') {
    // Wallet layer (admin API, environment API token): allowlist = only the agent's LeaderBook, only these functions, only testnet.
    const token = readFileSync(resolve(cfg.ROOT, '../services/.env'), 'utf8').match(/^DYNAMIC_API_TOKEN=(.+)$/m)?.[1]?.trim();
    if (!token) throw new Error('DYNAMIC_API_TOKEN missing in services/.env');
    const fns = ['trade', 'checkpoint', 'rollEpoch'] as const;
    const operations = fns.map((fn) => ({
      op: 'upsert',
      rule: {
        name: `Agent #${agentState.agentId}: LeaderBook.${fn} only`,
        ruleType: 'allow',
        chain: 'EVM',
        chainIds: [10143],
        addresses: [agentState.leaderBook],
        contractAbi: LB.filter((f) => f.type === 'function' && f.name === fn),
        functionName: fn,
      },
    }));
    const r = await fetch(`https://app.dynamicauth.com/api/v0/environments/${DYN_ENV}/waas/wallets/${w.walletMetadata.walletId}/policy-layer`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'batch', operations }),
    });
    const body = await r.text();
    console.log('policy-layer', r.status, body.slice(0, 2000));
    if (!r.ok) process.exit(1);
    writeFileSync(resolve(cfg.ROOT, 'dynamic/agent-policy.json'), JSON.stringify({ at: new Date().toISOString(), walletId: w.walletMetadata.walletId, layer: JSON.parse(body) }, null, 2));
  } else if (step === 'deny') {
    // approve, not transfer: the wallet holds no AUSD, so a transfer would fail simulation before the policy is asked.
    const to = '0x000000000000000000000000000000000000dEaD' as Address;
    const data = encodeFunctionData({ abi: parseAbi(['function approve(address,uint256) returns (bool)']), functionName: 'approve', args: [to, 1_000_000n] });
    const attempt = { at: new Date().toISOString(), chainId: 10143, provider: 'Dynamic', wallet: address, walletId: w.walletMetadata.walletId, agentId: agentState.agentId, request: { to: dep.ausd, call: `approve(${to}, 1 AUSD)`, data } };
    let record: object;
    try {
      const hash = await send(dep.ausd, data, 'AUSD approve (must be refused)');
      record = { ...attempt, outcome: 'ALLOWED', hash, warning: 'policy did NOT block this' };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      record = { ...attempt, outcome: /polic|denied|not permitted|forbidden/i.test(msg) ? 'DENIED' : 'ERROR', status: e?.status ?? null, code: e?.code ?? null, error: msg.split('\n')[0].slice(0, 400) };
    }
    mkdirSync(resolve(cfg.ROOT, 'logs'), { recursive: true });
    writeFileSync(resolve(cfg.ROOT, 'logs/dynamic-deny.json'), JSON.stringify(record, null, 2));
    console.log(JSON.stringify(record, null, 2));
  } else if (step === 'checkpoint') {
    await send(agentState.leaderBook, encodeFunctionData({ abi: LB, functionName: 'checkpoint' }), 'LeaderBook.checkpoint from Dynamic agent wallet');
  } else if (step === 'trade') {
    const close = process.argv[3] === 'close';
    const lot = BigInt(process.argv[4] ?? '10');
    const info = (await pub.readContract({
      address: dep.exchange,
      abi: ABI.exchange,
      functionName: 'getPerpetualInfo',
      args: [16n],
    })) as { basePricePNS: bigint; maxBidPriceONS: bigint; minAskPriceONS: bigint };
    // IOC: open long crosses the ask (+1%), close long crosses the bid (-1%). Same price math as script/AgentLeader.s.sol.
    const price = close ? ((info.basePricePNS + info.maxBidPriceONS) * 99n) / 100n : ((info.basePricePNS + info.minAskPriceONS) * 101n) / 100n;
    await send(
      agentState.leaderBook,
      encodeFunctionData({ abi: LB, functionName: 'trade', args: [16n, close ? 2 : 0, lot, price, 200n] }),
      `LeaderBook.trade ${close ? 'close' : 'open'} long ${lot} lots BTC from Dynamic agent wallet`,
    );
  } else {
    throw new Error('usage: pnpm dynamic:agent setup|link|policy|trade|checkpoint|deny');
  }
}
