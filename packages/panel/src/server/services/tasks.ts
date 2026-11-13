import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { findCoreById } from "../repositories/cores.repo";
import { findCommentsForTask, insertComment } from "../repositories/task-comments.repo";
import {
  InvalidTaskCursorError,
  claimAssignedTask,
  releaseClaimedTask,
  scheduleAutoRetryRow,
  updateAutoRetryRow,
  setAssignedWaitingReason,
  countTasks,
  deleteTaskRow,
  findTaskById,
  findTaskHistory,
  findTasks,
  findTasksPage,
  insertTaskWithHistory,
  setTaskSessionState as setTaskSessionStateRow,
  transitionTask,
  updateTaskRow,
  type NewTaskCommentRow,
  type TaskCommentRow,
  type TaskCounts,
  type TaskListRow,
  type TaskRow,
  type TasksPage,
  type TasksPageQuery,
  type TaskStatusHistoryRow,
} from "../repositories/tasks.repo";
import type { NewOutboxRow } from "../repositories/webhooks.repo";
import {
  clampAutoRetryMaxAttempts,
  formatAutoRetryComment,
  formatAutoRetryWaiting,
  lineageOnlyAutoRetry,
  newTaskAutoRetry,
  taskAutoRetryView,
  type AutoRetryNoticeKind,
  type TaskAutoRetry,
} from "~/shared/auto-retry";
import {
  COMMENT_AUTHOR_KINDS,
  DELETABLE_TASK_STATUSES,
  EDITABLE_TASK_STATUSES,
  FINISHED_TASK_STATUSES,
  TASK_STATUSES,
  TASKS_PAGE_MAX_LIMIT,
  TASK_TIMEOUT_DEFAULT_MINUTES,
  canMoveTask,
  formatTaskSessionStateComment,
  formatTaskStopComment,
  formatTaskTimeLimitChangeComment,
  isTaskStatus,
  isValidTaskTimeoutMinutes,
  resolveAttemptSessions,
  statusesBefore,
  type CommentAuthorKind,
  type TaskSessionState,
  type TaskStatus,
  TASK_WAITING_PREFIX,
} from "~/shared/tasks";
import type { WebhookEventType } from "~/shared/webhooks";
import { newId } from "./_ids";
import { getAutoRetrySettings } from "./auto-retry-settings";

/**
 * Tasks, their comments and their status history (#568). Every call takes the
 * owner first and every read and write is scoped to it (ADR 0041 D15): a Task
 * of another owner is "not found", never "forbidden".
 *
 * The status rules live here, so a route, a script or the dispatcher cannot
 * skip them: the legal moves are `TASK_TRANSITIONS` in `shared/tasks.ts`.
 *
 * Each write also inserts a webhook outbox row in the same transaction (#574),
 * so a rolled-back change never emits.
 */

export type Task = TaskRow;
export type TaskComment = TaskCommentRow;
export type TaskStatusChange = TaskStatusHistoryRow;

/** A status move the rules do not allow. Typed, so a caller can tell it from a missing Task. */
export class IllegalTaskTransitionError extends ConflictError {
  readonly code = "illegal_task_transition";
  constructor(
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super(
      from === "in_progress" && (to === "assigned" || to === "draft")
        ? `a Task cannot move from ${from} to ${to}: it is running. Stop it first (POST /api/v1/tasks/:id/stop, MCP stop_task, or Stop in the Task detail), then re-assign it`
        : `a Task cannot move from ${from} to ${to}`,
    );
    this.name = "IllegalTaskTransitionError";
  }
}

/**
 * An edit or a delete of a Task whose status does not allow it (#722): today
 * only `in_progress`, whose Session already has the prompt. Same 409 family as
 * {@link IllegalTaskTransitionError}.
 */
export class TaskNotChangeableError extends ConflictError {
  readonly code = "illegal_task_transition";
  constructor(
    readonly action: "edit" | "delete",
    readonly status: TaskStatus,
  ) {
    super(
      action === "edit"
        ? `a Task that is ${status} cannot be edited: its Session already has the prompt. Wait for it to finish, then edit and re-assign it`
        : `a Task that is ${status} cannot be deleted while its Session runs. Wait for it to finish, then delete it`,
    );
    this.name = "TaskNotChangeableError";
  }
}

