import { and, asc, desc, eq, getTableColumns, inArray, sql, type SQL } from "drizzle-orm";
import { ownedBy } from "~/db/owner";
import { panelDb } from "~/db/panel-db-handle";
import { taskComments, taskStatusHistory, tasks } from "~/db/pg-schema";
import type { TaskSessionState, TaskStatus } from "~/shared/tasks";
import { insertOutboxInTx, type NewOutboxRow, type PanelTx } from "./webhooks.repo";

export type TaskRow = typeof tasks.$inferSelect;
export type TaskCommentRow = typeof taskComments.$inferSelect;
export type NewTaskCommentRow = typeof taskComments.$inferInsert;
/** A comment as the repository inserts it: the Task, owner and time are filled in here. */
export type CommentInsert = Omit<NewTaskCommentRow, "taskId" | "ownerId" | "createdAt">;
export type TaskStatusHistoryRow = typeof taskStatusHistory.$inferSelect;

/**
 * Every query here filters on `owner_id` (ADR 0041 D15): one owner's Tasks,
 * comments and history are never another's. A comment or history row is only
 * written after its Task was found under the same owner. Outbox rows for
 * webhooks (#574) are written in the same transaction as the change.
 */

export async function findTasks(
  ownerId: number,
  statuses?: TaskStatus[],
  sessionStates?: readonly TaskSessionState[],
): Promise<TaskRow[]> {
  return panelDb()
    .select()
    .from(tasks)
    .where(
      ownedBy(
        tasks,
        ownerId,
        and(
          statuses?.length ? inArray(tasks.status, statuses) : undefined,
          sessionStates?.length ? inArray(tasks.sessionState, [...sessionStates]) : undefined,
        ),
      ),
    )
    .orderBy(desc(tasks.createdAt), asc(tasks.id));
}

/** A Task as the board lists it: every column but `description`, which can be large. */
export type TaskListRow = Omit<TaskRow, "description">;

export type TasksPageQuery = {
  /** Only these statuses; none given = every status. */
  statuses?: readonly TaskStatus[];
  /** Only Tasks whose Session is in one of these states (#951); none given = any, including no Session. */
  sessionStates?: readonly TaskSessionState[];
  coreId?: string;
  /** A restricted API key's Cores: only Tasks on one of these (a Task with no Core is left out). */
  scopeCoreIds?: readonly string[];
  limit: number;
  /** The `nextCursor` of the previous page. */
  cursor?: string;
};

export type TasksPage = { tasks: TaskListRow[]; nextCursor: string | null };

/** The opaque cursor: base64url of `updatedAt:id`, the sort key of the last row of a page. */
function encodeTaskCursor(row: { updatedAt: number; id: string }): string {
  return Buffer.from(`${row.updatedAt}:${row.id}`, "utf8").toString("base64url");
}

/** What a Task id is made of (`newId`: prefix, base36 time, hex); anything else (a NUL, say) is not one Postgres should see. */
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function decodeTaskCursor(cursor: string): { updatedAt: number; id: string } {
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const colon = text.indexOf(":");
  const updatedAt = Number(text.slice(0, colon));
  const id = text.slice(colon + 1);
  if (colon < 1 || !Number.isSafeInteger(updatedAt) || !TASK_ID_PATTERN.test(id)) throw new InvalidTaskCursorError();
  const decoded = { updatedAt, id };
  // Only a cursor this repository issued: it must encode back to the very same text.
  if (encodeTaskCursor(decoded) !== cursor) throw new InvalidTaskCursorError();
  return decoded;
}

/** A cursor this repository did not issue. */
export class InvalidTaskCursorError extends Error {
  constructor() {
    super("invalid cursor");
    this.name = "InvalidTaskCursorError";
  }
}

/**
 * One page of the owner's Tasks, newest update first (`updated_at DESC, id DESC`,
 * so rows with an equal time still have one order), without `description`.
 * Keyset paging: the cursor is the last row's sort key, so a Task changed
 * between two pages never makes the next page skip or repeat a row. It reads
 * `limit + 1` rows to know whether another page exists.
 */
