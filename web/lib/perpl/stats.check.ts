// Run: node --experimental-strip-types lib/perpl/stats.check.ts
import assert from "node:assert/strict";
import { computeTradeStats, type Trade } from "./stats.ts";

const t = (pnl: number, closedAt: number, market = "BTC", openedAt: number | null = closedAt - 1000): Trade => ({
  market, side: "long", openedAt, closedAt, entry: 1, maxNotional: 100, pnl, liquidated: false, tx: "",
});

const s = computeTradeStats([t(10, 1), t(-5, 2), t(-5, 3, "ETH"), t(20, 4), t(5, 5, "ETH", null)]);
assert.equal(s.trades, 5);
assert.equal(s.winRate, 60);
assert.equal(s.realized, 25);
assert.equal(s.profitFactor, 35 / 10);
assert.equal(s.maxDrawdown, 10); // peak 10 -> 0
assert.equal(s.longestLossStreak, 2);
assert.equal(s.longestWinStreak, 2);
assert.equal(s.avgHoldMs, 1000); // the null-open trade is excluded
assert.deepEqual(s.byMarket.map((m) => m.market), ["BTC", "ETH"]);
assert.equal(computeTradeStats([]).winRate, null);
console.log("stats ok");

// Copas breach/slash math (shown on /proof).
import { breachMath } from "../copas/math.ts";
const b = breachMath({ equity: 2190.42, units: 2700.89, peak: 1.186, maxDD: 20, slash: 900, capTotal: 2250, cap: 500, loss: 150 });
assert.ok(Math.abs(b.unit - 0.811) < 1e-3);
assert.ok(b.breach && b.dd > 31 && b.dd < 32);
assert.equal(b.claim, 150); // pro-rata 200, capped at loss
assert.equal(breachMath({ equity: 100, units: 100, peak: 1.05, maxDD: 10, slash: 900, capTotal: 2250, cap: 500, loss: 150 }).claim, 0);
console.log("breach math ok");

// percent display: small values never read as 0%, and never "−0.0%"
import { pct, pctAuto } from "../format.ts";
assert.equal(pctAuto(0.01), "0.01%");
assert.equal(pctAuto(15), "15%");
assert.equal(pctAuto(0), "0%");
assert.equal(pctAuto(0.0001), "<0.001%");
assert.equal(pct(-0.01, 1), "0.0%");
assert.equal(pct(-1.25, 1), "−1.3%");
console.log("percent format ok");
