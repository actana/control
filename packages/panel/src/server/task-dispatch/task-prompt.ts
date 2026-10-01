import type { Task, TaskComment } from "../services/tasks";
import { REPORT_END_MARKER, taskResultPath } from "~/shared/task-report";

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

function clip(text: string): string {
  const body = text.trim();
  return body.length <= MAX_PROMPT_COMMENT_CHARS ? body : `${body.slice(0, MAX_PROMPT_COMMENT_CHARS)} [cut]`;
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
    `Task: ${task.title.trim()}`,
    "",
    "Description:",
    task.description.trim() || "(none)",
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
