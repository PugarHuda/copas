import "server-only";
import { createPublicClient, http } from "viem";
import { monad, PERPL } from "../chains";
import { perplExchangeAbi } from "./abi";
import type { Market } from "./api";

/**
 * Direct reads of the Perpl Exchange (mainnet). Equity per SPEC §3.1:
 *   equity = balanceCNS + Σ (depositCNS + pnlCNS)   (pnl includes funding)
 * Public RPC keeps ~130h of historical state, enough for 5-day equity/TVL curves.
 */
export const EXCHANGE = PERPL[monad.id].exchange;

export const rpc = createPublicClient({
  chain: monad,
  transport: http(process.env.MONAD_RPC_URL || "https://rpc.monad.xyz", { timeout: 20_000, retryCount: 2 }),
});

const ex = { address: EXCHANGE, abi: perplExchangeAbi } as const;
const C = (v: bigint) => Number(v) / 1e6;

export type RawPos = {
  accountId: bigint;
  nextNodeId: bigint;
  positionType: number;
  depositCNS: bigint;
  pricePNS: bigint;
  lotLNS: bigint;
  entryBlock: bigint;
  pnlCNS: bigint;
  premiumPnlCNS: bigint;
};

export type Position = {
  marketId: number;
  market: string;
  accountId: number;
  side: "long" | "short";
  size: number; // base units
  entry: number;
  mark: number;
  notional: number; // at mark
  margin: number; // depositCNS
  upnl: number; // incl. funding
  funding: number;
  leverage: number; // notional / (margin + upnl)
  liq: number | null; // estimate
  liqDistance: number | null; // % from mark
  entryBlock: number;
};

/**
 * Isolated-margin liquidation estimate. Liquidation when position equity
 * (margin + pnl) falls to notional / maintenance leverage.
 * long:  P = (qM − E) / (q(1 − 1/ML));  short: P = (E + qM) / (q(1 + 1/ML))
 * ponytail: ignores liquidation fees and price impact; exact engine price is in PositionLiquidated events.
 */
export function liqPrice(side: "long" | "short", q: number, mark: number, posEquity: number, maintLev: number) {
  if (q <= 0 || maintLev <= 0) return null;
  const mmf = 1 / maintLev;
  const p = side === "long" ? (q * mark - posEquity) / (q * (1 - mmf)) : (posEquity + q * mark) / (q * (1 + mmf));
  return p > 0 ? p : null;
}

export function toPosition(m: Market, p: RawPos, markPNS: bigint): Position {
  const side = p.positionType === 0 ? "long" : "short";
  const size = Number(p.lotLNS) / 10 ** m.sd;
  const mark = Number(markPNS) / 10 ** m.pd;
  const margin = C(p.depositCNS);
  const upnl = C(p.pnlCNS);
  const notional = size * mark;
  const eq = margin + upnl;
  const liq = liqPrice(side, size, mark, eq, m.maintLev);
  return {
    marketId: m.id,
    market: m.name,
    accountId: Number(p.accountId),
    side,
    size,
    entry: Number(p.pricePNS) / 10 ** m.pd,
    mark,
    notional,
    margin,
    upnl,
    funding: C(p.premiumPnlCNS),
    leverage: eq > 0 ? notional / eq : Infinity,
    liq,
    liqDistance: liq ? (Math.abs(mark - liq) / mark) * 100 : null,
    entryBlock: Number(p.entryBlock),
  };
}

/** Every open position in a market, walking the exchange's linked list. */
export async function allPositions(m: Market): Promise<Position[]> {
  const [start] = await rpc.readContract({ ...ex, functionName: "getPositionIds", args: [BigInt(m.id)] });
  const out: Position[] = [];
  let cur = start;
  for (let guard = 0; cur !== 0n && guard < 50; guard++) {
    const [page, , mark] = await rpc.readContract({ ...ex, functionName: "getPositions", args: [BigInt(m.id), cur, 300n] });
    const live = page.filter((p) => p.accountId !== 0n && p.lotLNS > 0n);
    out.push(...live.map((p) => toPosition(m, p as RawPos, mark)));
    const last = live[live.length - 1];
    if (!last || page.length < 300) break;
    cur = last.nextNodeId;
  }
  return out;
}

export async function perpInfos(markets: Market[], blockNumber?: bigint) {
  const res = await rpc.multicall({
    contracts: markets.map((m) => ({ ...ex, functionName: "getPerpetualInfo", args: [BigInt(m.id)] }) as const),
    blockNumber,
  });
  return markets.map((m, i) => {
    const r = res[i];
    if (r.status !== "success") return null;
    const v = r.result;
    return {
      id: m.id,
      mark: Number(v.markPNS) / 10 ** m.pd,
      oracle: Number(v.oraclePNS) / 10 ** m.pd,
      oiBase: Number(v.longOpenInterestLNS) / 10 ** m.sd,
      fundingRatePct100k: Number(v.fundingRatePct100k),
      insurance: C(v.insuranceBalanceCNS),
      positionBalance: C(v.positionBalanceCNS),
    };
  });
}

