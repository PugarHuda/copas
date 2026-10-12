/**
 * Pure risk math for the analytics dashboard (no I/O, checked by riskmath.check.ts).
 * Book levels are human units (price, size in base asset), best level first.
 */
export type Level = { p: number; s: number };
export type Book = { bid: Level[]; ask: Level[] };

export const mid = (b: Book) => (b.bid[0] && b.ask[0] ? (b.bid[0].p + b.ask[0].p) / 2 : NaN);

/** USD resting on one side within `pct` % of mid. */
export function depth(levels: Level[], m: number, pct: number) {
  const lim = (m * pct) / 100;
  return levels.filter((l) => Math.abs(l.p - m) <= lim).reduce((a, l) => a + l.p * l.s, 0);
}

/**
 * Slippage in bps vs mid for a market order of `usd` notional eating `levels` (asks for a buy, bids for a sell).
 * null when the served book (100 levels) runs out first.
 */
export function slippageBps(levels: Level[], m: number, usd: number): number | null {
  let left = usd;
  let base = 0;
  for (const l of levels) {
    const take = Math.min(left, l.p * l.s);
    base += take / l.p;
    left -= take;
    if (left <= 1e-9) return (Math.abs(usd / base - m) / m) * 1e4;
  }
  return null;
}

/** [marketId, side 0 long / 1 short, liqPrice, notional] as protocolSnapshot().ladder emits it. */
export type LadderRow = readonly [number, number, number, number];

/**
 * Liquidation notional triggered by a `pct` % move against each side: longs liquidate on the way down,
 * shorts on the way up.
 */
export function liqWithin(ladder: readonly LadderRow[], marketId: number, mark: number, pct: number) {
  let longs = 0;
  let shorts = 0;
  for (const [id, side, liq, n] of ladder) {
    if (id !== marketId) continue;
    if (side === 0 && liq <= mark && liq >= mark * (1 - pct / 100)) longs += n;
    if (side === 1 && liq >= mark && liq <= mark * (1 + pct / 100)) shorts += n;
  }
  return { longs, shorts };
}

/* --------------------------------- cohorts --------------------------------- */

export type AccountRow = { volume: number; netPnl: number; fees: number; liquidations: number; wins: number; losses: number };
export const COHORTS = [
  { label: "< $10K", max: 1e4 },
  { label: "$10K–100K", max: 1e5 },
  { label: "$100K–1M", max: 1e6 },
  { label: "$1M–10M", max: 1e7 },
  { label: "$10M–100M", max: 1e8 },
  { label: "≥ $100M", max: Infinity },
] as const;

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = s.length >> 1;
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
};

/** Traders bucketed by lifetime volume: how each size class actually fared (realized PnL after fees). */
export function cohorts(rows: AccountRow[]) {
  const out = COHORTS.map((c) => ({ label: c.label, traders: 0, profitable: 0, netPnl: 0, fees: 0, liquidated: 0, pnls: [] as number[], rates: [] as number[] }));
  for (const r of rows) {
    const b = out[COHORTS.findIndex((c) => r.volume < c.max)];
    b.traders++;
    if (r.netPnl > 0) b.profitable++;
    b.netPnl += r.netPnl;
    b.fees += r.fees;
    if (r.liquidations > 0) b.liquidated++;
    if (r.wins + r.losses) b.rates.push((r.wins / (r.wins + r.losses)) * 100);
    b.pnls.push(r.netPnl);
  }
  return out
    .filter((b) => b.traders)
    .map(({ pnls, rates, ...b }) => ({ ...b, medianPnl: median(pnls), winRate: rates.length ? median(rates) : null })); // per-trader median: trade-weighted rates are all bots
}

/** Share of all positive PnL taken by the top `pct` % of traders by PnL. */
export function profitConcentration(rows: AccountRow[], pct: number) {
  const winners = rows.map((r) => r.netPnl).filter((x) => x > 0).sort((a, b) => b - a);
  const total = winners.reduce((a, x) => a + x, 0);
  const n = Math.max(1, Math.round((rows.length * pct) / 100));
  return total ? (winners.slice(0, n).reduce((a, x) => a + x, 0) / total) * 100 : 0;
}

/* --------------------------------- funding --------------------------------- */

/** Daily average funding as APR %: Perpl rates are 1e-5 per interval (FundingEventCompleted.actualRatePct100k). */
export const fundingApr = (sumRatePct100k: number, events: number, intervalSec: number) =>
  events ? (sumRatePct100k / events / 1e5) * ((365 * 86400) / intervalSec) * 100 : null;