/** A stop of a Task that is not running (#723). Same 409 family as {@link IllegalTaskTransitionError}. */
export class TaskNotRunningError extends ConflictError {
  readonly code = "illegal_task_transition";
  constructor(readonly taskStatus: TaskStatus) {
    super(`a Task that is ${taskStatus} is not running: only an in_progress Task can be stopped`);
    this.name = "TaskNotRunningError";
  }
}

/** An agent comment whose source file this Task already has a comment for. */
export class DuplicateTaskCommentSourceError extends ConflictError {
  readonly code = "duplicate_comment_source_file";
  constructor(readonly sourceFile: string) {
    super(`this Task already has a comment from ${sourceFile}`);
    this.name = "DuplicateTaskCommentSourceError";
  }
}

export type NewTask = {
  title: string;
  description?: string;
  coreId?: string | null;
  agent?: string | null;
  /** Start now: create the Task `assigned`, in one call, instead of `draft`. */
  startNow?: boolean;
  /** Minutes per attempt, 1 to 43200 (#724). undefined: 60. null: No limit. */
  timeoutMinutes?: number | null;
  /**
   * Opt in to auto-retry (#958): at most `maxAttempts` attempts, clamped to the instance ceiling. Off when omitted or null.
   * A value that is not a whole number of at least 1 is a ValidationError.
   */
  autoRetry?: AutoRetryRequest | null;
  /**
   * The id of the Task whose Session creates this one (a Resume / hand-over, #958 guard 4). Only ever used to reduce
   * retries: it is not trusted for anything else, and an unknown id is ignored.
   */
  fromTaskId?: string | null;
};

export type AutoRetryRequest = { maxAttempts: number };

export type TaskUpdate = {
  title?: string;
  description?: string;
  /** Allowed at any status (#724). null: No limit. */
  timeoutMinutes?: number | null;
  /** Allowed at any status (#958). null: off; a Task that already used retries keeps its count (see {@link autoRetryAfterUpdate}). */
  autoRetry?: AutoRetryRequest | null;
  /** Who changed it, for the system comment on a changed time limit. Default "operator". */
  changedBy?: string;
};

export type NewComment = {
  authorKind: CommentAuthorKind;
  authorName: string;
  body: string;
  /** Agent comments only: the file the comment came from, unique per Task. */
  sourceFile?: string | null;
};

type CommentFields = Omit<NewTaskCommentRow, "taskId" | "ownerId" | "createdAt">;

function cleanComment(input: NewComment): CommentFields & { sourceFile: string | null } {
  if (!COMMENT_AUTHOR_KINDS.includes(input.authorKind)) {
    throw new ValidationError(`unknown comment author kind: ${String(input.authorKind)}`);
  }
  const authorName = input.authorName.trim();
  if (!authorName) throw new ValidationError("a comment needs an author name");
  if (!input.body.trim()) throw new ValidationError("a comment needs a body");
  const sourceFile = input.sourceFile?.trim() || null;
  if (sourceFile && input.authorKind !== "agent") {
    throw new ValidationError("only an agent comment has a source file");
  }
  return { id: newId("tcm"), authorKind: input.authorKind, authorName, sourceFile, body: input.body };
}

/** Postgres' unique violation (23505), straight from the driver or wrapped by drizzle. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

async function writeComment<T>(sourceFile: string | null, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (sourceFile && isUniqueViolation(err)) throw new DuplicateTaskCommentSourceError(sourceFile);
    throw err;
  }
}

function taskPayload(task: TaskRow) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    coreId: task.coreId,
    agent: task.agent,
    attemptCount: task.attemptCount,
    timeoutMinutes: task.timeoutMinutes,
    autoRetry: taskAutoRetryView(task.autoRetry),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function outboxEvent(
  ownerId: number,
  eventType: WebhookEventType,
  data: unknown,
  coreId: string | null,
  now: number,
): NewOutboxRow {
  const id = newId("wob");
  return {
    id,
    ownerId,
    eventType,
    payload: JSON.stringify({ id, type: eventType, createdAt: now, data }),
    coreId,
    createdAt: now,
    processedAt: null,
  };
}

function assertTimeoutMinutes(v: unknown): void {
  if (!isValidTaskTimeoutMinutes(v)) {
    throw new ValidationError("a time limit is a whole number of minutes from 1 to 43200, or null for No limit");
  }
}

function assertAutoRetryRequest(v: unknown): asserts v is AutoRetryRequest | null | undefined {
  if (v === undefined || v === null) return;
  const max = (v as { maxAttempts?: unknown }).maxAttempts;
  if (typeof v !== "object" || typeof max !== "number" || !Number.isInteger(max) || max < 1) {
    throw new ValidationError("autoRetry is { maxAttempts } with a whole number of attempts from 1 to 3");
  }
}

/**
 * What a new Task's `autoRetry` is (#958): the request clamped to the instance ceiling (`clamped` says it was lowered). A parent
 * that is itself an auto-retry attempt (`retries > 0`) makes it null (guard 4); otherwise the child inherits the parent's retries.
 */
