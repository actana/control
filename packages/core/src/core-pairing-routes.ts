// The Core's pairing endpoint — the one route on this machine that answers a
// client holding no certificate (#280, #282).
//
// A client with a pairing code posts here, and what it gets back is the
// credential every other surface on this Core requires it to already have. That
// makes this file the Core's only pre-auth attack surface, and the reason the
// defences below are not negotiable:
//
//   POST /v1/pair/redeem
//   { "sessionId", "code", "client": { … }, "csr": "-----BEGIN CERTIFICATE REQUEST-----" }
//   → 200 { "caCert", "clientCert", "bearer", "endpoint" }
//
// **The private key is not in that exchange, in either direction.** The client
// generates its key pair, keeps the private half and sends a CSR; this Core
// signs it and sends back a certificate. There is nothing here that could
// return a key because there is nothing here that has one (#280).
//
// **Validation runs in a fixed order** — rate limit, then session lookup and
// binding, then revocation, TTL, single use and the attempt cap, and only then
// the code itself. The order is the design's, not a convenience: every check
// before the code is one an attacker cannot influence with a guess, so a guess
// reaches the comparison only after the cheap defences have had their say — and
// a guess against a session the operator has already cancelled never costs that
// session one of its five attempts.
//
// **Every refusal is the same refusal.** Expired, consumed, unknown, dead,
// wrong code — one status, one body, no header that differs. A response that
// said *which* would tell an attacker whether a session id exists, whether it
// is still live, and whether their last guess was closer; the audit log on this
// Core says all of it, because the operator reading that log already owns the
// Core.
//
// It mounts on the `https.Server` the core link and the `/v1/…` file routes
// already share (ADR 0028 — one port, one certificate, two protocols), through
// the same `CoreHttpRoutes` shape `core-files-routes.ts` returns.
// `core-preauth-gate.ts` is what lets an uncertificated client reach it without
// opening anything else, and `core-pairing-wiring.ts` is where the two are tied
// together.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CsrRejectedError, assertSignableCsr, signClientCsr } from "@actana/shared/core-cert-material";
import { signBearer } from "@actana/shared/core-link-bearer";
import { normalisePairingCode } from "@actana/shared/pairing-code";
import {
  isConsumed,
  isDead,
  isExpired,
  isRevoked,
  type PairingSession,
} from "@actana/shared/pairing-session";
import {
  derivePairingCodeKey,
  hashPairingCode,
  pairingCodeMatches,
  type PairedClient,
  type PairingConsumeOutcome,
} from "@actana/shared/pairing-store";
import log from "@actana/shared/log";
import type { CoreHttpRoutes } from "./core-files-routes";
import { pairingAuditor, type PairingAuditEvent } from "@actana/shared/pairing-audit";
import { PairingRateLimiter } from "./core-pairing-rate-limit";
import { pairingBearerSubject } from "./core-pairing-revocation";

/** Everything this module answers lives under here. */
export const CORE_PAIRING_ROUTE_PREFIX = "/v1/pair/";

/** The one route. Named so the pre-auth gate and the tests agree on the string. */
export const CORE_PAIRING_REDEEM_PATH = "/v1/pair/redeem";

/**
 * The most a redemption body may weigh.
 *
 * A CSR for a 2048-bit RSA key is around 1 KB in PEM; 16 KB leaves room for a
 * larger key and a label without leaving a pre-auth endpoint willing to buffer
 * whatever an attacker feels like sending.
 */
export const MAX_REDEEM_BODY_BYTES = 16 * 1024;

/**
 * How much of an over-sized body is read before the socket is simply dropped.
 *
 * A client that sent a request slightly too big gets a `413` it can act on; a
 * sender still going at a megabyte is not making a request this Core has any
 * reason to finish reading.
 */
export const DRAIN_CEILING_BYTES = 1024 * 1024;

/** How long an issued bearer is good for, when the caller does not say. */
export const DEFAULT_PAIRED_BEARER_DAYS = 365;

/**
 * The store of sessions and paired clients, as this endpoint uses it.
 *
 * A port rather than the class, so the endpoint can be exercised against an
 * in-memory double — `PairingStore` in `@actana/shared/pairing-store` satisfies
 * it structurally and is what the daemon passes.
 */
