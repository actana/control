// Which of this Panel's own tabs drives a Session (issue 147, ADR 0024 D3).
//
// **This is not the Session lock and must never be reported as one.** The Panel
// is one Core client; it holds a Session's lock once, for all of its tabs, and
// no frame in here goes anywhere near a core-link. Two browser tabs are one
// human with two tabs — "which of them drives is the Panel's own business,
// settled between Panel sessions inside the Panel, and never crosses the wire"
// is D3's own sentence, and this module is where that happens.
//
// The rule is first-come. A tab that opens a pane on a Session nobody in this
// Panel is driving starts driving it; a tab that opens a pane on one that is
// already driven follows it, and may take the keyboard with an explicit
// gesture. A tab that goes away — a closed pane, a closed tab, a dropped socket
// — hands the drive to the next tab that is still watching, because the
// alternative is a Session that nobody drives while two tabs have it on screen.
//
// Interest is kept as an ordered list rather than a holder plus a set: the
// order is the answer to "who drives next", and keeping it means a handover
// never has to pick arbitrarily between two tabs that are both still there.
//
// **What a tab is, here, is a client id and not a socket** (issue 242). The
// register used to key interest by the object identity of the panel-link
// session — the browser's socket — and a socket is precisely the thing a reload
// destroys. The returning tab arrived as a stranger, queued behind the
// predecessor it had just replaced (whose `close` a reverse proxy or Docker's
// NAT routinely delays), and rendered read-only until the panel-link heartbeat
// reaped that ghost 45 seconds later. Keyed by an id the tab carries across its
// own reload, the entry the returning tab finds is *its own*: there is nothing
// to queue behind, nothing to double-register, and no window in which the
// Session is held by a corpse. The layer below solved the same problem the same
// way — a client id and `reclaim` on the core link (ADR 0024 D9, issue 146) —
// and this is its counterpart at the layer where an actual browser reload
// happens.
//
// The id is not authority and nothing verifies it, exactly as D9 says of its
// own: it decides which of one Operator's tabs holds a keyboard, and the
// gesture it arbitrates is unconditional for any tab that asks for it outright.

/**
 * The tab identity this register arbitrates between: a panel-link client id,
 * stable across that tab's reloads and dropped sockets.
 *
 * A string rather than the session object on purpose — see the module comment.
 * Resolving an id back to the socket to send on is the router's job, and it is
 * the router's map that changes on a reconnect while these lists do not.
 */
export type DriveClientId = string;

export type DriveChange = {
  taskId: string;
  /** The client id now driving, or null if nobody is. */
  driving: DriveClientId | null;
  /** Tabs that were driving and are not any more. They are told; nobody else is. */
  lost: DriveClientId[];
  /** Tabs newly told they drive. */
  gained: DriveClientId[];
};

/**
 * One Core's intra-Panel drive arbitration.
 *
 * Scoped per Core because a Session id is only unique within one — the same
 * `taskId` on two Cores is two Sessions, and a register that mixed them would
 * have a tab on one machine silently arbitrating against a tab on another.
 */
export class SessionDriveRegister {
  /** taskId → client ids watching it, driver first. */
  private readonly interest = new Map<string, DriveClientId[]>();

  /** Who drives this Session in this Panel right now, or null if nobody has asked to. */
  driverOf(taskId: string): DriveClientId | null {
    return this.interest.get(taskId)?.[0] ?? null;
  }

  /** Is this tab watching this Session at all — driving or following? */
  watches(taskId: string, clientId: DriveClientId): boolean {
    return (this.interest.get(taskId) ?? []).includes(clientId);
  }

  /**
   * A tab has this Session on screen and would like the keyboard.
   *
   * `take: false` (a pane opening) is first-come: it drives if nobody else
   * does, and follows if somebody does. `take: true` is the operator's explicit
   * gesture — "drive here" — and it takes the keyboard from whichever tab of
   * this Panel had it. That gesture is deliberately not confirmed and
   * deliberately not called a takeover: it moves nothing on any Core, costs
   * nobody their Session, and the tab that had it keeps rendering every byte.
   *
   * Re-announcing interest a tab already holds is idempotent as to *who drives*
   * — the sole watcher of a Session stays its driver across its own reload,
   * which is the whole of issue 242 — but it does move that tab to the tail
   * behind any other tab still watching. That is the first-come rule applied
   * evenly, and the same end state a reload reaches today; whether re-asserting
   * existing interest should preserve its position is issue 186's question, and
   * this ticket deliberately leaves it there.
   */
  want(
    taskId: string,
    clientId: DriveClientId,
    opts: { take?: boolean } = {},
  ): DriveChange {
    const before = this.driverOf(taskId);
    const watchers = this.interest.get(taskId) ?? [];
    const without = watchers.filter((w) => w !== clientId);
    const next = opts.take === true ? [clientId, ...without] : [...without, clientId];
    // First-come: an appended holder is the driver only when the list was empty.
    this.interest.set(taskId, next);
    return this.settle(taskId, before);
  }

  /**
   * This tab has stopped watching this Session — its pane closed, or its whole
   * socket went away. The drive falls to the next tab still watching.
   */
  release(taskId: string, clientId: DriveClientId): DriveChange {
    const watchers = this.interest.get(taskId);
    if (!watchers?.includes(clientId)) {
      return { taskId, driving: this.driverOf(taskId), lost: [], gained: [] };
    }
    const before = watchers[0];
    const next = watchers.filter((w) => w !== clientId);
    if (next.length) this.interest.set(taskId, next);
    else this.interest.delete(taskId);
    return this.settle(taskId, before);
  }

  /** Every Session this tab was watching, given back at once. Returns one change each. */
  releaseAll(clientId: DriveClientId): DriveChange[] {
    const changes: DriveChange[] = [];
    for (const taskId of [...this.interest.keys()]) {
      if (!this.watches(taskId, clientId)) continue;
      changes.push(this.release(taskId, clientId));
    }
    return changes;
  }

  private settle(taskId: string, before: DriveClientId | null | undefined): DriveChange {
    const after = this.driverOf(taskId);
    if (before === after) return { taskId, driving: after, lost: [], gained: [] };
    return {
      taskId,
      driving: after,
      lost: before ? [before] : [],
      gained: after ? [after] : [],
    };
  }
}
