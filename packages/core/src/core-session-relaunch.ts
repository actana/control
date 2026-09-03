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
//  - **The status `disconnected`.** Not "any settled status": that is the only
//    one this PR's own settles write for a Session that never worked, and
//    before this PR `ready` was one-way, so no such Session can be wearing
//    `finished`, `terminated` or `interrupted`. Narrowing to the one reachable
//    status is what keeps a real card safe by construction. `running` and
//    `needs-input` are claims about a live turn that a spawn does not refute.
//  - **A Session that is PROVEN never to have worked.** The one that matters.
//    A `finished` Session being reopened is being RESUMED, and its card must
//    keep saying `finished` — the operator's own record of what that Session
//    did. Only a Session with no turn behind it has nothing to lose by going
//    back to the status it never really left.
//
// The last one is a read of this Core's event log, not of the row: see
// `queryTaskProvenNeverWorked` for why the row cannot answer it, and for what
// that read cannot see — a turn from before v0.4.0 left no status in the log,
// so the read demands positive evidence and treats its absence as "cannot
// tell". Everything else a spawn could tell us — the launch command, the
// harness family — is either unavailable here or a guess, and this write is
// operator-visible.
//
// Those two guards are deliberately redundant. The status check alone already
// makes the pre-v0.4.0 failure impossible; the evidence check is what stops a
// `disconnected` row from an old log — one that did work — being reset as
// though it were bare.
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
 * The one status a spawn may reset — and the narrowness is the safety property,
 * not a simplification.
 *
 * Before this PR `ready` was a status a Session could not leave, so a row that
 * never worked could only ever BE `ready`. The only status this PR's own paths
 * move such a row to is `disconnected`: the PTY-exit settle writes it for any
 * exit code, and the boot sweep writes it too. `finished`, `terminated` and
 * `interrupted` are therefore not reachable by a never-worked Session at all —
 * every row wearing one of them worked for it.
 *
 * Which means they must never be candidates. They were, once, and the log read
 * below was the only thing standing between a real `finished` card and being
 * overwritten with `ready`. That read cannot see a turn that predates v0.4.0
 * (see {@link CoreSessionRelaunchDeps.provenNeverWorked}), so on a Core
 * upgraded from 0.3.x it answered "never worked" for a Session that had, and
 * the reset destroyed the operator's record of it. Excluding those three
 * statuses here makes that failure impossible by construction rather than by
 * an event-log query being right about history it cannot see.
 */
const RESETTABLE_STATUS = "disconnected";

export type CoreSessionRelaunchDeps = {
  /** The one seam a task row changes through, events included. */
  writer: CoreTaskWriter;
  /**
   * Positive proof that no status change on this row has ever described a
   * turn. `false` means "worked, OR the log cannot say" — the two are one
   * answer here on purpose, because both forbid the reset.
   */
  provenNeverWorked: (taskId: string) => boolean;
};

/**
 * An agent PTY was just spawned for this Session. Put its row back on `ready`
 * when — and only when — it is sitting on the status this PR's own settles
 * write and nothing in its history says it ever worked. Returns `true` when
 * the row moved.
 *
 * Called after the spawn succeeded, so a refused spawn changes nothing. Both
 * reads and the write are inside the `try`: the caller invokes this from the
 * spawn handler's own `try`, whose `catch` answers `spawnError`, so anything
 * thrown here would report a failed spawn for a PTY that is alive and running
 * — and lose the client the `ptyId` besides. A card left one status stale is
 * the far smaller failure.
 */
export function readySessionOnAgentSpawn(
  deps: CoreSessionRelaunchDeps,
  taskId: string,
): boolean {
  if (!taskId) return false;
  try {
    const task = deps.writer.readTask(taskId);
    if (!task || task.status !== RESETTABLE_STATUS) return false;
    if (!deps.provenNeverWorked(taskId)) return false;
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
