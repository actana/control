import { describe, expect, it } from "vitest";
import {
  advanceTerminalTurn,
  harnessUsesTerminalPromptFallback,
  IDLE_TERMINAL_TURN,
  shouldResetTerminalRunningFallback,
  terminalInputStartsTurn,
} from "../task-status-sync";

/** Fold a script of onData chunks, keeping every submit the run produced. */
function typeInto(chunks: string[]) {
  let state = IDLE_TERMINAL_TURN;
  const submits: boolean[] = [];
  for (const chunk of chunks) {
    const step = advanceTerminalTurn(state, chunk);
    state = step.state;
    submits.push(step.submittedTurn);
  }
  return { state, submits, submitted: submits.some(Boolean) };
}

describe("terminal status sync", () => {
  it("stands the fallback down only for a Session whose hooks actually went in", () => {
    // The Core installed them for this spawn — the hooks report the turn.
    expect(terminalInputStartsTurn(true, true)).toBe(false);
  });

  it("keeps the fallback armed for a hook-capable harness whose hooks did NOT go in", () => {
    // The regression this rule exists for (issue 84): claude-code is a family
    // that supports hooks, so the old family-set check exempted it — leaving a
    // Session with neither hooks nor a fallback, stuck on `ready` forever.
    expect(terminalInputStartsTurn(false, true)).toBe(true);
    expect(terminalInputStartsTurn(false, false)).toBe(false);
  });

  it("marks input-driven agents as running when the user submits input", () => {
    expect(harnessUsesTerminalPromptFallback("cursor-cli")).toBe(true);
    expect(harnessUsesTerminalPromptFallback("codex")).toBe(false);
    expect(typeInto(["hello"]).submitted).toBe(false);
    expect(typeInto(["implement this\r"]).submitted).toBe(true);
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

describe("advanceTerminalTurn", () => {
  it("submits only a newline that terminates composed text", () => {
    expect(typeInto(["fix ", "login", "\r"]).submitted).toBe(true);
    // A bare Enter at an empty prompt enters nothing (issue 386).
    expect(typeInto(["\r"]).submitted).toBe(false);
    expect(typeInto(["\n"]).submitted).toBe(false);
    expect(typeInto(["\r", "\r", "\n"]).submitted).toBe(false);
    // Whitespace is not something the operator entered either.
    expect(typeInto(["   \r"]).submitted).toBe(false);
  });

  it("clears the composition on submit, so the next Enter starts nothing", () => {
    const run = typeInto(["ship it\r", "\r"]);
    expect(run.submits).toEqual([true, false]);
    expect(run.state.composed).toBe("");
  });

  it("treats a bracketed paste as text, never as a submit", () => {
    // xterm wraps a paste in ESC[200~ … ESC[201~ whenever the harness has
    // bracketed paste on, which every TUI harness here does. Pasting is the
    // terminal inserting characters; it is not pressing Return — so a pasted
    // path, even one carrying newlines, starts no turn.
    const path = typeInto(["\x1b[200~/home/core/repos/control\x1b[201~"]);
    expect(path.submitted).toBe(false);
    expect(path.state.composed).toBe("/home/core/repos/control");
    expect(typeInto(["\x1b[200~one\ntwo\n\x1b[201~"]).submitted).toBe(false);
    // …and the Enter the operator presses afterwards submits what was pasted.
    const state = advanceTerminalTurn(IDLE_TERMINAL_TURN, "\x1b[200~./notes.md\x1b[201~").state;
    expect(advanceTerminalTurn(state, "\r").submittedTurn).toBe(true);
  });

  it("survives a paste split across chunks", () => {
    const run = typeInto(["\x1b[200~/home/core", "/repos\x1b[201~", "\r"]);
    expect(run.submits).toEqual([false, false, true]);
  });

  it("ignores terminal-generated replies and cursor keys", () => {
    // Focus reports and device-attribute answers ride onData too; none of them
    // is the operator entering anything.
    expect(typeInto(["\x1b[I"]).state.composed).toBe("");
    expect(typeInto(["\x1b[?62;c"]).state.composed).toBe("");
    const arrows = typeInto(["hi", "\x1b[A", "\x1b[B", "\r"]);
    expect(arrows.state.composed).toBe("");
    expect(arrows.submitted).toBe(true);
  });

  it("honours backspace, so a fully erased line submits nothing", () => {
    expect(typeInto(["ab\x7f\x7f", "\r"]).submitted).toBe(false);
    expect(typeInto(["ship\x7f it", "\r"]).submitted).toBe(true);
    expect(typeInto(["ship\x7f"]).state.composed).toBe("shi");
  });

  it("handles a chunk that submits and then keeps typing", () => {
    const step = advanceTerminalTurn(IDLE_TERMINAL_TURN, "go\rnext");
    expect(step.submittedTurn).toBe(true);
    expect(step.state.composed).toBe("next");
  });
});
