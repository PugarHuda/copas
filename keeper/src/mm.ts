// DOWN-token market maker (Monad testnet only: Kuru mainnet listing is owner-only).
// Each tick, for every Active leader: mint the UP/DOWN series of the running epoch (and of epoch+1 near its end),
// list DOWN/AUSD on Kuru (permissionless testnet Router.deployProxy), and keep one bid + one ask around the fair
// breach probability from src/mmLogic.ts. Finished/breached series: cancel, withdraw, redeem the winning side.
// Signs with MM_PRIVATE_KEY, a plain local key: the Privy keeper wallet's policy forbids AUSD on purpose.
import {
  createWalletClient, encodeFunctionData, erc20Abi, http, maxUint256, parseAbi, zeroAddress,
  type Abi, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ABI, cfg, log, type Deployments } from './config.js';
import { chain, client } from './chain.js';
import { STATUS, type Leader } from './logic.js';
import { MM_DEFAULTS, breachProbability, epochsToQuote, mintAmount, planQuotes, quotePrices, type MmParams, type Order } from './mmLogic.js';

// Kuru V1 testnet (fragments of @kuru-labs/kuru-sdk 0.0.95 abi/{Router,OrderBook,MarginAccount}.json, same as onramp/src/kuru/market.ts)
export const KURU_ROUTER: Address = '0x7EFbE105Ca7415dE98F96622173458ac1c054630';
const AUSD_FAUCET: Address = '0xd236c18d274e54faccc3dd9dda4b27965a73ee6c';
const routerAbi = parseAbi([
  'function deployProxy(uint8 _type, address _baseAssetAddress, address _quoteAssetAddress, uint96 _sizePrecision, uint32 _pricePrecision, uint32 _tickSize, uint96 _minSize, uint96 _maxSize, uint256 _takerFeeBps, uint256 _makerFeeBps, uint96 _kuruAmmSpread) returns (address)',
  'function computeAddress(address _baseAssetAddress, address _quoteAssetAddress, uint96 _sizePrecision, uint32 _pricePrecision, uint32 _tickSize, uint96 _minSize, uint96 _maxSize, uint256 _takerFeeBps, uint256 _makerFeeBps, uint96 _kuruAmmSpread, address oldImplementation, bool old) view returns (address)',
  'function marginAccountAddress() view returns (address)',
]);
const bookAbi = parseAbi([
  'function getMarketParams() view returns (uint32 pricePrecision, uint96 sizePrecision, address baseAsset, uint256 baseDecimals, address quoteAsset, uint256 quoteDecimals, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps)',
  'function s_orderIdCounter() view returns (uint40)',
  'function s_orders(uint40) view returns (address ownerAddress, uint96 size, uint40 prev, uint40 next, uint40 flippedId, uint32 price, uint32 flippedPrice, bool isBuy)',
  'function batchUpdate(uint32[] buyPrices, uint96[] buySizes, uint32[] sellPrices, uint96[] sellSizes, uint40[] orderIdsToCancel, bool postOnly)',
  'function batchCancelOrders(uint40[] _orderIds)',
]);
const marginAbi = parseAbi([
  'function deposit(address _user, address _token, uint256 _amount) payable',
  'function withdraw(uint256 _amount, address _token)',
  'function getBalance(address _user, address _token) view returns (uint256)',
]);
const riskAbi = parseAbi(['function latest(address) view returns (uint8 riskLevel, uint16 ddToLimitPct, uint64 at, bytes32 noteHash)']);
const faucetAbi = parseAbi(['function requestFunds(address)']);
/** DOWN/AUSD book defaults (onramp/src/kuru/market.ts DOWN_MARKET_DEFAULTS): price 1e-4 AUSD, tick 0.001, size 0.01 DOWN, min 1 DOWN. */
const D = { type: 0, sizePrecision: 100n, pricePrecision: 10_000, tickSize: 10, minSize: 100n, maxSize: 10n ** 12n, takerFeeBps: 30n, makerFeeBps: 10n, kuruAmmSpread: 100n };
const RISK_CONSUMER: Address = '0xBc28c947e51572e55eeb0f988a068C7A0f4ec7b0';
/** ponytail: only the newest ORDER_SCAN order ids are searched for ours; a busier book needs OrderCreated logs instead. */
const ORDER_SCAN = 200;

