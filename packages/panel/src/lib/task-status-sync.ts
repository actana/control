import type { Harness } from "@actana/shared/domain";
import { isTerminalAutoReply } from "~/lib/terminal-user-input";

// Cursor CLI installs .cursor/hooks.json (beforeSubmitPrompt/stop/sessionStart),
// but beforeSubmitPrompt still does not fire in cursor-agent — only stop /
// sessionStart / tool hooks do. Capture submitted prompts from the terminal so
// titles and icons can still be generated, and use Enter as the running signal.
const HARNESSES_WITH_TERMINAL_PROMPT_FALLBACK = new Set<Harness>(["cursor-cli"]);

export function harnessUsesTerminalPromptFallback(agent: Harness): boolean {
  return HARNESSES_WITH_TERMINAL_PROMPT_FALLBACK.has(agent);
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const BACKSPACE = "\x7f";
const CTRL_H = "\b";

// Anchored at the cursor, so the scanner can step over a complete escape
// sequence instead of over its first byte. Same shapes `terminal-user-input`
// classifies, plus a catch-all for a bare/truncated ESC.
const ESCAPE_AT =
  /(?:\x1b\[[0-9:;<=>?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[\s\S]*?\x1b\\|\x1bO[\s\S]|\x1b[\s\S]?)/y;

/**
 * What the operator has entered into this pane but not yet submitted.
 *
 * `composed` is the printable text standing at the harness's own prompt;
 * `pasting` records that we are inside a bracketed paste (ESC[200~ … ESC[201~),
 * where newlines are pasted *text*, never a submit.
 */
export type TerminalTurnState = {
  composed: string;
  pasting: boolean;
};

export const IDLE_TERMINAL_TURN: TerminalTurnState = { composed: "", pasting: false };

/**
 * Fold one chunk of terminal input into the turn state.
 *
 * `submittedTurn` is the fresh turn-start signal the running fallback is gated
 * on (issue 386). It is NOT "the bytes contained a CR or an LF": after a
 * Session settles, a stray Enter, a pasted path, or a drop-path write all
 * carry a newline while starting nothing, and each one used to PATCH the row
 * back to `running`. A turn starts only when a newline SUBMITS text the
 * operator actually composed here — which is also why a paste alone never
 * submits: the terminal is inserting text, not pressing Return.
 */
export function advanceTerminalTurn(
  state: TerminalTurnState,
  data: string,
): { state: TerminalTurnState; submittedTurn: boolean } {
  // Focus reports, cursor-position and device-attribute replies ride the same
  // stream as keystrokes; none of them is the operator entering anything.
  if (isTerminalAutoReply(data)) return { state, submittedTurn: false };
  let composed = state.composed;
  let pasting = state.pasting;
  let submittedTurn = false;
  let i = 0;
  while (i < data.length) {
    if (data.startsWith(PASTE_START, i)) {
      pasting = true;
      i += PASTE_START.length;
      continue;
    }
    if (data.startsWith(PASTE_END, i)) {
      pasting = false;
      i += PASTE_END.length;
      continue;
    }
    const char = data[i]!;
    if (pasting) {
      // Everything between the markers is literal text, newlines included.
      if (char >= " " || char === "\t" || char === "\r" || char === "\n") composed += char;
      i += 1;
      continue;
    }
    if (char === "\x1b") {
      ESCAPE_AT.lastIndex = i;
      const escape = ESCAPE_AT.exec(data);
      i += escape ? escape[0].length : 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      if (composed.trim().length > 0) submittedTurn = true;
      composed = "";
      i += 1;
      continue;
    }
    if (char === BACKSPACE || char === CTRL_H) {
      composed = composed.slice(0, -1);
      i += 1;
      continue;
    }
    if (char >= " " || char === "\t") composed += char;
    i += 1;
  }
  return { state: { composed, pasting }, submittedTurn };
}

/**
 * Does this submitted turn start a turn for a Session nothing else will report?
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
  hooksReportTurnStart: boolean,
  submittedTurn: boolean,
): boolean {
  if (hooksReportTurnStart) return false;
  return submittedTurn;
}

/**
 * Clear the Enter→running one-shot latch once the task is no longer running.
 * Without this, a second prompt in the same Cursor session never flips the
 * card back to running after stop → finished.
 */
export function shouldResetTerminalRunningFallback(currentStatus: string): boolean {
  return currentStatus !== "running";
}

/** The pane's whole Enter→running fallback: the latch and the turn it watches. */
export type TerminalRunningFallback = {
  turn: TerminalTurnState;
  posted: boolean;
};

export const IDLE_TERMINAL_RUNNING_FALLBACK: TerminalRunningFallback = {
  turn: IDLE_TERMINAL_TURN,
  posted: false,
};

/**
 * Decide, for one chunk of terminal input, whether to PATCH the row `running`.
 *
 * Two gates, and both must open. `posted` is the per-turn one-shot, re-armed
 * as soon as the row leaves `running` so a second prompt in the same Session
 * still updates the card. The turn state is the one issue 386 added: re-arming
 * on "not running" alone made every post-settlement newline a turn start.
 */
export function advanceTerminalRunningFallback(
  state: TerminalRunningFallback,
  input: { data: string; currentStatus: string; hooksReportTurnStart: boolean },
): { state: TerminalRunningFallback; postRunning: boolean } {
  const { state: turn, submittedTurn } = advanceTerminalTurn(state.turn, input.data);
  const posted = shouldResetTerminalRunningFallback(input.currentStatus) ? false : state.posted;
  const postRunning =
    !posted && terminalInputStartsTurn(input.hooksReportTurnStart, submittedTurn);
  return { state: { turn, posted: posted || postRunning }, postRunning };
}
