import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook request signing (#574). The signature is
 * `sha256=` + hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`)).
 * Comparisons of digests use `timingSafeEqual` after equal-length checks —
 * never a plain string compare where a secret is involved.
 */

export function signWebhookBody(secret: string, timestamp: string, rawBody: string): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return `sha256=${digest}`;
}

/** True when `presented` matches the HMAC of `secret` over `timestamp.body`. */
export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  presented: string,
): boolean {
  const expected = Buffer.from(signWebhookBody(secret, timestamp, rawBody), "utf8");
  const got = Buffer.from(presented, "utf8");
  return expected.length === got.length && timingSafeEqual(expected, got);
}
