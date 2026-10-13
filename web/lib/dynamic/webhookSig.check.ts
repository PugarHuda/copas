// node --experimental-strip-types lib/dynamic/webhookSig.check.ts
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyWebhook } from "./webhookSig.ts";

const body = JSON.stringify({ eventName: "wallet.delegation.revoked", data: { walletId: "25193936-3ecd-4c1b-84e6-9eabc82e53c2" } });
const sig = (s: string, b = body) => `sha256=${createHmac("sha256", s).update(b).digest("hex")}`;
assert.equal(verifyWebhook(body, sig("k"), undefined), "unset"); // no secret configured -> route answers 503
assert.equal(verifyWebhook(body, null, "k"), false); // unsigned -> 401
assert.equal(verifyWebhook(body, sig("wrong"), "k"), false); // wrong secret -> 401
assert.equal(verifyWebhook(body + " ", sig("k"), "k"), false); // tampered body -> 401
assert.equal(verifyWebhook(body, "sha256=00", "k"), false); // wrong length -> 401, no throw
assert.equal(verifyWebhook(body, sig("k"), "k"), true);
console.log("webhookSig.check: ok");