async function resolveNewAutoRetry(
  ownerId: number,
  request: AutoRetryRequest | null | undefined,
  fromTaskId: string | null | undefined,
): Promise<{ autoRetry: TaskAutoRetry | null; clamped: boolean }> {
  const parent = fromTaskId ? await findTaskById(ownerId, fromTaskId) : null;
  const parentRetry = parent?.autoRetry ?? null;
  const lineage = parentRetry ? parentRetry.inherited + parentRetry.retries : 0;
  // No retry for this Task, but what its lineage used is not forgotten: a lineage-only record keeps the count (guard 4).
  const none = { autoRetry: lineage > 0 ? lineageOnlyAutoRetry(lineage) : null, clamped: false };
  if (!request) return none;
  if (parentRetry && parentRetry.retries > 0) return none;
  const { maxAttemptsCeiling } = await getAutoRetrySettings(ownerId);
  const { maxAttempts, clamped } = clampAutoRetryMaxAttempts(request.maxAttempts, maxAttemptsCeiling);
  return { autoRetry: newTaskAutoRetry(maxAttempts, lineage), clamped };
}

/**
 * The `autoRetry` after an update (#958). Null turns it off, but a Task that already used retries (its own or its lineage's)
 * keeps the count with one attempt allowed, which no retry fits: switching it off and on again never resets guard 4.
 */
export function autoRetryAfterUpdate(before: TaskAutoRetry | null, request: AutoRetryRequest | null, ceiling: number): TaskAutoRetry | null {
  if (request === null) {
    return before && before.inherited + before.retries > 0 ? { ...before, maxAttempts: 1, notBefore: null } : null;
  }
  const { maxAttempts } = clampAutoRetryMaxAttempts(request.maxAttempts, ceiling);
  if (!before) return newTaskAutoRetry(maxAttempts);
  // A lineage-only record opts in now; the inherited count stays.
  const { optedIn: _lineageOnly, ...kept } = before;
  return { ...kept, maxAttempts };
}

export async function createTask(ownerId: number, input: NewTask, now = Date.now()): Promise<Task> {
  return (await createTaskDetailed(ownerId, input, now)).task;
}

/** {@link createTask}, plus whether the requested `autoRetry.maxAttempts` was lowered to the instance ceiling. */
export async function createTaskDetailed(
  ownerId: number,
  input: NewTask,
  now = Date.now(),
): Promise<{ task: Task; autoRetryClamped: boolean }> {
  const title = input.title.trim();
  if (!title) throw new ValidationError("a Task needs a title");
  const coreId = input.coreId ?? null;
  if (coreId && !(await findCoreById(ownerId, coreId))) throw new NotFoundError("core not found");
  const timeoutMinutes = input.timeoutMinutes === undefined ? TASK_TIMEOUT_DEFAULT_MINUTES : input.timeoutMinutes;
  assertTimeoutMinutes(timeoutMinutes);
  assertAutoRetryRequest(input.autoRetry);
  const { autoRetry, clamped } = await resolveNewAutoRetry(ownerId, input.autoRetry, input.fromTaskId);
  const row: TaskRow = {
    id: newId("task"),
    ownerId,
    title,
    description: input.description ?? "",
    status: input.startNow ? "assigned" : "draft",
    coreId,
    agent: input.agent?.trim() || null,
    attemptCount: 0,
    dispatchedAt: null,
    lastError: null,
    sessionState: null,
    sessionStateAt: null,
    timeoutMinutes,
    autoRetry,
    createdAt: now,
    updatedAt: now,
  };
  await insertTaskWithHistory(row, newId("tsh"), [
    outboxEvent(ownerId, "task.created", { task: taskPayload(row) }, coreId, now),
  ]);
  return { task: row, autoRetryClamped: clamped };
}

