// Where a Core keeps its pending pairing sessions and the clients it has
// already paired (#280, #282).
//
// `pairing-session.ts` owns the *rules* — TTL, the attempt cap, single use —
// and holds no state at all. This module is the other half: one JSON file, read
// and rewritten under it, so that the two processes that need a pairing session
// can both see it. There are two, and that is the whole reason this file lives
// in `packages/shared` rather than beside the endpoint in `packages/core`:
//
//   • **`actana pair new`** (#283) mints the session and prints the code. It
//     runs in the `actana` CLI, and `actana-cli-entry.ts` says why that binary
//     never imports `@actana/core` — one binary does both jobs by keeping the
//     daemon's bundle out of its own.
//   • **The Core daemon** redeems it, at the pre-auth endpoint in
//     `packages/core/src/core-pairing-routes.ts`.
//
// So this sits next to `core-material-store.ts`, which is in `packages/shared`
// for exactly that reason after #288 — the CLI writes the material and the
// daemon reads it — and it deliberately mirrors that module's shape: a JSON
// file at a path derived from the material file, 0600 because what is in it is
// sensitive, and a reader that treats a corrupt file as "nothing here" rather
// than crashing a daemon at boot.
//
// **What is sensitive here is not the code.** The plaintext pairing code is
// printed once to the operator's terminal and never written down; what is
// stored is a keyed digest of it (see {@link hashPairingCode}), so a copy of
// this file is not a copy of the live codes.
//
// Core-side only — never imported by the browser.

import { createHmac, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PairingRefusal, PairingSession } from "./pairing-session";
import { canRedeem, isConsumed, isRevoked, recordWrongAttempt } from "./pairing-session";

/** The filename, beside `material.json` in the same directory. */
export const PAIRING_STORE_FILENAME = "pairing.json";

/**
 * The pairing file for a Core whose material file is `materialFile`.
 *
 * Derived from the material path rather than configured separately: the daemon
 * is handed exactly one path (`AC_CORE_MATERIAL_FILE`), a container mounts
 * exactly one volume, and a second env var to keep in step with it is a second
 * thing to get wrong. It has to sit beside the material anyway — the digest a
 * session stores is keyed by the bearer secret in that file.
 */
export function pairingStorePath(materialFile: string): string {
  return path.join(path.dirname(materialFile), PAIRING_STORE_FILENAME);
}

/**
 * A client this Core has paired — one row per issued certificate.
 *
 * This is what `actana pair ls` lists and what `actana pair revoke` revokes
 * (#283), which is why the certificate's serial is here: the serial is the only
 * thing that names one issuance unambiguously, where a label is whatever the
 * operator typed twice.
 */
export type PairedClient = {
  /** The certificate serial, hex. The identity of this pairing. */
  certSerial: string;
  /** The certificate subject as issued, e.g. `CN=laptop`. */
  certSubject: string;
  /** The operator's name for the machine, carried over from the session. */
  label: string;
  /** The session this client redeemed. Kept so an audit can join the two. */
  sessionId: string;
  /** Wall-clock ms of the successful redemption. */
  pairedAt: number;
  /** Wall-clock ms the issued certificate stops verifying. */
  certNotAfter: number;
  /** Wall-clock ms of `actana pair revoke`, or `null` while the pairing stands. */
  revokedAt: number | null;
  /** Inert (#280): copied from the session, for a later identity layer. */
  created_by: string | null;
  /** Inert (#280). */
  tenant_id: string | null;
  /** Inert (#280). */
  auth_method: string | null;
};

/** The file's shape. Versioned so a later change can migrate rather than guess. */
export type PairingRecords = {
  version: 1;
  sessions: PairingSession[];
  clients: PairedClient[];
};

/** An empty store — what a missing or unreadable file reads as. */
export function emptyPairingRecords(): PairingRecords {
  return { version: 1, sessions: [], clients: [] };
}

/**
 * How long a session stays in the file after it stops being redeemable.
 *
 * Expired and consumed sessions are kept for a day rather than deleted on the
 * spot, because they are what an operator reads when asking why a pairing
 * failed an hour ago. Beyond that they are only file size: the refusal a
 * pruned session produces is byte-identical to the one it produced while it
 * was still there (see {@link PairingStore.consume}), so pruning cannot change
 * what any client observes.
 */
