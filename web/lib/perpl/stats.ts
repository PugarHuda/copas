/** Pure trade analytics. Same math for RPC-scanned and Envio-indexed trades. */

export type Trade = {
  market: string;
  side: "long" | "short";
  openedAt: number | null; // ms, null when opened before the scanned window
  closedAt: number | null;
  entry: number | null;
  exit?: number | null;
  maxNotional: number;
  pnl: number; // realized, incl. funding, before trading fees
  liquidated: boolean;
  tx: string;
};

export type TradeStats = {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null; // %
  realized: number;
  grossWin: number;
  grossLoss: number;
  profitFactor: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  maxDrawdown: number; // on cumulative realized PnL, AUSD
  longestWinStreak: number;
  longestLossStreak: number;
  avgHoldMs: number | null;
  liquidations: number;
  byMarket: { market: string; pnl: number; trades: number }[];
  longPnl: number;
  shortPnl: number;
  curve: { t: number; cum: number }[];
};

export function computeTradeStats(input: Trade[]): TradeStats {
  const trades = [...input].filter((t) => t.closedAt != null).sort((a, b) => a.closedAt! - b.closedAt!);
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  let ws = 0;
  let ls = 0;
  let bestW = 0;
  let bestL = 0;
  const curve: { t: number; cum: number }[] = [];
  for (const t of trades) {
    cum += t.pnl;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
    curve.push({ t: t.closedAt!, cum });
    if (t.pnl > 0) {
      ws++;
      ls = 0;
    } else if (t.pnl < 0) {
      ls++;
      ws = 0;
    }
    bestW = Math.max(bestW, ws);
    bestL = Math.max(bestL, ls);
  }
  const held = trades.filter((t) => t.openedAt != null).map((t) => t.closedAt! - t.openedAt!);
  const mk = new Map<string, { market: string; pnl: number; trades: number }>();
  trades.forEach((t) => {
    const v = mk.get(t.market) ?? { market: t.market, pnl: 0, trades: 0 };
    v.pnl += t.pnl;
    v.trades++;
    mk.set(t.market, v);
  });
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : null,
    realized: cum,
    grossWin,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
    maxDrawdown: maxDd,
    longestWinStreak: bestW,
    longestLossStreak: bestL,
    avgHoldMs: held.length ? held.reduce((a, b) => a + b, 0) / held.length : null,
    liquidations: trades.filter((t) => t.liquidated).length,
    byMarket: [...mk.values()].sort((a, b) => b.pnl - a.pnl),
    longPnl: trades.filter((t) => t.side === "long").reduce((a, t) => a + t.pnl, 0),
    shortPnl: trades.filter((t) => t.side === "short").reduce((a, t) => a + t.pnl, 0),
    curve,
  };
}