export async function listTasks(
  ownerId: number,
  statuses?: TaskStatus[],
  sessionStates?: readonly TaskSessionState[],
): Promise<Task[]> {
  return findTasks(ownerId, statuses, sessionStates);
}

export type { TaskCounts, TaskListRow, TasksPage, TasksPageQuery };

/**
 * One page of Tasks without their descriptions (#896), newest update first. The
 * limit is 1 to 100 and the cursor is one this service handed out; anything else
 * is a ValidationError, so a route answers 400.
 */
export async function listTasksPage(ownerId: number, query: TasksPageQuery): Promise<TasksPage> {
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > TASKS_PAGE_MAX_LIMIT) {
    throw new ValidationError(`limit must be a whole number from 1 to ${TASKS_PAGE_MAX_LIMIT}`);
  }
  try {
    return await findTasksPage(ownerId, query);
  } catch (e) {
    if (e instanceof InvalidTaskCursorError) throw new ValidationError("invalid cursor");
    throw e;
  }
}

export async function getTaskCounts(ownerId: number, coreId?: string): Promise<TaskCounts> {
  return countTasks(ownerId, coreId);
}

export async function getTask(ownerId: number, id: string): Promise<Task> {
  const task = await findTaskById(ownerId, id);
  if (!task) throw new NotFoundError("task not found");
  return task;
}

export async function listTaskHistory(ownerId: number, id: string): Promise<TaskStatusChange[]> {
  await getTask(ownerId, id);
  return findTaskHistory(ownerId, id);
}

export async function listTaskComments(ownerId: number, id: string): Promise<TaskComment[]> {
  await getTask(ownerId, id);
  return findCommentsForTask(ownerId, id);
}

/**
 * Update a Task's title, description and time limit; emits `task.updated`. The
 * title and description only in {@link EDITABLE_TASK_STATUSES}; a request with
 * only a time limit (#724) is allowed at any status, including `in_progress`.
 * A request with both is refused as a whole while `in_progress`. Checked once
 * the row is locked (#722). A changed time limit also writes a system comment.
 */
export async function updateTask(
  ownerId: number,
  id: string,
  input: TaskUpdate,
  now = Date.now(),
): Promise<Task> {
  const title = input.title?.trim();
  if (input.title !== undefined && !title) throw new ValidationError("a Task needs a title");
  if (input.timeoutMinutes !== undefined) assertTimeoutMinutes(input.timeoutMinutes);
  assertAutoRetryRequest(input.autoRetry);
  const touchesText = input.title !== undefined || input.description !== undefined;
  const touchesPolicy = input.timeoutMinutes !== undefined || input.autoRetry !== undefined;
  const legalFrom = touchesText || !touchesPolicy ? EDITABLE_TASK_STATUSES : TASK_STATUSES;
  const request = input.autoRetry;
  const ceiling = request ? (await getAutoRetrySettings(ownerId)).maxAttemptsCeiling : 3;
  const patch = {
    ...(request === undefined ? {} : { autoRetry: (before: TaskRow) => autoRetryAfterUpdate(before.autoRetry ?? null, request, ceiling) }),
    ...(title === undefined ? {} : { title }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.timeoutMinutes === undefined ? {} : { timeoutMinutes: input.timeoutMinutes }),
    updatedAt: now,
  };
  const newLimit = input.timeoutMinutes;
  const result = await updateTaskRow(
    ownerId,
    id,
    legalFrom,
    patch,
    ({ task, comment }) => {
      const events: NewOutboxRow[] = [];
      if (comment) {
        events.push(
          outboxEvent(
            ownerId,
            "comment.created",
            {
              comment: {
                id: comment.id,
                taskId: id,
                authorKind: comment.authorKind,
                authorName: comment.authorName,
                sourceFile: comment.sourceFile ?? null,
                body: comment.body,
                createdAt: now,
              },
              task: taskPayload(task),
            },
            task.coreId,
            now,
          ),
        );
      }
      events.push(outboxEvent(ownerId, "task.updated", { task: taskPayload(task) }, task.coreId, now));
      return events;
    },
    (before) =>
      newLimit === undefined || newLimit === before.timeoutMinutes
        ? null
        : cleanComment({
            authorKind: "system",
            authorName: "Panel",
            body: formatTaskTimeLimitChangeComment({
              from: before.timeoutMinutes,
              to: newLimit,
              changedBy: input.changedBy ?? "operator",
            }),
          }),
  );
  if (result.kind === "missing") throw new NotFoundError("task not found");
  if (result.kind === "illegal") throw new TaskNotChangeableError("edit", result.from);
  return result.task;
}