export const PAIRING_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;

export type PairingConsumeOutcome =
  | { ok: true; session: PairingSession }
  | { ok: false; reason: PairingRefusal | "unknown" };

/**
 * The pairing file, as the daemon and the CLI both drive it.
 *
 * Every method reads the file, changes what it must and writes it back, rather
 * than holding the parsed records in memory. That is a deliberate cost: the
 * CLI and the daemon are two processes over one file, and an in-memory copy in
 * the daemon would go stale the moment an operator ran `actana pair new` — the
 * exact sequence pairing consists of.
 *
 * **What this gives, and what it does not.** Within one process the
 * read-mutate-write in {@link consume} runs to completion without yielding, so
 * two concurrent redemptions cannot both find the session unconsumed: the
 * second one sees `already-consumed` and the endpoint refuses it. Across
 * processes there is no lock, and a `pair new` landing in the same millisecond
 * as a redemption can lose its write. That trade is taken knowingly — the
 * alternative is a lockfile protocol between a daemon and a one-shot CLI for a
 * collision measured in milliseconds a few times in a Core's life, and the
 * failure it would prevent is "the operator runs `pair new` again".
 */
export class PairingStore {
  constructor(private readonly filePath: string) {}

  /**
   * Everything on disk. A missing, corrupt or wrong-shaped file reads as empty,
   * and a single unrecognised row is dropped while the rest are kept.
   *
   * That leniency is right for every writer here — a daemon must not fail to
   * boot because a file it is about to rewrite is malformed — and **wrong for
   * anything whose safety depends on the contents**, because it makes "this
   * Core has revoked nobody" and "this Core cannot tell you who it revoked"
   * the same answer. A reader in that position uses {@link readStrict}.
   */
  read(): PairingRecords {
    try {
      return this.parse(false);
    } catch {
      return emptyPairingRecords();
    }
  }

  /**
   * Everything on disk, or throw saying why it could not be read.
   *
   * The distinction {@link read} cannot draw, for the one caller that must:
   * `core-pairing-revocation.ts` treats an unreadable store as *everything is
   * revoked*, and it can only do that if being unable to read is a different
   * outcome from reading nothing.
   *
   * **A file that is not there is not an error.** A Core that has never paired
   * anything has no `pairing.json`, and a reader that failed closed on its
   * absence would refuse every client on every fresh Core. Every *other* read
   * failure — a permission this process does not have, an I/O error, a
   * half-written document, a row whose shape this build does not recognise —
   * throws, because each of them is a state in which a revoked row could be
   * sitting in this file unseen.
   */
  readStrict(): PairingRecords {
    return this.parse(true);
  }

  /**
   * The one reader, in its two moods.
   *
   * Written once rather than twice on purpose: the lenient and the strict
   * reader must agree about what a *good* file contains, and two parsers would
   * be two chances to disagree — the strict one accepting a document the
   * lenient one silently trimmed, or the reverse.
   */
  private parse(strict: boolean): PairingRecords {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (err) {
      // Absent is empty in both moods. It is the state of a Core that has
      // paired nobody, not a failure to read one that has.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyPairingRecords();
      throw new Error(`${this.filePath} could not be read: ${errorText(err)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${this.filePath} is not valid JSON: ${errorText(err)}`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`${this.filePath} is not a pairing store`);
    }
    const o = parsed as Partial<PairingRecords>;
    return {
      version: 1,
      sessions: this.rows(o.sessions, isPairingSession, "session", strict),
      clients: this.rows(o.clients, isPairedClient, "client", strict),
    };
  }