export async function exchangeInfo(blockNumber?: bigint) {
  const [[balance, protocolBalance], accounts] = await Promise.all([
    rpc.readContract({ ...ex, functionName: "getExchangeInfo", blockNumber }),
    rpc.readContract({ ...ex, functionName: "numberOfAccounts", blockNumber }),
  ]);
  return { tvl: C(balance), protocolBalance: C(protocolBalance), accounts: Number(accounts) };
}

export type AccountSnapshot = {
  accountId: number;
  address: string;
  balance: number;
  locked: number;
  frozen: boolean;
  positions: Position[];
  equity: number;
  equityValid: boolean;
};

async function snapshot(markets: Market[], acct: { accountId: bigint; balanceCNS: bigint; lockedBalanceCNS: bigint; frozen: number; accountAddr: string }, blockNumber?: bigint): Promise<AccountSnapshot> {
  const res = await rpc.multicall({
    contracts: markets.map((m) => ({ ...ex, functionName: "getPosition", args: [BigInt(m.id), acct.accountId] }) as const),
    blockNumber,
  });
  const positions: Position[] = [];
  let valid = true;
  res.forEach((r, i) => {
    if (r.status !== "success") return;
    const [p, mark, markValid] = r.result;
    if (p.lotLNS === 0n) return;
    if (!markValid) valid = false;
    positions.push(toPosition(markets[i], p as RawPos, mark));
  });
  const balance = C(acct.balanceCNS);
  return {
    accountId: Number(acct.accountId),
    address: acct.accountAddr,
    balance,
    locked: C(acct.lockedBalanceCNS),
    frozen: acct.frozen !== 0,
    positions,
    equity: balance + positions.reduce((s, p) => s + p.margin + p.upnl, 0),
    equityValid: valid,
  };
}

export async function accountByAddr(markets: Market[], addr: `0x${string}`, blockNumber?: bigint) {
  const a = await rpc.readContract({ ...ex, functionName: "getAccountByAddr", args: [addr], blockNumber });
  if (a.accountId === 0n) return null;
  return snapshot(markets, a, blockNumber);
}

export async function accountById(markets: Market[], id: number, blockNumber?: bigint) {
  const a = await rpc.readContract({ ...ex, functionName: "getAccountById", args: [BigInt(id)], blockNumber });
  if (a.accountId === 0n) return null;
  return snapshot(markets, a, blockNumber);
}

/** Resolve many account ids to owner addresses in one multicall. */
export async function addressesFor(ids: number[]): Promise<Map<number, string>> {
  const uniq = [...new Set(ids)];
  const res = await rpc.multicall({
    contracts: uniq.map((id) => ({ ...ex, functionName: "getAccountById", args: [BigInt(id)] }) as const),
  });
  const m = new Map<number, string>();
  res.forEach((r, i) => r.status === "success" && m.set(uniq[i], r.result.accountAddr.toLowerCase()));
  return m;
}

/** Monad public RPC serves historical state for ~1.56M blocks (~130h). Stay inside it. */
export const HISTORY_BLOCKS = 1_400_000n;

/** Equity curve from historical state, `samples` points across the last ~5 days. */
export async function equityCurve(markets: Market[], accountId: number, samples = 40) {
  const head = await rpc.getBlockNumber();
  const step = HISTORY_BLOCKS / BigInt(samples);
  const blocks = Array.from({ length: samples + 1 }, (_, i) => head - HISTORY_BLOCKS + step * BigInt(i));
  const [snaps, times] = await Promise.all([
    Promise.all(blocks.map((b) => accountById(markets, accountId, b).catch(() => null))),
    blockTimes(blocks),
  ]);
  return blocks
    .map((b, i) => ({ t: times[i], equity: snaps[i]?.equity ?? null, block: Number(b) }))
    .filter((p): p is { t: number; equity: number; block: number } => p.equity != null && Number.isFinite(p.t));
}

/** Exchange TVL (AUSD held by the exchange) sampled across the history window. */
export async function tvlCurve(samples = 60) {
  const head = await rpc.getBlockNumber();
  const step = HISTORY_BLOCKS / BigInt(samples);
  const blocks = Array.from({ length: samples + 1 }, (_, i) => head - HISTORY_BLOCKS + step * BigInt(i));
  const [infos, times] = await Promise.all([
    Promise.all(blocks.map((b) => exchangeInfo(b).catch(() => null))),
    blockTimes(blocks),
  ]);
  return blocks
    .map((_, i) => (infos[i] ? { t: times[i], tvl: infos[i]!.tvl, protocolBalance: infos[i]!.protocolBalance, accounts: infos[i]!.accounts } : null))
    .filter((x): x is NonNullable<typeof x> => !!x && Number.isFinite(x.t));
}

/** Timestamps (ms) for blocks. */
export async function blockTimes(blocks: bigint[]) {
  const bs = await Promise.all(blocks.map((b) => rpc.getBlock({ blockNumber: b }).catch(() => null)));
  return bs.map((b) => (b ? Number(b.timestamp) * 1000 : NaN));
}