/**
 * Delete a Task; emits `task.deleted` with the last known row. Only in
 * {@link DELETABLE_TASK_STATUSES}, checked once the row is locked (#722).
 */
export async function deleteTask(ownerId: number, id: string, now = Date.now()): Promise<Task> {
  const result = await deleteTaskRow(ownerId, id, DELETABLE_TASK_STATUSES, (task) => [
    outboxEvent(ownerId, "task.deleted", { task: taskPayload(task) }, task.coreId, now),
  ]);
  if (result.kind === "missing") throw new NotFoundError("task not found");
  if (result.kind === "illegal") throw new TaskNotChangeableError("delete", result.from);
  return result.task;
}

/** Add a comment without changing the status. */
export async function addTaskComment(
  ownerId: number,
  id: string,
  input: NewComment,
  now = Date.now(),
): Promise<TaskComment> {
  const task = await getTask(ownerId, id);
  const clean = cleanComment(input);
  const row = { ...clean, taskId: id, ownerId, createdAt: now };
  const outbox = [
    outboxEvent(
      ownerId,
      "comment.created",
      {
        comment: {
          id: clean.id,
          taskId: id,
          authorKind: clean.authorKind,
          authorName: clean.authorName,
          sourceFile: clean.sourceFile,
          body: clean.body,
          createdAt: now,
        },
        task: taskPayload(task),
      },
      task.coreId,
      now,
    ),
  ];
  const stored = await writeComment(clean.sourceFile, () => insertComment(row, outbox));
  if (!stored) throw new NotFoundError("task not found");
  return stored;
}

async function move(
  ownerId: number,
  id: string,
  to: TaskStatus,
  now: number,
  comment?: CommentFields,
  /** Narrower than the rules when a call is only for some of the moves into `to`. */
  legalFrom: readonly TaskStatus[] = statusesBefore(to),
  patch?: { lastError?: string | null; refundAttempt?: boolean },
): Promise<Task> {
  if (!isTaskStatus(to)) throw new ValidationError(`unknown status: ${String(to)}`);
  const result = await writeComment(comment?.sourceFile ?? null, () =>
    transitionTask(ownerId, id, legalFrom, to, now, newId("tsh"), comment, patch ?? {}, ({ from, task }) => {
      const events: NewOutboxRow[] = [];
      if (comment) {
        events.push(
          outboxEvent(
            ownerId,
            "comment.created",
            {
              comment: {
                id: comment.id,
                taskId: id,
                authorKind: comment.authorKind,
                authorName: comment.authorName,
                sourceFile: comment.sourceFile,
                body: comment.body,
                createdAt: now,
              },
              task: taskPayload({ ...task, status: from }),
            },
            task.coreId,
            now,
          ),
        );
      }
      events.push(
        outboxEvent(
          ownerId,
          "task.status_changed",
          { task: taskPayload(task), from, to },
          task.coreId,
          now,
        ),
      );
      return events;
    }),
  );
  if (result.kind === "missing") throw new NotFoundError("task not found");
  if (result.kind === "illegal") throw new IllegalTaskTransitionError(result.from, to);
  return result.task;
}

/**
 * Move a Task to `to`. The rules are checked against the status the row has
 * once it is locked, not the one the caller last read, so two racing callers
 * cannot both make the same move.
 */
export async function changeTaskStatus(ownerId: number, id: string, to: TaskStatus, now = Date.now()): Promise<Task> {
  return move(ownerId, id, to, now);
}