  /**
   * One list of rows: filtered when lenient, checked when strict.
   *
   * Absent is empty either way — a document that never grew a `clients` key has
   * no clients. Present and wrong, or one unrecognised row, is where the two
   * moods part: the lenient reader drops it, and a dropped row is exactly what
   * a revoked client's row would look like to a reader that must not miss one.
   */
  private rows<T>(
    value: unknown,
    isRow: (row: unknown) => row is T,
    what: string,
    strict: boolean,
  ): T[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      if (!strict) return [];
      throw new Error(`${this.filePath}: ${what}s is not a list`);
    }
    if (!strict) return value.filter(isRow);
    return value.map((row, index) => {
      if (!isRow(row)) {
        throw new Error(`${this.filePath}: ${what} ${index} is not a ${what} this build knows`);
      }
      return row;
    });
  }

  /** Add a freshly minted session. `actana pair new`'s one write. */
  createSession(session: PairingSession, now: number = Date.now()): void {
    const records = this.read();
    records.sessions = prune([...records.sessions.filter((s) => s.id !== session.id), session], now);
    this.write(records);
  }

  /** One session by id, or `null`. */
  getSession(id: string): PairingSession | null {
    return this.read().sessions.find((session) => session.id === id) ?? null;
  }

  /** Every session still on file, newest first. What `actana pair ls` reads. */
  listSessions(): PairingSession[] {
    return [...this.read().sessions].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Count a wrong code against a session and persist the count.
   *
   * Returns the session as it now stands — at the cap, it is dead and no later
   * redemption can revive it. Returns `null` for a session that is not there,
   * which the caller must treat exactly as it treats a refusal, so that a
   * guess cannot be used to learn whether a session id exists.
   */
  recordWrongAttempt(id: string): PairingSession | null {
    const records = this.read();
    const index = records.sessions.findIndex((session) => session.id === id);
    if (index === -1) return null;
    const updated = recordWrongAttempt(records.sessions[index]!);
    records.sessions[index] = updated;
    this.write(records);
    return updated;
  }

  /**
   * Mark a session consumed, or say why it cannot be.
   *
   * **This is the step that issues.** The endpoint calls it *before* it signs
   * anything, so the window in which two redemptions could both be signing is
   * closed by the write below rather than by the certificate that follows it.
   * A signature that then fails leaves the session consumed and the operator
   * runs `pair new` again: that is the safe direction to fail, where the other
   * one hands two clients a certificate for one code.
   */
  consume(id: string, now: number): PairingConsumeOutcome {
    const records = this.read();
    const index = records.sessions.findIndex((session) => session.id === id);
    if (index === -1) return { ok: false, reason: "unknown" };
    const gate = canRedeem(records.sessions[index]!, now);
    if (!gate.ok) return { ok: false, reason: gate.reason };
    const consumed: PairingSession = { ...records.sessions[index]!, consumedAt: now };
    records.sessions[index] = consumed;
    this.write(records);
    return { ok: true, session: consumed };
  }

  /**
   * Cancel a pending session before anybody redeems it — `actana pair revoke`
   * pointed at a session rather than at a paired client (#283).
   *
   * Returns the cancelled row, the row unchanged when it was already cancelled,
   * or `null` when there is no such session. A session that has already been
   * *redeemed* is returned unchanged too and reports itself through
   * `consumedAt`: there is a certificate in the world for it, so the thing to
   * take back is the client, not the code, and the caller says so rather than
   * pretending a cancel undid an issuance.
   *
   * The stamp is what stops the redemption: `canRedeem` checks `revokedAt`
   * first, so the endpoint's next look at this session refuses it with the same
   * body every other refusal gets — a client that had the code cannot tell a
   * cancelled session from one that never existed.
   */
  cancelSession(id: string, now: number): PairingSession | null {
    const records = this.read();
    const index = records.sessions.findIndex((session) => session.id === id);
    if (index === -1) return null;
    const session = records.sessions[index]!;
    if (isRevoked(session) || isConsumed(session)) return session;
    const cancelled: PairingSession = { ...session, revokedAt: now };
    records.sessions[index] = cancelled;
    this.write(records);
    return cancelled;
  }

  /** Record an issued client identity. What `pair ls` and `pair revoke` read. */
  recordClient(client: PairedClient, now: number = Date.now()): void {
    const records = this.read();
    records.clients = [...records.clients.filter((c) => c.certSerial !== client.certSerial), client];
    records.sessions = prune(records.sessions, now);
    this.write(records);
  }

  /** Every paired client, newest first. */
  listClients(): PairedClient[] {
    return [...this.read().clients].sort((a, b) => b.pairedAt - a.pairedAt);
  }

  /**
   * Revoke one pairing by certificate serial. Returns the revoked row, or
   * `null` when no such serial is paired here.
   *
   * Revoking is a stamp, not a delete: a row that vanished would take the
   * audit trail of the pairing with it, and #283's `pair revoke` has to be able
   * to say what it revoked.
   */
  revokeClient(certSerial: string, now: number): PairedClient | null {
    const records = this.read();
    const index = records.clients.findIndex((client) => client.certSerial === certSerial);
    if (index === -1) return null;
    if (records.clients[index]!.revokedAt !== null) return records.clients[index]!;
    const revoked: PairedClient = { ...records.clients[index]!, revokedAt: now };
    records.clients[index] = revoked;
    this.write(records);
    return revoked;
  }

  /**
   * Write the file, owner-only, through a temporary file and a rename.
   *
   * The rename is what makes a reader see either the old file or the new one:
   * a daemon polling this while the CLI writes it must never read half a JSON
   * document and conclude the operator has no sessions.
   */
  private write(records: PairingRecords): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      /* best effort — non-POSIX filesystems have no mode to set */
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Drop sessions that stopped being interesting a day ago. See the constant. */
function prune(sessions: PairingSession[], now: number): PairingSession[] {
  return sessions.filter((session) => {
    const settled = session.consumedAt ?? session.expiresAt;
    return now - settled < PAIRING_SESSION_RETENTION_MS;
  });
}

function isPairingSession(value: unknown): value is PairingSession {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.label === "string" &&
    typeof o.codeHash === "string" &&
    typeof o.createdAt === "number" &&
    typeof o.expiresAt === "number" &&
    typeof o.attempts === "number" &&
    typeof o.attemptCap === "number" &&
    (o.consumedAt === null || typeof o.consumedAt === "number")
  );
}

