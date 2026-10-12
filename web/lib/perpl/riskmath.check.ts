// Run: node --experimental-strip-types lib/perpl/riskmath.check.ts
import assert from "node:assert/strict";
import { cohorts, depth, fundingApr, liqWithin, mid, profitConcentration, slippageBps, type AccountRow } from "./riskmath.ts";

const book = { bid: [{ p: 99, s: 1 }, { p: 98, s: 2 }, { p: 90, s: 10 }], ask: [{ p: 101, s: 1 }, { p: 102, s: 2 }] };
const m = mid(book);
assert.equal(m, 100);
assert.equal(depth(book.bid, m, 2), 99 + 196); // 90 is 10% away
assert.equal(slippageBps(book.ask, m, 101), 100); // fills fully at 101 = 100 bps
const s = slippageBps(book.ask, m, 101 + 102)!; // 1 @101 + 1 @102 -> avg 101.5
assert.ok(Math.abs(s - 150) < 1e-9);
assert.equal(slippageBps(book.ask, m, 1e6), null); // book exhausted

const lad = [[1, 0, 97, 500], [1, 0, 80, 900], [1, 1, 104, 300], [2, 0, 99, 1]] as const;
assert.deepEqual(liqWithin(lad, 1, 100, 5), { longs: 500, shorts: 300 });

const a = (volume: number, netPnl: number, liquidations = 0): AccountRow => ({ volume, netPnl, fees: 1, liquidations, wins: netPnl > 0 ? 1 : 0, losses: netPnl > 0 ? 0 : 1 });
const c = cohorts([a(5e3, -10, 1), a(5e3, 20), a(5e3, -30), a(2e6, 500)]);
assert.equal(c.length, 2);
assert.equal(c[0].traders, 3);
assert.equal(c[0].profitable, 1);
assert.equal(c[0].medianPnl, -10);
assert.equal(c[0].liquidated, 1);
assert.equal(c[0].winRate, 0); // per-trader rates 0, 100, 0 -> median 0
assert.equal(c[1].label, "$1M–10M");
assert.equal(profitConcentration([a(1, 90), a(1, 10), a(1, -5), a(1, -5)], 25), 90);

// 2 x 1e-5 per 2580 s interval ~ 24.4 % APR
assert.ok(Math.abs(fundingApr(4, 2, 2580)! - 24.446) < 0.01);
assert.equal(fundingApr(0, 0, 2580), null);
console.log("riskmath ok");
