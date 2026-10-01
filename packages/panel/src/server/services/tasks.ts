import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { findCoreById } from "../repositories/cores.repo";
import { findCommentsForTask, insertComment } from "../repositories/task-comments.repo";
import {
  claimAssignedTask,
  findTaskById,
  findTaskHistory,
  findTasks,
  insertTaskWithHistory,
  transitionTask,
  type NewTaskCommentRow,
  type TaskCommentRow,
  type TaskRow,
  type TaskStatusHistoryRow,
} from "../repositories/tasks.repo";
import {
  COMMENT_AUTHOR_KINDS,
  FINISHED_TASK_STATUSES,
  canMoveTask,
  isTaskStatus,
  statusesBefore,
  type CommentAuthorKind,
  type TaskStatus,
} from "~/shared/tasks";
import { newId } from "./_ids";

/**
 * Tasks, their comments and their status history (#568). Every call takes the
 * owner first and every read and write is scoped to it (ADR 0041 D15): a Task
 * of another owner is "not found", never "forbidden".
 *
 * The status rules live here, so a route, a script or the dispatcher cannot
 * skip them: the legal moves are `TASK_TRANSITIONS` in `shared/tasks.ts`.
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
    super(`a Task cannot move from ${from} to ${to}`);
    this.name = "IllegalTaskTransitionError";
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

export async function createTask(ownerId: number, input: NewTask, now = Date.now()): Promise<Task> {
  const title = input.title.trim();
  if (!title) throw new ValidationError("a Task needs a title");
  const coreId = input.coreId ?? null;
  if (coreId && !(await findCoreById(ownerId, coreId))) throw new NotFoundError("core not found");
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
    createdAt: now,
    updatedAt: now,
  };
  await insertTaskWithHistory(row, newId("tsh"));
  return row;
}

export async function listTasks(ownerId: number, statuses?: TaskStatus[]): Promise<Task[]> {
  return findTasks(ownerId, statuses);
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

/** Add a comment without changing the status. */
export async function addTaskComment(
  ownerId: number,
  id: string,
  input: NewComment,
  now = Date.now(),
): Promise<TaskComment> {
  const clean = cleanComment(input);
  const row = { ...clean, taskId: id, ownerId, createdAt: now };
  const stored = await writeComment(clean.sourceFile, () => insertComment(row));
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
  patch?: { lastError?: string | null },
): Promise<Task> {
  if (!isTaskStatus(to)) throw new ValidationError(`unknown status: ${String(to)}`);
  const result = await writeComment(comment?.sourceFile ?? null, () =>
    transitionTask(ownerId, id, legalFrom, to, now, newId("tsh"), comment, patch),
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
 * set. A Task of another owner is null too.
 */
export async function claimTask(ownerId: number, id: string, now = Date.now()): Promise<Task | null> {
  return claimAssignedTask(ownerId, id, now, newId("tsh"));
}

/**
 * Dispatch could not start the Task's Session: `in_progress` to `failed` (a legal
 * move), with the reason as the Task's last error and as a system comment, in one
 * transaction. The Task is not left `in_progress` with nothing running, and not
 * put back to `assigned` to be claimed again in a loop.
 */
export async function failTaskDispatch(ownerId: number, id: string, reason: string, now = Date.now()): Promise<Task> {
  const comment = cleanComment({
    authorKind: "system",
    authorName: "Panel",
    body: `Dispatch failed: ${reason}`,
  });
  return move(ownerId, id, "failed", now, comment, ["in_progress"], { lastError: reason });
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
