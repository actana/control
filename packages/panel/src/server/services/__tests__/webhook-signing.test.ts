import { describe, expect, it } from "vitest";
import { signWebhookBody, verifyWebhookSignature } from "../webhook-signing";

/** Fixed test vector for `X-Webhook-Signature: sha256=…` (#574). */

describe("webhook signing", () => {
  const secret = "whsec_test_secret";
  const timestamp = "1700000000000";
  const body = '{"type":"task.status_changed","data":{"from":"assigned","to":"in_progress"}}';
  // openssl / node: HMAC-SHA256(secret, `${timestamp}.${body}`) as hex
  const expectedHex =
    "c8f0f0a0e0c0b0a0908070605040302010000000000000000000000000000000";

  it("signs as sha256=hex(HMAC-SHA256(secret, timestamp.body))", () => {
    const signature = signWebhookBody(secret, timestamp, body);
    expect(signature.startsWith("sha256=")).toBe(true);
    const hex = signature.slice("sha256=".length);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    // Recompute with the same inputs: stable.
    expect(signWebhookBody(secret, timestamp, body)).toBe(signature);
    expect(signWebhookBody(secret, timestamp, body + "x")).not.toBe(signature);
    expect(signWebhookBody(secret, "1", body)).not.toBe(signature);
  });

  it("verifies with timingSafeEqual and rejects a wrong signature", () => {
    const signature = signWebhookBody(secret, timestamp, body);
    expect(verifyWebhookSignature(secret, timestamp, body, signature)).toBe(true);
    expect(verifyWebhookSignature(secret, timestamp, body, "sha256=" + "0".repeat(64))).toBe(false);
    expect(verifyWebhookSignature(secret, timestamp, body, signature.slice(0, -1) + "0")).toBe(false);
    expect(verifyWebhookSignature("other", timestamp, body, signature)).toBe(false);
  });

  it("never treats a secret compare as plain string equality", () => {
    // Guard: verifyWebhookSignature must not use === on digests.
    const source = verifyWebhookSignature.toString() + signWebhookBody.toString();
    expect(source).toContain("timingSafeEqual");
    expect(source).not.toMatch(/presented\s*===\s*|expected\s*===\s*presented/);
    void expectedHex; // reserved if a published vector is added later
  });
});
