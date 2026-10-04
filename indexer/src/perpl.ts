// Shared state helpers for the Perpl Exchange handlers.
// All money is AUSD in CNS units (6 decimals). See schema.graphql for the unit conventions.
import type {
  EvmOnEventContext,
  Account,
  AccountDaily,
  ClosedTrade,
  Market,
  MarketDaily,
  Position,
  Protocol,
  ProtocolDaily,
  TxCursor,
} from "envio";

export type Ctx = EvmOnEventContext;
type Mut<T> = { -readonly [K in keyof T]: T[K] };

export const CNS = 1_000_000n;
export const DAY = 86_400;
export const dayOf = (ts: number) => Math.floor(ts / DAY);
export const max = (a: bigint, b: bigint) => (a > b ? a : b);

// ponytail: decimals read from getPerpetualInfo on 2026-10-03 (mainnet). ContractAdded(V2)
// events overwrite/extend this when indexed from genesis; unknown perps log a warning.
const KNOWN_MARKETS: Record<number, [symbol: string, priceDecimals: number, lotDecimals: number]> = {
  1: ["BTC", 1, 5], 10: ["MON", 6, 0], 20: ["ETH", 2, 3], 30: ["SOL", 2, 3], 31: ["SOL_v2", 3, 3],
  40: ["HYPE", 4, 2], 50: ["ZEC", 2, 4], 60: ["LIT", 5, 1], 70: ["VVV", 4, 2], 80: ["TAO", 3, 3],
  90: ["PUMP", 6, 0], 100: ["NEAR", 4, 2], 110: ["UNI", 4, 2], 120: ["ARB", 5, 1], 130: ["AAVE", 3, 3],
  140: ["MORPHO", 4, 2], 150: ["ENA", 5, 1],
};

/** price (PNS) x lot (LNS) -> AUSD notional in CNS. */
export const notional = (m: Market, pricePNS: bigint, lotLNS: bigint) =>
  (pricePNS * lotLNS * CNS) / 10n ** BigInt(m.priceDecimals + m.lotDecimals);

// ---------------------------------------------------------------------------
// loaders (return mutable copies; callers `set` them when done)
// ---------------------------------------------------------------------------

export async function loadMarket(ctx: Ctx, perpId: bigint, ts: number): Promise<Mut<Market>> {
  const id = perpId.toString();
  const m = await ctx.Market.get(id);
  if (m) return { ...m };
  const k = KNOWN_MARKETS[Number(perpId)];
  if (!k && !ctx.isPreload) ctx.log.warn(`Perpl: unknown perpId ${id}, notional will be wrong until ContractAdded`);
  return {
    id, perpId: Number(perpId), symbol: k?.[0] ?? `PERP-${id}`, name: k?.[0] ?? "",
    priceDecimals: k?.[1] ?? 0, lotDecimals: k?.[2] ?? 0, lastPricePNS: 0n,
    longOpenInterestLNS: 0n, shortOpenInterestLNS: 0n, openInterestCNS: 0n,
    volumeCNS: 0n, feesCNS: 0n, trades: 0, liquidations: 0,
    lastFundingRatePct100k: undefined, cumulativeFundingSumPNS: undefined, lastUpdatedAt: ts,
  };
}

export async function loadAccount(ctx: Ctx, accountId: bigint, ts: number, block: number): Promise<Mut<Account>> {
  const id = accountId.toString();
  const a = await ctx.Account.get(id);
  if (a) return { ...a, lastSeenAt: ts };
  return {
    id, accountId, address: undefined, balanceCNS: 0n, depositsCNS: 0n, withdrawalsCNS: 0n,
    fills: 0, makerFills: 0, takerFills: 0, volumeCNS: 0n, makerVolumeCNS: 0n, takerVolumeCNS: 0n,
    feesCNS: 0n, realizedPnlCNS: 0n, fundingPnlCNS: 0n, netPnlCNS: 0n, peakNetPnlCNS: 0n, maxDrawdownCNS: 0n,
    closedTrades: 0, wins: 0, losses: 0, grossProfitCNS: 0n, grossLossCNS: 0n,
    currentStreak: 0, bestStreak: 0, worstStreak: 0, totalHoldSeconds: 0n, liquidations: 0, openPositions: 0,
    firstSeenAt: ts, lastSeenAt: ts, firstSeenBlock: block,
  };
}

