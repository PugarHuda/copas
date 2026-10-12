// Run: node --experimental-strip-types lib/mera/feed.check.ts
import assert from "node:assert";
import { feedKeyFromPrf, sealNote, openNote, blobReaders } from "./feed.ts";
const prf = () => crypto.getRandomValues(new Uint8Array(32));
const fixed = new Uint8Array(32).fill(7);
const a1 = await feedKeyFromPrf(fixed.slice()), a2 = await feedKeyFromPrf(fixed.slice());
assert.equal(a1.pub, a2.pub, "deterministic from PRF");
const leader = await feedKeyFromPrf(prf()), fol = await feedKeyFromPrf(prf()), out = await feedKeyFromPrf(prf());
const blob = await sealNote("long BTC above 84k", leader, [{ address: "0xAA", pub: leader.pub }, { address: "0xBB", pub: fol.pub }]);
assert.equal((await openNote(blob, "0xbb", fol)).text, "long BTC above 84k");
assert.equal((await openNote(blob, "0xaa", leader)).text, "long BTC above 84k");
assert.equal((await openNote(blob, "0xcc", out)).text, null);
await assert.rejects(openNote(blob, "0xbb", out)); // wrong key for a listed address
assert.equal(blobReaders(blob), 2);
console.log("feed crypto ok", leader.pub.length);
