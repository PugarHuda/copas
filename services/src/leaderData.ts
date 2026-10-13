/**
 * Leader data: a wallet's Perpl fill history, closed round trips, realized equity curve and stats.
 *
 * Sources (all public, no key):
 *  - Perpl official leaderboard  GET https://app.perpl.xyz/api/v1/trading/leaderboard/:period/:sorting
 *    (period day|week|2weeks|month|all, sorting pnl|roi|vol). Official 30d PnL / ROI / volume.
 *  - Per-wallet fills: Perpl's own /v1/trading/fills needs an API key signed by THAT wallet (401 otherwise),
 *    so for arbitrary leaders we read an indexer:
 *      * Envio HyperIndex (copas/indexer, `Fill` entity) when ENVIO_GRAPHQL_URL is set: testnet accounts
 *        (Copas LeaderBooks) always, mainnet when fresh and the history fits ENVIO_MAX_ROWS, else
 *      * plumb (third-party mainnet Perpl indexer, https://plumb.huginn.tech/api/v1/wallets/:addr/trades).
 *    See fetchFills.
 */
import { BaseError, ContractFunctionRevertedError, createPublicClient, http, parseAbi } from "viem";
import { type Fetch, env, getJson, median, round, rpcUrl, sum } from "./util.js";

export const PERPL_API = "https://app.perpl.xyz/api/v1";
export const PLUMB_API = "https://plumb.huginn.tech/api/v1";
/** Perpl mainnet market ids (SPEC §2.2). */
export const MARKETS: Record<number, string> = { 1: "BTC", 10: "MON", 20: "ETH", 31: "SOL", 40: "HYPE", 50: "ZEC", 60: "LIT", 70: "VVV", 90: "PUMP", 100: "NEAR" };
export const MAINNET = 143;
export const TESTNET = 10143;
/**
 * Perpl testnet markets (exchange 0x1964C32f0bE608E7D29302AFF5E61268E72080cc getPerpetualInfo). The indexer's
 * testnet start block is after ContractAdded, so its testnet Market rows say "PERP-16" with 0 decimals.
 * ponytail: static table; read getPerpetualInfo over RPC if Copas ever supports more testnet markets.
 */
export const TESTNET_MARKETS: Record<number, { symbol: string; priceDecimals: number; lotDecimals: number }> = {
  16: { symbol: "BTC", priceDecimals: 1, lotDecimals: 5 },
  32: { symbol: "ETH", priceDecimals: 2, lotDecimals: 3 },
  48: { symbol: "SOL", priceDecimals: 2, lotDecimals: 3 },
  64: { symbol: "MON", priceDecimals: 5, lotDecimals: 0 },
};

/** Perpl Exchange per chain (docs/SPEC.md §2.2). */
export const PERPL_EXCHANGE: Record<number, `0x${string}`> = { [MAINNET]: "0x34B6552d57a35a1D042CcAe1951BD1C370112a6F", [TESTNET]: "0x1964C32f0bE608E7D29302AFF5E61268E72080cc" };
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const PERPL_ABI = parseAbi([
  "struct PositionInfo { uint256 accountId; uint256 nextNodeId; uint256 prevNodeId; uint8 positionType; uint256 depositCNS; uint256 pricePNS; uint256 lotLNS; uint256 entryBlock; int256 pnlCNS; int256 deltaPnlCNS; int256 premiumPnlCNS; }",
  "function getPosition(uint256 perpId, uint256 accountId) view returns (PositionInfo positionInfo, uint256 markPricePNS, bool markPriceValid)",
  "struct PerpetualInfo { string name; string symbol; uint256 priceDecimals; uint256 lotDecimals; bytes32 linkFeedId; uint256 priceTolPer100K; uint256 marginTol; uint256 marginTolDecimals; uint256 refPriceMaxAgeSec; uint256 positionBalanceCNS; uint256 insuranceBalanceCNS; uint256 markPNS; uint256 markTimestamp; uint256 lastPNS; uint256 lastTimestamp; uint256 oraclePNS; uint256 oracleTimestampSec; uint256 longOpenInterestLNS; uint256 shortOpenInterestLNS; uint256 fundingStartBlock; int16 fundingRatePct100k; uint256 absFundingClampPctPer100K; uint8 status; uint256 basePricePNS; uint256 maxBidPriceONS; uint256 minBidPriceONS; uint256 maxAskPriceONS; uint256 minAskPriceONS; uint256 numOrders; bool ignOracle; }",
  "function getPerpetualInfo(uint256 perpId) view returns (PerpetualInfo perpetualInfo)",
  "struct PositionBitMap { uint256 bank1; uint256 bank2; uint256 bank3; uint256 bank4; }",
  "struct AccountInfo { uint256 accountId; uint256 balanceCNS; uint256 lockedBalanceCNS; uint8 frozen; address accountAddr; PositionBitMap positions; }",
  "function getAccountByAddr(address accountAddress) view returns (AccountInfo accountInfo)",
]);