export async function loadProtocol(ctx: Ctx, ts: number): Promise<Mut<Protocol>> {
  const p = await ctx.Protocol.get("perpl");
  if (p) return { ...p, lastUpdatedAt: ts };
  return {
    id: "perpl", accounts: 0, traders: 0, fills: 0, trades: 0, volumeCNS: 0n, feesCNS: 0n, builderFeesCNS: 0n,
    insFeesCNS: 0n, protFeesCNS: 0n, depositsCNS: 0n, withdrawalsCNS: 0n, netFlowCNS: 0n, liquidations: 0,
    liquidatedNotionalCNS: 0n, realizedPnlCNS: 0n, openInterestCNS: 0n, lastUpdatedAt: ts,
  };
}

export async function loadProtocolDaily(ctx: Ctx, ts: number): Promise<Mut<ProtocolDaily>> {
  const day = dayOf(ts);
  const d = await ctx.ProtocolDaily.get(String(day));
  if (d) return { ...d };
  return {
    id: String(day), day, date: day * DAY, volumeCNS: 0n, longVolumeCNS: 0n, shortVolumeCNS: 0n, feesCNS: 0n,
    builderFeesCNS: 0n, trades: 0, uniqueTraders: 0, newAccounts: 0, depositsCNS: 0n, withdrawalsCNS: 0n,
    netFlowCNS: 0n, liquidations: 0, liquidatedNotionalCNS: 0n, realizedPnlCNS: 0n, openInterestCNS: 0n,
  };
}

export async function loadMarketDaily(ctx: Ctx, m: Market, ts: number): Promise<Mut<MarketDaily>> {
  const day = dayOf(ts);
  const id = `${m.id}-${day}`;
  const d = await ctx.MarketDaily.get(id);
  if (d) return { ...d };
  return {
    id, market_id: m.id, day, date: day * DAY, volumeCNS: 0n, longVolumeCNS: 0n, shortVolumeCNS: 0n, feesCNS: 0n,
    trades: 0, uniqueTraders: 0, liquidations: 0, liquidatedNotionalCNS: 0n,
    openPricePNS: m.lastPricePNS, highPricePNS: m.lastPricePNS, lowPricePNS: m.lastPricePNS, closePricePNS: m.lastPricePNS,
    longOpenInterestLNS: m.longOpenInterestLNS, shortOpenInterestLNS: m.shortOpenInterestLNS,
    openInterestCNS: m.openInterestCNS, fundingEvents: 0, sumFundingRatePct100k: 0n,
  };
}

/** Returns [row, isNew]; isNew drives the unique-trader counters. */
export async function loadAccountDaily(ctx: Ctx, a: Account, ts: number): Promise<[Mut<AccountDaily>, boolean]> {
  const day = dayOf(ts);
  const id = `${a.id}-${day}`;
  const d = await ctx.AccountDaily.get(id);
  if (d) return [{ ...d }, false];
  return [{
    id, account_id: a.id, day, date: day * DAY, volumeCNS: 0n, fills: 0, feesCNS: 0n,
    realizedPnlCNS: 0n, netPnlCNS: 0n, cumNetPnlCNS: a.netPnlCNS,
  }, true];
}

export async function loadPosition(ctx: Ctx, a: Account, m: Market, ts: number, block: number, tx: string): Promise<Mut<Position>> {
  const id = `${a.id}-${m.id}`;
  const p = await ctx.Position.get(id);
  if (p) return { ...p };
  return {
    id, account_id: a.id, market_id: m.id, isOpen: false, side: undefined, lotLNS: 0n, maxLotLNS: 0n,
    entryPricePNS: 0n, depositCNS: 0n, leverageHdths: 0n, realizedPnlCNS: 0n, fundingCNS: 0n, feesCNS: 0n,
    openedAt: ts, openedBlock: block, openTx: tx, updatedAt: ts, tradeSeq: 0, lastClosedTrade_id: undefined,
  };
}

