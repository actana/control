import type { CoreShared } from "@actana/sdk/shared";
import {
  attemptShowedProgress,
  autoRetryCauseSignature,
  decideAutoRetry,
  formatAutoRetryCircuitComment,
  isAutoRetryOptedIn,
  type AutoRetryStopReason,
} from "~/shared/auto-retry";
import { taskFolder } from "~/shared/task-report";
import { getAutoRetrySettings, isCorePaused, recordCoreRetry } from "../services/auto-retry-settings";
import { getTask, listTaskComments, scheduleAutoRetry, setAutoRetryNotice } from "../services/tasks";

/**
 * The auto-retry policy of the result watcher's exit path (#958): a Session exited without a result, and the Task opted in.
 * It gathers the facts (progress, cause, the instance settings, the Core's breaker) and asks the pure `decideAutoRetry`.
 * Nothing here runs for an operator stop, a timeout or a `fail.md` the agent wrote: the watcher only calls it on a bare exit.
 */

export type AutoRetryExit = {
  ownerId: number;
  taskId: string;
  attempt: number;
  dispatchedAt: number;
  coreId: string;
  shared: CoreShared;
  /** When and how the Session exited (code null: it was found gone). */
  exit: { at: number; code: number | null };
  now: number;
};

export type AutoRetryOutcome =
  /** The Task is `assigned` again, waiting out its back-off. */
  | { kind: "retried" }
  /** The Task does not retry: fail it as usual; `message` (null: nothing to add) goes into the `fail.md` and a gave-up notice. */
  | { kind: "stop"; reason: AutoRetryStopReason; message: string | null }
  /** Not this policy's case (no `autoRetry`, or the Task is no longer running this attempt): fail as usual. */
  | { kind: "none" };

/** A file the Session left in the Task's folder: not the prompt files the Panel writes, not an archived earlier result. */
function isAgentFile(name: string): boolean {
  return !/^prompt-attempt-\d+\.md$/.test(name) && !/^attempt-\d+-/.test(name);
}

function lastLineOf(text: string | null | undefined): string {
  const lines = (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? "";
}

export async function decideExitRetry(x: AutoRetryExit): Promise<AutoRetryOutcome> {
  const task = await getTask(x.ownerId, x.taskId);
  if (task.status !== "in_progress" || task.attemptCount !== x.attempt || !isAutoRetryOptedIn(task.autoRetry)) return { kind: "none" };
  const autoRetry = task.autoRetry;
  const { enabled, maxAttemptsCeiling } = await getAutoRetrySettings(x.ownerId);
  const corePaused = await isCorePaused(x.ownerId, x.coreId);
  const runMs = Math.max(0, x.exit.at - x.dispatchedAt);

  const comments = (await listTaskComments(x.ownerId, x.taskId)).filter((c) => c.authorKind !== "system");
  const newComments = comments.filter((c) => c.createdAt > x.dispatchedAt).length;
  const folder = taskFolder(x.taskId);
  const entries = await x.shared.list(folder).catch(() => []);
  const newFiles = entries.filter(
    (e) => e.kind === "file" && isAgentFile(e.path.slice(folder.length)) && e.modifiedAt !== undefined && e.modifiedAt.getTime() > x.dispatchedAt,
  ).length;
  // The cause: the exit code and a real error text only (the Session's last error, else nothing). An agent comment is
  // not part of it: a new comment each time must not make the same exit look different (guard 3).
  const cause = autoRetryCauseSignature(x.exit.code, lastLineOf(task.lastError));

  const decision = decideAutoRetry({
    enabled,
    ceiling: maxAttemptsCeiling,
    corePaused,
    autoRetry,
    attemptCount: task.attemptCount,
    runMs,
    progress: attemptShowedProgress({ newComments, newFiles, runMs }),
    cause,
    exitCode: x.exit.code,
  });
  if (decision.kind === "stop") {
    // Every give-up of an opted-in Task tells the operator (guard 6): the two silent stops get a notice, the fail.md stays as before.
    const notice = decision.reason === "too-short" ? "Auto-retry stopped: the Session exited within 2 minutes of starting" : decision.reason === "disabled" ? "Auto-retry is switched off" : null;
    if (notice) await setAutoRetryNotice(x.ownerId, x.taskId, "gave-up", notice, x.now);
    return decision;
  }

  const { tripped } = await recordCoreRetry(x.ownerId, x.coreId, x.now);
  const scheduled = await scheduleAutoRetry(
    x.ownerId,
    x.taskId,
    {
      attempt: x.attempt,
      exitCode: x.exit.code,
      cause,
      delayMs: decision.delayMs,
      max: decision.max,
      ...(tripped ? { pausedNote: formatAutoRetryCircuitComment(x.coreId) } : {}),
    },
    x.now,
  );
  return scheduled ? { kind: "retried" } : { kind: "none" };
}

/** The Task failed with an auto-retry stop message: the operator is told (a notice, which clients turn into a notification). */
export async function noteGaveUp(ownerId: number, taskId: string, message: string, now: number): Promise<void> {
  await setAutoRetryNotice(ownerId, taskId, "gave-up", message, now);
}
