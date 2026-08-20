// Signed bearer token for the core-link app-layer session (ADR 0002).
//
// After the mTLS handshake the Panel presents a signed bearer
// `{coreId, exp, sig}` in an `auth` frame; the Core validates `exp` and
// closes on expiry. The Panel then re-handshakes TLS and reconnects, replaying
// missed events via `lastEventId` (the same path as Panel-sleep recovery — no
// rolling renewal over the live socket).
//
// The token is a compact, URL-safe string: `base64url(payload).base64url(sig)`
// where `payload` is JSON `{coreId, exp}` — since #282 optionally carrying the
// standard `iss`, `sub`, `aud` and `jti` claims beside them, all four inert in
// this train — and `sig` is HMAC-SHA256 over the
// payload string, keyed by the shared secret provisioned at Core install
// (carried in the registration blob). ~50 lines of app-layer code on top of
// TLS; the mTLS handshake is the key-pair handshake, TLS 1.3 is the symmetric
// encryption, and this bearer is only the bounded session lifetime.
//
// This file is self-contained (no `~/` imports) so it compiles under both the
// Vite (browser/server) and the Core's CommonJS tsconfigs. It uses Node's
// `node:crypto` via a thin injectable HMAC port so it can be exercised from
// either runtime; the default port calls `crypto.createHmac`.

import { createHmac, timingSafeEqual } from "node:crypto";

/** The shared HMAC key. Provisioned at Core install; carried in the blob. */
export type BearerSecret = string;

export type BearerClaims = {
  /** The Core this bearer authorizes the Panel to drive. */
  coreId: string;
  /** Wall-clock ms expiry (JWT `exp`-style). Inclusive at the boundary. */
  exp: number;
  /**
   * Who issued this bearer — the Core itself, as `core:<coreId>` (#282).
   *
   * The four claims below are the standard set #280 fixes on, and **nothing in
   * this feature train reads them**. They exist so that a later identity layer
   * can gate a bearer on who and what it was issued for without a protocol
   * change, which is only possible if the tokens minted today already carry the
   * fields. Every one of them is optional, and that is load-bearing rather than
   * lax: bearers signed before this existed are `{coreId, exp}` and must keep
   * verifying, so absence is a valid token and not a malformed one.
   */
  iss?: string;
  /** The subject the bearer speaks for — the paired client's identity (#282). */
  sub?: string;
  /**
   * The audience: this Core's **stable UUID**, not its `coreId` (#280).
   *
   * `coreId` is `core_<hex>` and is re-minted whenever an operator regenerates
   * the material; the UUID in `core-material-store.ts` survives that and a
   * `reissueServerCert`, which is what makes it the thing a token can name and
   * a Panel can pin.
   */
  aud?: string;
  /** Unique token id, so a later layer can revoke or de-duplicate one (#280). */
  jti?: string;
};

/** The optional standard claims, in the order {@link signBearer} writes them. */
const STANDARD_CLAIMS = ["iss", "sub", "aud", "jti"] as const;

/**
 * HMAC port. The default implementation uses `node:crypto.createHmac`, which is
 * available in the Panel service, the Core, and
 * node tests. The renderer preload does not sign/verify (only the Core
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
 * Sign `{coreId, exp}` — plus whichever of `iss`, `sub`, `aud` and `jti` the
 * caller supplied — with `secret`, and return the URL-safe bearer string
 * `base64url(payload).base64url(sig)`.
 */
export function signBearer(
  claims: BearerClaims,
  secret: BearerSecret,
  hmac: HmacPort = defaultHmac,
): string {
  // Absent claims are left out of the payload rather than written as `null`.
  // A Core that mints no `aud` produces byte-for-byte the token it produced
  // before this file knew what an `aud` was, so nothing downstream can start
  // depending on the shape having grown.
  const payload: Record<string, string | number> = { coreId: claims.coreId, exp: claims.exp };
  for (const claim of STANDARD_CLAIMS) {
    const value = claims[claim];
    if (value !== undefined) payload[claim] = value;
  }
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = encodeBase64Url(Buffer.from(payloadJson, "utf8"));
  const sig = hmac.sha256(secret, payloadB64);
  return `${payloadB64}${SEP}${encodeBase64Url(sig)}`;
}

export type BearerVerifyOk = {
  ok: true;
  coreId: string;
  exp: number;
  /** The standard claims, when the Core that signed this one minted them (#282). */
  iss?: string;
  sub?: string;
  aud?: string;
  jti?: string;
};
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
  const claims = readStandardClaims(parsed as Record<string, unknown>);
  // A claim that is present but not a string is a token this Core did not mint
  // and cannot reason about. It signed, so it is not `bad-signature`; it is
  // simply not the shape — which is what `malformed` already means here.
  if (claims === null) return { ok: false, reason: "malformed" };
  const now = opts.now ?? Date.now();
  if (obj.exp < now) return { ok: false, reason: "expired" };
  return { ok: true, coreId: obj.coreId, exp: obj.exp, ...claims };
}

/**
 * Pull the optional standard claims out of a decoded payload, or `null` when
 * one of them is present with a non-string value.
 *
 * Absence is never a failure — see {@link BearerClaims}.
 */
function readStandardClaims(payload: Record<string, unknown>): Partial<BearerClaims> | null {
  const claims: Partial<BearerClaims> = {};
  for (const claim of STANDARD_CLAIMS) {
    const value = payload[claim];
    if (value === undefined) continue;
    if (typeof value !== "string") return null;
    claims[claim] = value;
  }
  return claims;
}

/**
 * Decode a bearer's `{coreId, exp}` payload WITHOUT verifying the signature.
 * Used by the Panel to inspect a bearer it holds (e.g. to read `exp` for a UI
 * "session expires at" hint) — never by the Core, which must always verify.
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
  const claims = readStandardClaims(parsed as Record<string, unknown>);
  if (claims === null) return null;
  return { coreId: obj.coreId, exp: obj.exp, ...claims };
}