export async function findTasksPage(ownerId: number, query: TasksPageQuery): Promise<TasksPage> {
  const { description: _description, ...listColumns } = getTableColumns(tasks);
  const conditions: (SQL | undefined)[] = [
    query.statuses?.length ? inArray(tasks.status, [...query.statuses]) : undefined,
    query.sessionStates?.length ? inArray(tasks.sessionState, [...query.sessionStates]) : undefined,
    query.coreId === undefined ? undefined : eq(tasks.coreId, query.coreId),
    query.scopeCoreIds === undefined
      ? undefined
      : query.scopeCoreIds.length
        ? inArray(tasks.coreId, [...query.scopeCoreIds])
        : sql`false`,
  ];
  if (query.cursor !== undefined) {
    const after = decodeTaskCursor(query.cursor);
    // A row comparison, so the paging index (updated_at DESC, id DESC) gives the order.
    conditions.push(sql`(${tasks.updatedAt}, ${tasks.id}) < (${after.updatedAt}, ${after.id})`);
  }
  const rows = await panelDb()
    .select(listColumns)
    .from(tasks)
    .where(ownedBy(tasks, ownerId, and(...conditions)))
    .orderBy(desc(tasks.updatedAt), desc(tasks.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return { tasks: page, nextCursor: rows.length > query.limit && last ? encodeTaskCursor(last) : null };
}

export type TaskCounts = {
  byStatus: Partial<Record<TaskStatus, number>>;
  /** Per Core id; Tasks with no Core are only in `byStatus`. */
  byCore: Record<string, Partial<Record<TaskStatus, number>>>;
};

/** The owner's Task counts by status and by Core (a status with none is absent), optionally for one Core. */
export async function countTasks(ownerId: number, coreId?: string): Promise<TaskCounts> {
  const rows = await panelDb()
    .select({ status: tasks.status, coreId: tasks.coreId, n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(ownedBy(tasks, ownerId, coreId === undefined ? undefined : eq(tasks.coreId, coreId)))
    .groupBy(tasks.status, tasks.coreId);
  const counts: TaskCounts = { byStatus: {}, byCore: {} };
  for (const { status, coreId: core, n } of rows) {
    const s = status as TaskStatus;
    counts.byStatus[s] = (counts.byStatus[s] ?? 0) + n;
    if (core !== null) (counts.byCore[core] ??= {})[s] = n;
  }
  return counts;
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
  patch: { lastError?: string | null; /** Give back the attempt the claim counted: no Session started (#962). */ refundAttempt?: boolean } = {},
  outboxFor?: (args: { from: TaskStatus; task: TaskRow }) => NewOutboxRow[],
): Promise<TransitionResult> {
  const { refundAttempt, ...fields } = patch;
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
      .set({
        status: to,
        updatedAt: now,
        sessionState: null,
        sessionStateAt: null,
        ...fields,
        ...(refundAttempt ? { attemptCount: sql`greatest(${tasks.attemptCount} - 1, 0)` } : {}),
      })
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

export type SessionStateResult =
  | { kind: "missing" }
  /** The Task is not `in_progress`: no attempt runs, so there is no state to record. */
  | { kind: "not-running"; status: TaskStatus }
  /** The Task already has this state. */
  | { kind: "unchanged"; task: TaskRow }
  | { kind: "changed"; task: TaskRow; from: TaskSessionState | null };

/**
 * Record what the Session of the running attempt is doing (#949), if the Task is `in_progress` once its row is
 * locked and the state differs. `commentFor` gets the previous state and returns the system comment to add in the
 * same transaction, or null; `outboxFor` adds outbox events to it. The status and `updated_at` do not move.
 */
export async function setTaskSessionState(
  ownerId: number,
  id: string,
  state: TaskSessionState,
  now: number,
  commentFor?: (from: TaskSessionState | null) => Omit<NewTaskCommentRow, "taskId" | "ownerId" | "createdAt"> | null,
  outboxFor?: (args: { from: TaskSessionState | null; task: TaskRow; comment: NewTaskCommentRow | null }) => NewOutboxRow[],
): Promise<SessionStateResult> {
  return panelDb().transaction(async (tx): Promise<SessionStateResult> => {
    const locked = await tx
      .select()
      .from(tasks)
      .where(ownedBy(tasks, ownerId, eq(tasks.id, id)))
      .for("update");
    const current = locked[0];
    if (!current) return { kind: "missing" };
    if (current.status !== "in_progress") return { kind: "not-running", status: current.status as TaskStatus };
    const from = (current.sessionState as TaskSessionState | null) ?? null;
    if (from === state) return { kind: "unchanged", task: current };
    const fields = commentFor?.(from) ?? null;
    const comment = fields ? { ...fields, taskId: id, ownerId, createdAt: now } : null;
    if (comment) await tx.insert(taskComments).values(comment);
    const updated = await tx
      .update(tasks)
      .set({ sessionState: state, sessionStateAt: now })
      .where(ownedBy(tasks, ownerId, eq(tasks.id, id)))
      .returning();
    const task = updated[0]!;
    await writeOutbox(tx, outboxFor?.({ from, task, comment }));
    return { kind: "changed", task, from };
  });
}

/**
 * Update title, description and time limit, if the Task is in one of `legalFrom`
 * once its row is locked (#722, #724): a dispatcher that claims the Task first
 * wins, and the edit then reads `illegal`. With `commentFor`, the comment it
 * returns (from the row as it was) is inserted in the same transaction. Outbox
 * events ride the same transaction. `legalFrom` is the service's rule, not this
 * file's.
 */
export async function updateTaskRow(
  ownerId: number,
  id: string,
  legalFrom: readonly TaskStatus[],
  /** Only the fields given are written. */
  patch: { title?: string; description?: string; timeoutMinutes?: number | null; updatedAt: number },
  outboxFor?: (args: {
    before: TaskRow;
    task: TaskRow;
    comment: CommentInsert | null;
  }) => NewOutboxRow[],
  /** A system comment to write with the change, decided from the locked row. */
  commentFor?: (before: TaskRow) => CommentInsert | null,
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
    const comment = commentFor?.(current) ?? null;
    if (comment) {
      await tx
        .insert(taskComments)
        .values({ ...comment, taskId: id, ownerId, createdAt: patch.updatedAt });
    }
    const updated = await tx
      .update(tasks)
      .set({
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.timeoutMinutes === undefined ? {} : { timeoutMinutes: patch.timeoutMinutes }),
        updatedAt: patch.updatedAt,
      })
      .where(ownedBy(tasks, ownerId, eq(tasks.id, id)))
      .returning();
    const task = updated[0]!;
    await writeOutbox(tx, outboxFor?.({ before: current, task, comment }));
    return { kind: "ok", task };
  });
}

/**
 * Delete a Task (cascades comments and history), if it is in one of `legalFrom`
 * once its row is locked (#722). `ok` carries the row as it was. Outbox in the
 * same transaction.
 */
export async function deleteTaskRow(
  ownerId: number,
  id: string,
  legalFrom: readonly TaskStatus[],
  outboxFor?: (task: TaskRow) => NewOutboxRow[],
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
    await writeOutbox(tx, outboxFor?.(current));
    await tx.delete(tasks).where(ownedBy(tasks, ownerId, eq(tasks.id, id)));
    return { kind: "ok", task: current };
  });
}

