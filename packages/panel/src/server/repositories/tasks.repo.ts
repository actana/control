import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { ownedBy } from "~/db/owner";
import { panelDb } from "~/db/panel-db-handle";
import { taskComments, taskStatusHistory, tasks } from "~/db/pg-schema";
import type { TaskStatus } from "~/shared/tasks";
import { insertOutboxInTx, type NewOutboxRow, type PanelTx } from "./webhooks.repo";

export type TaskRow = typeof tasks.$inferSelect;
export type TaskCommentRow = typeof taskComments.$inferSelect;
export type NewTaskCommentRow = typeof taskComments.$inferInsert;
export type TaskStatusHistoryRow = typeof taskStatusHistory.$inferSelect;

/**
 * Every query here filters on `owner_id` (ADR 0041 D15): one owner's Tasks,
 * comments and history are never another's. A comment or history row is only
 * written after its Task was found under the same owner. Outbox rows for
 * webhooks (#574) are written in the same transaction as the change.
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

async function writeOutbox(tx: PanelTx, events: NewOutboxRow[] | undefined): Promise<void> {
  if (!events?.length) return;
  for (const event of events) await insertOutboxInTx(tx, event);
}

/** The Task and its first history row, in one transaction, with any outbox events. */
export async function insertTaskWithHistory(
  row: TaskRow,
  historyId: string,
  outbox: NewOutboxRow[] = [],
): Promise<void> {
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
    await writeOutbox(tx, outbox);
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
 * the status where it was. Outbox events ride the same transaction (#574).
 * `legalFrom` is the service's rule, not this file's.
 */
export async function transitionTask(
  ownerId: number,
  id: string,
  legalFrom: readonly TaskStatus[],
  to: TaskStatus,
  now: number,
  historyId: string,
  comment?: Omit<NewTaskCommentRow, "taskId" | "ownerId" | "createdAt">,
  /** Written with the move: the dispatcher records why a start failed (#570). */
  patch: { lastError?: string | null } = {},
  outboxFor?: (args: { from: TaskStatus; task: TaskRow }) => NewOutboxRow[],
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
      .set({ status: to, updatedAt: now, ...patch })
      .where(ownedBy(tasks, ownerId, and(eq(tasks.id, id), eq(tasks.status, from))))
      .returning();
    await tx
      .insert(taskStatusHistory)
      .values({ id: historyId, taskId: id, ownerId, fromStatus: from, toStatus: to, changedAt: now });
    const task = updated[0]!;
    await writeOutbox(tx, outboxFor?.({ from, task }));
    return { kind: "ok", task };
  });
}

/** Update title/description; outbox events ride the same transaction. Null when missing. */
export async function updateTaskRow(
  ownerId: number,
  id: string,
  patch: { title: string; description: string; updatedAt: number },
  outbox: NewOutboxRow[] = [],
): Promise<TaskRow | null> {
  return panelDb().transaction(async (tx) => {
    const updated = await tx
      .update(tasks)
      .set({ title: patch.title, description: patch.description, updatedAt: patch.updatedAt })
      .where(ownedBy(tasks, ownerId, eq(tasks.id, id)))
      .returning();
    if (!updated[0]) return null;
    await writeOutbox(tx, outbox);
    return updated[0];
  });
}

/** Delete a Task (cascades comments and history); outbox in the same transaction. */
export async function deleteTaskRow(
  ownerId: number,
  id: string,
  outbox: NewOutboxRow[] = [],
): Promise<TaskRow | null> {
  return panelDb().transaction(async (tx) => {
    const locked = await tx
      .select()
      .from(tasks)
      .where(ownedBy(tasks, ownerId, eq(tasks.id, id)))
      .for("update");
    const current = locked[0];
    if (!current) return null;
    await writeOutbox(tx, outbox);
    await tx.delete(tasks).where(ownedBy(tasks, ownerId, eq(tasks.id, id)));
    return current;
  });
}

/**
 * Claim an `assigned` Task for dispatch (#570): ONE conditional update, so two
 * dispatchers that read the same Task cannot both start it. Only the statement
 * that finds the row still `assigned` changes it (to `in_progress`, attempt count
 * plus one, dispatch time set, the last error cleared); the other gets no row
 * back. The history row goes in the same transaction, and only for the winner.
 * Null when the owner has no such Task, or it was no longer `assigned`.
 */
export async function claimAssignedTask(
  ownerId: number,
  id: string,
  now: number,
  historyId: string,
): Promise<TaskRow | null> {
  return panelDb().transaction(async (tx) => {
    const claimed = await tx
      .update(tasks)
      .set({
        status: "in_progress",
        attemptCount: sql`${tasks.attemptCount} + 1`,
        dispatchedAt: now,
        lastError: null,
        updatedAt: now,
      })
      .where(ownedBy(tasks, ownerId, and(eq(tasks.id, id), eq(tasks.status, "assigned"))))
      .returning();
    const row = claimed[0];
    if (!row) return null;
    await tx.insert(taskStatusHistory).values({
      id: historyId,
      taskId: id,
      ownerId,
      fromStatus: "assigned",
      toStatus: "in_progress",
      changedAt: now,
    });
    return row;
  });
}