const num = (k: string, d: number) => { const v = Number(process.env[k]); return process.env[k] && Number.isFinite(v) ? v : d; };
const params: MmParams = {
  ...MM_DEFAULTS,
  ...Object.fromEntries((Object.keys(MM_DEFAULTS) as (keyof MmParams)[]).filter((k) => k !== 'riskBump')
    .map((k) => [k, num(`MM_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`, MM_DEFAULTS[k] as number)])),
};
const MAX_SPEND = num('MM_MAX_SPEND_PER_TICK', 500); // AUSD minted + deposited per tick, all leaders together
const MARGIN_AUSD = num('MM_MARGIN_AUSD', 50); // Kuru margin AUSD kept for bids (shared by every book)
const MIN_AUSD = num('MM_MIN_AUSD', 1_000); // below this the MM asks the testnet faucet for more
const U = 1e6; // AUSD / DOWN / UP decimals
const NEW_SERIES_GAS = 4n * 10n ** 17n; // 0.4 MON at testnet's ~100 gwei

export function kuruMarketFor(down: Address, ausd: Address) {
  return client.readContract({
    address: KURU_ROUTER, abi: routerAbi, functionName: 'computeAddress',
    args: [down, ausd, D.sizePrecision, D.pricePrecision, D.tickSize, D.minSize, D.maxSize, D.takerFeeBps, D.makerFeeBps, D.kuruAmmSpread, zeroAddress, false],
  });
}

type Out = {
  journal: { kind: string; to: Address; outcome: 'sent' | 'skipped' | 'failed' | 'dry-run'; detail: string }[];
  decisions: { what: string; decision: string }[];
  dryRun: boolean;
};

