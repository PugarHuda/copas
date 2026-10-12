// node --experimental-strip-types lib/alchemy.check.ts
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyAlchemy } from "./alchemy.ts";

const body = '{"type":"ADDRESS_ACTIVITY"}';
const sig = createHmac("sha256", "k").update(body).digest("hex");
assert.equal(verifyAlchemy(body, sig, "k"), true);
assert.equal(verifyAlchemy(body + " ", sig, "k"), false);
assert.equal(verifyAlchemy(body, sig, "other"), false);
assert.equal(verifyAlchemy(body, null, "k"), false);
assert.equal(verifyAlchemy(body, "ab", "k"), false);
console.log("alchemy ok");
