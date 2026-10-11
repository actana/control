import { addTaskComment, findCurrentTaskSession, markTaskStopped, type Task } from "../services/tasks";
import type { TaskSessionStopDto } from "~/shared/task-wire";
import type { ResultWatcher } from "./result-watcher";
import { consoleDispatchLog, messageOf, type Clock, type DispatchLog, type SessionStopper } from "./types";

/**
 * An operator stops a running Task (#723). The order matters:
 *  1. The Task moves to `failed` first, with its system comment (`markTaskStopped`, one transaction that also
 *     refuses a Task that is not `in_progress`). From then on a result file the Session still writes is a
 *     comment only and cannot flip the Task back.
 *  2. The watcher lets go of it, so it is not read for results or timed out.
 *  3. The Session is killed on its Core. If that did not work (the Core is offline, the kill failed), a second
 *     system comment says the Session may still be running; the Task is failed either way.
 */

export type StopTaskDeps = {
  /** The running dispatch's watcher; null when dispatch is not running in this process. */
  watcher: Pick<ResultWatcher, "untrack"> | null;
  stopSession: SessionStopper;
  now?: Clock;
  log?: DispatchLog;
};

/** The comment for a Session that was not confirmed stopped. */
export function unstoppedSessionComment(target: { coreId: string; sessionId: string }, why: string): string {
  return `Session ${target.sessionId} on Core ${target.coreId} could not be stopped: ${why}. It may still be running.`;
}

export async function stopTaskRun(
  ownerId: number,
  id: string,
  input: { stoppedBy: string; reason?: string | null },
  deps: StopTaskDeps,
): Promise<{ task: Task; session: TaskSessionStopDto | null }> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? consoleDispatchLog;
  const task = await markTaskStopped(ownerId, id, input, now());
  deps.watcher?.untrack(id);
  const target = await findCurrentTaskSession(ownerId, id, task.attemptCount).catch((err) => {
    log.error(`task ${id}: could not read its Session to stop it: ${messageOf(err)}`);
    return null;
  });
  if (!target) {
    log.info(`task ${id}: stopped by ${input.stoppedBy}; it had no Session recorded yet`);
    return { task, session: null };
  }
  const result = await deps.stopSession({ coreId: target.coreId, sessionId: target.sessionId });
  log.info(`task ${id}: stopped by ${input.stoppedBy}; Session ${target.sessionId} on Core ${target.coreId}: ${result.outcome}${result.detail ? ` (${result.detail})` : ""}`);
  if (result.outcome === "unreachable" || result.outcome === "failed") {
    const why = result.outcome === "unreachable" ? `the Core is unreachable${result.detail ? ` (${result.detail})` : ""}` : (result.detail ?? "the Core refused");
    try {
      await addTaskComment(
        ownerId,
        id,
        { authorKind: "system", authorName: "Panel", body: unstoppedSessionComment(target, why) },
        now(),
      );
    } catch (err) {
      log.error(`task ${id}: could not note that its Session was not stopped: ${messageOf(err)}`);
    }
  }
  return {
    task,
    session: { coreId: target.coreId, sessionId: target.sessionId, outcome: result.outcome, detail: result.detail },
  };
}
