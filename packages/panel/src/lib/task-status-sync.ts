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
 * Does this keystroke start a turn for a Session nothing else will report?
 *
 * The suppression follows reality, not the harness family (issue 84). It used
 * to check a static "these families have lifecycle hooks" set, which was true
 * about the family and false about the Session: nothing installed hooks at
 * all after the Electron main process was retired, so every hook-capable
 * Session was exempt from the fallback AND had no hooks — nothing ever moved
 * it off `ready`.
 *
 * `hooksReportTurnStart` is the owning Core's answer for this Session, from
 * its spawn result, and it is narrower than "hooks were installed" on
 * purpose: Cursor takes the hooks file but never fires `beforeSubmitPrompt`,
 * and Codex will not run newly-installed hooks until the operator reviews
 * them. Both report a turn's end; neither reports its start, so both still
 * need this.
 */
export function terminalInputStartsTurn(
  agent: Harness,
  data: string,
  hooksReportTurnStart: boolean,
): boolean {
  if (hooksReportTurnStart) return false;
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
