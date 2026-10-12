/** Hyperliquid track-record math (public info API, no keys). Pure: imported by the API route and lib/hyperliquid.check.ts. */

export type HlSeries = { accountValueHistory: [number, string][]; pnlHistory: [number, string][]; vlm: string };

/**
 * Max drawdown (%) of the flow-neutral return index: each step's return is ΔPnL / previous account value, compounded.
 * Account value alone would count deposits and withdrawals as gains and losses; this mirrors a LeaderBook unit price.
 */
export function maxDrawdownPct(s: Pick<HlSeries, "accountValueHistory" | "pnlHistory">): number {
  const av = s.accountValueHistory.map(([, v]) => Number(v));
  const pnl = s.pnlHistory.map(([, v]) => Number(v));
  let idx = 1, peak = 1, dd = 0;
  for (let i = 1; i < Math.min(av.length, pnl.length); i++) {
    const base = av[i - 1];
    if (!(base > 0)) continue; // empty account: no defined return for this step
    idx *= 1 + Math.max(-1, (pnl[i] - pnl[i - 1]) / base);
    peak = Math.max(peak, idx);
    dd = Math.max(dd, 1 - idx / peak);
  }
  return dd * 100;
}

/** Return (%) of the same index over the series. */
export function returnPct(s: Pick<HlSeries, "accountValueHistory" | "pnlHistory">): number {
  const av = s.accountValueHistory.map(([, v]) => Number(v));
  const pnl = s.pnlHistory.map(([, v]) => Number(v));
  let idx = 1;
  for (let i = 1; i < Math.min(av.length, pnl.length); i++) if (av[i - 1] > 0) idx *= 1 + Math.max(-1, (pnl[i] - pnl[i - 1]) / av[i - 1]);
  return (idx - 1) * 100;
}

/** Copas tier whose max-DD mandate leaves 25% headroom over the observed 30-day drawdown; null when none does. */
export function suggestTier(monthDdPct: number): { tier: "konservatif" | "moderat" | "agresif"; maxDD: number } | null {
  for (const [tier, maxDD] of [["konservatif", 5], ["moderat", 15], ["agresif", 30]] as const) if (monthDdPct * 1.25 <= maxDD) return { tier, maxDD };
  return null;
}
