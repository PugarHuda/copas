// node --env-file=.env.local --experimental-strip-types lib/tgWatch.check.ts — round-trips a watch list through the real private Blob store.
import assert from "node:assert/strict";
import { getWatch, setWatch } from "./tgWatch.ts";

const chat = `selftest-${Date.now()}`;
assert.deepEqual(await getWatch(chat), []);
await setWatch(chat, ["0xabc"]);
assert.deepEqual(await getWatch(chat), ["0xabc"]);
await setWatch(chat, []);
assert.deepEqual(await getWatch(chat), []);
console.log("tgWatch ok");
