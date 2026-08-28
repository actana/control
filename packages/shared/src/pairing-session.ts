// The pending pairing session — what the Core holds between `actana pair new`
// and the client redeeming the code (#280, #281).
//
// Everything here is a pure function over a plain object. The session is
// minted, expired, attempted against and consumed by the Core, which owns the
// clock, the store and the audit log; this module owns only the rules, so it
// takes `now` as an argument in the manner of `verifyBearer`'s injectable
// clock in `core-link-bearer.ts`. Nothing here reads a socket, a disk or a
// clock it was not handed, and no test needs fake timers to walk a session
// past its expiry.
//
// The three defences the design fixes on (#280 "Security properties") are
// deliberately separate: a **TTL** bounds how long a code is worth stealing, a
// **cap of five wrong attempts** bounds guessing within one session, and
// **single use** stops a redeemed code being replayed. Each has its own field
// and its own transition below, so a change to one cannot silently weaken
// another. Rate limiting on the endpoint is the fourth defence and is *not*
// here — it is per-caller, not per-session, and belongs to the server that can
// see callers.
//
// These are internals, not wire types: `packages/shared` is private and stays
// private ([ADR 0025][adr] D4). The redemption request and response are the
// SDK's to declare, for the reason written out at the top of
// `packages/sdk/src/core-registration-blob.ts`.
//
// [adr]: ../../../docs/adr/0025-the-protocol-ships-with-the-client.md

/** How long a freshly minted session stays redeemable. Five minutes (#280). */
export const PAIRING_SESSION_TTL_MS = 5 * 60 * 1000;

/** Wrong codes a single session tolerates before it is dead (#280). */
export const PAIRING_ATTEMPT_CAP = 5;

/**
 * A pending pairing session.
 *
 * `codeHash` is a digest, not the code: the plaintext is printed once to the
 * operator's terminal and never stored, so a stolen session store is not a
 * pile of live pairing codes. Which digest is the Core's business — this
 * module compares nothing and only carries the field.
 *
 * `created_by`, `tenant_id` and `auth_method` are **inert today**. #280 keeps a
 * later OIDC layer able to gate *who may create a pairing session* without a
 * protocol change, and these three are the hooks it will read; nothing in this
 * feature train writes or enforces them. They keep the snake_case of the
 * columns they will become so that the identity work does not have to rename
 * anything to find them.
 */
export type PairingSession = {
  /** Opaque session id — what a redemption names, so it cannot be replayed
   *  against a different session. */
  id: string;
  /** Operator-supplied name for the machine being paired. Display only. */
  label: string;
  /** Digest of the pairing code. Never the code itself — see above. */
  codeHash: string;
  /** Wall-clock ms at mint. */
  createdAt: number;
  /** Wall-clock ms after which the session is no longer redeemable. */
  expiresAt: number;
  /** Wrong codes seen so far, capped at `attemptCap`. */
  attempts: number;
  /** This session's cap, copied at mint so a config change cannot retroactively
   *  revive or kill sessions already in flight. */
  attemptCap: number;
  /** Wall-clock ms of the successful redemption, or `null` while pending. A
   *  timestamp rather than a boolean because the audit log wants to say when. */
  consumedAt: number | null;
  /**
   * Wall-clock ms of `actana pair revoke` cancelling this session before it was
   * redeemed, or `null` while it stands (#283).
   *
   * Its own field rather than a `consumedAt` stamp, and the difference is not
   * cosmetic: a cancelled session was never redeemed, so nobody holds a
   * certificate for it, and an operator reading `actana pair ls` or the audit
   * log after the fact has to be able to tell "somebody used this code" from "I
   * took it back". Optional on the type because sessions written before this
   * field existed are still valid sessions — see {@link isRevoked}.
   */
  revokedAt?: number | null;
  /**
   * Which of this Core's configured public hosts this pairing's redemption
   * hands back as its endpoint, or `null`/absent for the primary (#347).
   *
   * The one address-shaped field on a pairing session, and it is here rather
   * than resolved at redemption time because the Core has to answer "where do I
   * tell *this* client to dial me?" from something it stored when the operator
   * minted the code — never from the request. A `Host` header is chosen by the
   * caller, and a client that pinned it would have pinned whatever an attacker
   * wrote there; `core-pairing-routes.ts` says so at the option that reads this.
   *
   * **It can only ever name a host the certificate already covers.** `actana
   * pair new --public-host` refuses an address that is not in the Core's
   * recorded SAN list, and the resolver on the daemon side falls back to the
   * primary for a stored value that is no longer configured — so a pairing code
   * cannot introduce a name a client would fail hostname verification against.
   *
   * Optional, because a session written before this field existed is still a
   * session, and it means what it has always meant: the primary.
   */
  endpointHost?: string | null;
  /** Inert (#280): the identity that created the session, once there is one. */
  created_by: string | null;
  /** Inert (#280): the tenant the session belongs to, once there are tenants. */
  tenant_id: string | null;
  /** Inert (#280): how that identity authenticated, once it authenticates. */
  auth_method: string | null;
};

