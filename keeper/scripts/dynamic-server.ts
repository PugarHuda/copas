// pnpm dynamic:server <step> — Dynamic server wallet (environment API token) as LeaderBook operator. steps: create | policy | unpolicy | signtest <chainId> | trade <orderType> <lot> | deny
import { readFileSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, encodeFunctionData, http, parseAbi, type Address, type Hex } from 'viem';
import { DynamicEvmWalletClient } from '@dynamic-labs-wallet/node-evm';
import { ThresholdSignatureScheme } from '@dynamic-labs-wallet/node';
import { ABI, cfg, loadDeployments } from '../src/config.js';

const ENV = 'efd0454a-9032-45ba-9bce-0a796254c83b';
const TOKEN = readFileSync(resolve(cfg.ROOT, '../services/.env'), 'utf8').match(/^DYNAMIC_API_TOKEN=(.+)$/m)![1].trim().replace(/"/g, '');
const FILE = resolve(cfg.ROOT, 'dynamic/server-wallet.json');
const dep = loadDeployments();
const LEADER = JSON.parse(readFileSync(resolve(cfg.ROOT, '../contracts/deployments/short-10143.json'), 'utf8')).leader as Address;
const chain = { id: 10143, name: 'Monad Testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } } as const;
const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
const LB = parseAbi(['function trade(uint256 perpId, uint8 orderType, uint256 lot, uint256 price, uint256 leverageHdths) returns (uint256)', 'function checkpoint()', 'function rollEpoch()']);
const client = new DynamicEvmWalletClient({ environmentId: ENV, enableMPCAccelerator: false });
await client.authenticateApiToken(TOKEN);
const step = process.argv[2];

if (step === 'create') {
  const { walletMetadata, externalServerKeyShares } = await client.createWalletAccount({ thresholdSignatureScheme: ThresholdSignatureScheme.TWO_OF_TWO, backUpToDynamic: false });
  writeFileSync(FILE, JSON.stringify({ environmentId: ENV, leaderBook: LEADER, walletMetadata }, null, 2));
  const envPath = resolve(cfg.ROOT, '.env');
  appendFileSync(envPath, `\nDYNAMIC_SERVER_KEYSHARES=${Buffer.from(JSON.stringify(externalServerKeyShares)).toString('base64')}\n`, { mode: 0o600 });
  chmodSync(envPath, 0o600); // a key share is half of the wallet: owner-only
  console.log('server wallet', walletMetadata.accountAddress, walletMetadata.walletId);
} else {
  const { walletMetadata } = JSON.parse(readFileSync(FILE, 'utf8'));
  const shares = JSON.parse(Buffer.from(process.env.DYNAMIC_SERVER_KEYSHARES!, 'base64').toString('utf8'));
  const w = { walletMetadata, externalServerKeyShares: shares };
  // Dynamic's policy engine does not validate Monad (143/10143), so Copas enforces the allowlist before signing.
  const ALLOWED = new Set((['trade', 'checkpoint', 'rollEpoch'] as const).map((fn) => encodeFunctionData({ abi: LB, functionName: fn, args: fn === 'trade' ? [0n, 0, 0n, 0n, 0n] : undefined } as never).slice(0, 10)));
  const send = async (to: Address, data: Hex, what: string) => {
    if (to.toLowerCase() !== LEADER.toLowerCase() || !ALLOWED.has(data.slice(0, 10))) throw new Error(`refused by Copas allowlist: only trade/checkpoint/rollEpoch on ${LEADER}`);
    const wc = await client.getWalletClient({ ...w, chain, rpcUrl: cfg.rpcUrl } as never);
    const hash = await (wc as any).sendTransaction({ to, data, chain });
    const r = await pub.waitForTransactionReceipt({ hash });
    console.log(`${what}: ${r.status} ${hash}`);
    return hash;
  };
  if (step === 'trade') {
    const orderType = Number(process.argv[3]); const lot = BigInt(process.argv[4] ?? '20');
    const i = (await pub.readContract({ address: dep.exchange, abi: ABI.exchange, functionName: 'getPerpetualInfo', args: [16n] })) as any;
    const buy = orderType === 0 || orderType === 3; // open long / close short cross the ask
    const price = buy ? ((i.basePricePNS + i.minAskPriceONS) * 101n) / 100n : ((i.basePricePNS + i.maxBidPriceONS) * 99n) / 100n;
    await send(LEADER, encodeFunctionData({ abi: LB, functionName: 'trade', args: [16n, orderType, lot, price, 500n] }), `LeaderBook.trade type ${orderType} lot ${lot} from Dynamic server wallet`);
  } else if (step === 'policy') {
    const operations = (['trade', 'checkpoint', 'rollEpoch'] as const).map((fn) => ({ op: 'upsert', rule: { name: `Copas leader ${LEADER.slice(0, 8)}: LeaderBook.${fn} only`, ruleType: 'allow', chain: 'EVM', chainIds: [Number(process.env.POLICY_CHAIN ?? 10143)], addresses: [LEADER], contractAbi: LB.filter((f) => f.name === fn), functionName: fn } }));
    const r = await fetch(`https://app.dynamicauth.com/api/v0/environments/${ENV}/waas/wallets/${walletMetadata.walletId}/policy-layer`, { method: 'PATCH', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'batch', operations }) });
    const body = await r.text(); console.log('policy-layer', r.status, body.slice(0, 300));
    if (r.ok) writeFileSync(resolve(cfg.ROOT, 'dynamic/server-policy.json'), JSON.stringify({ at: new Date().toISOString(), walletId: walletMetadata.walletId, layer: JSON.parse(body) }, null, 2));
  } else if (step === 'unpolicy') {
    const url = `https://app.dynamicauth.com/api/v0/environments/${ENV}/waas/wallets/${walletMetadata.walletId}/policy-layer`;
    const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const cur = await (await fetch(url, { headers: H })).json() as any;
    const ids = (cur?.layerContent?.rules ?? []).map((r: any) => r.ruleId);
    const r = await fetch(url, { method: 'PATCH', headers: H, body: JSON.stringify({ op: 'batch', operations: ids.map((ruleId: string) => ({ op: 'remove', ruleId })) }) });
    console.log('unpolicy', ids.length, r.status, (await r.text()).slice(0, 200));
  } else if (step === 'signtest') {
    // sign only, never broadcast: does Dynamic's policy engine validate this chain?
    const cid = Number(process.argv[3]);
    const ch = { ...chain, id: cid };
    for (const [what, to, data] of [['allowed trade', LEADER, encodeFunctionData({ abi: LB, functionName: 'checkpoint' })], ['AUSD approve', dep.ausd, encodeFunctionData({ abi: parseAbi(['function approve(address,uint256) returns (bool)']), functionName: 'approve', args: ['0x000000000000000000000000000000000000dEaD', 1n] })]] as const) {
      try { const sig = await client.signTransaction({ ...w, transaction: { type: 'eip1559', chainId: cid, to, data, nonce: 0, gas: 300000n, maxFeePerGas: 200000000000n, maxPriorityFeePerGas: 1000000000n } } as never); console.log(cid, what, 'SIGNED', String(sig).slice(0, 20)); }
      catch (e: any) { console.log(cid, what, 'REFUSED', String(e?.message ?? e).split(String.fromCharCode(10))[0].slice(0, 160)); }
    }
  } else if (step === 'deny') {
    const data = encodeFunctionData({ abi: parseAbi(['function approve(address,uint256) returns (bool)']), functionName: 'approve', args: ['0x000000000000000000000000000000000000dEaD', 1_000_000n] });
    let rec: object;
    try { rec = { outcome: 'ALLOWED', hash: await send(dep.ausd, data, 'AUSD approve (must be refused)') }; }
    catch (e: any) { rec = { outcome: /polic|denied|not permitted|forbidden|allowlist/i.test(String(e?.message)) ? 'DENIED' : 'ERROR', error: String(e?.message ?? e).split('\n')[0].slice(0, 400) }; }
    const out = { at: new Date().toISOString(), wallet: walletMetadata.accountAddress, request: 'AUSD.approve(0xdEaD, 1 AUSD)', ...rec };
    writeFileSync(resolve(cfg.ROOT, 'logs/dynamic-server-deny.json'), JSON.stringify(out, null, 2)); console.log(JSON.stringify(out));
  }
}
