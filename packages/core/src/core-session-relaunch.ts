// Putting a relaunched Session back on `ready` (issue 387, review finding 2).
//
// Issue 387 made `ready` a status a Session can leave: a bare Session whose
// PTY died settles to `disconnected`, by the PTY-exit path or by the boot
// sweep. That fixed the zombie and opened the mirror of it. Nothing in this
// Core ever writes `ready` back, and a bare Session was never going to be
// written back by a hook either — it has run no turn, so no hook fires for it
// until the operator's first prompt. So the operator reopens a swept Session,
// the Core spawns a perfectly healthy harness, it sits at its prompt, and the
// card says `disconnected` until the operator types. That is the same class of
// bug as the zombie: a card that does not describe the Session.
//
// This is the write-back, and it is deliberately narrow. Three things must all
// hold before a row moves:
//
//  - **An agent spawn.** A `shell` or `shellSession` PTY carries a `taskId`
//    for routing and is not harness work; neither may reset a Session's card.
//  - **A settled status.** `ready` needs no reset, and `running` /
//    `needs-input` are claims about a live turn that a spawn does not refute.
//  - **A Session that has never worked.** The one that matters. A `finished`
//    Session being reopened is being RESUMED, and its card must keep saying
//    `finished` — the operator's own record of what that Session did. Only a
//    Session with no turn behind it has nothing to lose by going back to the
//    status it never really left.
//
// The last one is a read of this Core's event log, not of the row: see
// `queryTaskEverWorked` for why the row cannot answer it. Everything else a
// spawn could tell us — the launch command, the harness family — is either
// unavailable here or a guess, and this write is operator-visible.
//
// Like every other status change on this Core it goes through
// {@link CoreTaskWriter}, so the `task:updated` a connected Panel re-renders
// from is appended with it.

import log from "@actana/shared/log";
import type { TaskStatus } from "@actana/shared/domain";
import type { CoreTaskWriter } from "./core-task-writer";

/** The status a relaunched Session that never worked goes back to. */
const RELAUNCH_STATUS: TaskStatus = "ready";

/**
 * The statuses a spawn may reset. Everything a Session settles on, and nothing
 * that describes a live turn — a spawn is not evidence against `running`.
 * `ready` is absent because a row already there needs no write.
 */
const SETTLED_STATUSES: ReadonlySet<string> = new Set([
  "finished",
  "terminated",
  "disconnected",
  "interrupted",
]);

export type CoreSessionRelaunchDeps = {
  /** The one seam a task row changes through, events included. */
  writer: CoreTaskWriter;
  /** Has any status change on this row ever described a turn? */
  everWorked: (taskId: string) => boolean;
};

/**
 * An agent PTY was just spawned for this Session. Put its row back on `ready`
 * when — and only when — the row is settled and the Session never worked.
 * Returns `true` when the row moved.
 *
 * Called after the spawn succeeded, so a refused spawn changes nothing. A
 * write that throws is logged and swallowed: a card left one status stale is a
 * far smaller failure than a spawn that answers `spawnError` because of it.
 */
export function readySessionOnAgentSpawn(
  deps: CoreSessionRelaunchDeps,
  taskId: string,
): boolean {
  if (!taskId) return false;
  const task = deps.writer.readTask(taskId);
  if (!task || !SETTLED_STATUSES.has(task.status)) return false;
  if (deps.everWorked(taskId)) return false;
  try {
    const updated = deps.writer.mutate({
      op: "update",
      taskId,
      status: RELAUNCH_STATUS,
    });
    if (!updated) return false;
    log.info("session-relaunch.reset", { taskId, from: task.status });
    return true;
  } catch (err) {
    log.warn("session-relaunch.reset-failed", { taskId, error: String(err) });
    return false;
  }
}
