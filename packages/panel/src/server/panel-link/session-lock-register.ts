// What the Panel knows about one Core's Session locks, kept current without
// asking (issue 147, ADR 0024 D8).
//
// The lock is held by a *connection*, and the connection is the service's —
// one per Core, shared by every browser tab. So "may I write this Session"
// has exactly one answer per Core for the whole Panel, and this is where it
// lives. A tab never works it out for itself: it could not, because the tab
// holds no core-link and the published answer is addressed to the connection
// that asked for it, not to the browser behind it.
//
// Four things move the answer, and between them they cover every way a lock
// changes without this Panel asking:
//
//   1. **A published snapshot** (`lock` on a task/session row, D8). The
//      authoritative, addressed answer — `{ writable, state }` as the Core sees
//      it for *this* connection. Every list this Panel already makes carries
//      one, so this register is seeded and re-seeded for free, and any drift in
//      what it derived below is corrected the next time a view lists.
//   2. **This connection's own claim / release / takeover answers.** The Panel
//      asked, and the answer says what it got.
//   3. **`session:lockChanged` events** (D8). What tells this Panel that
//      *somebody else* moved a lock — the whole reason the event exists, and the
//      only thing that makes a force takeover visible to its loser before its
//      next keystroke.
//   4. **`reclaimResult.taskIds`** (D9). After a reconnect, the Sessions whose
//      locks came across from the socket this one replaced. Nothing else says
//      so: the transfer is a rewrite in place, it appends no event, and without
//      this the Panel would render its own Sessions read-only until something
//      refetched.
//
// And one thing resets it: the link going down. Dropping a connection releases
// every lock it held (D7), so a register that survived a reconnect would claim
// holds the Core gave back.

import type {
  CoreLinkEvent,
  CoreLinkSessionLock,
  CoreLinkSessionLockChangedPayload,
} from "@actana/shared/core-link-frames";
import { SESSION_LOCK_CHANGED_EVENT_KIND } from "@actana/shared/core-link-frames";
import {
  UNSUPPORTED_SESSION_LOCK,
  type PanelSessionLock,
} from "~/shared/session-write-access";

/** How a Session's lock is remembered here. Both bits, because they are independent. */
type Known = {
  /** Does this Panel's connection hold it? */
  held: boolean;
  /** Is it held by *somebody* — this connection or another? */
  locked: boolean;
};

export type SessionLockChange = { taskId: string; lock: PanelSessionLock };

/**
 * One Core's lock state, as the Panel's connection to it sees it.
 *
 * Deliberately not a cache of the Core's whole lock table: it holds only the
 * Sessions this Panel has been told something about. An unheard-of Session
 * reads `unlocked` — which is what it is, on a Core that has never mentioned
 * it, and the state that keeps every client that never claims working exactly
 * as it does today (D11).
 */
export class SessionLockRegister {
  private readonly known = new Map<string, Known>();
  private readonly listeners = new Set<(change: SessionLockChange) => void>();
  /**
   * Lock changes this connection caused and has already applied, waiting for
   * their own event to come back.
   *
   * The Core appends the event and answers the frame, and the Panel sees both:
   * the answer settles the state, and the event is an echo of what the answer
   * already said. Without this the echo of *our own* force takeover — a
   * `taken-over` on a Session we now hold — would read as somebody having taken
   * it off us, and the tab that just took the Session would be told it lost it.
   *
   * A queue per Session rather than a flag, because two gestures can be in
   * flight; the head is consumed by the first matching transition. An
   * unmatched entry is dropped by the next change from anybody, which is the
   * conservative direction: a stale suppression outliving its event would
   * swallow a real takeover.
   */
  private readonly selfEchoes = new Map<string, string[]>();

  /**
   * @param supported Does this Core announce `multiConnection`? Read live,
   * because a link that has not yet had its `ready` frame does not know, and
   * the honest answer before it lands is the one that changes nothing:
   * unsupported, writable, no affordances.
   */
  constructor(private readonly supported: () => boolean) {}

  /** Every Session this register has an opinion about. */
  taskIds(): string[] {
    return [...this.known.keys()];
  }

  /**
   * The lock as this Panel's tabs should be told it.
   *
   * On a Core with no lock table this is {@link UNSUPPORTED_SESSION_LOCK} and
   * nothing else — not "unlocked because we have not heard otherwise", but
   * "there is no lock here", which is what stops a single-connection Core
   * growing a Claim button it has nothing to claim.
   */
  lockFor(taskId: string): PanelSessionLock {
    if (!this.supported()) return UNSUPPORTED_SESSION_LOCK;
    const known = this.known.get(taskId);
    if (!known || (!known.held && !known.locked)) {
      return { supported: true, writable: true, state: "unlocked" };
    }
    if (known.held) return { supported: true, writable: true, state: "held-by-you" };
    return { supported: true, writable: false, state: "held-by-another" };
  }

