/**
 * Leader data: a wallet's Perpl fill history, closed round trips, realized equity curve and stats.
 *
 * Sources (all public, no key):
 *  - Perpl official leaderboard  GET https://app.perpl.xyz/api/v1/trading/leaderboard/:period/:sorting
 *    (period day|week|2weeks|month|all, sorting pnl|roi|vol). Official 30d PnL / ROI / volume.
 *  - Per-wallet fills: Perpl's own /v1/trading/fills needs an API key signed by THAT wallet (401 otherwise),
 *    so for arbitrary leaders we read an indexer:
 *      * Envio HyperIndex (copas/indexer, `Fill` entity) when ENVIO_GRAPHQL_URL is set, else
 *      * plumb (third-party Perpl indexer, https://plumb.huginn.tech/api/v1/wallets/:addr/trades).
 */
import { type Fetch, env, getJson, median, round, sum } from "./util.js";

export const PERPL_API = "https://app.perpl.xyz/api/v1";
export const PLUMB_API = "https://plumb.huginn.tech/api/v1";
/** Perpl mainnet market ids (SPEC §2.2). */
export const MARKETS: Record<number, string> = { 1: "BTC", 10: "MON", 20: "ETH", 31: "SOL", 40: "HYPE", 50: "ZEC", 60: "LIT", 70: "VVV", 90: "PUMP", 100: "NEAR" };

export interface Fill {
  ts: number; // unix seconds
  block: number;
  logIndex: number;
  tx: string;
  market: number; // perpId
  symbol: string;
  buy: boolean;
  price: number;
  size: number; // base units, always > 0
  notional: number; // AUSD
  fee: number; // AUSD, gross
  pnl: number; // realized by this fill (price pnl + funding), before fee
  role: "maker" | "taker";
  kind: string; // open | increase | decrease | close | invert | liquidation (plumb); "fill" (envio)
  positionAfter: number; // signed size after this fill (+ long, - short)
  leverage: number | null; // leverage chosen on entry, when known
}

export interface ClosedTrade {
  market: number;
  symbol: string;
  side: "long" | "short";
  openedAt: number;
  closedAt: number;
  holdSeconds: number;
  maxNotional: number;
  leverage: number | null;
  pnl: number;
  fees: number;
  netPnl: number;
  win: boolean;
  fills: number;
  liquidated: boolean;
}

export interface EquityPoint {
  ts: number;
  cumNetPnl: number; // realized pnl - fees since window start
}

export interface LeaderboardRow {
  rank: number;
  address: string;
  pnl: number; // AUSD
  roi: number; // fraction (0.21 = 21%)
  volume: number;
}

export interface LeaderStats {
  fills: number;
  closedTrades: number;
  wins: number;
  winRate: number; // 0..1
  profitFactor: number | null;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  fees: number;
  volume: number;
  maxDrawdown: number; // AUSD, on the realized curve
  avgHoldSeconds: number;
  medianNotional: number;
  avgLeverage: number | null;
  tradesPerDay: number;
  longShare: number; // share of closed trades that were long
  markets: { symbol: string; trades: number; netPnl: number; share: number }[];
  worstLosingStreak: number;
  lastTradeAt: number | null;
}

export interface LeaderData {
  address: string;
  source: "envio" | "plumb";
  window: { from: number; to: number };
  official30d: LeaderboardRow | null;
  /** AUSD base Perpl uses for ROI: PnL / max(100, starting equity + inbound transfers) */
  capitalEstimate: number | null;
  fills: Fill[];
  closedTrades: ClosedTrade[];
  equityCurve: EquityPoint[];
  stats: LeaderStats;
}

// ------------------------------------------------------------------ sources

export async function fetchLeaderboard(period = "month", sorting = "pnl", f: Fetch = fetch): Promise<LeaderboardRow[]> {
  const j = await getJson<{ d: { i: number; a: string; p: string; r: number; v: string }[] }>(
    `${PERPL_API}/trading/leaderboard/${period}/${sorting}`,
    {},
    f,
  );
  return j.d.map((r) => ({ rank: r.i, address: r.a.toLowerCase(), pnl: Number(r.p) / 1e6, roi: r.r / 10_000, volume: Number(r.v) / 1e6 }));
}

/** plumb rows are newest first; `remaining` is the size left on `side` after the fill (side is the new side on an invert). */
export function normalizePlumbRow(r: any): Fill {
  const remaining = Number(r.remaining ?? 0);
  return {
    ts: r.ts,
    block: Number(r.block),
    logIndex: r.log_index,
    tx: r.tx,
    market: r.market,
    symbol: String(r.symbol).replace(/_v\d+$/, ""),
    buy: !!r.buy,
    price: Number(r.price),
    size: Number(r.size),
    notional: Number(r.notional),
    fee: Number(r.fee),
    pnl: Number(r.pnl),
    role: r.role === "maker" ? "maker" : "taker",
    kind: r.kind,
    positionAfter: remaining === 0 ? 0 : r.side === "short" ? -remaining : remaining,
    leverage: r.leverage ?? null,
  };
}

