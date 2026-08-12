// Which core-link connection may mutate which Session (ADR 0024 D3–D7, D10).
//
// One Session, at most one writer. The writer is named by the **connection**
// (D3) — not by a per-client credential and not by a logical actor above the
// socket — so the whole table is a map from a Session to the connection object
// currently holding it. A connection is an opaque identity here on purpose:
// this module knows nothing about sockets, auth or PTYs, which is what lets the
// server hand it an `ActiveConnection` and a test hand it `{}`.
//
// A Session is keyed by its **taskId**. That is the one identifier every
// mutation the lock covers can be reduced to: `tasksMutate` names it directly,
// and `write`/`kill` name a `ptyId` the server resolves to the Session it was
// spawned for. Keying on `ptyId` would give a Session as many locks as it has
// had processes.
//
// ─── What this table deliberately does not do ───
//
// **It is not a security boundary** (D10). The Core's only authentication is the
// bearer in the registration blob, and anyone holding it can open a VM Shell
// Session and kill the process directly — a lock defended against someone with a
// shell on the machine is theatre. This is an accident guard: it stops a Panel
// tab left open in another window from typing into a running automation. Read it
// as one, and do not harden it into something it is not.
//
// **It has no timeout** (D7). A long agent run is idle *by definition* — no
// mutations for many minutes is the success case, not the abandoned one — so an
// idle timeout would drop the lock exactly when losing it costs most. The three
// endings are all here and there is no fourth: {@link SessionLockTable.release}
// (explicit), {@link SessionLockTable.releaseAll} (the connection dropped), and
// {@link SessionLockTable.forceTakeover} (a hung client is being taken over).
// Do not add a timer here "as a safety net"; it is the opposite of one.
//
// **It grants nothing to a creator** (D5). Nothing calls into this table on
// spawn. A Session starts unlocked, unlocked is a real state, and any connection
// may claim it. The window between a Session starting and its first claim is a
// real race, and it is accepted rather than closed — see ADR 0024's known risks.
//
// **It never claims implicitly** (D6). No mutation path writes to this table;
// only the three lock frames do. A mutation that arrives without the lock is
// refused, never turned into an acquisition.
//
// **It never says who holds a Session, to anybody but that holder** (D8, D10).
// {@link SessionLockTable.stateFor} is the published answer, and it is asked on
// behalf of one connection: it reports `held-by-another` where {@link holderOf}
// would hand back the holder itself. `holderOf` stays for the Core's own
// bookkeeping — reference comparison inside this process — and nothing puts its
// answer on the wire.

import type { CoreLinkSessionLock } from "@actana/sdk/core-link-frames";

/**
 * A lock holder, as this table sees one: an identity to compare by reference.
 *
 * The server passes its `ActiveConnection`. Nothing here reads a field off it,
 * which is the point — the unit of write authority is the connection itself
 * (D3), so identity is the whole of what a holder needs to have.
 */
export type SessionLockHolder = object;

/** Who lost a lock to a {@link SessionLockTable.forceTakeover}. */
export type SessionLockTakenFrom = "nobody" | "another-connection" | "this-connection";

/**
 * The Session locks one Core is holding, in memory, for as long as the process
 * lives (D12). Not persisted: the PTYs these locks guard do not survive the
 * daemon either, and a Core restart returning every Session to unlocked is the
 * correct state for a Session with no running process behind it.
 */
export class SessionLockTable {
  private readonly holders = new Map<string, SessionLockHolder>();

  /** The connection holding `taskId`, or null when the Session is unlocked. */
  holderOf(taskId: string): SessionLockHolder | null {
    return this.holders.get(taskId) ?? null;
  }

  /** Does `holder` hold this Session's lock right now? */
  isHeldBy(taskId: string, holder: SessionLockHolder): boolean {
    return this.holders.get(taskId) === holder;
  }

  /**
   * May `holder` mutate this Session?
   *
   * True when the Session is **unlocked** as well as when this holder holds it,
   * and that is load-bearing rather than lenient. D11 promises that an old
   * client against a new Core "works untouched — it never claims, and never
   * notices it is no longer evicting anybody", and a client that never claims
   * has to be able to write. Refusing on an unlocked Session would make the
   * capability's absence yield something *lesser* than today rather than exactly
   * today, which is the one thing the D11 rule amendment does not allow.
   *
   * So the refusal is narrow and says what it means: this Session is held by
   * **someone else**. D6's "a mutation without the lock is an error" is about
   * acquisition — a mutation never becomes a claim — not about making an
   * unclaimed Session unwritable.
   *
   * `taskId` may be null for a mutation the server could not resolve to a
   * Session (a `ptyId` this Core has no PTY for). That answers true: there is no
   * Session to be holding, and the underlying call is about to report "gone" on
   * its own, which is exactly the answer the caller needs to tell apart from a
   * refusal.
   */
  mayMutate(taskId: string | null | undefined, holder: SessionLockHolder): boolean {
    if (!taskId) return true;
    const current = this.holders.get(taskId);
    return current === undefined || current === holder;
  }

  /**
   * This Session's lock as `asker` must be **told** it (D8) — the published
   * answer, and the only shape of this table's state that ever crosses the wire.
   *
   * Lock state is published rather than discovered by failing: a Reader renders
   * its terminal non-editable before anyone types, which is not something a
   * refusal can do, because a refusal arrives only after the mutation it
   * refuses.
   *
   * It answers "can **you** write to this", not "is this locked". The
   * `writable` half is {@link mayMutate} for this asker — the same rule, from
   * the same table, so a client can never be told it may write and then refused,
   * or told it may not and then served. The `state` half is what a client needs
   * to choose between a claim and a takeover, and it collapses every holder who
   * is not the asker into `held-by-another`: naming one would put a connection's
   * identity in front of every watcher, and the lock is coordination rather than
   * identity (D3, D10). The asker is the only connection this answer is true
   * for, which is why it is a parameter and not a snapshot of the table.
   */
  stateFor(taskId: string, asker: SessionLockHolder): CoreLinkSessionLock {
    const writable = this.mayMutate(taskId, asker);
    const current = this.holders.get(taskId);
    if (current === undefined) return { writable, state: "unlocked" };
    if (current === asker) return { writable, state: "held-by-you" };
    return { writable, state: "held-by-another" };
  }

