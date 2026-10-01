import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signWebhookBody, verifyWebhookSignature } from "../webhook-signing";

/** Fixed test vector for `X-Webhook-Signature: sha256=…` (#574). */

describe("webhook signing", () => {
  const secret = "whsec_test_secret";
  const timestamp = "1700000000000";
  const body = '{"type":"task.status_changed","data":{"from":"assigned","to":"in_progress"}}';
  // Independently computed: HMAC-SHA256(secret, `${timestamp}.${body}`) as hex.
  const expectedHex = "896bbe5e7d639beb8bf2bb582eb3226e3b7b70997ee84b55ccde6765b1d0e1ad";

  it("matches the fixed HMAC-SHA256 test vector over timestamp.body", () => {
    const independent = createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
    expect(independent).toBe(expectedHex);
    expect(signWebhookBody(secret, timestamp, body)).toBe(`sha256=${expectedHex}`);
    // Wrong separator or swapped fields must not match the vector.
    expect(signWebhookBody(secret, timestamp, body)).not.toBe(
      `sha256=${createHmac("sha256", secret).update(`${body}.${timestamp}`, "utf8").digest("hex")}`,
    );
    expect(signWebhookBody(secret, timestamp, body)).not.toBe(
      `sha256=${createHmac("sha256", secret).update(`${timestamp}${body}`, "utf8").digest("hex")}`,
    );
  });

  it("verifies with timingSafeEqual and rejects a wrong signature", () => {
    const signature = signWebhookBody(secret, timestamp, body);
    expect(verifyWebhookSignature(secret, timestamp, body, signature)).toBe(true);
    expect(verifyWebhookSignature(secret, timestamp, body, "sha256=" + "0".repeat(64))).toBe(false);
    expect(verifyWebhookSignature(secret, timestamp, body, signature.slice(0, -1) + "0")).toBe(false);
    expect(verifyWebhookSignature("other", timestamp, body, signature)).toBe(false);
  });

  it("never treats a secret compare as plain string equality", () => {
    const source = verifyWebhookSignature.toString() + signWebhookBody.toString();
    expect(source).toContain("timingSafeEqual");
    expect(source).not.toMatch(/presented\s*===\s*|expected\s*===\s*presented/);
  });
});