/** What a caller must supply to mint a session; everything else is derived. */
export type NewPairingSession = {
  id: string;
  label: string;
  codeHash: string;
  /** Mint time. The caller's clock, never this module's. */
  now: number;
  /** Override the five-minute default, e.g. `actana pair new --ttl`. */
  ttlMs?: number;
  /** Override the cap of five. Present for tests and future policy, not for a
   *  caller looking for a way around the cap. */
  attemptCap?: number;
  /**
   * `actana pair new --public-host` — which configured host this one code hands
   * back (#347). Omitted is the primary, which is what every code did before.
   *
   * Validated by the caller, not here: membership is a question about the
   * Core's certificate, and this module owns the rules of a session rather than
   * the identity of a Core.
   */
  endpointHost?: string;
};

/**
 * Mint a pending session. The three future-proofing fields default to `null`
 * here and are set by nothing in this train — see `PairingSession`.
 */
export function createPairingSession(input: NewPairingSession): PairingSession {
  const ttlMs = input.ttlMs ?? PAIRING_SESSION_TTL_MS;
  return {
    id: input.id,
    label: input.label,
    codeHash: input.codeHash,
    createdAt: input.now,
    expiresAt: input.now + ttlMs,
    attempts: 0,
    attemptCap: input.attemptCap ?? PAIRING_ATTEMPT_CAP,
    consumedAt: null,
    revokedAt: null,
    endpointHost: input.endpointHost ?? null,
    created_by: null,
    tenant_id: null,
    auth_method: null,
  };
}

/**
 * Has the session outlived its TTL at `now`?
 *
 * Inclusive at the boundary — a session whose `expiresAt` is exactly `now` is
 * still live — matching `verifyBearer`, which treats `exp === now` as valid.
 * One rule for "expiry" across the two things a Core times out is worth more
 * than the millisecond either way.
 */
export function isExpired(session: PairingSession, now: number): boolean {
  return now > session.expiresAt;
}

/** Has the cap been reached? A dead session can never be redeemed again. */
export function isDead(session: PairingSession): boolean {
  return session.attempts >= session.attemptCap;
}

/** Has the session already been redeemed? Single use is single use. */
export function isConsumed(session: PairingSession): boolean {
  return session.consumedAt !== null;
}

/**
 * Has the operator taken this session back with `actana pair revoke` (#283)?
 *
 * `?? null` rather than `!== null`, because the field is optional: a session
 * persisted before it existed has no `revokedAt` at all, and `undefined !==
 * null` would read every one of them as revoked — which would kill every
 * pending session on a Core the moment it upgraded.
 */
export function isRevoked(session: PairingSession): boolean {
  return (session.revokedAt ?? null) !== null;
}

/** Why a session would refuse a redemption. Ordered by how it is checked. */
export type PairingRefusal = "expired" | "attempts-exhausted" | "already-consumed" | "revoked";

export type PairingRedeemability =
  | { ok: true }
  | { ok: false; reason: PairingRefusal };

/**
 * May this session be redeemed at `now`? A typed reason rather than a boolean,
 * so the caller can audit-log *which* defence refused — the same shape
 * `verifyBearer` returns, and for the same reason.
 *
 * The caller still has to check the code itself; this is only the state gate.
 */
export function canRedeem(session: PairingSession, now: number): PairingRedeemability {
  // Revocation is checked first because it is the operator's own decision, and
  // it is the answer the audit log should carry when several of these are true
  // at once — a session revoked and then left to expire was revoked.
  if (isRevoked(session)) return { ok: false, reason: "revoked" };
  if (isConsumed(session)) return { ok: false, reason: "already-consumed" };
  if (isDead(session)) return { ok: false, reason: "attempts-exhausted" };
  if (isExpired(session, now)) return { ok: false, reason: "expired" };
  return { ok: true };
}

/**
 * Record a wrong code. Returns the next session — the input is never mutated,
 * so a caller that fails to persist has not already changed its in-memory copy.
 *
 * The counter stops at the cap rather than climbing past it: past the cap the
 * session is dead and the exact number of attempts beyond it says nothing,
 * while an unbounded counter invites `attempts > attemptCap` states that every
 * later reader has to reason about.
 */
export function recordWrongAttempt(session: PairingSession): PairingSession {
  return { ...session, attempts: Math.min(session.attempts + 1, session.attemptCap) };
}

export type PairingConsumeResult =
  | { ok: true; session: PairingSession }
  | { ok: false; reason: PairingRefusal };

/**
 * Redeem the session once, stamping `consumedAt`. A second consume is refused
 * with `already-consumed`, which is the whole of single use: the Core writes
 * the returned session back and any replay of the same code meets this branch.
 */
export function consumePairingSession(
  session: PairingSession,
  now: number,
): PairingConsumeResult {
  const gate = canRedeem(session, now);
  if (!gate.ok) return gate;
  return { ok: true, session: { ...session, consumedAt: now } };
}
