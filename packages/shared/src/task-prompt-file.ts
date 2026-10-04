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

const TASK_POINTER = /~\/shared\/tasks\/[^\s/]+\/prompt-attempt-[1-9][0-9]*\.md/;

/** Does this starting prompt point at a Task's prompt file (as `buildTaskPointer` writes it, whatever the mention form)? */
export function isTaskPointerPrompt(text: string): boolean {
  return TASK_POINTER.test(text);
}