function isPairedClient(value: unknown): value is PairedClient {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.certSerial === "string" &&
    typeof o.certSubject === "string" &&
    typeof o.label === "string" &&
    typeof o.pairedAt === "number" &&
    (o.revokedAt === null || typeof o.revokedAt === "number")
  );
}

// ─── The code digest ────────────────────────────────────────────────────────
//
// `pairing-session.ts` carries a `codeHash` and deliberately says nothing about
// what hashes it. This is that decision, made once for both the process that
// mints a session and the process that redeems one.

/** Domain separator, so the derived key cannot collide with the bearer's use. */
const PAIRING_CODE_KEY_INFO = "actana:pairing-code:v1";

/**
 * Derive the key the code digest is taken under, from the Core's bearer secret.
 *
 * A bare `sha256(code)` would not do. The code is eight characters from a
 * 31-character alphabet — around 2^39.6 possibilities — which is a number of
 * hashes an attacker who has copied `pairing.json` can simply enumerate. A
 * digest keyed by a secret that is *not* in that file cannot be attacked that
 * way at all without the material file too.
 *
 * The bearer secret is reused rather than a second secret invented, because a
 * second secret is a second thing to mint, persist and lose; the separator
 * above is what keeps this from being the same computation the bearer does, so
 * neither use is an oracle for the other.
 */
export function derivePairingCodeKey(bearerSecret: string): Buffer {
  return createHmac("sha256", bearerSecret).update(PAIRING_CODE_KEY_INFO).digest();
}

/**
 * The digest stored in a session's `codeHash`.
 *
 * Bound to the session id as well as the code, which is session binding at the
 * cryptographic layer rather than only at the lookup: a digest lifted from one
 * session's row cannot be matched against another session, even by something
 * that can write this file.
 *
 * `code` must be the canonical form from `normalisePairingCode` — the hash of
 * `abcd-efgh` and of `ABCDEFGH` are different strings, and the endpoint
 * canonicalises before it gets here for exactly that reason.
 */
export function hashPairingCode(opts: { key: Buffer; sessionId: string; code: string }): string {
  return createHmac("sha256", opts.key).update(`${opts.sessionId}:${opts.code}`).digest("hex");
}

/**
 * Compare a candidate digest against a stored one in constant time.
 *
 * The comparison is on the *digests*, not the codes, so a timing signal here
 * would leak the digest rather than the code — but a digest is enough to
 * redeem, being what the store compares, so it gets `timingSafeEqual` all the
 * same. `core-link-bearer.ts` makes the same call for the same reason.
 */
export function pairingCodeMatches(storedHash: string, candidateHash: string): boolean {
  const stored = Buffer.from(storedHash, "hex");
  const candidate = Buffer.from(candidateHash, "hex");
  if (stored.length === 0 || stored.length !== candidate.length) return false;
  try {
    return timingSafeEqual(stored, candidate);
  } catch {
    return false;
  }
}