export interface PairingSessionPort {
  /** The session with this id, or `null`. */
  getSession(id: string): PairingSession | null;
  /** Count a wrong code. Returns the session as it now stands, or `null`. */
  recordWrongAttempt(id: string): PairingSession | null;
  /** Mark consumed if it may be — the step that decides who wins a race. */
  consume(id: string, now: number): PairingConsumeOutcome;
  /** Persist the identity of a client that just paired. */
  recordClient(client: PairedClient): void;
}

/** What this Core signs and speaks as. A slice of `PersistedMaterial`. */
export type PairingIssuerMaterial = {
  /** PEM CA certificate — signed against, and handed to the client. */
  caCert: string;
  /** PEM CA private key. Never leaves this process. */
  caKey: string;
  /** HMAC secret for the issued bearer, and the root of the code digest key. */
  bearerSecret: string;
  /** The `coreId` claim, as every bearer has always carried. */
  coreId: string;
  /** The stable core UUID — the `aud` claim (#280). */
  coreUuid: string;
};

export type CorePairingRoutesOptions = {
  material: PairingIssuerMaterial;
  sessions: PairingSessionPort;
  /**
   * The `wss://host:port` a paired client dials afterwards — what goes in the
   * response's `endpoint`, and from there into the client's blob-shaped
   * credential. The Core's own idea of its public address, not a value derived
   * from the request: a `Host` header is chosen by the caller, and a client
   * that pinned it would have pinned whatever an attacker wrote there.
   */
  endpoint: string;
  /** Issued bearer lifetime. Defaults to {@link DEFAULT_PAIRED_BEARER_DAYS}. */
  bearerDays?: number;
  /** Shared across requests. A fresh default one is made when omitted. */
  rateLimiter?: PairingRateLimiter;
  /** Where attempts are recorded. Defaults to this repo's log. */
  audit?: (event: PairingAuditEvent) => void;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
};

/** A refusal, in the JSON shape `core-files-routes.ts` already answers with. */
type Refusal = { status: number; code: string; message: string; headers?: Record<string, string> };

/**
 * The single refusal every session-state and wrong-code failure answers with.
 *
 * One object, referenced by every branch, because "indistinguishable" is a
 * property that decays the moment two call sites write their own version of it.
 */
const PAIRING_REFUSED: Refusal = {
  status: 403,
  code: "pairing-refused",
  message: "this pairing code cannot be redeemed",
};

