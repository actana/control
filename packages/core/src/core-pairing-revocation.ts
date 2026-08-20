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

/** The paired-client rows this module reads. `PairingStore` satisfies it. */
export interface RevokedClientsPort {
  listClients(): PairedClient[];
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

/**
 * This Core's revoked serials, re-read from the store on demand.
 *
 * Held as a set rather than re-read per question because the questions are
 * asked on the hot path — every request and every upgrade — and the answers
 * only change when {@link refresh} says so. The sweep is what calls `refresh`,
 * so "how stale can this be" has exactly one answer and it is the sweep
 * interval.
 */
export class PairingRevocations {
  private revoked = new Set<string>();

  constructor(private readonly clients: RevokedClientsPort) {}

  /**
   * Re-read the store. Returns the serials revoked **since the last read**, in
   * their stored spelling, so a caller can act on the new ones without acting
   * on every one it has already handled.
   *
   * A store that cannot be read leaves the set exactly as it was and returns
   * nothing. Failing that way round is deliberate: an unreadable pairing file
   * must never be read as "nobody is revoked", which is the one interpretation
   * that hands a revoked client its access back.
   */
  refresh(): string[] {
    let rows: PairedClient[];
    try {
      rows = this.clients.listClients();
    } catch (err) {
      log.warn("core-pairing.revocation.unreadable", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
    const fresh: string[] = [];
    for (const row of rows) {
      if (row.revokedAt === null) continue;
      const key = normaliseCertSerial(row.certSerial);
      if (this.revoked.has(key)) continue;
      this.revoked.add(key);
      fresh.push(row.certSerial);
    }
    return fresh;
  }

  /** Is this certificate serial revoked? `null` — no peer certificate — is not. */
  isRevoked(certSerial: string | null | undefined): boolean {
    if (!certSerial) return false;
    return this.revoked.has(normaliseCertSerial(certSerial));
  }

  /** Is the pairing this bearer speaks for revoked? A bearer with no
   *  `pair:` subject is one this Core minted before pairing existed, and it is
   *  governed by its own expiry rather than by a list it is not on. */
  isBearerSubjectRevoked(sub: string | undefined): boolean {
    return this.isRevoked(certSerialFromBearerSubject(sub));
  }
}

/** A running sweep. Stopped with the daemon, like every other Core timer. */
export type PairingRevocationSweep = { stop(): void };

/**
 * Poll the store and hand every newly revoked serial to `onRevoked`.
 *
 * The first read happens immediately and its results are **not** dispatched:
 * at boot, every revocation already on file was made against a link that does
 * not exist any more, and reporting them would ask the server to close
 * connections that were never opened. What the first read does is seed the set,
 * so that `isRevoked` is right from the first request rather than from one
 * second in.
 */
export function startPairingRevocationSweep(opts: {
  revocations: PairingRevocations;
  onRevoked: (certSerials: string[]) => void;
  intervalMs?: number;
}): PairingRevocationSweep {
  opts.revocations.refresh();
  const timer = setInterval(() => {
    const fresh = opts.revocations.refresh();
    if (fresh.length === 0) return;
    log.info("pairing.revoked", { certSerials: fresh });
    opts.onRevoked(fresh);
  }, opts.intervalMs ?? REVOCATION_SWEEP_MS);
  // Never the reason this process stays alive: a Core with nothing else to do
  // should exit, and a one-second timer would keep it running forever.
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
