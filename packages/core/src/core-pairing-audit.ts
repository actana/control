// The audit record of every pairing attempt (#280, #282).
//
// Pairing is the one thing on a Core that turns knowledge of a short code into
// a certificate this Core's CA vouches for, so "who asked, when, and what did
// they get" is the record an operator needs after the fact — and needs for
// failures as much as for successes, because a run of failures is what an
// attack looks like from here.
//
// The whole of this module is one shape and one rule:
//
//   **What is logged is built from a fixed list of fields, never from the
//   request.** The pairing code, the CSR and any key material are not on that
//   list and cannot be added to it by a caller. A log line is the easiest place
//   in this feature for a secret to end up — it is written on the failure path,
//   it is read by people, and it outlives the request by however long the log
//   is kept — so the redaction is a function with a test rather than a
//   convention with a comment.
//
// The default sink is this repo's `log`, which is where every other Core-side
// event goes; the seam exists so a test can read what was written, and so that
// a later "ship the audit trail somewhere" has one place to attach.

import log from "@actana/shared/log";

/** What happened to one attempt. */
export type PairingOutcome =
  /** A certificate was issued. The only outcome that changes anything. */
  | "issued"
  /** The code, or the session's state, refused it. Indistinguishable on the wire. */
  | "refused"
  /** The endpoint's rate limit turned it away before the session was looked at. */
  | "rate-limited"
  /** The request was not shaped like a redemption at all. */
  | "bad-request"
  /** The Core failed — a CA key it could not read, a disk it could not write. */
  | "core-error";

/**
 * One attempt, as the audit log records it.
 *
 * Every field is optional except the three that are always knowable, because a
 * request refused before it was parsed still has to be logged: an attacker who
 * could avoid the audit log by sending garbage would have found the way to
 * knock quietly.
 */
export type PairingAuditEvent = {
  outcome: PairingOutcome;
  /**
   * The internal reason, for the operator reading the log — `wrong-code`,
   * `expired`, `unknown-session`.
   *
   * This is exactly the distinction the *response* refuses to draw (#282: an
   * expired, consumed, unknown or dead session is refused identically). Here it
   * is safe and necessary: the log is on the Core, read by the person who owns
   * the Core, and the whole point of the uniform refusal is that the client
   * cannot see this.
   */
  reason?: string;
  /** The session the attempt named, when it named one that parsed. */
  sessionId?: string | null;
  /** The operator's label for that session. Display-only, and never a secret. */
  label?: string | null;
  /** Where the request came from — `req.socket.remoteAddress`. */
  peer: string;
  /** Wrong codes counted against the session after this attempt. */
  attempts?: number;
  /** The serial of the certificate issued, on the one outcome that issues. */
  certSerial?: string;
  /** Wall-clock ms. */
  at: number;
};

/**
 * The fields that may be written, in the order they are written.
 *
 * A list rather than a spread, and that is the whole mechanism: a field added
 * to {@link PairingAuditEvent} later is not logged until somebody adds it here,
 * which is a line in a diff a reviewer can see rather than a secret that
 * appeared in a log because a type grew.
 */
const LOGGED_FIELDS = [
  "outcome",
  "reason",
  "sessionId",
  "label",
  "peer",
  "attempts",
  "certSerial",
  "at",
] as const satisfies readonly (keyof PairingAuditEvent)[];

/** Where an audit record goes. Injectable so a test can read what was written. */
export type PairingAuditSink = (record: Record<string, unknown>) => void;

/**
 * Reduce an event to the fields that may be logged.
 *
 * Absent fields are dropped rather than written as `undefined`, so a line about
 * a request that never named a session does not carry an empty `sessionId` for
 * a reader to wonder about.
 */
export function redactPairingAuditEvent(event: PairingAuditEvent): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const field of LOGGED_FIELDS) {
    const value = event[field];
    if (value === undefined) continue;
    record[field] = value;
  }
  return record;
}

/** The default sink: one structured line per attempt, at info. */
export const logPairingAudit: PairingAuditSink = (record) => {
  log.info("pairing.attempt", record);
};

/**
 * Build the audit function the endpoint calls.
 *
 * The redaction happens here rather than in the sink, so that every sink — this
 * repo's log today, something else later — gets the same already-safe record
 * and none of them has to be trusted to redact.
 */
export function pairingAuditor(sink: PairingAuditSink = logPairingAudit): (event: PairingAuditEvent) => void {
  return (event) => {
    try {
      sink(redactPairingAuditEvent(event));
    } catch {
      // An audit sink that throws must not take the request with it. The
      // attempt has already been decided by the time this runs; losing the
      // record is bad, and answering a paired client with a 500 because the
      // log was unwritable is worse.
    }
  };
}
