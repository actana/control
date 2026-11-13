import { and, desc, eq, inArray } from "drizzle-orm";
import { panelDb } from "~/db/panel-db-handle";
import { taskStatusHistory, tasks } from "~/db/pg-schema";
import { FINISHED_TASK_STATUSES } from "~/shared/tasks";

// The status URL (#950) names a Task by a signed token, not by an owner: the HMAC is the capability, and what it
// opens is one Task's status and Session state, nothing else. So this read is by Task id alone, deliberately not
// through `ownedBy`, and it selects only the columns the payload and the validity rules need: never the title,
// the description or the comments.

export type TaskWatchRow = {
  id: string;
  status: string;
  attemptCount: number;
  lastError: string | null;
  sessionState: string | null;
  sessionStateAt: number | null;
  updatedAt: number;
  /** When the Task last moved into a finished status (epoch ms); null when it never did. */
  endedAt: number | null;
};

export async function findTaskWatchRow(id: string): Promise<TaskWatchRow | null> {
  const rows = await panelDb()
    .select({
      id: tasks.id,
      status: tasks.status,
      attemptCount: tasks.attemptCount,
      lastError: tasks.lastError,
      sessionState: tasks.sessionState,
      sessionStateAt: tasks.sessionStateAt,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(eq(tasks.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const ended = await panelDb()
    .select({ changedAt: taskStatusHistory.changedAt })
    .from(taskStatusHistory)
    .where(and(eq(taskStatusHistory.taskId, id), inArray(taskStatusHistory.toStatus, [...FINISHED_TASK_STATUSES])))
    .orderBy(desc(taskStatusHistory.seq))
    .limit(1);
  return { ...row, endedAt: ended[0]?.changedAt ?? null };
}