export async function fetchPlumbFills(address: string, from: number, to: number, f: Fetch = fetch, maxRows = 5000): Promise<Fill[]> {
  const rows: any[] = [];
  let next: string | null = null;
  do {
    const q = new URLSearchParams({ limit: "500", from: String(from), to: String(to) });
    if (next) q.set("before", next);
    const page: any = await getJson(`${PLUMB_API}/wallets/${address}/trades?${q}`, {}, f);
    rows.push(...page.rows);
    next = page.next ?? null;
  } while (next && rows.length < maxRows);
  return sortFills(rows.map(normalizePlumbRow));
}

const ENVIO_ACCOUNT = `query($addr: String!) { Account(where: { address: { _eq: $addr } }) { id } }`;
const ENVIO_FILLS = `query($acc: String!, $from: Int!, $to: Int!) {
  Fill(where: { account_id: { _eq: $acc }, timestamp: { _gte: $from, _lte: $to } }, order_by: [{ block: asc }, { id: asc }], limit: 5000) {
    id timestamp block txHash role side pricePNS lotLNS notionalCNS feeCNS realizedPnlCNS
    market { perpId symbol priceDecimals lotDecimals }
  } }`;

async function envio<T>(url: string, query: string, variables: object, f: Fetch): Promise<T> {
  const j = await getJson<{ data?: T; errors?: { message: string }[] }>(
    url,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) },
    f,
  );
  if (j.errors?.length) throw new Error(`envio: ${j.errors[0].message}`);
  return j.data as T;
}

/**
 * Envio `Fill` (copas/indexer/schema.graphql). The entity carries no position size, so positionAfter is the
 * running sum of fills inside the window (ponytail: assumes flat at window start; plumb gives exact sizes).
 */
export async function fetchEnvioFills(url: string, address: string, from: number, to: number, f: Fetch = fetch): Promise<Fill[]> {
  const acc = await envio<{ Account: { id: string }[] }>(url, ENVIO_ACCOUNT, { addr: address.toLowerCase() }, f);
  if (!acc.Account.length) return [];
  const d = await envio<{ Fill: any[] }>(url, ENVIO_FILLS, { acc: acc.Account[0].id, from, to }, f);
  const pos = new Map<number, number>();
  const out: Fill[] = [];
  for (const r of d.Fill) {
    if (!r.side || !r.market) continue;
    const m = r.market;
    const size = Number(r.lotLNS) / 10 ** m.lotDecimals;
    const buy = r.side === "BUY";
    const p = round((pos.get(m.perpId) ?? 0) + (buy ? size : -size), 10);
    pos.set(m.perpId, p);
    out.push({
      ts: r.timestamp,
      block: r.block,
      logIndex: Number(String(r.id).split("-")[1] ?? 0),
      tx: r.txHash,
      market: m.perpId,
      symbol: m.symbol,
      buy,
      price: Number(r.pricePNS) / 10 ** m.priceDecimals,
      size,
      notional: Number(r.notionalCNS) / 1e6,
      fee: Number(r.feeCNS) / 1e6,
      pnl: Number(r.realizedPnlCNS) / 1e6,
      role: r.role === "MAKER" ? "maker" : "taker",
      kind: "fill",
      positionAfter: p,
      leverage: null,
    });
  }
  return out;
}

const sortFills = (xs: Fill[]) => xs.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);

// ------------------------------------------------------------------ derived

/** Round trips per market: flat -> ... -> flat (or an invert, which closes one trip and opens another). */
export function closedTrades(fills: Fill[]): ClosedTrade[] {
  const open = new Map<number, ClosedTrade>();
  const done: ClosedTrade[] = [];
  for (const x of fills) {
    const before = round(x.positionAfter - (x.buy ? x.size : -x.size), 10);
    let t = open.get(x.market);
    if (!t) {
      // first sight of this market (or flat before): start a trip on the side we now hold / held
      const side = (before !== 0 ? before : x.positionAfter) > 0 ? "long" : "short";
      t = { market: x.market, symbol: x.symbol, side, openedAt: x.ts, closedAt: 0, holdSeconds: 0, maxNotional: 0, leverage: x.leverage, pnl: 0, fees: 0, netPnl: 0, win: false, fills: 0, liquidated: false };
      open.set(x.market, t);
    }
    t.fills++;
    t.pnl += x.pnl;
    t.fees += x.fee;
    t.leverage ??= x.leverage;
    t.maxNotional = Math.max(t.maxNotional, Math.abs(before) * x.price, Math.abs(x.positionAfter) * x.price);
    if (x.kind === "liquidation") t.liquidated = true;
    const flipped = before !== 0 && x.positionAfter !== 0 && Math.sign(before) !== Math.sign(x.positionAfter);
    if (x.positionAfter === 0 || flipped) {
      t.closedAt = x.ts;
      t.holdSeconds = x.ts - t.openedAt;
      t.netPnl = t.pnl - t.fees;
      t.win = t.netPnl > 0;
      done.push(t);
      open.delete(x.market);
      if (flipped) {
        open.set(x.market, { ...t, side: x.positionAfter > 0 ? "long" : "short", openedAt: x.ts, closedAt: 0, holdSeconds: 0, maxNotional: Math.abs(x.positionAfter) * x.price, leverage: x.leverage, pnl: 0, fees: 0, netPnl: 0, win: false, fills: 0, liquidated: false });
      }
    }
  }
  return done;
}

