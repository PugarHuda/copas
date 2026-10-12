// Run: node --experimental-strip-types lib/hyperliquid.check.ts
import assert from "node:assert";
import { maxDrawdownPct, returnPct, suggestTier } from "./hyperliquid.ts";
const s = (av: number[], pnl: number[]) => ({ accountValueHistory: av.map((v, i) => [i, String(v)] as [number, string]), pnlHistory: pnl.map((v, i) => [i, String(v)] as [number, string]) });
// 100 -> 110 (+10%) -> 99 (−10%): dd 10%, return −1%
assert.ok(Math.abs(maxDrawdownPct(s([100, 110, 99], [0, 10, -1])) - 10) < 1e-9);
assert.ok(Math.abs(returnPct(s([100, 110, 99], [0, 10, -1])) + 1) < 1e-9);
// a 900 deposit with zero PnL is not a gain, a withdrawal is not a loss
assert.equal(maxDrawdownPct(s([100, 1000, 100], [0, 0, 0])), 0);
assert.equal(maxDrawdownPct(s([0, 0], [0, 0])), 0);
assert.deepEqual(suggestTier(3), { tier: "konservatif", maxDD: 5 });
assert.deepEqual(suggestTier(10), { tier: "moderat", maxDD: 15 });
assert.deepEqual(suggestTier(24), { tier: "agresif", maxDD: 30 });
assert.equal(suggestTier(25), null);
console.log("hyperliquid math ok");
