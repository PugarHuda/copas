/**
 * Deterministic risk features of a leader (D1/D3). Computed in code; the LLM only explains them.
 */
import { type Activity, type ClosedTrade, type Fill, type LeaderStats, type OpenPosition, activityOf } from "./leaderData.js";
import { median, round, sum } from "./util.js";

export interface Reason {
  key: string;
  severity: number; // 0..1, higher = stronger reason not to follow
  metric: string;
  value: number;
  detail: string; // English, numbers only from data
}

export interface Features {
  /** Ground truth on whether the leader traded at all: fills, closed round trips and live open positions. */
  activity: {
    status: Activity;
    fills: number;
    closedTrades: number;
    openPositions: OpenPosition[] | null; // null = could not be read
    unrealizedPnl: number | null; // AUSD over open positions
    summary: string; // deterministic English sentence, used verbatim when the LLM contradicts it
  };
  style: {
    trades: number;
    tradesPerDay: number;
    winRate: number;
    profitFactor: number | null;
    avgHoldHours: number;
    avgLeverage: number | null;
    medianNotional: number;
    longShare: number;
    makerShare: number;
    topMarket: string | null;
    topMarketShare: number;
    label: "scalper" | "intraday" | "swing" | "position" | "new" | "inactive"; // new = activity but no closed trade yet
  };
  tilt: {
    detected: boolean;
    sizeAfterLossRatio: number | null; // median next-trade size after a loss / median size
    sizeAfterWinRatio: number | null;
    sizeUpsAfterLoss: number; // next trade >= 1.5x the losing trade's size
    quickReentriesAfterLoss: number; // next trade opened < 1h after a losing close
    lossesFollowed: number;
    frequencySpikeDays: { day: string; trades: number }[];
  };
  drift: {
    detected: boolean;
    recentDays: number;
    marketShift: number; // total variation distance between market mixes, 0..1
    newMarkets: string[];
    leverageRatio: number | null; // recent avg leverage / baseline
    sizeRatio: number | null; // recent median notional / baseline
    frequencyRatio: number | null; // recent trades/day / baseline
  };
  weekly: { from: number; to: number; trades: number; fills: number; netPnl: number; winRate: number; best: number; worst: number; volume: number };
  reasonsNotToFollow: Reason[]; // ranked candidates for the devil's advocate
}

const DAY = 86400;

