// What a revoked pairing means to the running daemon (#283).
//
// `actana pair revoke` runs in the `actana` CLI, in a different process, and
// all it can do there is stamp `revokedAt` on a row in the pairing store. That
// stamp is a record, not an enforcement: the certificate it names is still one
// this Core's CA signed, the bearer it issued still verifies against the same
// secret, and any core link the client already has open is still carrying
// frames. Nothing about revocation is true until this module makes it true.
//
// So there are two halves here, and they answer two different questions:
//
//   1. **Is this credential revoked?** — asked at the TLS gate on every request
//      and every upgrade, and at the `auth` frame. That is what stops a revoked
//      client coming *back*.
//   2. **What has just been revoked?** — asked on a timer, so a link that is
//      already open is closed rather than left running until its next
//      handshake, which for a healthy Panel is never. {@link
//      startPairingRevocationSweep} is that timer.
//
// **Polling, not watching.** `fs.watch` is per-platform, misses writes behind a
// rename on some filesystems — and a rename is exactly how `PairingStore`
// writes — and reports nothing at all on some network mounts. A one-second
// read of a small JSON file is a cost this Core does not notice, and it is the
// same code path on every platform. The bound it buys is stated plainly: a
// revoked client's live link is closed within {@link REVOCATION_SWEEP_MS}, not
// instantly.
//
// The store is reached through a port rather than the class, the way
// `PairingSessionPort` is in `core-pairing-routes.ts`: this module is driven
// from tests against an in-memory list, and `PairingStore` satisfies it
// structurally.

import log from "@actana/shared/log";
import type { PairedClient } from "@actana/shared/pairing-store";

/** How often the daemon re-reads the store looking for fresh revocations. */
export const REVOCATION_SWEEP_MS = 1_000;

/**
 * The paired-client rows this module reads. `PairingStore` satisfies it.
 *
 * `readStrict` rather than `listClients`, and the difference is the whole of
 * {@link PairingRevocations.refresh}'s guarantee. `PairingStore.read` swallows
 * every failure and answers with an empty store, which makes "this Core has
 * revoked nobody" and "this Core cannot tell you who it revoked" the same
 * answer — and the second one must never be served as the first.
 */
export interface RevokedClientsPort {
  /** Every row on file, or throw saying why the file could not be read. */
  readStrict(): { clients: PairedClient[] };
}

/**
 * The `sub` claim a paired client's bearer carries — `pair:<serial>`.
 *
 * One function for the whole repository. The endpoint mints the claim and this
 * module takes it apart, and a prefix that two files spelled independently
 * would fail open the first time either changed it: a `sub` that no longer
 * parses is a bearer that is never found to be revoked.
 */
export function pairingBearerSubject(certSerial: string): string {
  return `${BEARER_SUBJECT_PREFIX}${certSerial}`;
}

const BEARER_SUBJECT_PREFIX = "pair:";

/** The serial inside a `pair:<serial>` subject, or `null` for anything else. */
export function certSerialFromBearerSubject(sub: string | undefined): string | null {
  if (!sub || !sub.startsWith(BEARER_SUBJECT_PREFIX)) return null;
  const serial = sub.slice(BEARER_SUBJECT_PREFIX.length);
  return serial.length > 0 ? serial : null;
}

/**
 * One spelling of a certificate serial, so two spellings of one certificate
 * cannot be one revoked and one not.
 *
 * The same serial reaches this module three ways and none of them agree on
 * presentation: `@peculiar/x509` issues it lower-case, Node's
 * `getPeerCertificate().serialNumber` reports it upper-case, and a serial that
 * came back through JSON may have kept a leading zero one of them dropped. Hex
 * only, upper case, no leading zeros — a comparison on anything less would let
 * a revoked client back in on a difference of case.
 */
export function normaliseCertSerial(serial: string): string {
  return serial.replace(/[^0-9a-fA-F]/g, "").toUpperCase().replace(/^0+(?=.)/, "");
}

/** What one {@link PairingRevocations.refresh} found. */
export type RevocationRefresh =
  /** The store was read. `revoked` is what was newly revoked since last time. */
  | { ok: true; revoked: string[] }
  /** The store could not be read, so every pairing is treated as revoked. */
  | { ok: false; error: string };

/**
 * This Core's revoked serials, re-read from the store on demand.
 *
 * Held as a set rather than re-read per question because the questions are
 * asked on the hot path — every request and every upgrade — and the answers
 * only change when {@link refresh} says so. The sweep is what calls `refresh`,
 * so "how stale can this be" has exactly one answer and it is the sweep
 * interval.
 *
 * **When the store cannot be read, everything is revoked.** Not "nothing is",
 * and not "whatever we happened to know last time": those are both the reading
 * that hands a revoked client its access straight back, and boot — where there
 * is no last time — is exactly when the question is asked. See
 * {@link failClosed}.
 */