/** Build the pairing route family. */
export function createCorePairingRequestHandler(opts: CorePairingRoutesOptions): CoreHttpRoutes {
  const now = opts.now ?? (() => Date.now());
  const rateLimiter = opts.rateLimiter ?? new PairingRateLimiter({ now });
  const audit = opts.audit ?? pairingAuditor();
  const bearerDays = opts.bearerDays ?? DEFAULT_PAIRED_BEARER_DAYS;
  const codeKey = derivePairingCodeKey(opts.material.bearerSecret);

  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? "/", "https://core.invalid");
    if (!url.pathname.startsWith(CORE_PAIRING_ROUTE_PREFIX)) return false;
    void route(req, res, url).catch((err: unknown) => {
      // Anything reaching here is a bug in this file: every expected refusal
      // is returned rather than thrown. Say nothing useful on the wire.
      log.error("core-pairing.unhandled", { error: err instanceof Error ? err.message : String(err) });
      audit({ outcome: "core-error", reason: "unhandled", peer: peerOf(req), at: now() });
      sendRefusal(res, { status: 500, code: "core-error", message: "the Core failed to handle this request" });
    });
    return true;
  }

  /**
   * `Expect: 100-continue` on a redemption.
   *
   * A listener has to exist or Node answers `100 Continue` itself for every
   * route on this server (see `mountHttpRoutes`), so the choice is what to do
   * rather than whether to be here. An oversized body is refused before it is
   * sent; everything else is continued and handled exactly as a plain POST,
   * which keeps one path through {@link route} and one rate-limit count.
   */
  function handleContinue(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? "/", "https://core.invalid");
    if (!url.pathname.startsWith(CORE_PAIRING_ROUTE_PREFIX)) return false;
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_REDEEM_BODY_BYTES) {
      sendRefusal(res, tooLarge());
      return true;
    }
    res.writeContinue();
    return handle(req, res);
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const peer = peerOf(req);

    if (url.pathname !== CORE_PAIRING_REDEEM_PATH) {
      return sendRefusal(res, { status: 404, code: "not-found", message: `no route for ${url.pathname}` });
    }
    if (req.method !== "POST") {
      return sendRefusal(res, {
        status: 405,
        code: "method-not-allowed",
        message: `${req.method ?? "?"} is not allowed here — use POST`,
        headers: { allow: "POST" },
      });
    }

    // ── 1. Rate limit ──
    // First, and before anything is read off the socket: this is the defence
    // that has to hold when the attacker is not playing along, and every check
    // after it costs this process something an attacker can ask for at will.
    const verdict = rateLimiter.check(peer);
    if (!verdict.ok) {
      audit({ outcome: "rate-limited", reason: verdict.scope, peer, at: now() });
      return sendRefusal(res, {
        status: 429,
        code: "rate-limited",
        message: "too many pairing attempts — wait and try again",
        headers: { "retry-after": String(Math.ceil(verdict.retryAfterMs / 1000)) },
      });
    }

    const body = await readJsonBody(req);
    if (!body.ok) {
      audit({ outcome: "bad-request", reason: body.reason, peer, at: now() });
      return sendRefusal(res, body.refusal);
    }
    const request = parseRedeemRequest(body.value);
    if (!request.ok) {
      audit({ outcome: "bad-request", reason: request.reason, peer, at: now() });
      return sendRefusal(res, {
        status: 400,
        code: "bad-request",
        message: request.message,
      });
    }
    const { sessionId, code, label: clientLabel, csr } = request.value;

    // ── 2. Session lookup and binding ──
    // The redemption names one session and is answered by that session or by
    // nothing. There is no search for a session the code might belong to, which
    // is what "cannot be replayed against another" means in code: the digest
    // below is taken over this session's id, so a code lifted from session A
    // does not hash to session B's stored digest even if it is the right code.
    const session = opts.sessions.getSession(sessionId);
    if (!session) {
      audit({ outcome: "refused", reason: "unknown-session", sessionId, peer, at: now() });
      return sendRefusal(res, PAIRING_REFUSED);
    }

    // ── 3. Revoked · 4. TTL · 5. Single use · 6. Attempt cap ──
    // Written out in the order #282 fixes rather than delegated to `canRedeem`,
    // whose internal order is its own. Nothing observable turns on which of the
    // four answers first — all four produce the one refusal — but the order a
    // reader has to check against the spec is the order it is written in.
    //
    // Revocation joins the ladder rather than being left to `consume()` below
    // (#283). It is caught at the same layer as the rest for two reasons that
    // are about the operator, not the attacker: a guess against a cancelled
    // session should not cost that session an attempt it will never use, and
    // the audit line should say `revoked` rather than `wrong-code` — otherwise
    // the log does not show that the operator's own cancellation is what
    // stopped the redemption. `consume()` still refuses it, and must: this is
    // the reported reason, not the enforcement.
    const at = now();
    if (isRevoked(session)) return refuse(res, audit, session, peer, "revoked");
    if (isExpired(session, at)) return refuse(res, audit, session, peer, "expired");
    if (isConsumed(session)) return refuse(res, audit, session, peer, "already-consumed");
    if (isDead(session)) return refuse(res, audit, session, peer, "attempts-exhausted");

    // ── 7. The code ──
    // A code that is not in the alphabet at all is a wrong code, not a protocol
    // error: it is a guess that cannot be right, and treating it as a 400 would
    // hand an attacker a free probe that never costs them an attempt.
    const canonical = normalisePairingCode(code);
    const candidate =
      canonical === null ? null : hashPairingCode({ key: codeKey, sessionId, code: canonical });
    if (candidate === null || !pairingCodeMatches(session.codeHash, candidate)) {
      const after = opts.sessions.recordWrongAttempt(sessionId);
      audit({
        outcome: "refused",
        reason: canonical === null ? "malformed-code" : "wrong-code",
        sessionId,
        label: session.label,
        peer,
        attempts: after?.attempts ?? session.attempts,
        at: now(),
      });
      return sendRefusal(res, PAIRING_REFUSED);
    }

    // ── The CSR, before anything is spent ──
    // Checked here rather than at the signature below so that a malformed
    // request does not consume the operator's session: the code was right, so
    // this is a client bug rather than an attack, and the operator should not
    // have to mint a new code for it. An attacker gains nothing — they had to
    // know the code to get this far.
    try {
      await assertSignableCsr(csr);
    } catch (err) {
      if (!(err instanceof CsrRejectedError)) throw err;
      audit({
        outcome: "bad-request",
        reason: `csr-${err.rejection}`,
        sessionId,
        label: session.label,
        peer,
        at: now(),
      });
      return sendRefusal(res, { status: 400, code: "bad-request", message: "the CSR was not acceptable" });
    }

    // ── Consume, then issue ──
    // This is the step that decides a race, and it is a single synchronous
    // read-modify-write inside the store. Two redemptions arriving together
    // both reach here; one marks the session consumed and goes on to sign, the
    // other is told `already-consumed` and gets the same refusal a replay gets.
    const consumed = opts.sessions.consume(sessionId, at);
    if (!consumed.ok) return refuse(res, audit, session, peer, consumed.reason);

    let issued;
    try {
      issued = await signClientCsr({
        ca: { cert: opts.material.caCert, key: opts.material.caKey },
        csrPem: csr,
        // The subject is the Core's to write, from what the operator typed when
        // they opened the session — never from the CSR, which is the client's
        // to fill in. See `signClientCsr`.
        subject: `CN=${certCommonName(session.label || clientLabel || sessionId)}`,
      });
    } catch (err) {
      // The session is spent and no certificate exists. That is the safe
      // direction: the operator runs `actana pair new` again, where the other
      // one would leave a live code after a failed issuance.
      log.error("core-pairing.sign-failed", { error: err instanceof Error ? err.message : String(err) });
      audit({ outcome: "core-error", reason: "sign-failed", sessionId, label: session.label, peer, at: now() });
      return sendRefusal(res, { status: 500, code: "core-error", message: "this Core could not sign the request" });
    }

    const client: PairedClient = {
      certSerial: issued.serial,
      certSubject: issued.subject,
      label: session.label,
      sessionId,
      pairedAt: at,
      certNotAfter: issued.notAfter,
      revokedAt: null,
      // Inert (#280), carried across from the session so a later identity layer
      // can read on the client what it wrote on the session.
      created_by: session.created_by,
      tenant_id: session.tenant_id,
      auth_method: session.auth_method,
    };
    opts.sessions.recordClient(client);

    const bearer = signBearer(
      {
        coreId: opts.material.coreId,
        exp: at + bearerDays * 24 * 60 * 60 * 1000,
        // The four claims #280 fixes on, all inert in this train. `sub` is the
        // certificate serial because that is what identifies *this pairing* —
        // a label is whatever the operator typed, possibly twice.
        iss: `core:${opts.material.coreId}`,
        sub: pairingBearerSubject(issued.serial),
        aud: opts.material.coreUuid,
        jti: randomUUID(),
      },
      opts.material.bearerSecret,
    );

    audit({
      outcome: "issued",
      sessionId,
      label: session.label,
      peer,
      certSerial: issued.serial,
      at: now(),
    });

    // Four fields, and the absence of a fifth is the point: there is no key
    // here, and `core-pairing-redeem.test.ts` asserts the response never
    // contains one.
    sendJson(res, 200, {
      caCert: opts.material.caCert,
      clientCert: issued.cert,
      bearer,
      endpoint: opts.endpoint,
    });
  }

  return { handle, handleContinue };
}

