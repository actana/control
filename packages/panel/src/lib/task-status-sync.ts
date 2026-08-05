import type { Harness } from "@actana/shared/domain";

// Cursor CLI installs .cursor/hooks.json (beforeSubmitPrompt/stop/sessionStart),
// but beforeSubmitPrompt still does not fire in cursor-agent — only stop /
// sessionStart / tool hooks do. Capture submitted prompts from the terminal so
// titles and icons can still be generated, and use Enter as the running signal.
const HARNESSES_WITH_TERMINAL_PROMPT_FALLBACK = new Set<Harness>(["cursor-cli"]);

export function harnessUsesTerminalPromptFallback(agent: Harness): boolean {
  return HARNESSES_WITH_TERMINAL_PROMPT_FALLBACK.has(agent);
}

/**
 * Does this keystroke start a turn for a Session with no hooks reporting?
 *
 * The suppression follows reality, not the harness family (issue 84). It used
 * to check a static "these families have lifecycle hooks" set, which was true
 * about the family and false about the Session: the Core installs the hook
 * files at spawn, and a spawn where that did not happen — an unsupported
 * harness, an unwritable workspace, a Core with no hook receiver — produced a
 * Session that was exempt from the fallback and had no hooks either, so
 * nothing ever moved it off `ready`.
 *
 * `hooksInstalled` is the Core's own answer for this Session, from its spawn
 * result. Only that exempts it.
 */
export function terminalInputStartsTurn(
  agent: Harness,
  data: string,
  hooksInstalled: boolean,
): boolean {
  if (hooksInstalled) return false;
  return data.includes("\r") || data.includes("\n");
}

/**
 * Clear the Enter→running one-shot latch once the task is no longer running.
 * Without this, a second prompt in the same Cursor session never flips the
 * card back to running after stop → finished.
 */
export function shouldResetTerminalRunningFallback(currentStatus: string): boolean {
  return currentStatus !== "running";
}