/**
 * Comment & re-assign: add the comment and move a finished Task back to
 * `assigned` in one transaction. A Task that is not finished, or a comment that
 * is refused, changes nothing.
 */
export async function commentAndReassign(
  ownerId: number,
  id: string,
  input: NewComment,
  now = Date.now(),
): Promise<Task> {
  return move(ownerId, id, "assigned", now, cleanComment(input), FINISHED_TASK_STATUSES);
}

/**
 * Claim an `assigned` Task for dispatch (#570): one conditional update, so of two
 * dispatchers only one gets the Task back and the other gets null. The Task is
 * `in_progress` afterwards, with its attempt count plus one and its dispatch time
 * set. A Task of another owner is null too. The winning claim writes
 * `task.status_changed` in the same transaction (#574).
 */
export async function claimTask(ownerId: number, id: string, now = Date.now()): Promise<Task | null> {
  return claimAssignedTask(ownerId, id, now, newId("tsh"), (task) => [
    outboxEvent(
      ownerId,
      "task.status_changed",
      { task: taskPayload(task), from: "assigned", to: "in_progress" },
      task.coreId,
      now,
    ),
  ]);
}

/**
 * Dispatch could not start the Task's Session: `in_progress` to `failed` (a legal
 * move), with the reason as the Task's last error and as a system comment, in one
 * transaction. The Task is not left `in_progress` with nothing running, and not
 * put back to `assigned` to be claimed again in a loop.
 */
export async function failTaskDispatch(
  ownerId: number,
  id: string,
  reason: string,
  now = Date.now(),
  /** No Session started: the attempt the claim counted is given back (#962). */
  opts: { refundAttempt?: boolean } = {},
): Promise<Task> {
  const comment = cleanComment({
    authorKind: "system",
    authorName: "Panel",
    body: `Dispatch failed: ${reason}`,
  });
  return move(ownerId, id, "failed", now, comment, ["in_progress"], { lastError: reason, ...(opts.refundAttempt ? { refundAttempt: true } : {}) });
}

function waitingComment(reason: string) {
  return cleanComment({ authorKind: "system", authorName: "Panel", body: `Waiting: ${reason.replace(TASK_WAITING_PREFIX, "")}. It starts by itself when that clears.` });
}

/**
 * Dispatch could not start the Task's Session for a reason that may pass (#962): a Core that is full or not connected.
 * The Task goes back to `assigned` with `reason` (`waiting: ...`) as its waiting reason and the attempt given back, to be
 * dispatched again. With `comment` a system comment is written with it (the one a Task gets when it starts waiting).
 * Null when the Task was no longer `in_progress` on that attempt (stopped meanwhile).
 */
export async function releaseTaskClaim(ownerId: number, id: string, attempt: number, reason: string, opts: { comment?: boolean } = {}, now = Date.now()): Promise<Task | null> {
  return releaseClaimedTask(ownerId, id, attempt, reason, now, newId("tsh"), opts.comment ? waitingComment(reason) : undefined, (task) => [
    outboxEvent(ownerId, "task.status_changed", { task: taskPayload(task), from: "in_progress", to: "assigned" }, task.coreId, now),
  ]);
}

/** An `assigned` Task that is not started yet says why (#962). Writes only when the reason changed; a comment only when asked. */
export async function markTaskWaiting(ownerId: number, id: string, reason: string, opts: { comment?: boolean } = {}, now = Date.now()): Promise<Task | null> {
  return setAssignedWaitingReason(ownerId, id, reason, now, opts.comment ? waitingComment(reason) : undefined);
}

/**
 * An operator stops a running Task (#723): `in_progress` to `failed` with a system
 * comment ("Stopped by X: reason") and the reason as the last error, in one
 * transaction. A Task that is not `in_progress` throws {@link TaskNotRunningError}.
 * Stopping the Session itself is the caller's job (`task-dispatch/stop-task.ts`).
 */
export async function markTaskStopped(
  ownerId: number,
  id: string,
  input: { stoppedBy: string; reason?: string | null },
  now = Date.now(),
): Promise<Task> {
  const body = formatTaskStopComment(input);
  const comment = cleanComment({ authorKind: "system", authorName: "Panel", body });
  try {
    return await move(ownerId, id, "failed", now, comment, ["in_progress"], { lastError: body });
  } catch (err) {
    if (err instanceof IllegalTaskTransitionError) throw new TaskNotRunningError(err.from);
    throw err;
  }
}

