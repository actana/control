import { ConflictError, ValidationError } from "../errors";
import { FINISHED_TASK_STATUSES, type TaskStatus } from "~/shared/tasks";
import { attachmentNote, checkAttachmentPath, taskAttachmentPath, ATTACHMENTS_DIR } from "~/shared/task-attachments";
import { sharedFiles } from "./shared-files";
import {
  IllegalTaskTransitionError,
  addTaskComment,
  changeTaskStatus,
  commentAndReassign,
  createTask,
  getTask,
  type NewComment,
  type NewTask,
  type Task,
  type TaskComment,
} from "./tasks";

/**
 * Task attachments (#568 step 3, #571): files written to `shared/tasks/<id>/attachments/` in the Task's Core, as the
 * Task's owner, **through the Files tab's service** ({@link sharedFiles}, PR 637). There is no second S3 path here: the
 * owner check, the Core's own prefix, the path rule and the upload limit are that service's, and each file goes through
 * its `upload`.
 *
 * - **Order.** A Task created with Start now and attachments is created a `draft`, gets every file written, and only then
 *   moves to `assigned`: dispatch never claims a Task whose files are not all there. If a write fails the Task stays a
 *   draft and {@link TaskAttachmentError} says which Task, which file and why. A comment that reassigns is the same: the
 *   files first, then the comment and the move, so a failed write adds no comment and moves nothing.
 * - **Where.** `attachments/` under the Task's folder, so no attached name can be a result file the dispatcher watches.
 * - **Paths.** Every relative path is checked before the Task is even created; the service checks the whole path again.
 */

export type AttachmentFile = {
  /** Relative to the Task's attachments folder, `/` separated; a folder upload keeps its tree. */
  path: string;
  size: number;
  stream: () => ReadableStream<Uint8Array>;
};

/** An attachment could not be written. The Task (when there is one) is still a draft, and nothing was assigned. */
export class TaskAttachmentError extends ConflictError {
  readonly code = "task_attachment_failed";
  constructor(
    readonly taskId: string,
    readonly path: string,
    readonly reason: unknown,
  ) {
    super(`The attachment ${path} could not be written: ${reason instanceof Error ? reason.message : String(reason)}`);
    this.name = "TaskAttachmentError";
  }
}

function plan(files: readonly AttachmentFile[]): string[] {
  const seen = new Set<string>();
  for (const f of files) {
    const checked = checkAttachmentPath(f.path);
    if (!checked.ok) throw new ValidationError(`Refused ${JSON.stringify(f.path)}: ${checked.reason}.`);
    if (seen.has(f.path)) throw new ValidationError(`${f.path} is attached twice.`);
    seen.add(f.path);
  }
  return files.map((f) => f.path);
}

async function writeAll(ownerId: number, coreId: string, taskId: string, files: readonly AttachmentFile[]): Promise<void> {
  for (const f of files) {
    try {
      await sharedFiles().upload(ownerId, coreId, taskAttachmentPath(taskId, f.path), f.stream(), f.size);
    } catch (err) {
      throw new TaskAttachmentError(taskId, f.path, err);
    }
  }
}

/** A name that is already attached is refused, not overwritten: an earlier comment's file must stay what it was. */
async function refuseOverwrites(ownerId: number, coreId: string, taskId: string, rels: readonly string[]): Promise<void> {
  const folders = new Map<string, Set<string>>();
  for (const rel of rels) {
    const slash = rel.lastIndexOf("/");
    const folder = `${taskAttachmentPath(taskId, "")}${slash < 0 ? "" : rel.slice(0, slash + 1)}`;
    if (!folders.has(folder)) {
      const listing = await sharedFiles().list(ownerId, coreId, folder);
      folders.set(folder, new Set(listing.entries.map((e) => e.name)));
    }
    const name = slash < 0 ? rel : rel.slice(slash + 1);
    if (folders.get(folder)!.has(name)) {
      throw new ConflictError(`${rel} is already attached to this Task: rename the file.`);
    }
  }
}

/**
 * Create a Task with attachments. Always created a `draft`; with `startNow` it is assigned once every file is written.
 * Needs a Core, because the Shared folder is the Core's.
 */
export async function createTaskWithAttachments(
  ownerId: number,
  input: NewTask,
  files: readonly AttachmentFile[],
  author: string,
  now = Date.now(),
): Promise<Task> {
  const rels = plan(files);
  if (!input.coreId) throw new ValidationError("Attachments are kept in a Core's Shared folder: choose a Core first.");
  const draft = await createTask(ownerId, { ...input, startNow: false }, now);
  await writeAll(ownerId, input.coreId, draft.id, files);
  try {
    // The agent is told what was attached the way it is told everything the operator said: as a comment.
    await addTaskComment(ownerId, draft.id, { authorKind: "user", authorName: author, body: attachmentNote(draft.id, rels) }, now);
  } catch (err) {
    throw new TaskAttachmentError(draft.id, ATTACHMENTS_DIR, err);
  }
  return input.startNow ? changeTaskStatus(ownerId, draft.id, "assigned", now) : draft;
}

/** A comment with files attached, optionally Comment & re-assign. The files are written first. */
export async function commentWithAttachments(
  ownerId: number,
  taskId: string,
  input: Omit<NewComment, "authorKind"> & { reassign?: boolean },
  files: readonly AttachmentFile[],
  now = Date.now(),
): Promise<{ task: Task; comment: TaskComment | null }> {
  const rels = plan(files);
  const task = await getTask(ownerId, taskId);
  if (!task.coreId) throw new ValidationError("Attachments are kept in a Core's Shared folder: this Task has no Core.");
  // The same refusal the service gives, before a file is written for a move that cannot happen.
  if (input.reassign && !(FINISHED_TASK_STATUSES as readonly string[]).includes(task.status)) {
    throw new IllegalTaskTransitionError(task.status as TaskStatus, "assigned");
  }
  await refuseOverwrites(ownerId, task.coreId, taskId, rels);
  await writeAll(ownerId, task.coreId, taskId, files);
  const body = [input.body.trim(), attachmentNote(taskId, rels)].filter(Boolean).join("\n\n");
  const comment: NewComment = { authorKind: "user", authorName: input.authorName, body };
  if (input.reassign) return { task: await commentAndReassign(ownerId, taskId, comment, now), comment: null };
  const stored = await addTaskComment(ownerId, taskId, comment, now);
  return { task: await getTask(ownerId, taskId), comment: stored };
}
