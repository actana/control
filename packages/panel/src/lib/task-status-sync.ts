import type { Harness } from "@actana/shared/domain";

// Codex has lifecycle hooks, but keep an input fallback because older or
// partially configured Codex builds may not invoke project-local hooks.
// Hook events can still upgrade later transitions when they arrive.
const HARNESSES_WITH_LIFECYCLE_HOOKS = new Set<Harness>(["claude-code", "opencode"]);

// Cursor CLI installs .cursor/hooks.json (beforeSubmitPrompt/stop/sessionStart),
// but beforeSubmitPrompt still does not fire in cursor-agent — only stop /
// sessionStart / tool hooks do. Capture submitted prompts from the terminal so
// titles and icons can still be generated, and use Enter as the running signal.
const HARNESSES_WITH_TERMINAL_PROMPT_FALLBACK = new Set<Harness>(["cursor-cli"]);

export function harnessHasLifecycleHooks(agent: Harness): boolean {
  return HARNESSES_WITH_LIFECYCLE_HOOKS.has(agent);
}

export function harnessUsesTerminalPromptFallback(agent: Harness): boolean {
  return HARNESSES_WITH_TERMINAL_PROMPT_FALLBACK.has(agent);
}

export function terminalInputStartsTurn(agent: Harness, data: string): boolean {
  if (harnessHasLifecycleHooks(agent)) return false;
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
