import { describe, it, expect } from "vitest";
import {
  signBearer,
  verifyBearer,
  decodeBearer,
  type BearerSecret,
} from "../core-link-bearer";

// Bearer `{coreId, exp, sig}` — the Panel presents this in an `auth` frame
// after the mTLS handshake (ADR 0002). The Core validates `exp` and closes
// on expiry; the Panel re-handshakes TLS and reconnects, replaying missed
// events via `lastEventId` (the same path as Panel-sleep recovery).
//
// The bearer is a compact signed token: a base64url payload
// `{coreId, exp}` joined to an HMAC-SHA256 signature over that payload, keyed
// by a shared secret provisioned at Core install (part of the registration
// blob). ~50 lines of app-layer code on top of TLS.

const SECRET: BearerSecret = "test-secret-32-bytes-0123456789abcdef";

describe("core-link bearer", () => {
  describe("signBearer / verifyBearer", () => {
    it("round-trips a valid bearer", () => {
      const exp = Date.now() + 60_000;
      const token = signBearer({ coreId: "core_abc", exp }, SECRET);
      const result = verifyBearer(token, SECRET);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.coreId).toBe("core_abc");
        expect(result.exp).toBe(exp);
      }
    });

    it("rejects an expired bearer (exp in the past)", () => {
      const exp = Date.now() - 1_000;
      const token = signBearer({ coreId: "core_abc", exp }, SECRET);
      const result = verifyBearer(token, SECRET);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("expired");
    });

    it("rejects a bearer signed with a different secret", () => {
      const exp = Date.now() + 60_000;
      const token = signBearer({ coreId: "core_abc", exp }, SECRET);
      const result = verifyBearer(token, "wrong-secret-also-32-bytes-long!");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("bad-signature");
    });

    it("rejects a tampered payload", () => {
      const exp = Date.now() + 60_000;
      const token = signBearer({ coreId: "core_abc", exp }, SECRET);
      // Flip a character in the payload half.
      const tampered = token.slice(0, 5) + (token[5] === "a" ? "b" : "a") + token.slice(6);
      const result = verifyBearer(tampered, SECRET);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("bad-signature");
    });

    it("rejects a malformed bearer (not two parts)", () => {
      const result = verifyBearer("not-a-token", SECRET);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("malformed");
    });

    it("rejects an empty bearer", () => {
      const result = verifyBearer("", SECRET);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("malformed");
    });

    it("rejects a bearer whose payload is not valid JSON", () => {
      // Unsigned garbage that splits on the separator — signature check fails
      // first (no valid HMAC), so it's `bad-signature`, not `malformed`.
      const result = verifyBearer("%%%notbase64%%%.sig", SECRET);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("bad-signature");
    });
  });

  describe("decodeBearer", () => {
    it("decodes the payload without verifying the signature", () => {
      const exp = Date.now() + 60_000;
      const token = signBearer({ coreId: "core_xyz", exp }, SECRET);
      const decoded = decodeBearer(token);
      expect(decoded).toEqual({ coreId: "core_xyz", exp });
    });

    it("returns null for a malformed bearer", () => {
      expect(decodeBearer("garbage")).toBeNull();
    });

    it("returns null for a bearer with a non-object payload", () => {
      // base64url of `"hello"` (a JSON string, not an object).
      const payload = Buffer.from(JSON.stringify("hello")).toString("base64url");
      expect(decodeBearer(`${payload}.sig`)).toBeNull();
    });
  });

  describe("exp boundary", () => {
    // Pin the verifier's clock via `opts.now` — reading Date.now() twice lets
    // the millisecond tick between sign and verify, which fails the inclusive
    // boundary on a loaded CI runner.
    it("accepts a bearer exp exactly now (boundary inclusive)", () => {
      const exp = Date.now();
      const token = signBearer({ coreId: "core_abc", exp }, SECRET);
      const result = verifyBearer(token, SECRET, { now: exp });
      expect(result.ok).toBe(true);
    });

    it("rejects a bearer 1ms past exp", () => {
      const exp = Date.now();
      const token = signBearer({ coreId: "core_abc", exp }, SECRET);
      const result = verifyBearer(token, SECRET, { now: exp + 1 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("expired");
    });
  });
});
