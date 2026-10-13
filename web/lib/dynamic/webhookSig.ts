import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC-SHA256 of the raw body with the webhook secret, as Dynamic signs it (`x-dynamic-signature-256: sha256=<hex>`).
 * Fails closed: "unset" when the secret is not configured, false on a missing or wrong signature.
 */
export function verifyWebhook(raw: string, header: string | null, secret = process.env.DYNAMIC_WEBHOOK_SECRET): true | false | "unset" {
  if (!secret) return "unset";
  if (!header) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`);
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}
