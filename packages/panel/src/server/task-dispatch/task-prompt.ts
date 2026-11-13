import { taskPointerLine, taskPromptFilePath, taskPromptHomePath } from "@actana/shared/task-prompt-file";
import { fileReference } from "@actana/shared/harness-file-mention";
import type { Task, TaskComment } from "../services/tasks";
import type { Harness } from "~/shared/agents";
import { REPORT_END_MARKER, taskResultPath } from "~/shared/task-report";

/**
 * What a Session is told when a Task is dispatched to it (#570): the Task, its
 * comments, and where and how to report the result.
 *
 * **No standard block here.** The Core appends its versioned block to a starting
 * prompt itself (control PR 621, `appendPromptBlock`), and a prompt that already
 * carries one is left alone. For the pointer typed to a Task's Session the Core
 * appends the Task variant, which has no session-report sentence, so the Task has
 * exactly one report instruction: the one in the prompt file built here. The report
 * paths are client PR 41's (`shared/task-report.ts`); this file only says which of
 * the Task's result files to write, from the home directory, as the harness sees them.
 *
 * The Core flattens line endings when it types a prompt, so the layout below is
 * for whoever reads a log, not something the harness depends on.
 */

/**
 * Comments are earlier reports and the operator's steering; a long thread or report is cut, not dropped. What the
 * prompt file holds is the last {@link MAX_PROMPT_COMMENTS} non-system comments, each cut at
 * {@link MAX_PROMPT_COMMENT_CHARS} characters, and the description cut at {@link MAX_PROMPT_DESCRIPTION_CHARS}
 * (`[cut]` marks a cut); earlier comments are not in it. The file is written once per attempt and never removed:
 * it stays in the Task's Shared folder, with the Task text and comments in it, and syncs like any file there.
 */
export const MAX_PROMPT_COMMENTS = 20;
export const MAX_PROMPT_COMMENT_CHARS = 4_000;
export const MAX_PROMPT_DESCRIPTION_CHARS = 20_000;

/** The Core leaves a prompt that already holds its block alone, so text that quotes the block's opening must not. */
function defuse(text: string): string {
  return text.replace(/\[(\/?)Actana standard block/g, "[$1Actana standard-block");
}

/** The first `max` UTF-16 units of `text`, without splitting a surrogate pair: a lone surrogate does not survive being written as UTF-8. */
export function cutAtCodePoint(text: string, max: number): string {
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function clipTo(text: string, max: number): string {
  return text.length <= max ? text : `${cutAtCodePoint(text, max)} [cut]`;
}

function clip(text: string): string {
  const body = text.trim();
  return defuse(clipTo(body, MAX_PROMPT_COMMENT_CHARS));
}

/** Where and how to report the attempt's result: the same words for a new Session and for a resumed one. */
function resultLines(task: Pick<Task, "id">, attempt: number): string[] {
  const success = `~/shared/${taskResultPath(task.id, { kind: "success" })}`;
  const fail = `~/shared/${taskResultPath(task.id, { kind: "fail" })}`;
  const partial = `~/shared/${taskResultPath(task.id, { kind: "partial", n: 1 })}`.replace("partial-1.md", "partial-<n>.md");
  return [
    "",
    `Result (attempt ${attempt}): when you are done, write your report in Markdown to exactly one of these files and make its last line exactly ${REPORT_END_MARKER}:`,
    `- ${success} if the Task is done;`,
    `- ${fail} if you could not do it;`,
    `- ${partial} (n = 1, 2, ...) if only part of it is done.`,
    "Say what you did, what is left, and what the next person needs to know.",
  ];
}

export function buildTaskPrompt(task: Pick<Task, "id" | "title" | "description">, comments: readonly TaskComment[], attempt: number): string {
  // System comments are the Panel talking to the operator ("dispatched", "failed to start"); they say nothing about the work.
  const thread = comments.filter((c) => c.authorKind !== "system").slice(-MAX_PROMPT_COMMENTS);
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
  lines.push(...resultLines(task, attempt));
  return lines.join("\n");
}

/**
 * What a Task's own Session is told when it is resumed for a re-assign (#955): a new message in the conversation it
 * already has, not the Task again. It holds the user comments written since the previous attempt's Session started
 * (`since`: that comment's index; the agent's own reports are not repeated to it), the last
 * {@link MAX_PROMPT_COMMENTS} of them, and where to report this attempt's result. It is the file the one typed line points at.
 */
export function buildResumePrompt(task: Pick<Task, "id" | "title">, comments: readonly TaskComment[], attempt: number, since: number): string {
  const fresh = comments.slice(since + 1).filter((c) => c.authorKind === "user");
  const shown = fresh.slice(-MAX_PROMPT_COMMENTS);
  const lines = [
    "The operator's Panel has re-assigned this Task to you. This is a new message in the Session you already have: the Task and what you did stay as they were.",
    "",
    `Task: ${defuse(task.title.trim())}`,
    "",
  ];
  if (shown.length === 0) {
    lines.push("There is no new comment. Check the current state (branches, PRs, files, the comments on the Task) before repeating any step.");
  } else {
    lines.push("New comments since you last worked on it, oldest first:");
    for (const c of shown) lines.push(`- ${c.authorName} (${c.authorKind}): ${clip(c.body)}`);
    if (fresh.length > shown.length) lines.push(`(${fresh.length - shown.length} older comments not included; read them with get_task ${task.id})`);
  }
  lines.push(...resultLines(task, attempt));
  return lines.join("\n");
}

/**
 * Where a dispatch's full prompt is written, relative to the Shared folder: one file per attempt, so a re-run
 * with new comments gets a fresh one and the earlier attempt's stays as it was. It is not a result name
 * (`classifyTaskEntry` says `other`), so neither the watcher nor the archiving of old results touches it.
 */
export function taskPromptPath(taskId: string, attempt: number): string {
  return taskPromptFilePath(taskId, attempt);
}

/**
 * The one short line typed into the harness instead of the Task: a long text typed into a composer is
 * scrolled, collapsed into a paste block or swallowed, and the Core then cannot see it landed. The file
 * holds the Task, and the result instructions with it. The file is named the way the harness takes a file
 * (`HARNESS_FILE_MENTION`), one line, well under {@link MAX_POINTER_CHARS}.
 */
export function buildTaskPointer(harness: Harness, taskId: string, attempt: number): string {
  return taskPointerLine(fileReference(harness, taskPromptHomePath(taskId, attempt)));
}

/**
 * The cap on the pointer line only (the typed total adds the Core's block, about 420 characters, still far below the
 * 1000 to 3000 that broke delivery). The plain path is about 142 characters with today's ids; 300 leaves room for the
 * `@P (file P)` form, which repeats the path (about 206), and for longer ids.
 */
export const MAX_POINTER_CHARS = 300;
