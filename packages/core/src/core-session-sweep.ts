// The Core's boot reconciliation (issue 243, part 3).
//
// A Core's PTYs do not survive its process. Kill the daemon — a restart, a
// crash, a container replaced — and every harness it was running dies with it:
// no exit callback fires, no `pty:exit` is recorded, and `onSessionExit`, the
// only unconditional settle this Core has, is never reached. The rows those
// Sessions left behind keep claiming `running`, and on the code before this
// file nothing ever came back for them. A live Core was found with twenty
// `pty:spawn` events against four `pty:exit`s and a row that had claimed to be
// working since eight hours before the daemon it belonged to even started.
//
// The Panel has had this sweep for its own rows since it had rows, and its
// reasoning transfers word for word (`panel/src/server/services/tasks.ts`):
//
// > at that point no local PTYs exist, so any such status is an orphan of a
// > previous run
//
// What did not transfer is the code: `sweepOrphanedActiveTasks` reads
// `findActiveLocalTasks()`, which is local-scope rows only — and every Session
// on a remote Core is Core-owned, so no Core-owned row was ever in scope for
// any sweep anywhere. This is that sweep, on the side that owns the rows.
//
// Two properties make it safe to run unconditionally at boot:
//
//  - It runs BEFORE any PTY of this process can exist, so "the row claims a
//    live process" and "the process is from a previous run" are the same
//    statement. There is no live Session it could take down.
//  - It writes through {@link CoreTaskWriter} like every other status change on
//    this Core, so each swept row appends the `task:updated` event a connected
//    Panel re-renders from and a reconnecting one replays off its cursor. A
//    sweep nobody is told about would leave the operator looking at the same
//    wrong card until they refreshed.
//
// `disconnected` is the status, not `finished` or `terminated`: it is what the
// Panel already uses for exactly this — a Session whose process went away
// without reporting — and it makes no claim about how the work ended, which is
// the honest position. Nobody knows.

import log from "@actana/shared/log";
import type { CoreLinkTaskSnapshot } from "@actana/sdk/core-link-frames";
import type { CoreTaskWriter } from "./core-task-writer";

/** The status a stranded Session settles on. See the note above. */
const STRANDED_STATUS = "disconnected";

export type CoreSessionSweepDeps = {
  /**
   * Every row a PTY of the previous run left behind. `listBootSweepTasks` from
   * `core-query-store.ts` in the daemon; an array in tests.
   *
   * That is the rows claiming `running` / `needs-input`, plus the `ready` rows
   * this Core once spawned a PTY for (issue 387) — a bare Session waiting on
   * its first prompt never leaves `ready`, so no status filter would ever have
   * caught it and no hook was ever going to arrive for it either. A `ready`
   * row with no `pty:spawn` behind it is not in the list and must not be: that
   * is a Session the operator has simply not started yet.
   */
  listBootSweepTasks: () => CoreLinkTaskSnapshot[];
  /** The one seam a task row changes through, events included. */
  writer: CoreTaskWriter;
};

/**
 * Settle every Session a PTY of the previous run stranded, and return the ids
 * that moved.
 *
 * Called once per boot. A row that vanishes between the read and the write
 * (deleted by a Panel racing the boot) answers `null` from the writer and is
 * simply not counted — a missing row needs no settling. A write that throws is
 * logged and the sweep continues: one unwritable row must not leave the rest
 * of the fleet's Sessions wedged.
 */
export function sweepStrandedSessions(deps: CoreSessionSweepDeps): string[] {
  const stranded = deps.listBootSweepTasks();
  if (stranded.length === 0) return [];

  const settled: string[] = [];
  for (const task of stranded) {
    try {
      const updated = deps.writer.mutate({
        op: "update",
        taskId: task.taskId,
        status: STRANDED_STATUS,
      });
      if (updated) settled.push(task.taskId);
    } catch (err) {
      log.warn("session-sweep.settle-failed", {
        taskId: task.taskId,
        error: String(err),
      });
    }
  }

  if (settled.length > 0) {
    log.info("session-sweep.settled", {
      count: settled.length,
      status: STRANDED_STATUS,
      taskIds: settled,
    });
  }
  return settled;
}