/**
 * The Core and Session of the Task's current attempt, read from the newest dispatch
 * comment whose attempt is `attempt` (default: the Task's attempt count now; a caller that stopped
 * a particular attempt passes that one, so a newer attempt is never picked). Null when there is none (not
 * dispatched yet, or the comment could not be written).
 */
export async function findCurrentTaskSession(
  ownerId: number,
  id: string,
  attempt?: number,
): Promise<{ coreId: string; sessionId: string; attempt: number } | null> {
  const wanted = attempt ?? (await getTask(ownerId, id)).attemptCount;
  const found = resolveAttemptSessions(await listTaskComments(ownerId, id)).filter((s) => s.attempt === wanted).at(-1);
  return found ? { coreId: found.coreId, sessionId: found.sessionId, attempt: found.attempt } : null;
}

/**
 * Record the Session state of a Task's running attempt (#949): the two columns and, for a change into
 * `needs-input`, `interrupted` or `idle-no-result` (or back to `working` from one), one system comment, in one
 * transaction. A repeated state, or a Task that is not `in_progress`, writes nothing. Never moves the status.
 * Returns whether anything was written.
 */
export async function setTaskSessionState(
  ownerId: number,
  id: string,
  state: TaskSessionState,
  now = Date.now(),
): Promise<boolean> {
  const result = await setTaskSessionStateRow(
    ownerId,
    id,
    state,
    now,
    (from) => {
      const body = formatTaskSessionStateComment(from as TaskSessionState | null, state);
      return body ? cleanComment({ authorKind: "system", authorName: "Panel", body }) : null;
    },
    ({ from, task, comment }) => [
      outboxEvent(
        ownerId,
        "task.session_state_changed",
        {
          task: taskPayload(task),
          taskId: task.id,
          attempt: task.attemptCount,
          sessionState: state,
          sessionStateAt: now,
          from,
        },
        task.coreId,
        now,
      ),
      ...(comment
        ? [
            outboxEvent(
              ownerId,
              "comment.created",
              {
                comment: {
                  id: comment.id,
                  taskId: id,
                  authorKind: comment.authorKind,
                  authorName: comment.authorName,
                  sourceFile: comment.sourceFile ?? null,
                  body: comment.body,
                  createdAt: now,
                },
                task: taskPayload(task),
              },
              task.coreId,
              now,
            ),
          ]
        : []),
    ],
  );
  if (result.kind === "missing") throw new NotFoundError("task not found");
  return result.kind === "changed";
}

export type TaskResultInput = {
  /** The status the result file stands for. */
  to: "done" | "failed" | "partial";
  authorName: string;
  /** The report. */
  body: string;
  /** The file the report came from, unique per Task: the Task's comments are keyed on it. */
  sourceFile: string;
};

/**
 * A result file's one agent comment and its one status move, in one transaction
 * and through the same rules as every other move (#570). `in_progress` is the
 * only status a result can move a Task out of, so a Task that already finished
 * (an earlier result file of the same attempt won) keeps its status and the
 * report is still kept, as a comment with no move: `moved` says which happened.
 * A file that already has its comment throws {@link DuplicateTaskCommentSourceError}.
 */
export async function applyTaskResult(
  ownerId: number,
  id: string,
  input: TaskResultInput,
  now = Date.now(),
): Promise<{ task: Task; moved: boolean }> {
  const comment = cleanComment({
    authorKind: "agent",
    authorName: input.authorName,
    body: input.body,
    sourceFile: input.sourceFile,
  });
  try {
    return { task: await move(ownerId, id, input.to, now, comment), moved: true };
  } catch (err) {
    if (!(err instanceof IllegalTaskTransitionError)) throw err;
  }
  await addTaskComment(
    ownerId,
    id,
    { authorKind: "agent", authorName: input.authorName, body: input.body, sourceFile: input.sourceFile },
    now,
  );
  return { task: await getTask(ownerId, id), moved: false };
}

export { canMoveTask };

/** Strictly increasing per Task, so a client can tell a new notice from the one it has seen. */
function nextNoticeId(before: TaskAutoRetry): number {
  return (before.notice?.id ?? 0) + 1;
}

