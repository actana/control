import { ConflictError } from "../errors";
import { addTaskComment, findCurrentTaskSession, getTask, type Task } from "../services/tasks";
import { sessionIsHeld } from "../panel-link/lock-probe";
import type { TaskSessionStopDto } from "~/shared/task-wire";
import { consoleDispatchLog, messageOf, type Clock, type DispatchLog, type SessionStopper } from "./types";

/**
 * `close_session` (#962): end the harness of a Task that is no longer running, so its PTY slot is free, the way a
 * Task that reports does (p1). The Session row, transcript and harness session id stay, so a comment can still continue it.
 *
 * Refused (409) while the Task is `in_progress` (that is `stop_task`), when it has no Session, and when someone is
 * working in the Session: a client holds its lock (an attached terminal or a Panel tab), whether the Panel's link knows
 * it or the Core refuses the kill with `session-locked`. A lock is never taken over here. Never touches the Task's status.
 */
export type CloseSessionDeps = {
  stopSession: SessionStopper;
  /** Told a slot on this Core was freed, so a waiting Task dispatches (`slotFreed`). */
  slotFreed: (coreId: string) => void;
  isHeld?: (coreId: string, sessionId: string) => boolean;
  now?: Clock;
  log?: DispatchLog;
};

export async function closeTaskSession(
  ownerId: number,
  id: string,
  input: { closedBy: string },
  deps: CloseSessionDeps,
): Promise<{ task: Task; session: TaskSessionStopDto }> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? consoleDispatchLog;
  const task = await getTask(ownerId, id);
  if (task.status === "in_progress") throw new ConflictError("this Task is in_progress: stop_task it instead");
  const target = await findCurrentTaskSession(ownerId, id, task.attemptCount);
  if (!target) throw new ConflictError("this Task has no Session to close");
  if ((deps.isHeld ?? sessionIsHeld)(target.coreId, target.sessionId)) {
    throw new ConflictError("someone is working in this Session (a terminal is attached): it is not closed");
  }
  const result = await deps.stopSession({ coreId: target.coreId, sessionId: target.sessionId }, { takeOver: false });
  if (result.outcome === "failed" && result.detail === "session-locked") {
    throw new ConflictError("someone is working in this Session (it is locked): it is not closed");
  }
  log.info(`task ${id}: Session ${target.sessionId} on Core ${target.coreId} closed by ${input.closedBy}: ${result.outcome}`);
  if (result.outcome === "stopped" || result.outcome === "not-running") {
    deps.slotFreed(target.coreId);
    if (result.outcome === "stopped") {
      await addTaskComment(
        ownerId,
        id,
        { authorKind: "system", authorName: "Panel", body: `Session ${target.sessionId} closed by ${input.closedBy}; it can be continued with a comment.` },
        now(),
      ).catch((err) => log.error(`task ${id}: could not note the closed Session: ${messageOf(err)}`));
    }
  }
  return { task, session: { coreId: target.coreId, sessionId: target.sessionId, outcome: result.outcome, detail: result.detail } };
}