/**
 * Claim an `assigned` Task for dispatch (#570): ONE conditional update, so two
 * dispatchers that read the same Task cannot both start it. Only the statement
 * that finds the row still `assigned` changes it (to `in_progress`, attempt count
 * plus one, dispatch time set, the last error cleared); the other gets no row
 * back. The history row and any webhook outbox events (#574) go in the same
 * transaction, and only for the winner. Null when the owner has no such Task,
 * or it was no longer `assigned`.
 */
export async function claimAssignedTask(
  ownerId: number,
  id: string,
  now: number,
  historyId: string,
  outboxFor?: (task: TaskRow) => NewOutboxRow[],
): Promise<TaskRow | null> {
  return panelDb().transaction(async (tx) => {
    const claimed = await tx
      .update(tasks)
      .set({
        status: "in_progress",
        attemptCount: sql`${tasks.attemptCount} + 1`,
        dispatchedAt: now,
        lastError: null,
        sessionState: null,
        sessionStateAt: null,
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
    await writeOutbox(tx, outboxFor?.(row));
    return row;
  });
}

/**
 * Give a claimed Task back (#962): the Session could not be started for a reason that may pass (a Core that is full or
 * not connected). `in_progress` to `assigned` with the attempt the claim counted given back and `reason` as the waiting
 * reason (`lastError`), only if the Task is still `in_progress` on that attempt once its row is locked: a Task stopped
 * meanwhile is left alone. History and outbox ride the same transaction. Null when it did not apply.
 */
export async function releaseClaimedTask(
  ownerId: number,
  id: string,
  attempt: number,
  reason: string,
  now: number,
  historyId: string,
  comment?: Omit<NewTaskCommentRow, "taskId" | "ownerId" | "createdAt">,
  outboxFor?: (task: TaskRow) => NewOutboxRow[],
): Promise<TaskRow | null> {
  return panelDb().transaction(async (tx) => {
    const released = await tx
      .update(tasks)
      .set({
        status: "assigned",
        attemptCount: Math.max(attempt - 1, 0),
        dispatchedAt: null,
        lastError: reason,
        sessionState: null,
        sessionStateAt: null,
        updatedAt: now,
      })
      .where(ownedBy(tasks, ownerId, and(eq(tasks.id, id), eq(tasks.status, "in_progress"), eq(tasks.attemptCount, attempt))))
      .returning();
    const row = released[0];
    if (!row) return null;
    if (comment) await tx.insert(taskComments).values({ ...comment, taskId: id, ownerId, createdAt: now });
    await tx.insert(taskStatusHistory).values({
      id: historyId,
      taskId: id,
      ownerId,
      fromStatus: "in_progress",
      toStatus: "assigned",
      changedAt: now,
    });
    await writeOutbox(tx, outboxFor?.(row));
    return row;
  });
}

/**
 * Record why an `assigned` Task is not being started (#962), as its `lastError`, when it differs from what is there. With
 * `comment`, that is added in the same transaction. Only while the Task is `assigned`. Null when nothing changed.
 */
export async function setAssignedWaitingReason(
  ownerId: number,
  id: string,
  reason: string,
  now: number,
  comment?: Omit<NewTaskCommentRow, "taskId" | "ownerId" | "createdAt">,
): Promise<TaskRow | null> {
  return panelDb().transaction(async (tx) => {
    const updated = await tx
      .update(tasks)
      .set({ lastError: reason, updatedAt: now })
      .where(
        ownedBy(
          tasks,
          ownerId,
          and(eq(tasks.id, id), eq(tasks.status, "assigned"), sql`${tasks.lastError} is distinct from ${reason}`),
        ),
      )
      .returning();
    const row = updated[0];
    if (!row) return null;
    if (comment) await tx.insert(taskComments).values({ ...comment, taskId: id, ownerId, createdAt: now });
    return row;
  });
}
