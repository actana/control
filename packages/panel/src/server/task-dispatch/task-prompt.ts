import { fileReference } from "@actana/shared/harness-file-mention";
import type { Task, TaskComment } from "../services/tasks";
import type { Harness } from "~/shared/agents";
import { REPORT_END_MARKER, taskFolder, taskResultPath } from "~/shared/task-report";

/**
 * What a Session is told when a Task is dispatched to it (#570): the Task, its
 * comments, and where and how to report the result.
 *
 * **No standard block here.** The Core appends its versioned block to a starting
 * prompt itself (control PR 621, `appendPromptBlock`), naming this Session's own
 * report file, and a prompt that already carries one is left alone. A block from
 * this side would be missing that Session id, and would stop the Core's from
 * being added. The block's text and the report paths are client PR 41's
 * (`shared/task-report.ts`); this file only says which of the Task's result
 * files to write, from the home directory, as the harness sees them.
 *
 * The Core flattens line endings when it types a prompt, so the layout below is
 * for whoever reads a log, not something the harness depends on.
 */

/** Comments are earlier reports and the operator's steering; a long thread or report is cut, not dropped. */
export const MAX_PROMPT_COMMENTS = 20;
export const MAX_PROMPT_COMMENT_CHARS = 4_000;
export const MAX_PROMPT_DESCRIPTION_CHARS = 20_000;

/** The Core leaves a prompt that already holds its block alone, so text that quotes the block's opening must not. */
function defuse(text: string): string {
  return text.replace(/\[(\/?)Actana standard block/g, "[$1Actana standard-block");
}

function clipTo(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} [cut]`;
}

function clip(text: string): string {
  const body = text.trim();
  return defuse(body.length <= MAX_PROMPT_COMMENT_CHARS ? body : `${body.slice(0, MAX_PROMPT_COMMENT_CHARS)} [cut]`);
}

export function buildTaskPrompt(task: Pick<Task, "id" | "title" | "description">, comments: readonly TaskComment[], attempt: number): string {
  // System comments are the Panel talking to the operator ("dispatched", "failed to start"); they say nothing about the work.
  const thread = comments.filter((c) => c.authorKind !== "system").slice(-MAX_PROMPT_COMMENTS);
  const success = `~/shared/${taskResultPath(task.id, { kind: "success" })}`;
  const fail = `~/shared/${taskResultPath(task.id, { kind: "fail" })}`;
  const partial = `~/shared/${taskResultPath(task.id, { kind: "partial", n: 1 })}`.replace("partial-1.md", "partial-<n>.md");
  const lines = [
    "You have been given a Task by the operator's Panel. Do the work, then report the result as described at the end.",
    "",
    `Task: ${defuse(task.title.trim())}`,
    "",
    "Description:",
    defuse(clipTo(task.description.trim(), MAX_PROMPT_DESCRIPTION_CHARS)) || "(none)",
  ];
  if (thread.length > 0) {
    lines.push("", "Comments so far, oldest first:");
    for (const c of thread) lines.push(`- ${c.authorName} (${c.authorKind}): ${clip(c.body)}`);
  }
  lines.push(
    "",
    `Result (attempt ${attempt}): when you are done, write your report in Markdown to exactly one of these files and make its last line exactly ${REPORT_END_MARKER}:`,
    `- ${success} if the Task is done;`,
    `- ${fail} if you could not do it;`,
    `- ${partial} (n = 1, 2, ...) if only part of it is done.`,
    "Say what you did, what is left, and what the next person needs to know.",
  );
  return lines.join("\n");
}

/**
 * Where a dispatch's full prompt is written, relative to the Shared folder: one file per attempt, so a re-run
 * with new comments gets a fresh one and the earlier attempt's stays as it was. It is not a result name
 * (`classifyTaskEntry` says `other`), so neither the watcher nor the archiving of old results touches it.
 */
export function taskPromptPath(taskId: string, attempt: number): string {
  return `${taskFolder(taskId)}prompt-attempt-${attempt}.md`;
}

/**
 * The one short line typed into the harness instead of the Task: a long text typed into a composer is
 * scrolled, collapsed into a paste block or swallowed, and the Core then cannot see it landed. The file
 * holds the Task, and the result instructions with it. The file is named the way the harness takes a file
 * (`HARNESS_FILE_MENTION`), one line, well under {@link MAX_POINTER_CHARS}.
 */
export function buildTaskPointer(harness: Harness, taskId: string, attempt: number): string {
  const file = fileReference(harness, `~/shared/${taskPromptPath(taskId, attempt)}`);
  return `Read ${file} and do what it says. It holds your Task and tells you where to report the result.`;
}

export const MAX_POINTER_CHARS = 200;
