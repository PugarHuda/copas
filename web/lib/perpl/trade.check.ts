// Run: node --experimental-strip-types lib/perpl/trade.check.ts
import assert from "node:assert/strict";
import { checkMandate, drawdown, looser, orderDesc, toLNS, toPNS, toTMarkets, touch, walk, DEFAULT_MANDATE, type TMarket } from "./trade.ts";

const btc: TMarket = { id: 16, sym: "BTC", pd: 1, sd: 5, maxLev: 15, maintLev: 25, takerBp: 3.45, maxSlipBps: 1000, mnpBps: 1000 };
assert.equal(toPNS(83137.3, btc), 831373n);
assert.equal(toLNS(0.0001, btc), 10n);
assert.equal(toLNS(0.000109, btc), 10n); // floors to a whole lot

// maxNegPnlCollatBPS 0 makes Perpl refuse every taker fill on the wrong side of mark (0xb29d1949, code 14): never send 0
const ioc = { perpId: 16, orderType: 1, pricePNS: 830000n, lotLNS: 20n, leverageHdths: 300n, ioc: true };
assert.equal(orderDesc(ioc, 100n).maxNegPnlCollatBPS, 1000n);
assert.equal(orderDesc({ ...ioc, mnpBps: 500 }, 100n).maxNegPnlCollatBPS, 500n);
const cfg = { is_open: true, price_decimals: 1, size_decimals: 5, initial_margin: 1500, maintenance_margin: 2500, taker_fee: 345 };
assert.equal(toTMarkets({ markets: [{ id: 16, symbol: "BTC", config: cfg }] })[0].mnpBps, 1000);
assert.equal(toTMarkets({ markets: [{ id: 16, symbol: "BTC", order_max_neg_pnl_collat_bps: 2000, config: cfg }] })[0].mnpBps, 2000);

assert.deepEqual(walk([{ p: 101, s: 1 }, { p: 102, s: 1 }], 2), { avg: 101.5, worst: 102 });
assert.equal(walk([{ p: 101, s: 1 }], 2), null);

// unit ledger: deposits do not move the unit price, losses do
let l = touch(null, 100); // 100 units at 1.0
l = touch(l, 100, 50); // deposit 50 -> 150 units
assert.equal(l.units, 150);
assert.equal(drawdown(l, 150), 0);
l = touch(l, 165); // +10% -> peak 1.1
assert.ok(Math.abs(l.peak - 1.1) < 1e-12);
assert.ok(Math.abs(drawdown(l, 148.5) - 10) < 1e-9); // 0.99 vs 1.1 peak

const base = { sym: "BTC", lev: 5, notional: 400, reduce: false, gross: 0, equity: 100, dd: 0 };
assert.ok(checkMandate(DEFAULT_MANDATE, base).every((c) => c.ok));
assert.equal(checkMandate(DEFAULT_MANDATE, { ...base, sym: "ZEC" }).find((c) => !c.ok)?.rule, "Market");
assert.equal(checkMandate(DEFAULT_MANDATE, { ...base, notional: 600 }).find((c) => !c.ok)?.rule, "Leverage"); // 6x account
assert.equal(checkMandate(DEFAULT_MANDATE, { ...base, notional: 900, gross: 200, equity: 1000 }).find((c) => !c.ok)?.rule, "Notional");
assert.equal(checkMandate(DEFAULT_MANDATE, { ...base, dd: 20 }).find((c) => !c.ok)?.rule, "Drawdown");
assert.deepEqual(checkMandate(DEFAULT_MANDATE, { ...base, sym: "ZEC", dd: 99, reduce: true }), []); // closing always allowed

assert.ok(looser(DEFAULT_MANDATE, { ...DEFAULT_MANDATE, maxLev: 6 }));
assert.ok(looser(DEFAULT_MANDATE, { ...DEFAULT_MANDATE, markets: ["BTC", "MON"] }));
assert.ok(!looser(DEFAULT_MANDATE, { ...DEFAULT_MANDATE, maxLev: 3, markets: ["BTC"] }));
console.log("trade.check ok");
