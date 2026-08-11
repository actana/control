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

/** The tab identity this register arbitrates between. Opaque — object identity is the key. */
export type DriveHolder = object;

export type DriveChange<T extends DriveHolder> = {
  taskId: string;
  /** Every tab whose answer changed, with what it now is. */
  driving: T | null;
  /** Tabs that were driving and are not any more. They are told; nobody else is. */
  lost: T[];
  /** Tabs newly told they drive. */
  gained: T[];
};

/**
 * One Core's intra-Panel drive arbitration.
 *
 * Scoped per Core because a Session id is only unique within one — the same
 * `taskId` on two Cores is two Sessions, and a register that mixed them would
 * have a tab on one machine silently arbitrating against a tab on another.
 */
export class SessionDriveRegister<T extends DriveHolder = DriveHolder> {
  /** taskId → tabs watching it, driver first. */
  private readonly interest = new Map<string, T[]>();

  /** Who drives this Session in this Panel right now, or null if nobody has asked to. */
  driverOf(taskId: string): T | null {
    return this.interest.get(taskId)?.[0] ?? null;
  }

  /** Is this tab watching this Session at all — driving or following? */
  watches(taskId: string, holder: T): boolean {
    return (this.interest.get(taskId) ?? []).includes(holder);
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
   */
  want(taskId: string, holder: T, opts: { take?: boolean } = {}): DriveChange<T> {
    const before = this.driverOf(taskId);
    const watchers = this.interest.get(taskId) ?? [];
    const without = watchers.filter((w) => w !== holder);
    const next = opts.take === true ? [holder, ...without] : [...without, holder];
    // First-come: an appended holder is the driver only when the list was empty.
    this.interest.set(taskId, next);
    return this.settle(taskId, before);
  }

  /**
   * This tab has stopped watching this Session — its pane closed, or its whole
   * socket went away. The drive falls to the next tab still watching.
   */
  release(taskId: string, holder: T): DriveChange<T> {
    const watchers = this.interest.get(taskId);
    if (!watchers?.includes(holder)) return { taskId, driving: this.driverOf(taskId), lost: [], gained: [] };
    const before = watchers[0];
    const next = watchers.filter((w) => w !== holder);
    if (next.length) this.interest.set(taskId, next);
    else this.interest.delete(taskId);
    return this.settle(taskId, before);
  }

  /** Every Session this tab was watching, given back at once. Returns one change each. */
  releaseAll(holder: T): DriveChange<T>[] {
    const changes: DriveChange<T>[] = [];
    for (const taskId of [...this.interest.keys()]) {
      if (!this.watches(taskId, holder)) continue;
      changes.push(this.release(taskId, holder));
    }
    return changes;
  }

  private settle(taskId: string, before: T | null | undefined): DriveChange<T> {
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
