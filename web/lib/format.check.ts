// Run: node --experimental-strip-types lib/format.check.ts
import assert from "node:assert";
import { usd } from "./format.ts";
assert.equal(usd(-0.0004, { dp: 0 }), "$0", "no −$0 for a value that rounds to zero");
assert.equal(usd(0.001, { sign: true }), "$0.00", "no +$0.00");
assert.equal(usd(-3.2, { dp: 0 }), "−$3");
assert.equal(usd(12.5, { sign: true }), "+$12.50");
assert.equal(usd(-25_000, { compact: true }), "−$25K");
console.log("format ok");
