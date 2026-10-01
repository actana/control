import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { ownedBy } from "~/db/owner";
import { panelDb } from "~/db/panel-db-handle";
import { taskComments, taskStatusHistory, tasks } from "~/db/pg-schema";
import type { TaskStatus } from "~/shared/tasks";

export type TaskRow = typeof tasks.$inferSelect;
export type TaskCommentRow = typeof taskComments.$inferSelect;
export type NewTaskCommentRow = typeof taskComments.$inferInsert;
export type TaskStatusHistoryRow = typeof taskStatusHistory.$inferSelect;

/**
 * Every query here filters on `owner_id` (ADR 0041 D15): one owner's Tasks,
 * comments and history are never another's. A comment or history row is only
 * written after its Task was found under the same owner.
 */

export async function findTasks(ownerId: number, statuses?: TaskStatus[]): Promise<TaskRow[]> {
  return panelDb()
    .select()
    .from(tasks)
    .where(ownedBy(tasks, ownerId, statuses?.length ? inArray(tasks.status, statuses) : undefined))
    .orderBy(desc(tasks.createdAt), asc(tasks.id));
}

export async function findTaskById(ownerId: number, id: string): Promise<TaskRow | null> {
  const rows = await panelDb()
    .select()
    .from(tasks)
    .where(ownedBy(tasks, ownerId, eq(tasks.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findTaskHistory(ownerId: number, taskId: string): Promise<TaskStatusHistoryRow[]> {
  return panelDb()
    .select()
    .from(taskStatusHistory)
    .where(ownedBy(taskStatusHistory, ownerId, eq(taskStatusHistory.taskId, taskId)))
    .orderBy(asc(taskStatusHistory.seq));
}

/** The Task and its first history row, in one transaction. */
export async function insertTaskWithHistory(row: TaskRow, historyId: string): Promise<void> {
  await panelDb().transaction(async (tx) => {
    await tx.insert(tasks).values({ ...row, ownerId: row.ownerId });
    await tx.insert(taskStatusHistory).values({
      id: historyId,
      taskId: row.id,
      ownerId: row.ownerId,
      fromStatus: null,
      toStatus: row.status,
      changedAt: row.createdAt,
    });
  });
}

export type TransitionResult =
  | { kind: "missing" }
  /** The Task is in `from`, which is not one of the statuses the move may leave. */
  | { kind: "illegal"; from: TaskStatus }
  | { kind: "ok"; task: TaskRow };

/**
 * Move a Task to `to`, if it is in one of `legalFrom` once its row is locked,
 * and write the history row. With a `comment`, that is added first, in the same
 * transaction, so a comment that is refused (a duplicate source file) leaves
 * the status where it was. `legalFrom` is the service's rule, not this file's.
 */
export async function transitionTask(
  ownerId: number,
  id: string,
  legalFrom: readonly TaskStatus[],
  to: TaskStatus,
  now: number,
  historyId: string,
  comment?: Omit<NewTaskCommentRow, "taskId" | "ownerId" | "createdAt">,
): Promise<TransitionResult> {
  return panelDb().transaction(async (tx): Promise<TransitionResult> => {
    const locked = await tx
      .select()
      .from(tasks)
      .where(ownedBy(tasks, ownerId, eq(tasks.id, id)))
      .for("update");
    const current = locked[0];
    if (!current) return { kind: "missing" };
    const from = current.status as TaskStatus;
    if (!legalFrom.includes(from)) return { kind: "illegal", from };
    if (comment) {
      await tx.insert(taskComments).values({ ...comment, taskId: id, ownerId, createdAt: now });
    }
    const updated = await tx
      .update(tasks)
      .set({ status: to, updatedAt: now })
      .where(ownedBy(tasks, ownerId, and(eq(tasks.id, id), eq(tasks.status, from))))
      .returning();
    await tx
      .insert(taskStatusHistory)
      .values({ id: historyId, taskId: id, ownerId, fromStatus: from, toStatus: to, changedAt: now });
    return { kind: "ok", task: updated[0]! };
  });
}
