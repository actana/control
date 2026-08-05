import { describe, expect, it } from "vitest";
import {
  harnessUsesTerminalPromptFallback,
  shouldResetTerminalRunningFallback,
  terminalInputStartsTurn,
} from "../task-status-sync";

describe("terminal status sync", () => {
  it("stands the fallback down only for a Session whose hooks actually went in", () => {
    // The Core installed them for this spawn — the hooks report the turn.
    expect(terminalInputStartsTurn("claude-code", "\r", true)).toBe(false);
    expect(terminalInputStartsTurn("cursor-cli", "implement this\r", true)).toBe(false);
  });

  it("keeps the fallback armed for a hook-capable harness whose hooks did NOT go in", () => {
    // The regression this rule exists for (issue 84): claude-code is a family
    // that supports hooks, so the old family-set check exempted it — leaving a
    // Session with neither hooks nor a fallback, stuck on `ready` forever.
    expect(terminalInputStartsTurn("claude-code", "\r", false)).toBe(true);
    expect(terminalInputStartsTurn("opencode", "\r", false)).toBe(true);
  });

  it("marks input-driven agents as running when the user submits input", () => {
    expect(harnessUsesTerminalPromptFallback("cursor-cli")).toBe(true);
    expect(harnessUsesTerminalPromptFallback("codex")).toBe(false);
    expect(terminalInputStartsTurn("cursor-cli", "hello", false)).toBe(false);
    expect(terminalInputStartsTurn("cursor-cli", "implement this\r", false)).toBe(true);
    expect(terminalInputStartsTurn("codex", "\r", false)).toBe(true);
  });

  it("re-arms the Enter→running fallback after a turn leaves running", () => {
    expect(shouldResetTerminalRunningFallback("running")).toBe(false);
    // stop/afterAgentResponse flipped the card to finished → clear the latch
    // so the next Enter in the same session can post running again.
    expect(shouldResetTerminalRunningFallback("finished")).toBe(true);
    expect(shouldResetTerminalRunningFallback("needs-input")).toBe(true);
    expect(shouldResetTerminalRunningFallback("ready")).toBe(true);
  });
});