export async function marketMake(dep: Deployments, leaders: Leader[], now: bigint, out: Out) {
  const key = process.env.MM_PRIVATE_KEY;
  if (!key) return out.decisions.push({ what: 'market maker', decision: 'off: MM_PRIVATE_KEY not set' });
  if (cfg.chainId !== 10143) return out.decisions.push({ what: 'market maker', decision: 'off: Kuru listing is permissioned on mainnet' });
  const account = privateKeyToAccount(key as Hex);
  const me = account.address;
  const wallet = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });
  const read = <T>(address: Address, abi: Abi | readonly unknown[], functionName: string, args: unknown[] = []) =>
    client.readContract({ address, abi: abi as Abi, functionName, args }) as Promise<T>;
  const bal = (token: Address, who: Address = me) => read<bigint>(token, erc20Abi, 'balanceOf', [who]);

  /** simulate, send, wait. false = reverted or failed (journaled), so the caller stops that series. */
  const send = async (kind: string, to: Address, data: Hex): Promise<boolean> => {
    const note = (outcome: Out['journal'][number]['outcome'], detail: string) => out.journal.push({ kind: `mm:${kind}`, to, outcome, detail });
    try {
      await client.call({ account: me, to, data });
    } catch (e: any) {
      note('skipped', `simulation reverts: ${(e?.shortMessage ?? String(e)).split('\n')[0].slice(0, 160)}`);
      return false;
    }
    if (out.dryRun) { note('dry-run', 'simulation ok, would send'); return true; }
    try {
      const hash = await wallet.sendTransaction({ to, data });
      const r = await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
      log(r.status === 'success' ? 'info' : 'warn', 'mm tx', { kind, to, hash, ok: r.status === 'success' });
      note(r.status === 'success' ? 'sent' : 'failed', hash);
      return r.status === 'success';
    } catch (e: any) {
      note('failed', (e?.shortMessage ?? String(e)).split('\n')[0].slice(0, 200));
      return false;
    }
  };
  const approve = async (token: Address, spender: Address, amount: bigint) =>
    (await read<bigint>(token, erc20Abi, 'allowance', [me, spender])) >= amount ||
    send('approve', token, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, maxUint256] }));

  const mon = await client.getBalance({ address: me }); // below 0.03 MON stop; 0.03-0.4 still cancels, re-quotes and redeems
  if (mon < 3n * 10n ** 16n) return out.decisions.push({ what: `market maker ${me}`, decision: `off: ${Number(mon) / 1e18} MON, needs gas` });
  let ausd = await bal(dep.ausd);
  if (ausd < BigInt(MIN_AUSD * U) && (await send('faucet', AUSD_FAUCET, encodeFunctionData({ abi: faucetAbi, functionName: 'requestFunds', args: [me] })))) ausd = await bal(dep.ausd);
  const margin = await read<Address>(KURU_ROUTER, routerAbi, 'marginAccountAddress');
  let budget = Math.min(MAX_SPEND, Number(ausd) / U);
  out.decisions.push({ what: `market maker ${me}`, decision: `${(Number(mon) / 1e18).toFixed(2)} MON, ${(Number(ausd) / U).toFixed(0)} AUSD, budget ${budget} AUSD this tick` });

  const myOrders = async (market: Address): Promise<Order[]> => {
    const n = Number(await read<number>(market, bookAbi, 's_orderIdCounter'));
    const ids = Array.from({ length: Math.min(n, ORDER_SCAN) }, (_, i) => BigInt(n - i));
    const rows = await Promise.all(ids.map((id) => read<readonly [Address, bigint, number, number, number, number, number, boolean]>(market, bookAbi, 's_orders', [id])));
    return rows.flatMap((r, i) => (r[0].toLowerCase() === me.toLowerCase() && r[1] > 0n ? [{ id: ids[i], isBuy: r[7], price: Number(r[5]), size: r[1] }] : []));
  };
  const series = (lb: Address, e: bigint) => read<{ up: Address; down: Address; settled: boolean; breach: boolean }>(dep.breachMarket, ABI.breachMarket, 'series', [lb, e]);

  async function quote(l: Leader, e: bigint, p: number, why: string) {
    const what = `mm ${l.address} epoch ${e}`;
    let s = await series(l.address, e);
    let market = s.down === zeroAddress ? null : await kuruMarketFor(s.down, dep.ausd);
    const listed = !!market && !!(await client.getCode({ address: market }));
    const orders = listed ? await myOrders(market!) : [];
    const down = s.down === zeroAddress ? 0 : Number((await bal(s.down)) + (await read<bigint>(margin, marginAbi, 'getBalance', [me, s.down])) + orders.filter((o) => !o.isBuy).reduce((a, o) => a + o.size, 0n) * BigInt(U) / D.sizePrecision) / U;
    const up = s.up === zeroAddress ? 0 : Number(await bal(s.up)) / U;
    // a new series costs ~0.33 MON (mint deploys 2 tokens, deployProxy a book + vault): don't start one that can't be listed
    if (!listed && (await client.getBalance({ address: me })) < NEW_SERIES_GAS) {
      return out.decisions.push({ what, decision: `p=${p.toFixed(3)} (${why}): skip, MM below ${Number(NEW_SERIES_GAS) / 1e18} MON` });
    }
    const mint = mintAmount({ downHeld: down, upHeld: up, budget }, params);
    if (mint > 0) {
      const amt = BigInt(mint * U);
      if (!(await approve(dep.ausd, dep.breachMarket, amt))) return;
      if (!(await send('mint', dep.breachMarket, encodeFunctionData({ abi: ABI.breachMarket, functionName: 'mint', args: [l.address, e, amt, me] })))) return;
      budget -= mint;
      s = await series(l.address, e);
    }
    if (s.down === zeroAddress) return out.decisions.push({ what, decision: `p=${p.toFixed(3)} (${why}): no series, nothing minted (budget ${budget})` });
    market ??= await kuruMarketFor(s.down, dep.ausd);
    if (!(await client.getCode({ address: market }))) {
      const data = encodeFunctionData({ abi: routerAbi, functionName: 'deployProxy', args: [D.type, s.down, dep.ausd, D.sizePrecision, D.pricePrecision, D.tickSize, D.minSize, D.maxSize, D.takerFeeBps, D.makerFeeBps, D.kuruAmmSpread] });
      if (!(await send('kuru-deploy', KURU_ROUTER, data)) || out.dryRun) return;
    }
    // move every DOWN into the Kuru margin account (orders are funded from it), keep MARGIN_AUSD there for bids
    const wDown = await bal(s.down);
    if (wDown > 0n && (!(await approve(s.down, margin, wDown)) || !(await send('deposit-down', margin, encodeFunctionData({ abi: marginAbi, functionName: 'deposit', args: [me, s.down, wDown] }))))) return;
    let mAusd = await read<bigint>(margin, marginAbi, 'getBalance', [me, dep.ausd]);
    const top = Math.min(budget, MARGIN_AUSD - Number(mAusd) / U);
    if (top >= 1) {
      const amt = BigInt(Math.floor(top * U));
      if ((await approve(dep.ausd, margin, amt)) && (await send('deposit-ausd', margin, encodeFunctionData({ abi: marginAbi, functionName: 'deposit', args: [me, dep.ausd, amt] })))) { budget -= top; mAusd += amt; }
    }
    const [pp, sp, , baseDec, , quoteDec, tick, minSize] = await read<readonly [number, bigint, Address, bigint, Address, bigint, number, bigint]>(market, bookAbi, 'getMarketParams');
    const live = await myOrders(market);
    const target = quotePrices(p, Number(pp), Number(tick), params.spread);
    const unitBase = 10n ** baseDec / sp; // atomic DOWN per size unit
    const mDown = await read<bigint>(margin, marginAbi, 'getBalance', [me, s.down]);
    const sellable = mDown / unitBase + live.filter((o) => !o.isBuy).reduce((a, o) => a + o.size, 0n);
    // AUSD atomic for `size` units at `price` = price * size * 10^quoteDec / (pp * sp)
    const lockedBuy = live.filter((o) => o.isBuy).reduce((a, o) => a + BigInt(o.price) * o.size * 10n ** quoteDec / (BigInt(pp) * sp), 0n);
    const buyable = down >= params.maxDown ? 0n : (mAusd + lockedBuy) * BigInt(pp) * sp / (BigInt(target.bid) * 10n ** quoteDec);
    const plan = planQuotes({
      orders: live, target, quoteSize: BigInt(params.quoteSize) * sp, minSize,
      requoteUnits: params.requote * Number(pp), sellable, buyable,
    });
    const head = `p=${p.toFixed(3)} (${why}) bid ${target.bid / Number(pp)} ask ${target.ask / Number(pp)} on ${market}`;
    if (!plan) return out.decisions.push({ what, decision: `${head}: quotes current` });
    out.decisions.push({ what, decision: `${head}: ${plan.why}` });
    await send('quote', market, encodeFunctionData({
      abi: bookAbi, functionName: 'batchUpdate',
      args: [plan.buy ? [plan.buy.price] : [], plan.buy ? [plan.buy.size] : [], plan.sell ? [plan.sell.price] : [], plan.sell ? [plan.sell.size] : [], plan.cancel.map(Number), false],
    }));
  }

  /** Series we no longer quote: pull orders and DOWN off Kuru, then redeem what pays out. */
  async function sweep(l: Leader, e: bigint) {
    const s = await series(l.address, e);
    if (s.down === zeroAddress) return;
    const market = await kuruMarketFor(s.down, dep.ausd);
    if (await client.getCode({ address: market })) {
      const mine = await myOrders(market);
      if (mine.length) {
        out.decisions.push({ what: `mm ${l.address} epoch ${e}`, decision: `not quoted any more: cancel ${mine.length} orders` });
        await send('cancel', market, encodeFunctionData({ abi: bookAbi, functionName: 'batchCancelOrders', args: [mine.map((o) => Number(o.id))] }));
      }
      const m = await read<bigint>(margin, marginAbi, 'getBalance', [me, s.down]);
      if (m > 0n) await send('withdraw-down', margin, encodeFunctionData({ abi: marginAbi, functionName: 'withdraw', args: [m, s.down] }));
    }
    const [up, down] = await Promise.all([bal(s.up), bal(s.down)]);
    if (up === 0n && down === 0n) return;
    const breached = await read<boolean>(l.address, ABI.leader, 'breached', [e]);
    if (breached || l.epoch > e) {
      const win = breached ? down : up;
      if (win > 0n) await send('redeem', dep.breachMarket, encodeFunctionData({ abi: ABI.breachMarket, functionName: 'redeem', args: [l.address, e, win] }));
    } else {
      const pair = up < down ? up : down;
      if (pair > 0n) await send('redeem-pair', dep.breachMarket, encodeFunctionData({ abi: ABI.breachMarket, functionName: 'redeemPair', args: [l.address, e, pair] }));
    }
  }

  for (const l of leaders) {
    try {
      const quoted = l.status === STATUS.Active ? epochsToQuote(l.epoch, l.epochEnd, now, params.premintSec) : [];
      if (quoted.length) {
        const [[u], peak, mandate, risk] = await Promise.all([
          read<readonly [bigint, boolean]>(l.address, ABI.leader, 'unitPrice'),
          read<bigint>(l.address, ABI.leader, 'peakUnitPrice'),
          read<{ epochLen: bigint }>(l.address, ABI.leader, 'mandate'),
          read<readonly [number, number, bigint, Hex]>(RISK_CONSUMER, riskAbi, 'latest', [l.address]).catch(() => null),
        ]);
        const r = risk && risk[2] > 0n ? { level: risk[0], ageSec: Number(now - risk[2]) } : undefined;
        for (const e of quoted) {
          const next = e > l.epoch;
          const secondsLeft = next ? Number(mandate.epochLen) : Number(l.epochEnd - now);
          // a fresh epoch resets the peak to the then unit price: full drawdown headroom
          const x = { unitPrice: Number(u) / 1e18, peak: next ? 0 : Number(peak) / 1e18, maxDDbps: l.maxDDbps, secondsLeft, risk: r };
          const dd = x.peak > 0 ? Math.max(0, 1 - x.unitPrice / x.peak) : 0;
          const why = `dd ${(dd * 100).toFixed(2)}%/${l.maxDDbps / 100}%, ${Math.round(secondsLeft / 60)}m left, CRE risk ${r ? `${r.level} (${Math.round(r.ageSec / 60)}m old)` : 'none'}`;
          await quote(l, e, breachProbability(x, params), why);
        }
      }
      for (let e = l.epoch - 2n; e <= l.epoch + 1n; e++) if (e > 0n && !quoted.includes(e)) await sweep(l, e);
    } catch (e: any) {
      log('warn', 'mm leader failed', { leader: l.address, err: e?.shortMessage ?? String(e) });
      out.journal.push({ kind: 'mm', to: l.address, outcome: 'failed', detail: (e?.shortMessage ?? String(e)).split('\n')[0].slice(0, 200) });
    }
  }
}
