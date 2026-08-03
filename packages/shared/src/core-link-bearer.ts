// Signed bearer token for the core-link app-layer session (ADR 0002).
//
// After the mTLS handshake the Panel presents a signed bearer
// `{coreId, exp, sig}` in an `auth` frame; the Harness validates `exp` and
// closes on expiry. The Panel then re-handshakes TLS and reconnects, replaying
// missed events via `lastEventId` (the same path as Panel-sleep recovery — no
// rolling renewal over the live socket).
//
// The token is a compact, URL-safe string: `base64url(payload).base64url(sig)`
// where `payload` is JSON `{coreId, exp}` and `sig` is HMAC-SHA256 over the
// payload string, keyed by the shared secret provisioned at Harness install
// (carried in the registration blob). ~50 lines of app-layer code on top of
// TLS; the mTLS handshake is the key-pair handshake, TLS 1.3 is the symmetric
// encryption, and this bearer is only the bounded session lifetime.
//
// This file is self-contained (no `~/` imports) so it compiles under both the
// Vite (browser/server) and the Harness's CommonJS tsconfigs. It uses Node's
// `node:crypto` via a thin injectable HMAC port so it can be exercised from
// either runtime; the default port calls `crypto.createHmac`.

import { createHmac, timingSafeEqual } from "node:crypto";

/** The shared HMAC key. Provisioned at Harness install; carried in the blob. */
export type BearerSecret = string;

export type BearerClaims = {
  /** The Core this bearer authorizes the Panel to drive. */
  coreId: string;
  /** Wall-clock ms expiry (JWT `exp`-style). Inclusive at the boundary. */
  exp: number;
};

/**
 * HMAC port. The default implementation uses `node:crypto.createHmac`, which is
 * available in the Panel service, the Harness, and
 * node tests. The renderer preload does not sign/verify (only the Harness
 * verifies; the Panel just stores + presents the pre-signed blob), so the
 * default is fine everywhere this module is imported.
 */
export interface HmacPort {
  sha256(key: string, data: string): Buffer;
}

const defaultHmac: HmacPort = {
  sha256: (key, data) => createHmac("sha256", key).update(data).digest(),
};

/** Separator between the base64url payload and the base64url signature. */
const SEP = ".";

function encodeBase64Url(buf: Buffer): string {
  return buf.toString("base64url");
}

function decodeBase64Url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Sign `{coreId, exp}` with `secret` and return the URL-safe bearer string
 * `base64url(payload).base64url(sig)`.
 */
export function signBearer(
  claims: BearerClaims,
  secret: BearerSecret,
  hmac: HmacPort = defaultHmac,
): string {
  const payloadJson = JSON.stringify({ coreId: claims.coreId, exp: claims.exp });
  const payloadB64 = encodeBase64Url(Buffer.from(payloadJson, "utf8"));
  const sig = hmac.sha256(secret, payloadB64);
  return `${payloadB64}${SEP}${encodeBase64Url(sig)}`;
}

export type BearerVerifyOk = { ok: true; coreId: string; exp: number };
export type BearerVerifyErr =
  | { ok: false; reason: "malformed" }
  | { ok: false; reason: "bad-signature" }
  | { ok: false; reason: "expired" };
export type BearerVerifyResult = BearerVerifyOk | BearerVerifyErr;

/**
 * Verify a bearer: split, decode the payload, check the HMAC in constant time,
 * then check `exp` against the current clock. `now` is injectable for tests.
 *
 * Returns `{ ok: true, coreId, exp }` on success, or a typed failure reason.
 */
export function verifyBearer(
  token: string,
  secret: BearerSecret,
  opts: { now?: number; hmac?: HmacPort } = {},
): BearerVerifyResult {
  const hmac = opts.hmac ?? defaultHmac;
  const sep = token.indexOf(SEP);
  if (sep <= 0 || sep === token.length - 1) return { ok: false, reason: "malformed" };
  const payloadB64 = token.slice(0, sep);
  const sigB64 = token.slice(sep + 1);
  let payloadJson: string;
  try {
    payloadJson = decodeBase64Url(payloadB64).toString("utf8");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  let expectedSig: Buffer;
  try {
    expectedSig = decodeBase64Url(sigB64);
  } catch {
    return { ok: false, reason: "bad-signature" };
  }
  // Verify the signature BEFORE parsing the payload so a tampered token is
  // rejected as `bad-signature` (not `malformed`) and no payload validity is
  // leaked to an attacker who can't produce a valid signature.
  const actualSig = hmac.sha256(secret, payloadB64);
  if (!safeEqual(actualSig, expectedSig)) return { ok: false, reason: "bad-signature" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "malformed" };
  const obj = parsed as { coreId?: unknown; exp?: unknown };
  if (typeof obj.coreId !== "string" || typeof obj.exp !== "number" || !Number.isFinite(obj.exp)) {
    return { ok: false, reason: "malformed" };
  }
  const now = opts.now ?? Date.now();
  if (obj.exp < now) return { ok: false, reason: "expired" };
  return { ok: true, coreId: obj.coreId, exp: obj.exp };
}

/**
 * Decode a bearer's `{coreId, exp}` payload WITHOUT verifying the signature.
 * Used by the Panel to inspect a bearer it holds (e.g. to read `exp` for a UI
 * "session expires at" hint) — never by the Harness, which must always verify.
 */
export function decodeBearer(token: string): BearerClaims | null {
  const sep = token.indexOf(SEP);
  if (sep <= 0 || sep === token.length - 1) return null;
  let payloadJson: string;
  try {
    payloadJson = decodeBase64Url(token.slice(0, sep)).toString("utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as { coreId?: unknown; exp?: unknown };
  if (typeof obj.coreId !== "string" || typeof obj.exp !== "number" || !Number.isFinite(obj.exp)) {
    return null;
  }
  return { coreId: obj.coreId, exp: obj.exp };
}
