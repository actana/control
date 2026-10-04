/**
 * The file a Task dispatch writes its full prompt to, and how a prompt that points at one is recognised.
 *
 * The Panel types only a one-line pointer to this file into the harness. The Core, which appends its
 * standard block to every starting prompt, recognises that pointer so a Task Session is not also told to
 * write a session report: a Task has exactly one report instruction, the Task result file named in the
 * prompt file. Both sides read this one definition.
 */

/** Relative to the Shared folder. One file per attempt, so a re-run gets a fresh one. */
export function taskPromptFilePath(taskId: string, attempt: number): string {
  return `tasks/${taskId}/prompt-attempt-${attempt}.md`;
}

/** `~/shared/` plus a Task's prompt file, as the agent opens it. */
export function taskPromptHomePath(taskId: string, attempt: number): string {
  return `~/shared/${taskPromptFilePath(taskId, attempt)}`;
}

const POINTER_TAIL = " and do what it says. It holds your Task and tells you where to report the result.";

/**
 * The whole line typed in place of a Task. `file` is the path as the harness takes it: the path itself, or the
 * mention form with the plain path after it (`@P (file P)`), see `HARNESS_FILE_MENTION`.
 */
export function taskPointerLine(file: string): string {
  return `Read ${file}${POINTER_TAIL}`;
}

const P = "~/shared/tasks/[^\\s/]+/prompt-attempt-[1-9][0-9]*\\.md";
const TAIL = POINTER_TAIL.replace(/[.]/g, "\\.");
// The whole prompt, exactly: a prompt that only mentions the path (an interactive question about a Task file) is not
// a Task's, and must keep its session report sentence, which `actana session wait` settles on.
const TASK_POINTER = new RegExp(`^Read (?:(${P})|@(${P}) \\(file \\2\\))${TAIL}$`);

/** Is this starting prompt exactly the line `taskPointerLine` writes, in either mention form? */
export function isTaskPointerPrompt(text: string): boolean {
  return TASK_POINTER.test(text.trim());
}