export type AutoRetryScheduleInput = {
  /** The attempt that ended: the Task's attempt count when its Session died. */
  attempt: number;
  /** The exit code it ended with; null = unknown. */
  exitCode: number | null;
  /** Its failure signature (`autoRetryCauseSignature`), kept for the same-cause guard. */
  cause: string;
  /** The back-off before the next attempt (`decideAutoRetry`'s `delayMs`). */
  delayMs: number;
  /** The attempts the Task may have in all (`decideAutoRetry`'s `max`). */
  max: number;
  /** This retry tripped the Core's circuit breaker (guard 5): the notice is then `paused` and says so. The retry itself still runs. */
  pausedNote?: string;
};

/**
 * Auto-retry (#958): the attempt that ended without a result goes back to `assigned` on the same Core and Agent, not to be
 * claimed before `now + delayMs`. One transaction: `in_progress` to `assigned` (legal source checked here, the attempt count
 * kept), `retries` plus one, `notBefore`, the cause, the session state cleared, the waiting reason, one system comment
 * (`Auto-retry <n>/<max>: previous Session exited (code <c>) without a result`), the notice the Panel tells the operator
 * about, history and the outbox events (`comment.created`, `task.status_changed`). Null when the Task is not `in_progress` on
 * `attempt` (stopped meanwhile) or has no `autoRetry`: nothing changes then.
 */
export async function scheduleAutoRetry(
  ownerId: number,
  id: string,
  input: AutoRetryScheduleInput,
  now = Date.now(),
): Promise<Task | null> {
  return scheduleAutoRetryRow(
    ownerId,
    id,
    input.attempt,
    now,
    newId("tsh"),
    (before) => {
      const current = before.autoRetry!;
      const body = formatAutoRetryComment({ n: input.attempt + 1, max: input.max, exitCode: input.exitCode });
      const notBefore = now + input.delayMs;
      return {
        autoRetry: {
          ...current,
          retries: current.retries + 1,
          notBefore,
          lastCause: input.cause,
          notice: input.pausedNote
            ? { id: nextNoticeId(current), kind: "paused", text: `${body}. ${input.pausedNote}` }
            : { id: nextNoticeId(current), kind: "retry", text: body },
        },
        waitingReason: formatAutoRetryWaiting(notBefore, now),
        comment: cleanComment({ authorKind: "system", authorName: "Panel", body }),
      };
    },
    ({ task, comment }) => [
      outboxEvent(
        ownerId,
        "comment.created",
        {
          comment: {
            id: comment.id,
            taskId: id,
            authorKind: comment.authorKind,
            authorName: comment.authorName,
            sourceFile: comment.sourceFile ?? null,
            body: comment.body,
            createdAt: now,
          },
          task: taskPayload({ ...task, status: "in_progress" }),
        },
        task.coreId,
        now,
      ),
      outboxEvent(ownerId, "task.status_changed", { task: taskPayload(task), from: "in_progress", to: "assigned" }, task.coreId, now),
    ],
  );
}

/**
 * The dispatcher starts a retried Task, or an operator re-assigned it: the pending back-off is over (`notBefore` null).
 * Nothing else changes (the cause and retry count stay). Null when no retry was pending.
 */
export async function clearAutoRetryPending(ownerId: number, id: string, now = Date.now()): Promise<Task | null> {
  return updateAutoRetryRow(ownerId, id, now, (current) =>
    current && current.notBefore !== null ? { ...current, notBefore: null } : null,
  );
}

/**
 * Tell the operator what auto-retry did to a Task: a new notice (the id counts up, so clients notice it) that ends any pending
 * back-off. For a give-up (`gave-up`), a Core paused by the breaker (`paused`). The system comment, the status move and the
 * webhook of the failure itself are the caller's. Null for a Task without `autoRetry`.
 */
export async function setAutoRetryNotice(
  ownerId: number,
  id: string,
  kind: AutoRetryNoticeKind,
  text: string,
  now = Date.now(),
): Promise<Task | null> {
  return updateAutoRetryRow(ownerId, id, now, (current) =>
    current ? { ...current, notBefore: null, notice: { id: nextNoticeId(current), kind, text } } : null,
  );
}