  /** Told when a Session's answer changes. Never fires for a change to the same answer. */
  onChange(cb: (change: SessionLockChange) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Take the Core's own published answer for a Session (D8).
   *
   * The strongest input here and the only one that is not derived: it is the
   * Core reporting its own table, addressed to this connection. Rows without a
   * `lock` are ignored rather than read as unlocked — an absent field is a Core
   * that publishes no lock state, and overwriting what this register knows with
   * a Core's silence would blank the state on every list from an older Core.
   */
  applySnapshots(rows: Array<{ taskId: string; lock?: CoreLinkSessionLock }>): void {
    for (const row of rows) {
      if (!row.lock) continue;
      this.set(row.taskId, {
        held: row.lock.state === "held-by-you",
        locked: row.lock.state !== "unlocked",
      });
    }
  }

  /**
   * This connection claimed a Session, or was told it could not.
   *
   * A denied claim is an answer about the *holder*, not about us: it says
   * somebody else has it, which is a fact worth recording — it is exactly the
   * state that renders read-only, and learning it from the answer means the tab
   * that asked does not wait for a snapshot to find out.
   */
  applyClaimResult(taskId: string, granted: boolean): void {
    if (granted) this.expectSelfEcho(taskId, "claimed");
    this.set(taskId, { held: granted, locked: true });
  }

  /** This connection gave a Session back. `released: false` means it never held it. */
  applyReleaseResult(taskId: string, released: boolean): void {
    if (!released) return;
    this.expectSelfEcho(taskId, "released");
    this.set(taskId, { held: false, locked: false });
  }

  /**
   * This connection took a Session, whoever had it. It always succeeds (D7), so
   * the only question the answer settles is whether anybody was evicted — which
   * decides which echo to expect, since the Core publishes a takeover of an
   * unheld Session as an ordinary `claimed`.
   */
  applyForceTakeoverResult(taskId: string, takenFrom: string): void {
    if (takenFrom === "another-connection") this.expectSelfEcho(taskId, "taken-over");
    else if (takenFrom === "nobody") this.expectSelfEcho(taskId, "claimed");
    this.set(taskId, { held: true, locked: true });
  }

  /**
   * The Sessions a `reclaim` brought across (D9). They are held by this
   * connection now, and no event said so — the Core rewrote the table in place,
   * which is the atomicity that makes the frame worth having.
   */
  applyReclaimed(taskIds: string[]): void {
    for (const taskId of taskIds) this.set(taskId, { held: true, locked: true });
  }

  /**
   * A `session:lockChanged` event (D8). Anything that is not one is ignored, so
   * this can be fed the Core's whole event stream.
   *
   * `locked` is read in preference to the transition, exactly as the frame's
   * documentation asks: a transition this build does not know still says
   * whether the Session is held, and the two derivations agree for the three it
   * does know.
   */
  applyEvent(event: CoreLinkEvent): void {
    if (event.kind !== SESSION_LOCK_CHANGED_EVENT_KIND) return;
    const payload = parseLockChanged(event.payload);
    if (!payload) return;
    const taskId = payload.taskId || event.taskId || "";
    if (!taskId) return;
    if (this.consumeSelfEcho(taskId, payload.transition)) return;
    // Somebody else moved it. `locked: false` is a release — by definition not
    // ours, since our own release was suppressed above — so the Session is free
    // and this Panel holds nothing on it. `locked: true` is a claim or a
    // takeover by another client, which is the loser's notice (D8): it is why
    // this Panel stops rendering an editable terminal now rather than on the
    // keystroke that would have come back refused.
    this.set(taskId, { held: false, locked: payload.locked });
  }

  /**
   * The link went down. Every lock it held is released Core-side (D7), so
   * everything this register believed about holders is now false — including
   * "somebody else has it", which may equally have died with their connection.
   *
   * Emptied rather than rewritten to unlocked: the next `ready` re-seeds it from
   * the reclaim and the first list, and an empty register already reads as
   * unlocked everywhere. What it must not do is keep saying `held-by-you` about
   * a lock the Core has given back.
   */
  reset(): void {
    const taskIds = [...this.known.keys()];
    this.known.clear();
    this.selfEchoes.clear();
    for (const taskId of taskIds) this.emit(taskId);
  }

  private set(taskId: string, next: Known): void {
    const before = this.known.get(taskId);
    if (before && before.held === next.held && before.locked === next.locked) return;
    this.known.set(taskId, next);
    this.emit(taskId);
  }

  private emit(taskId: string): void {
    const lock = this.lockFor(taskId);
    for (const cb of this.listeners) cb({ taskId, lock });
  }

  private expectSelfEcho(taskId: string, transition: string): void {
    const queue = this.selfEchoes.get(taskId) ?? [];
    queue.push(transition);
    this.selfEchoes.set(taskId, queue);
  }

  private consumeSelfEcho(taskId: string, transition: string): boolean {
    const queue = this.selfEchoes.get(taskId);
    if (!queue?.length) return false;
    const head = queue[0];
    // Only the transition we are actually waiting for. Anything else is
    // somebody else's change arriving first, and it is applied — the entry
    // stays queued for the echo that is still coming.
    //
    // Nothing else drains the queue, and in particular a snapshot must not:
    // a list landing between our claim and its event would clear the entry and
    // leave the echo to be read as another client's claim, which is this
    // Panel's own Session rendering read-only until something refetched. Every
    // successful gesture produces exactly one event, so the queue is bounded by
    // what this connection asked for, and {@link reset} empties it with the link.
    if (head !== transition) return false;
    queue.shift();
    if (!queue.length) this.selfEchoes.delete(taskId);
    return true;
  }
}

function parseLockChanged(payload: string): CoreLinkSessionLockChangedPayload | null {
  try {
    const parsed = JSON.parse(payload) as Partial<CoreLinkSessionLockChangedPayload>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.taskId !== "string") return null;
    return {
      taskId: parsed.taskId,
      transition: (parsed.transition ?? "claimed") as CoreLinkSessionLockChangedPayload["transition"],
      locked: parsed.locked !== false,
    };
  } catch {
    return null;
  }
}