/** Single rolling row linking a fill to the position event emitted right before it. */
export async function loadCursor(ctx: Ctx, tx: string): Promise<Mut<TxCursor>> {
  const c = await ctx.TxCursor.get("last");
  if (c && c.txHash === tx) return { ...c };
  return {
    id: "last", txHash: tx, accountId: "", perpId: "", side: undefined, realizedPnlCNS: 0n,
    pendingClosedTrade: c?.pendingClosedTrade, tradeIds: [],
  };
}

// ---------------------------------------------------------------------------
// pure-ish updates
// ---------------------------------------------------------------------------

/** Move the realized equity curve: realized pnl (incl. funding) in, fees out. */
export function applyPnl(a: Mut<Account>, realized: bigint, fee: bigint) {
  a.realizedPnlCNS += realized;
  a.feesCNS += fee;
  a.netPnlCNS = a.realizedPnlCNS - a.feesCNS;
  a.peakNetPnlCNS = max(a.peakNetPnlCNS, a.netPnlCNS);
  a.maxDrawdownCNS = max(a.maxDrawdownCNS, a.peakNetPnlCNS - a.netPnlCNS);
}

/** Recompute market OI notional at the last price; returns the delta for the protocol total. */
export function refreshOI(m: Mut<Market>, fallbackPrice: bigint): bigint {
  const before = m.openInterestCNS;
  const px = m.lastPricePNS > 0n ? m.lastPricePNS : fallbackPrice;
  m.openInterestCNS = notional(m, px, (m.longOpenInterestLNS + m.shortOpenInterestLNS) / 2n);
  return m.openInterestCNS - before;
}

export function markPrice(m: Mut<Market>, md: Mut<MarketDaily>, px: bigint) {
  if (px <= 0n) return;
  m.lastPricePNS = px;
  if (md.openPricePNS === 0n) md.openPricePNS = px;
  md.highPricePNS = max(md.highPricePNS, px);
  md.lowPricePNS = md.lowPricePNS === 0n || px < md.lowPricePNS ? px : md.lowPricePNS;
  md.closePricePNS = px;
}

/** Book a closed trade's win/loss into the account. Called once the closing fill fee is known. */
export async function finalizeClosedTrade(ctx: Ctx, id: string, extraFee = 0n, exitPricePNS = 0n) {
  const ct = await ctx.ClosedTrade.get(id);
  if (!ct) return;
  const a = await ctx.Account.get(ct.account_id);
  if (!a) return;
  const feesCNS = ct.feesCNS + extraFee;
  const netPnlCNS = ct.pnlCNS - feesCNS;
  const isWin = netPnlCNS > 0n;
  const done: ClosedTrade = {
    ...ct, feesCNS, netPnlCNS, isWin,
    exitPricePNS: ct.exitPricePNS === 0n ? exitPricePNS : ct.exitPricePNS,
  };
  ctx.ClosedTrade.set(done);
  const streak = isWin ? Math.max(a.currentStreak, 0) + 1 : Math.min(a.currentStreak, 0) - 1;
  ctx.Account.set({
    ...a,
    closedTrades: a.closedTrades + 1,
    wins: a.wins + (isWin ? 1 : 0),
    losses: a.losses + (isWin ? 0 : 1),
    grossProfitCNS: a.grossProfitCNS + (isWin ? netPnlCNS : 0n),
    grossLossCNS: a.grossLossCNS + (isWin ? 0n : -netPnlCNS),
    currentStreak: streak,
    bestStreak: Math.max(a.bestStreak, streak),
    worstStreak: Math.min(a.worstStreak, streak),
    totalHoldSeconds: a.totalHoldSeconds + BigInt(done.holdSeconds),
  });
}