export function computeFeatures(
  fills: Fill[],
  trades: ClosedTrade[],
  stats: LeaderStats,
  ctx: { now: number; capital?: number | null; backtest?: { breachedEpochs: number; epochs: number; maxDrawdownPct: number }; withdrawals30d?: number; openPositions?: OpenPosition[] | null } = { now: 0 },
): Features {
  const now = ctx.now || (fills.length ? fills[fills.length - 1].ts : 0);
  const byClose = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  const byOpen = [...trades].sort((a, b) => a.openedAt - b.openedAt);
  const sizes = trades.map((t) => t.maxNotional);
  const medSize = median(sizes);

  // ---- tilt: what happens right after a loss
  const afterLoss: number[] = [];
  const afterWin: number[] = [];
  let sizeUps = 0;
  let quick = 0;
  let lossesFollowed = 0;
  for (const t of byClose) {
    const next = byOpen.find((n) => n.openedAt >= t.closedAt && n !== t);
    if (!next) continue;
    (t.win ? afterWin : afterLoss).push(next.maxNotional);
    if (!t.win) {
      lossesFollowed++;
      if (next.maxNotional >= 1.5 * t.maxNotional) sizeUps++;
      if (next.openedAt - t.closedAt < 3600) quick++;
    }
  }
  const perDay = new Map<string, number>();
  for (const t of trades) {
    const d = new Date(t.openedAt * 1000).toISOString().slice(0, 10);
    perDay.set(d, (perDay.get(d) ?? 0) + 1);
  }
  const counts = [...perDay.values()];
  const mean = counts.length ? sum(counts) / counts.length : 0;
  const sd = counts.length ? Math.sqrt(sum(counts.map((c) => (c - mean) ** 2)) / counts.length) : 0;
  const spikes = [...perDay].filter(([, c]) => c >= 5 && c > mean + 2 * sd).map(([day, trades]) => ({ day, trades }));
  const sizeAfterLossRatio = afterLoss.length && medSize ? round(median(afterLoss) / medSize, 3) : null;
  const sizeAfterWinRatio = afterWin.length && medSize ? round(median(afterWin) / medSize, 3) : null;
  const tiltDetected =
    (lossesFollowed >= 3 && sizeUps / lossesFollowed >= 0.34) || (sizeAfterLossRatio ?? 0) >= 1.5 || (lossesFollowed >= 3 && quick / lossesFollowed >= 0.5) || spikes.length > 0;

  // ---- drift: last 7 days vs the rest of the window
  const recentFrom = now - 7 * DAY;
  const recent = trades.filter((t) => t.openedAt >= recentFrom);
  const base = trades.filter((t) => t.openedAt < recentFrom);
  const mix = (ts: ClosedTrade[]) => {
    const m = new Map<string, number>();
    for (const t of ts) m.set(t.symbol, (m.get(t.symbol) ?? 0) + 1 / ts.length);
    return m;
  };
  const mr = mix(recent);
  const mb = mix(base);
  const syms = new Set([...mr.keys(), ...mb.keys()]);
  const tvd = recent.length && base.length ? round(0.5 * sum([...syms].map((s) => Math.abs((mr.get(s) ?? 0) - (mb.get(s) ?? 0)))), 3) : 0;
  const avgLev = (ts: ClosedTrade[]) => {
    const l = ts.map((t) => t.leverage).filter((x): x is number => x != null);
    return l.length ? sum(l) / l.length : null;
  };
  const ratio = (a: number | null, b: number | null) => (a != null && b ? round(a / b, 3) : null);
  const baseDays = Math.max(1, (recentFrom - (base[0]?.openedAt ?? recentFrom)) / DAY);
  const leverageRatio = ratio(avgLev(recent), avgLev(base));
  const sizeRatio = recent.length && base.length ? ratio(median(recent.map((t) => t.maxNotional)), median(base.map((t) => t.maxNotional))) : null;
  const frequencyRatio = recent.length && base.length ? ratio(recent.length / 7, base.length / baseDays) : null;
  const newMarkets = base.length ? [...mr.keys()].filter((s) => !mb.has(s)) : [];
  const driftDetected = tvd > 0.3 || (leverageRatio ?? 1) >= 1.5 || (sizeRatio ?? 1) >= 2 || (frequencyRatio ?? 1) >= 3 || newMarkets.length > 0;

  // ---- weekly
  const wk = byClose.filter((t) => t.closedAt >= recentFrom);
  const wkFills = fills.filter((x) => x.ts >= recentFrom);
  const weekly = {
    from: recentFrom,
    to: now,
    trades: wk.length,
    fills: wkFills.length,
    netPnl: round(sum(wk.map((t) => t.netPnl)), 2),
    winRate: wk.length ? round(wk.filter((t) => t.win).length / wk.length, 3) : 0,
    best: wk.length ? round(Math.max(...wk.map((t) => t.netPnl)), 2) : 0,
    worst: wk.length ? round(Math.min(...wk.map((t) => t.netPnl)), 2) : 0,
    volume: round(sum(wkFills.map((x) => x.notional)), 2),
  };

  // ---- activity: "no closed trades yet" is not "no activity"
  const open = ctx.openPositions ?? null;
  const status = activityOf(fills.length, trades.length, open);
  const unrealizedPnl = open ? round(sum(open.map((p) => p.unrealizedPnl))) : null;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const posText = !open
    ? "open positions could not be read"
    : !open.length
    ? "no open positions"
    : `${plural(open.length, "open position")}: ` +
      open.map((p) => `${p.side} ${p.size} ${p.symbol} at entry ${p.entry} (mark ${p.mark}, unrealized PnL ${p.unrealizedPnl >= 0 ? "+" : ""}${p.unrealizedPnl} AUSD)`).join("; ");
  const summary =
    status === "trading"
      ? `${plural(trades.length, "closed trade")} from ${plural(fills.length, "fill")} in the window; ${posText}.`
      : status === "no_closed_trades_yet"
      ? `No closed trades yet: ${plural(fills.length, "fill")} in the window and ${posText}. Win rate, realized PnL and drawdown have no track record behind them yet.`
      : `No activity: no fills in the window and ${posText}.`;

  // ---- style
  const hold = stats.avgHoldSeconds / 3600;
  const top = stats.markets[0];
  const style: Features["style"] = {
    trades: stats.closedTrades,
    tradesPerDay: stats.tradesPerDay,
    winRate: round(stats.winRate, 3),
    profitFactor: stats.profitFactor,
    avgHoldHours: round(hold, 2),
    avgLeverage: stats.avgLeverage,
    medianNotional: stats.medianNotional,
    longShare: stats.longShare,
    makerShare: fills.length ? round(fills.filter((x) => x.role === "maker").length / fills.length, 3) : 0,
    topMarket: top?.symbol ?? null,
    topMarketShare: top?.share ?? 0,
    label: !trades.length ? (status === "no_activity" ? "inactive" : "new") : hold < 0.25 ? "scalper" : hold < 24 ? "intraday" : hold < 24 * 7 ? "swing" : "position",
  };

  // ---- reasons not to follow (deterministic candidates; LLM picks and phrases 3)
  const R: Reason[] = [];
  const cap = ctx.capital ?? null;
  if (cap && stats.maxDrawdown > 0) {
    const pct = (stats.maxDrawdown / cap) * 100;
    R.push({ key: "drawdown", severity: Math.min(1, pct / 30), metric: "maxDrawdownPctOfCapital", value: round(pct, 2), detail: `Realized max drawdown ${round(stats.maxDrawdown, 2)} AUSD = ${round(pct, 2)}% of ~${round(cap, 0)} AUSD capital in the window.` });
  }
  if (stats.closedTrades < 30)
    R.push({
      key: "small_sample",
      severity: stats.closedTrades < 10 ? 0.9 : 0.6,
      metric: "closedTrades",
      value: stats.closedTrades,
      detail: stats.closedTrades ? `Only ${stats.closedTrades} closed trades in the window: win rate and PnL are statistically weak.` : `${summary.split(":")[0]}: ${status === "no_activity" ? "nothing to copy and" : "there is"} no track record to judge.`,
    });
  if (top && top.share >= 0.7) R.push({ key: "concentration", severity: (top.share - 0.5) * 2, metric: "topMarketShare", value: top.share, detail: `${round(top.share * 100, 1)}% of trades are in ${top.symbol}; one market drives the result.` });
  if (stats.worstLosingStreak >= 3) R.push({ key: "losing_streak", severity: Math.min(1, stats.worstLosingStreak / 8), metric: "worstLosingStreak", value: stats.worstLosingStreak, detail: `Longest losing streak: ${stats.worstLosingStreak} trades in a row.` });
  if (tiltDetected) R.push({ key: "tilt", severity: 0.8, metric: "sizeUpsAfterLoss", value: sizeUps, detail: `After ${lossesFollowed} losses: ${sizeUps} size-ups (>=1.5x), ${quick} re-entries within 1h, ${spikes.length} frequency-spike days.` });
  if (driftDetected) R.push({ key: "style_drift", severity: 0.7, metric: "marketShift", value: tvd, detail: `Last 7 days differ from history: market shift ${tvd}, leverage x${leverageRatio ?? "n/a"}, size x${sizeRatio ?? "n/a"}, new markets ${newMarkets.join(",") || "none"}.` });
  const pos = trades.filter((t) => t.netPnl > 0).map((t) => t.netPnl).sort((a, b) => b - a);
  const net = sum(trades.map((t) => t.netPnl));
  if (net > 0 && pos.length >= 3) {
    const top3 = sum(pos.slice(0, 3)) / net;
    if (top3 >= 0.6) R.push({ key: "lucky_few", severity: Math.min(1, top3 - 0.3), metric: "top3ShareOfNetPnl", value: round(top3, 3), detail: `The 3 best trades make ${round(top3 * 100, 1)}% of net PnL; remove them and the record looks very different.` });
  }
  if (net <= 0 && trades.length) R.push({ key: "unprofitable", severity: 1, metric: "netPnl", value: round(net, 2), detail: `Net PnL after fees in the window is ${round(net, 2)} AUSD.` });
  const grossPnl = sum(fills.map((x) => x.pnl));
  if (grossPnl > 0 && stats.fees / grossPnl >= 0.3) R.push({ key: "fee_drag", severity: Math.min(1, stats.fees / grossPnl), metric: "feesShareOfGrossPnl", value: round(stats.fees / grossPnl, 3), detail: `Fees eat ${round((stats.fees / grossPnl) * 100, 1)}% of gross PnL; a follower paying taker fees keeps even less.` });
  if (style.makerShare >= 0.4) R.push({ key: "maker_edge", severity: style.makerShare, metric: "makerShare", value: style.makerShare, detail: `${round(style.makerShare * 100, 1)}% of fills are maker; followers copy with taker IOC orders and can't get that price/fee.` });
  if (stats.lastTradeAt && now - stats.lastTradeAt > 7 * DAY) R.push({ key: "inactive", severity: 0.6, metric: "daysSinceLastTrade", value: round((now - stats.lastTradeAt) / DAY, 1), detail: open?.length ? `No new trade for ${round((now - stats.lastTradeAt) / DAY, 1)} days; still holding ${plural(open.length, "open position")}.` : `No trade for ${round((now - stats.lastTradeAt) / DAY, 1)} days: nothing to copy.` });
  if (ctx.withdrawals30d && ctx.withdrawals30d > 0) R.push({ key: "withdrawals", severity: 0.5, metric: "withdrawals30d", value: round(ctx.withdrawals30d, 2), detail: `Withdrew ${round(ctx.withdrawals30d, 2)} AUSD in the last 30 days.` });
  if (ctx.backtest && ctx.backtest.breachedEpochs > 0) R.push({ key: "backtest_breach", severity: Math.min(1, 0.5 + ctx.backtest.breachedEpochs / ctx.backtest.epochs), metric: "breachedEpochs", value: ctx.backtest.breachedEpochs, detail: `Backtest: the mandate would have been breached in ${ctx.backtest.breachedEpochs} of ${ctx.backtest.epochs} epochs (follower max DD ${ctx.backtest.maxDrawdownPct}%).` });
  if (stats.avgLeverage != null && stats.avgLeverage >= 8) R.push({ key: "leverage", severity: Math.min(1, stats.avgLeverage / 20), metric: "avgLeverage", value: stats.avgLeverage, detail: `Average entry leverage ${stats.avgLeverage}x.` });
  R.sort((a, b) => b.severity - a.severity || a.key.localeCompare(b.key));
  for (const r of R) r.severity = round(r.severity, 3);

  return {
    activity: { status, fills: fills.length, closedTrades: trades.length, openPositions: open, unrealizedPnl, summary },
    style,
    tilt: { detected: tiltDetected, sizeAfterLossRatio, sizeAfterWinRatio, sizeUpsAfterLoss: sizeUps, quickReentriesAfterLoss: quick, lossesFollowed, frequencySpikeDays: spikes },
    drift: { detected: driftDetected, recentDays: 7, marketShift: tvd, newMarkets, leverageRatio, sizeRatio, frequencyRatio },
    weekly,
    reasonsNotToFollow: R,
  };
}
