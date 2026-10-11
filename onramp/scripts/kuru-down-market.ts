// Kuru V1 market for a BreachMarket DOWN token vs AUSD on Monad TESTNET (10143).
// Mainnet: listing is permissioned (Router.deployProxy is owner-only, Safe multisig) -> mainnet is mint/redeem only.
//
//   pnpm kuru:down-market simulate --down 0x...                      dry-run deployProxy (no key needed)
//   pnpm kuru:down-market deploy   --down 0x...                      or --breach-market 0x.. --leader-book 0x.. --epoch N
//   pnpm kuru:down-market book     --market 0x...
//   pnpm kuru:down-market deposit  --market 0x... --token down|ausd --amount 10     (MarginAccount, for limit orders)
//   pnpm kuru:down-market limit    --market 0x... --side buy|sell --price 0.12 --size 10
//   pnpm kuru:down-market market   --market 0x... --side buy|sell --amount 5 [--min-out 0]
// Env: PRIVATE_KEY (testnet), optional MONAD_TESTNET_RPC.
import { parseArgs } from 'node:util';
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, http, parseAbi, parseEventLogs, parseUnits, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { MONAD_TESTNET } from '../src/config.js';
import { deployProxyArgs, limitOrderData, marginAccountAbi, marketOrderData, orderBookAbi, routerAbi } from '../src/kuru/market.js';

try {
  process.loadEnvFile();
} catch {}
const { positionals, values: a } = parseArgs({
  allowPositionals: true,
  options: {
    down: { type: 'string' },
    'breach-market': { type: 'string' },
    'leader-book': { type: 'string' },
    epoch: { type: 'string' },
    market: { type: 'string' },
    token: { type: 'string' },
    side: { type: 'string' },
    price: { type: 'string' },
    size: { type: 'string' },
    amount: { type: 'string' },
    'min-out': { type: 'string' },
  },
});
const cmd = positionals[0] ?? 'help';

const chain = {
  id: MONAD_TESTNET.chainId,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [process.env.MONAD_TESTNET_RPC ?? MONAD_TESTNET.rpc] } },
} as const;
const pub = createPublicClient({ chain, transport: http() });
const pk = process.env.PRIVATE_KEY as Hex | undefined;
const account = pk ? privateKeyToAccount(pk) : undefined;
const wallet = account ? createWalletClient({ chain, account, transport: http() }) : undefined;
const router = MONAD_TESTNET.KURU_ROUTER;
const AUSD = MONAD_TESTNET.AUSD;

function needWallet() {
  if (!wallet || !account) throw new Error('PRIVATE_KEY (Monad testnet) required');
  return { wallet, account };
}
const addr = (v: string | undefined, name: string): Address => {
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`--${name} <address> required`);
  return v as Address;
};

async function send(to: Address, data: Hex, label: string) {
  const { wallet, account } = needWallet();
  await pub.call({ account: account.address, to, data }); // surface reverts before paying gas
  const hash = await wallet.sendTransaction({ to, data });
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`${label}: ${r.status} ${hash}`);
  if (r.status !== 'success') process.exit(1);
  return r;
}

async function downToken(): Promise<Address> {
  if (a.down) return addr(a.down, 'down');
  const bm = addr(a['breach-market'], 'breach-market');
  const lb = addr(a['leader-book'], 'leader-book');
  const series = await pub.readContract({
    address: bm,
    abi: parseAbi(['function series(address lb, uint256 e) view returns ((address up, address down, bool settled, bool breached))']),
    functionName: 'series',
    args: [lb, BigInt(a.epoch ?? '0')],
  });
  if (/^0x0{40}$/.test(series.down)) throw new Error('series not minted yet: BreachMarket.mint once to create the DOWN token');
  return series.down;
}

async function params(market: Address) {
  const p = await pub.readContract({ address: market, abi: orderBookAbi, functionName: 'getMarketParams' });
  return { pricePrecision: p[0], sizePrecision: p[1], base: p[2], baseDecimals: Number(p[3]), quote: p[4], quoteDecimals: Number(p[5]) };
}

async function main() {
  if ((await pub.getChainId()) !== MONAD_TESTNET.chainId) throw new Error('RPC is not Monad testnet; mainnet listing is permissioned');
  switch (cmd) {
    case 'simulate':
    case 'deploy': {
      const down = await downToken();
      if (!(await pub.getCode({ address: down }))) throw new Error(`${down} has no code on testnet (deployProxy reverts without a reason)`);
      const args = deployProxyArgs(down, AUSD);
      const from = account?.address ?? '0x000000000000000000000000000000000000dEaD';
      const { result } = await pub.simulateContract({ account: from, address: router, abi: routerAbi, functionName: 'deployProxy', args });
      console.log(`deployProxy(${down} / AUSD) simulates OK -> market ${result}`);
      if (cmd === 'simulate') return;
      const { wallet } = needWallet();
      const hash = await wallet.writeContract({ address: router, abi: routerAbi, functionName: 'deployProxy', args });
      const r = await pub.waitForTransactionReceipt({ hash });
      const ev = parseEventLogs({ abi: routerAbi, logs: r.logs, eventName: 'MarketRegistered' })[0];
      console.log(`deployed: market ${ev?.args.market ?? result} vault ${ev?.args.vaultAddress ?? '?'} tx ${hash}`);
      return;
    }
    case 'book': {
      const m = addr(a.market, 'market');
      const p = await params(m);
      const [bid, ask] = await pub.readContract({ address: m, abi: orderBookAbi, functionName: 'bestBidAsk' });
      console.log({ ...p, bestBid: bid.toString(), bestAsk: ask.toString() });
      return;
    }
    case 'deposit': {
      const m = addr(a.market, 'market');
      const p = await params(m);
      const token = a.token === 'down' ? p.base : p.quote;
      const amt = parseUnits(a.amount ?? '0', a.token === 'down' ? p.baseDecimals : p.quoteDecimals);
      const ma = await pub.readContract({ address: router, abi: routerAbi, functionName: 'marginAccountAddress' });
      const { account } = needWallet();
      await send(token, encodeApprove(ma, amt), 'approve MarginAccount');
      await send(ma, encodeDeposit(account.address, token, amt), 'MarginAccount.deposit');
      return;
    }
    case 'limit': {
      const m = addr(a.market, 'market');
      const side = a.side === 'sell' ? 'sell' : 'buy';
      await send(m, limitOrderData(await params(m), side, a.price ?? '0', a.size ?? '0'), `limit ${side}`);
      return;
    }
    case 'market': {
      const m = addr(a.market, 'market');
      const p = await params(m);
      const side = a.side === 'sell' ? 'sell' : 'buy';
      const spendToken = side === 'buy' ? p.quote : p.base;
      const spend = parseUnits(a.amount ?? '0', side === 'buy' ? p.quoteDecimals : p.baseDecimals);
      await send(spendToken, encodeApprove(m, spend), 'approve order book');
      await send(m, marketOrderData(p, side, a.amount ?? '0', BigInt(a['min-out'] ?? '0')), `market ${side}`);
      return;
    }
    default:
      console.log('commands: simulate | deploy | book | deposit | limit | market  (see header of scripts/kuru-down-market.ts)');
  }
}

const encodeApprove = (spender: Address, amt: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amt] });
const encodeDeposit = (user: Address, token: Address, amt: bigint) =>
  encodeFunctionData({ abi: marginAccountAbi, functionName: 'deposit', args: [user, token, amt] });

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
