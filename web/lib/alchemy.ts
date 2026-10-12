import { createHmac, timingSafeEqual } from "node:crypto";

/** Alchemy Notify signature: `x-alchemy-signature` is the hex HMAC-SHA256 of the raw body under the webhook's signing key. */
export function verifyAlchemy(body: string, sig: string | null, key: string) {
  if (!sig) return false;
  const want = Buffer.from(createHmac("sha256", key).update(body, "utf8").digest("hex"));
  const got = Buffer.from(sig.toLowerCase());
  return want.length === got.length && timingSafeEqual(want, got);
}