/** A live Perpl position (exchange getPosition), not derived from fills. */
export interface OpenPosition {
  market: number; // perpId
  symbol: string;
  side: "long" | "short";
  size: number; // base units
  entry: number;
  mark: number;
  notional: number; // AUSD at mark
  margin: number; // AUSD deposited on the position
  unrealizedPnl: number; // AUSD, incl. funding
  leverage: number | null; // notional / (margin + unrealized)
}

/** Closed round trips are the track record; fills or open positions without one are "no closed trades yet", not "no activity". */
export type Activity = "trading" | "no_closed_trades_yet" | "no_activity";
export const activityOf = (fills: number, closed: number, open: OpenPosition[] | null): Activity =>
  closed > 0 ? "trading" : fills > 0 || (open?.length ?? 0) > 0 ? "no_closed_trades_yet" : "no_activity";

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

export interface EnvioAccount {
  id: string;
  chainId: number;
  fills: number; // all-time
  closedTrades: number;
  wins: number;
  netPnlCNS: string;
  maxDrawdownCNS: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface LeaderData {
  address: string;
  chainId: number;
  source: "envio" | "plumb";
  /** Stats window. If the fill history hit the row cap, `from` is the oldest fill fetched and `complete` is false. */
  window: { from: number; to: number };
  complete: boolean;
  /** All-time aggregates from the Envio indexer (exact, not capped), when the wallet is indexed. */
  envioAccount: EnvioAccount | null;
  official30d: LeaderboardRow | null;
  /** AUSD base Perpl uses for ROI: PnL / max(100, starting equity + inbound transfers) */
  capitalEstimate: number | null;
  fills: Fill[];
  closedTrades: ClosedTrade[];
  equityCurve: EquityPoint[];
  stats: LeaderStats;
  /** Live positions read from the Perpl exchange now; null = RPC unavailable (unknown, not "none"). */
  openPositions: OpenPosition[] | null;
  activity: Activity;
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

export interface FillPage {
  fills: Fill[];
  complete: boolean; // false when the row cap was hit before the window was exhausted
}
// ponytail: ~2s per plumb page; 10 pages keeps a request well under the function timeout.
export const PLUMB_MAX_ROWS = 5000;
/** Envio's hosted GraphQL returns at most 1000 rows per query; we page up to ENVIO_MAX_ROWS. */
export const ENVIO_PAGE = 1000;
export const ENVIO_MAX_ROWS = 10_000;

/** plumb pages newest first (500/page) and carries exact position sizes, so a capped history only loses old fills. */
export async function fetchPlumbFills(address: string, from: number, to: number, f: Fetch = fetch, maxRows = PLUMB_MAX_ROWS): Promise<FillPage> {
  const rows: any[] = [];
  let next: string | null = null;
  do {
    const q = new URLSearchParams({ limit: "500", from: String(from), to: String(to) });
    if (next) q.set("before", next);
    const page: any = await getJson(`${PLUMB_API}/wallets/${address}/trades?${q}`, {}, f);
    rows.push(...page.rows);
    next = page.next ?? null;
  } while (next && rows.length < maxRows);
  return { fills: sortFills(rows.map(normalizePlumbRow)), complete: !next };
}

const ENVIO_ACCOUNT = `query($addr: String!) { Account(where: { address: { _eq: $addr } }) {
  id chainId fills closedTrades wins netPnlCNS maxDrawdownCNS firstSeenAt lastSeenAt } }`;
// Entities are per chain (indexer config disable_default_cross_chain) and Account ids are per-chain Perpl
// accountIds: mainnet account 1101 and testnet account 1101 are different wallets, so filter on chainId too.
const ENVIO_FILLS = `query($acc: String!, $chain: Int!, $from: Int!, $to: Int!, $offset: Int!) {
  Fill(where: { account_id: { _eq: $acc }, chainId: { _eq: $chain }, timestamp: { _gte: $from, _lte: $to } }, order_by: [{ block: asc }, { id: asc }], limit: ${ENVIO_PAGE}, offset: $offset) {
    id timestamp block txHash role side pricePNS lotLNS feeCNS realizedPnlCNS
    market { perpId symbol priceDecimals lotDecimals }
  } }`;

// Envio's hosted endpoint answers 429 to bursts (one leader page fires stats, backtest, alignment and attest at once):
// identical queries in flight or under 30 s old share one request, and a 429 is retried with backoff.
// ponytail: per-instance memo; a shared cache (KV) if several instances still trip the limit.
const ENVIO_MEMO_MS = 30_000;
const envioMemo = new WeakMap<Fetch, Map<string, { at: number; p: Promise<unknown> }>>();
export async function envio<T>(url: string, query: string, variables: object, f: Fetch): Promise<T> {
  const body = JSON.stringify({ query, variables });
  let memo = envioMemo.get(f);
  if (!memo) envioMemo.set(f, (memo = new Map()));
  const key = `${url} ${body}`;
  const now = Date.now();
  const hit = memo.get(key);
  if (hit && now - hit.at < ENVIO_MEMO_MS) return hit.p as Promise<T>;
  for (const [k, v] of memo) if (now - v.at >= ENVIO_MEMO_MS) memo.delete(k);
  const entry = { at: now, p: envioPost<T>(url, body, f) };
  memo.set(key, entry);
  entry.p.catch(() => memo!.get(key) === entry && memo!.delete(key)); // errors are never memoized
  return entry.p;
}
async function envioPost<T>(url: string, body: string, f: Fetch): Promise<T> {
  for (let i = 0; ; i++) {
    const r = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    if (r.status === 429 && i < 5) {
      await new Promise((ok) => setTimeout(ok, Math.min(3000, Number(r.headers.get("retry-after")) * 1000 || 400 * 2 ** i) * (0.5 + Math.random()) /* jitter: instances retry apart */));
      continue;
    }
    if (!r.ok) throw new Error(`POST ${url} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { data?: T; errors?: { message: string }[] };
    if (j.errors?.length) throw new Error(`envio: ${j.errors[0].message}`);
    return j.data as T;
  }
}

/**
 * Envio `Fill` (copas/indexer/schema.graphql). The entity carries no position size, so positionAfter is the
 * running sum of fills inside the window (ponytail: assumes flat at window start; plumb gives exact sizes).
 * Notional is recomputed as price x size: the indexer's notionalCNS is wrong wherever its market decimals are.
 */
export async function fetchEnvioFills(url: string, account: Pick<EnvioAccount, "id" | "chainId">, from: number, to: number, f: Fetch = fetch, maxRows = ENVIO_MAX_ROWS): Promise<FillPage> {
  const rows: any[] = [];
  let complete = false;
  for (let offset = 0; offset < maxRows && !complete; offset += ENVIO_PAGE) {
    const d = await envio<{ Fill: any[] }>(url, ENVIO_FILLS, { acc: account.id, chain: account.chainId, from, to, offset }, f);
    rows.push(...d.Fill);
    complete = d.Fill.length < ENVIO_PAGE;
  }
  const pos = new Map<number, number>();
  const out: Fill[] = [];
  for (const r of rows) {
    if (!r.side || !r.market) continue;
    const m = account.chainId === TESTNET ? TESTNET_MARKETS[r.market.perpId] : { ...r.market, symbol: String(r.market.symbol).replace(/_v\d+$/, "") };
    if (!m) continue; // testnet market Copas doesn't map: no decimals, so no honest numbers
    const perpId = r.market.perpId;
    const size = Number(r.lotLNS) / 10 ** m.lotDecimals;
    const price = Number(r.pricePNS) / 10 ** m.priceDecimals;
    const buy = r.side === "BUY";
    const p = round((pos.get(perpId) ?? 0) + (buy ? size : -size), 10);
    pos.set(perpId, p);
    out.push({
      ts: r.timestamp,
      block: r.block,
      logIndex: Number(String(r.id).split("-")[1] ?? 0),
      tx: r.txHash,
      market: perpId,
      symbol: m.symbol,
      buy,
      price,
      size,
      notional: round(price * size, 6),
      fee: Number(r.feeCNS) / 1e6,
      pnl: Number(r.realizedPnlCNS) / 1e6,
      role: r.role === "MAKER" ? "maker" : "taker",
      kind: "fill",
      positionAfter: p,
      leverage: null,
    });
  }
  return { fills: out, complete };
}

/** The wallet's indexed Perpl account; mainnet wins if the address traded on both chains. */
export async function fetchEnvioAccount(url: string, address: string, f: Fetch = fetch): Promise<EnvioAccount | null> {
  const d = await envio<{ Account: EnvioAccount[] }>(url, ENVIO_ACCOUNT, { addr: address.toLowerCase() }, f);
  return d.Account.find((a) => a.chainId === MAINNET) ?? d.Account.find((a) => a.chainId === TESTNET) ?? null;
}

/** Mainnet all-time aggregates for many wallets in one query (discovery ranking). */
export async function fetchEnvioAccounts(url: string, addresses: string[], f: Fetch = fetch): Promise<Map<string, EnvioAccount>> {
  const q = `query($addrs: [String!]!) { Account(where: { address: { _in: $addrs }, chainId: { _eq: ${MAINNET} } }) {
    address id chainId fills closedTrades wins netPnlCNS maxDrawdownCNS firstSeenAt lastSeenAt } }`;
  const d = await envio<{ Account: (EnvioAccount & { address: string })[] }>(url, q, { addrs: addresses.map((a) => a.toLowerCase()) }, f);
  return new Map(d.Account.map(({ address, ...a }) => [address, a]));
}

/**
 * Live open positions: Perpl getPosition (+ getPerpetualInfo for decimals) for every known market in one multicall.
 * accountId: the Envio Account id on this chain if known, else getAccountByAddr (reverts = no Perpl account = []).
 * Returns null when the RPC fails, so callers can say "unknown" instead of "none".
 */
export async function fetchOpenPositions(address: string, chainId: number, accountId: string | null, f: Fetch = fetch): Promise<OpenPosition[] | null> {
  const client = createPublicClient({ transport: http(rpcUrl(chainId), { fetchFn: f, retryCount: 1, timeout: 8000 }) });
  const ex = { address: PERPL_EXCHANGE[chainId] ?? PERPL_EXCHANGE[MAINNET], abi: PERPL_ABI } as const;
  try {
    let id = accountId ? BigInt(accountId) : null;
    if (id == null) {
      const a = await client.readContract({ ...ex, functionName: "getAccountByAddr", args: [address as `0x${string}`] }).catch((e) => {
        if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError)) return null;
        throw e;
      });
      if (!a || a.accountId === 0n) return [];
      id = a.accountId;
    }
    const ids = Object.keys(chainId === TESTNET ? TESTNET_MARKETS : MARKETS).map(Number);
    const contracts = ids.flatMap((m) => [
      { ...ex, functionName: "getPosition", args: [BigInt(m), id] },
      { ...ex, functionName: "getPerpetualInfo", args: [BigInt(m)] },
    ]);
    const res = (await client.multicall({ multicallAddress: MULTICALL3, contracts: contracts as any })) as { status: string; result?: any }[];
    const out: OpenPosition[] = [];
    ids.forEach((m, i) => {
      const pos = res[2 * i];
      const info = res[2 * i + 1];
      if (pos.status !== "success") throw new Error(`getPosition(${m}) failed`);
      const [p, markPNS] = pos.result;
      if (p.lotLNS === 0n) return;
      const t = TESTNET_MARKETS[m];
      const pd = info.status === "success" ? Number(info.result.priceDecimals) : t?.priceDecimals;
      const ld = info.status === "success" ? Number(info.result.lotDecimals) : t?.lotDecimals;
      if (pd == null || ld == null) throw new Error(`no decimals for market ${m}`);
      const size = Number(p.lotLNS) / 10 ** ld;
      const mark = Number(markPNS) / 10 ** pd;
      const margin = Number(p.depositCNS) / 1e6;
      const unrealizedPnl = Number(p.pnlCNS) / 1e6;
      const notional = size * mark;
      out.push({
        market: m,
        symbol: chainId === TESTNET ? t.symbol : (MARKETS[m] ?? String(info.result?.symbol ?? m).replace(/_v\d+$/, "")),
        side: p.positionType === 0 ? "long" : "short",
        size: round(size, 10),
        entry: Number(p.pricePNS) / 10 ** pd,
        mark,
        notional: round(notional),
        margin: round(margin),
        unrealizedPnl: round(unrealizedPnl),
        leverage: margin + unrealizedPnl > 0 ? round(notional / (margin + unrealizedPnl), 2) : null,
      });
    });
    return out;
  } catch {
    return null;
  }
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
      t.pnl = round(t.pnl);
      t.fees = round(t.fees);
      t.maxNotional = round(t.maxNotional);
      t.netPnl = round(t.pnl - t.fees);
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
    winRate: trades.length ? round(wins.length / trades.length, 4) : 0,
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
  const d = await envio<{ Protocol: { lastUpdatedAt: number }[] }>(url, `{ Protocol(where: { chainId: { _eq: ${MAINNET} } }) { lastUpdatedAt } }`, {}, f).catch(() => null);
  return !!d && (d.Protocol[0]?.lastUpdatedAt ?? 0) >= to - 86400;
}

export interface FillsResult extends FillPage {
  source: "envio" | "plumb";
  chainId: number;
  envioAccount: EnvioAccount | null;
}

/**
 * One fill source per wallet, shared by /stats, /analysis, /alignment and /attest:
 *  - testnet Perpl accounts (Copas LeaderBooks): Envio (plumb indexes mainnet only);
 *  - mainnet: Envio when fresh and the wallet's whole history fits ENVIO_MAX_ROWS, else plumb
 *    (exact position sizes, newest first, so a capped history only drops the oldest fills).
 */
export async function fetchFills(address: string, from: number, to: number, f: Fetch = fetch): Promise<FillsResult> {
  const url = env("ENVIO_GRAPHQL_URL");
  let envioErr: Error | undefined;
  const acc = url ? await fetchEnvioAccount(url, address, f).catch((e: Error) => ((envioErr = e), null)) : null;
  if (url && acc?.chainId === TESTNET) return { ...(await fetchEnvioFills(url, acc, from, to, f)), source: "envio", chainId: TESTNET, envioAccount: acc };
  if (url && (!acc || acc.fills <= ENVIO_MAX_ROWS) && (await envioFresh(url, to, f))) {
    const page = acc ? await fetchEnvioFills(url, acc, from, to, f) : { fills: [], complete: true };
    return { ...page, source: "envio", chainId: MAINNET, envioAccount: acc };
  }
  // plumb indexes mainnet only: an unknown wallet has no mainnet history, unless the Envio lookup failed and it may be
  // a testnet LeaderBook (then surface Envio's error rather than an empty track record that would be cached for a day)
  const page = await fetchPlumbFills(address, from, to, f).catch((e: Error) => {
    if (!/ACCOUNT_NOT_FOUND/.test(e.message)) throw e;
    if (envioErr) throw envioErr;
    return { fills: [], complete: true };
  });
  return { ...page, source: "plumb", chainId: MAINNET, envioAccount: acc };
}

export async function getLeaderData(address: string, opts: LeaderDataOpts = {}): Promise<LeaderData> {
  const f = opts.fetch ?? fetch;
  let to = opts.now ?? Math.floor(Date.now() / 1000);
  let from = to - (opts.days ?? 30) * 86400;
  const addr = address.toLowerCase();
  const [src, board] = await Promise.all([fetchFills(addr, from, to, f), fetchLeaderboard("month", "pnl", f).catch(() => [] as LeaderboardRow[])]);
  const inWindow = src.fills.filter((x) => x.ts >= from && x.ts <= to);
  // capped history: stats describe only the span actually fetched (plumb keeps the newest, Envio the oldest)
  if (!src.complete && inWindow.length) src.source === "plumb" ? (from = inWindow[0].ts) : (to = inWindow[inWindow.length - 1].ts);
  const trades = closedTrades(inWindow);
  // the Perpl leaderboard is mainnet only
  const row = src.chainId === MAINNET ? (board.find((r) => r.address === addr) ?? null) : null;
  const acc = src.envioAccount?.chainId === src.chainId ? src.envioAccount.id : null;
  const openPositions = await fetchOpenPositions(addr, src.chainId, acc, f);
  return {
    address: addr,
    chainId: src.chainId,
    source: src.source,
    window: { from, to },
    complete: src.complete,
    envioAccount: src.envioAccount,
    official30d: row,
    capitalEstimate: capitalFromRow(row),
    fills: inWindow,
    closedTrades: trades,
    equityCurve: equityCurve(inWindow),
    stats: computeStats(inWindow, trades, { from, to }),
    openPositions,
    activity: activityOf(inWindow.length, trades.length, openPositions),
  };
}