/** Answer the one refusal, and record which defence produced it. */
function refuse(
  res: ServerResponse,
  audit: (event: PairingAuditEvent) => void,
  session: PairingSession,
  peer: string,
  reason: string,
): void {
  audit({
    outcome: "refused",
    reason,
    sessionId: session.id,
    label: session.label,
    peer,
    attempts: session.attempts,
    at: Date.now(),
  });
  sendRefusal(res, PAIRING_REFUSED);
}

type RedeemRequest = {
  sessionId: string;
  code: string;
  label: string | null;
  csr: string;
};

type ParseResult =
  | { ok: true; value: RedeemRequest }
  | { ok: false; reason: string; message: string };

/**
 * Read the redemption out of a parsed JSON body.
 *
 * Refuses everything it does not recognise rather than coercing it: this is the
 * one endpoint on the Core where the sender is unauthenticated, so "was it a
 * string?" is the last question asked before the answer is used in a
 * cryptographic operation.
 */
function parseRedeemRequest(body: unknown): ParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "not-an-object", message: "the body must be a JSON object" };
  }
  const o = body as Record<string, unknown>;
  const sessionId = o.sessionId;
  const code = o.code;
  const csr = o.csr;
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 128) {
    return { ok: false, reason: "bad-session-id", message: "`sessionId` must be a non-empty string" };
  }
  if (typeof code !== "string" || code.length === 0 || code.length > 64) {
    return { ok: false, reason: "bad-code", message: "`code` must be a non-empty string" };
  }
  if (typeof csr !== "string" || !csr.includes("BEGIN CERTIFICATE REQUEST")) {
    return { ok: false, reason: "bad-csr", message: "`csr` must be a PEM certificate request" };
  }
  const client = o.client;
  const label =
    client && typeof client === "object" && typeof (client as Record<string, unknown>).label === "string"
      ? String((client as Record<string, unknown>).label).slice(0, 64)
      : null;
  return { ok: true, value: { sessionId, code, label, csr } };
}