export function equityCurve(fills: Fill[]): EquityPoint[] {
  let c = 0;
  return fills.map((x) => ({ ts: x.ts, cumNetPnl: round((c += x.pnl - x.fee)) }));
}

export function maxDrawdown(values: number[], start = 0): number {
  let peak = start;
  let dd = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    dd = Math.max(dd, peak - v);
  }
  return dd;
}

export function computeStats(fills: Fill[], trades: ClosedTrade[], window: { from: number; to: number }): LeaderStats {
  const wins = trades.filter((t) => t.win);
  const grossProfit = sum(wins.map((t) => t.netPnl));
  const grossLoss = -sum(trades.filter((t) => !t.win).map((t) => t.netPnl));
  const lev = trades.map((t) => t.leverage).filter((l): l is number => l != null);
  const bySym = new Map<string, { trades: number; netPnl: number }>();
  for (const t of trades) {
    const s = bySym.get(t.symbol) ?? { trades: 0, netPnl: 0 };
    s.trades++;
    s.netPnl += t.netPnl;
    bySym.set(t.symbol, s);
  }
  let streak = 0;
  let worst = 0;
  for (const t of [...trades].sort((a, b) => a.closedAt - b.closedAt)) {
    streak = t.win ? 0 : streak + 1;
    worst = Math.max(worst, streak);
  }
  const days = Math.max(1, (window.to - window.from) / 86400);
  return {
    fills: fills.length,
    closedTrades: trades.length,
    wins: wins.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : null,
    netPnl: round(sum(fills.map((x) => x.pnl - x.fee))),
    grossProfit: round(grossProfit),
    grossLoss: round(grossLoss),
    fees: round(sum(fills.map((x) => x.fee))),
    volume: round(sum(fills.map((x) => x.notional))),
    maxDrawdown: round(maxDrawdown(equityCurve(fills).map((p) => p.cumNetPnl))),
    avgHoldSeconds: trades.length ? Math.round(sum(trades.map((t) => t.holdSeconds)) / trades.length) : 0,
    medianNotional: round(median(trades.map((t) => t.maxNotional)), 2),
    avgLeverage: lev.length ? round(sum(lev) / lev.length, 2) : null,
    tradesPerDay: round(trades.length / days, 3),
    longShare: trades.length ? round(trades.filter((t) => t.side === "long").length / trades.length, 4) : 0,
    markets: [...bySym].map(([symbol, s]) => ({ symbol, trades: s.trades, netPnl: round(s.netPnl), share: round(s.trades / trades.length, 4) })).sort((a, b) => b.trades - a.trades),
    worstLosingStreak: worst,
    lastTradeAt: fills.length ? fills[fills.length - 1].ts : null,
  };
}

/** Perpl's ROI denominator, recovered from the official leaderboard row (pnl / roi). */
export const capitalFromRow = (r: LeaderboardRow | null) => (r && r.roi > 0 && r.pnl > 0 ? round(r.pnl / r.roi, 2) : null);

export interface LeaderDataOpts {
  days?: number; // window length, default 30
  now?: number; // unix seconds, default Date.now()
  fetch?: Fetch;
}

/** A backfilling indexer has no recent fills; use it only once its last mainnet event is within a day of `to`. */
async function envioFresh(url: string, to: number, f: Fetch): Promise<boolean> {
  const d = await envio<{ Protocol: { lastUpdatedAt: number }[] }>(url, `{ Protocol(where: { chainId: { _eq: 143 } }) { lastUpdatedAt } }`, {}, f).catch(() => null);
  return !!d && (d.Protocol[0]?.lastUpdatedAt ?? 0) >= to - 86400;
}

export async function getLeaderData(address: string, opts: LeaderDataOpts = {}): Promise<LeaderData> {
  const f = opts.fetch ?? fetch;
  const to = opts.now ?? Math.floor(Date.now() / 1000);
  const from = to - (opts.days ?? 30) * 86400;
  const addr = address.toLowerCase();
  const configured = env("ENVIO_GRAPHQL_URL");
  const envioUrl = configured && (await envioFresh(configured, to, f)) ? configured : undefined;
  const [fills, board] = await Promise.all([
    envioUrl ? fetchEnvioFills(envioUrl, addr, from, to, f) : fetchPlumbFills(addr, from, to, f),
    fetchLeaderboard("month", "pnl", f).catch(() => [] as LeaderboardRow[]),
  ]);
  const inWindow = fills.filter((x) => x.ts >= from && x.ts <= to);
  const trades = closedTrades(inWindow);
  const row = board.find((r) => r.address === addr) ?? null;
  return {
    address: addr,
    source: envioUrl ? "envio" : "plumb",
    window: { from, to },
    official30d: row,
    capitalEstimate: capitalFromRow(row),
    fills: inWindow,
    closedTrades: trades,
    equityCurve: equityCurve(inWindow),
    stats: computeStats(inWindow, trades, { from, to }),
  };
}