  /**
   * Take an unlocked Session (D6 — the explicit gesture).
   *
   * Idempotent for the connection that already holds it: a client that has lost
   * track re-claims and reads the answer rather than having to remember. Denied,
   * without disturbing anything, when another connection holds it — the way past
   * that is {@link forceTakeover}, deliberately a different frame, so taking a
   * Session out from under a working client is never something a retry loop does
   * by accident.
   */
  claim(taskId: string, holder: SessionLockHolder): { granted: boolean } {
    const current = this.holders.get(taskId);
    if (current !== undefined && current !== holder) return { granted: false };
    this.holders.set(taskId, holder);
    return { granted: true };
  }

  /**
   * Give up a Session this connection holds (D7 — the explicit ending).
   *
   * Returns false, and changes nothing, when this connection was not the holder.
   * Releasing is not a way to unlock someone else's Session; a release from a
   * non-holder is a stale client talking, not an instruction.
   */
  release(taskId: string, holder: SessionLockHolder): boolean {
    if (this.holders.get(taskId) !== holder) return false;
    this.holders.delete(taskId);
    return true;
  }

  /**
   * Take a Session whoever holds it (D7 — the hung-client ending).
   *
   * Unconditional by design: this exists because a client that has stopped
   * answering but whose socket is still open would otherwise render a Session
   * unusable until its process dies, and an idle timeout is the wrong instrument
   * for that (see the module comment). It is also unrecoverable by design — the
   * previous holder's in-flight keystrokes are gone, and its next mutation is
   * refused.
   *
   * The answer names who lost it so a caller can say so out loud rather than
   * infer it: taking an unheld Session is an ordinary claim by another name, and
   * a client should not report having evicted somebody when it did not.
   */
  forceTakeover(taskId: string, holder: SessionLockHolder): { takenFrom: SessionLockTakenFrom } {
    const current = this.holders.get(taskId);
    this.holders.set(taskId, holder);
    if (current === undefined) return { takenFrom: "nobody" };
    return { takenFrom: current === holder ? "this-connection" : "another-connection" };
  }

  /**
   * Drop **every** lock this connection holds, and report which Sessions they
   * were (D7 — the connection-drop ending).
   *
   * All of them, in one sweep of the table, rather than whatever a caller
   * remembered to track alongside: a connection may hold several Sessions at
   * once — that is the ordinary case this effort exists to enable — and a
   * bookkeeping list that drifts leaves a dead client holding a live Session
   * with nothing left to release it. ADR 0024 D7 already has a stale connection
   * holding its locks until the heartbeat reaps it; a partial sweep here would
   * make that permanent instead of bounded.
   *
   * The returned ids are what a caller publishes or logs. Empty is the common
   * case — most connections hold nothing.
   */
  releaseAll(holder: SessionLockHolder): string[] {
    const released: string[] = [];
    for (const [taskId, current] of this.holders) {
      if (current === holder) released.push(taskId);
    }
    for (const taskId of released) this.holders.delete(taskId);
    return released;
  }

  /**
   * Move **every** lock `from` holds to `to`, and report which Sessions moved
   * (D9 — a reconnecting Core client inheriting its predecessor's locks).
   *
   * **The one thing this method is for is that it is one step.** The obvious
   * spelling of an inheritance — `releaseAll(from)` then `claim` each id for
   * `to` — is a different behaviour wearing the same result: between those two
   * calls every one of those Sessions is unlocked, and unlocked means claimable
   * by anybody (D5, and {@link mayMutate} says a third connection may write one
   * outright). The Core is single-threaded, so "between two calls" sounds like
   * no time at all — it is not. A `close()` on the predecessor's socket, a log
   * line that awaits, any future callback in that gap, and a third client's
   * `claim` lands in the window. Rewriting the entry in place has no such
   * window to lose, at any interleaving, which is why this exists rather than
   * being left to the caller to compose.
   *
   * Also why `from` is closed *after* this returns and never before: a drop
   * runs {@link releaseAll}, and a predecessor dropped first would unlock every
   * Session on its way out. Called in this order, that same `releaseAll` finds
   * nothing left to release — the entries already name the successor — which is
   * the property that makes the ordinary drop path safe to leave alone.
   *
   * Nothing here is authority. This table compares holders by reference and
   * knows nothing about client ids, bearers or sockets; deciding that two
   * connections are the same Core client happens above it, unverified, and the
   * transfer moves no more than what `from` already held.
   */
  transferAll(from: SessionLockHolder, to: SessionLockHolder): string[] {
    if (from === to) return [];
    const moved: string[] = [];
    for (const [taskId, current] of this.holders) {
      if (current === from) moved.push(taskId);
    }
    for (const taskId of moved) this.holders.set(taskId, to);
    return moved;
  }

  /** How many Sessions are locked right now. For assertions and logging. */
  heldCount(): number {
    return this.holders.size;
  }

  /**
   * Forget every lock. The Core is going away, and D12 says locks go with it —
   * there is nothing here to hand on to a next process.
   */
  clear(): void {
    this.holders.clear();
  }
}
