// Where a Task's attachments live and how they are named (#568 step 3, #571).
//
// Attachments go to `tasks/<task id>/attachments/<path>` in the Core's Shared folder, **never beside** the
// result files the dispatcher watches (`success.md`, `fail.md`, `partial-<n>.md`, `attempt-<n>.log`, see
// `task-report.ts`). Those are told apart by their name straight under `tasks/<task id>/`, so a file called
// `success.md` that is attached lands in `attachments/` and is not a result. No name is refused for this reason:
// the subfolder is the whole rule, and the tests pin it against `classifyTaskEntry`.

import { checkSharedPath } from "./shared-files";
import { taskFolder } from "./task-report";

export const ATTACHMENTS_DIR = "attachments";

/** A path a browser sent for one attachment, relative to the Task's attachments folder: a file, never a way out of it. */
export function checkAttachmentPath(raw: unknown) {
  return checkSharedPath(raw, "file");
}

/** Relative to the Shared folder: `tasks/<id>/attachments/<rel>`. `rel` must already have passed {@link checkAttachmentPath}. */
export function taskAttachmentPath(taskId: string, rel: string): string {
  return `${taskFolder(taskId)}${ATTACHMENTS_DIR}/${rel}`;
}

/** The line a comment (or the Task) carries per attachment, as the harness sees the file from its home. */
export function attachmentNote(taskId: string, rels: readonly string[]): string {
  // The files are in storage when the Task is assigned; the Core copies its folder from there, a few seconds later at most.
  return [`Attached files, in ~/shared/${taskFolder(taskId)}${ATTACHMENTS_DIR}/ (the Core copies its Shared folder from storage, so they may take a few seconds to appear):`, ...rels.map((r) => `- ${r}`)].join("\n");
}