type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string; refusal: Refusal };

/**
 * Read the request body, refusing anything over {@link MAX_REDEEM_BODY_BYTES}.
 *
 * The cap is enforced as the bytes arrive, not against `content-length`: a
 * `content-length` is whatever the sender wrote, and a chunked body has none at
 * all.
 *
 * Past the cap nothing is kept, and the rest of the body is **drained rather
 * than cut off**. Destroying the socket there is the obvious move and it is
 * wrong: the refusal would be written into a connection that is about to be
 * reset, so a client sending one byte too many would see a dropped connection
 * instead of the `413` telling it why. Draining costs the read of a body the
 * sender has already put on the wire, and it stops at
 * {@link DRAIN_CEILING_BYTES} — past *that* the sender is not a client that
 * mis-sized a request, and the socket goes.
 */
function readJsonBody(req: IncomingMessage): Promise<BodyResult> {
  const contentType = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (contentType !== "" && contentType !== "application/json") {
    return Promise.resolve({
      ok: false,
      reason: "content-type",
      refusal: {
        status: 415,
        code: "unsupported-media-type",
        message: "a redemption is `application/json`",
      },
    });
  }
  return new Promise<BodyResult>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    let settled = false;
    const settle = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REDEEM_BODY_BYTES) {
        tooBig = true;
        chunks.length = 0;
        if (size > DRAIN_CEILING_BYTES) {
          settle({ ok: false, reason: "too-large", refusal: tooLarge() });
          req.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooBig) return settle({ ok: false, reason: "too-large", refusal: tooLarge() });
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        settle({
          ok: false,
          reason: "bad-json",
          refusal: { status: 400, code: "bad-request", message: "the body was not JSON" },
        });
        return;
      }
      settle({ ok: true, value: parsed });
    });
    req.on("error", () => {
      settle({
        ok: false,
        reason: "read-failed",
        refusal: { status: 400, code: "bad-request", message: "the request body could not be read" },
      });
    });
  });
}

function tooLarge(): Refusal {
  return {
    status: 413,
    code: "payload-too-large",
    message: `a redemption is at most ${MAX_REDEEM_BODY_BYTES} bytes`,
  };
}

/**
 * The address this attempt came from, for the audit log.
 *
 * `unknown` rather than an empty string when the socket has already gone: a log
 * line that says where it came from and a log line that says nothing must not
 * look the same.
 */
function peerOf(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * A label as it can appear inside a certificate subject.
 *
 * The operator typed this, and it ends up in an X.509 distinguished name where
 * `,`, `=` and `+` are structure rather than text. Everything outside a
 * conservative set is replaced rather than escaped: a certificate subject is
 * not the place to be clever, and no operator will miss the difference between
 * `my laptop` and `my-laptop` in a `pair ls` row.
 */
function certCommonName(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9 ._-]/g, "-").trim().slice(0, 48);
  return cleaned.length > 0 ? cleaned : "paired-client";
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendRefusal(res: ServerResponse, refusal: Refusal): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ code: refusal.code, error: refusal.message });
  res.writeHead(refusal.status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    ...refusal.headers,
  });
  res.end(body);
}
