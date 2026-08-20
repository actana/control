import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
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

  // ─── Standard claims (#280, #282) ────────────────────────────────────────
  //
  // The pairing endpoint issues bearers carrying `iss`, `sub`, `aud` and `jti`
  // beside the `exp` that was already there. Nothing in this train reads them;
  // what these tests pin is that adding them broke neither direction — a token
  // with the claims verifies, and a token from before they existed still does.

  describe("standard claims", () => {
    const claims = {
      coreId: "core_abc",
      exp: Date.now() + 60_000,
      iss: "core:core_abc",
      sub: "pair:laptop",
      aud: "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b",
      jti: "01H0000000000000000000",
    };

    it("carries every claim through sign and verify", () => {
      const result = verifyBearer(signBearer(claims, SECRET), SECRET, { now: claims.exp });
      expect(result).toMatchObject({
        ok: true,
        coreId: claims.coreId,
        exp: claims.exp,
        iss: claims.iss,
        sub: claims.sub,
        aud: claims.aud,
        jti: claims.jti,
      });
    });

    it("still verifies a bearer minted before the claims existed", () => {
      // The compatibility that matters: every Panel paired before #282 holds a
      // `{coreId, exp}` token, and a Core that refused it would lock them out
      // of a Core that had merely been upgraded.
      const legacy = signBearer({ coreId: "core_abc", exp: claims.exp }, SECRET);
      const result = verifyBearer(legacy, SECRET, { now: claims.exp });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.aud).toBeUndefined();
    });

    it("leaves an absent claim out of the payload rather than writing it null", () => {
      const legacy = signBearer({ coreId: "core_abc", exp: claims.exp }, SECRET);
      const payload = JSON.parse(Buffer.from(legacy.split(".")[0]!, "base64url").toString("utf8"));
      expect(Object.keys(payload).sort()).toEqual(["coreId", "exp"]);
    });

    it("exposes the claims to a decode that does not verify", () => {
      expect(decodeBearer(signBearer(claims, SECRET))).toMatchObject({
        aud: claims.aud,
        jti: claims.jti,
      });
    });

    it("calls a claim of the wrong type malformed, not merely absent", () => {
      // Hand-built rather than signed through `signBearer`, because the type
      // system stops this shape being minted here — and does not stop it
      // arriving on a socket.
      const payload = Buffer.from(JSON.stringify({ coreId: "core_abc", exp: claims.exp, aud: 7 }), "utf8")
        .toString("base64url");
      const sig = createHmac("sha256", SECRET).update(payload).digest().toString("base64url");
      const result = verifyBearer(`${payload}.${sig}`, SECRET, { now: claims.exp });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("malformed");
    });

    it("still refuses a token whose claims were edited after signing", () => {
      const token = signBearer(claims, SECRET);
      const payload = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"));
      payload.aud = "some-other-core";
      const forged = `${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.${token.split(".")[1]}`;
      const result = verifyBearer(forged, SECRET, { now: claims.exp });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("bad-signature");
    });
  });
});