export class PairingRevocations {
  private revoked = new Set<string>();
  /**
   * True while the last read failed. Every pairing-issued credential is
   * revoked for as long as it is set.
   *
   * Cleared by the next successful read, so the state is a fact about the
   * store as it is now rather than a latch an operator has to reset. An
   * operator recovers by making the file readable again — `actana pair new`
   * refuses to rewrite an unreadable one precisely so that recovery cannot be
   * "delete the record of who was revoked".
   */
  private failClosed = false;

  constructor(private readonly clients: RevokedClientsPort) {}

  /**
   * Re-read the store.
   *
   * On success, reports the serials revoked **since the last read**, in their
   * stored spelling, so a caller can act on the new ones without acting on
   * every one it has already handled.
   *
   * On failure, reports why and switches this Core to refusing every
   * pairing-issued credential. That is the fail-closed direction, and it is
   * chosen knowing what it costs: a Core whose `pairing.json` is corrupt stops
   * serving every client it ever paired. The alternative costs more — a
   * half-written file, a hand-edit, or a row this build does not recognise
   * would silently un-revoke every certificate an operator has taken back.
   */
  refresh(): RevocationRefresh {
    let rows: PairedClient[];
    try {
      rows = this.clients.readStrict().clients;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (!this.failClosed) {
        log.error("core-pairing.revocation.unreadable", { error, effect: "every pairing refused" });
      }
      this.failClosed = true;
      return { ok: false, error };
    }
    this.failClosed = false;
    const fresh: string[] = [];
    for (const row of rows) {
      if (row.revokedAt === null) continue;
      const key = normaliseCertSerial(row.certSerial);
      if (this.revoked.has(key)) continue;
      this.revoked.add(key);
      fresh.push(row.certSerial);
    }
    return { ok: true, revoked: fresh };
  }

  /** Is this Core currently refusing every pairing because it cannot read the store? */
  isFailClosed(): boolean {
    return this.failClosed;
  }

  /**
   * Is this certificate serial revoked?
   *
   * `null` — no peer certificate at all — is not, even while failing closed.
   * "No certificate" and "a revoked certificate" are different facts and
   * different gates answer them: `clientCertGate` refuses an uncertificated
   * caller everywhere but the pairing endpoint, and that endpoint is the one an
   * operator needs reachable to recover. Answering `true` here would close the
   * only door out of a corrupt store.
   */
  isRevoked(certSerial: string | null | undefined): boolean {
    if (!certSerial) return false;
    if (this.failClosed) return true;
    return this.revoked.has(normaliseCertSerial(certSerial));
  }

  /**
   * Is the pairing this bearer speaks for revoked?
   *
   * A bearer with no `pair:` subject is one this Core minted before pairing
   * existed — the hand-carried registration blob — and it is governed by its
   * own expiry rather than by a list it is not on. That holds while failing
   * closed too, and deliberately: such a bearer is not a pairing, so there is
   * no row about it that could have gone unread, and it is the credential the
   * operator's own Panel is holding while they go and fix the file.
   */
  isBearerSubjectRevoked(sub: string | undefined): boolean {
    return this.isRevoked(certSerialFromBearerSubject(sub));
  }
}

/** A running sweep. Stopped with the daemon, like every other Core timer. */
export type PairingRevocationSweep = { stop(): void };

/**
 * Poll the store and call `onRevoked` whenever what is revoked has changed.
 *
 * `onRevoked` takes no arguments and that is deliberate: the caller re-asks
 * this object about every connection it holds rather than being handed a list.
 * A list would carry only the *newly named* serials, and the change that most
 * needs acting on carries no serials at all — switching to fail-closed revokes
 * every pairing at once, including ones whose rows were never read.
 *
 * The first read happens immediately and does **not** call back: at boot, every
 * revocation already on file was made against a link that does not exist any
 * more, and reporting them would ask the server to close connections that were
 * never opened. What the first read does is seed the set — or, if the store is
 * unreadable, put this Core into fail-closed before it serves its first
 * request, which is the moment the guarantee has to hold.
 */
export function startPairingRevocationSweep(opts: {
  revocations: PairingRevocations;
  onRevoked: () => void;
  intervalMs?: number;
}): PairingRevocationSweep {
  opts.revocations.refresh();
  let wasFailClosed = opts.revocations.isFailClosed();
  const timer = setInterval(() => {
    const result = opts.revocations.refresh();
    const nowFailClosed = !result.ok;
    // Two things count as a change, and the second is the one a list could not
    // express: fresh serials, or crossing into fail-closed. Crossing back out
    // does not — nothing became revoked by the store becoming readable again.
    const enteredFailClosed = nowFailClosed && !wasFailClosed;
    wasFailClosed = nowFailClosed;
    if (result.ok && result.revoked.length > 0) {
      log.info("pairing.revoked", { certSerials: result.revoked });
    } else if (!enteredFailClosed) {
      return;
    }
    opts.onRevoked();
  }, opts.intervalMs ?? REVOCATION_SWEEP_MS);
  // Never the reason this process stays alive: a Core with nothing else to do
  // should exit, and a one-second timer would keep it running forever.
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
