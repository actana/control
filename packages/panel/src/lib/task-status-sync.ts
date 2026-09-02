import type { Harness } from "@actana/shared/domain";
import { isTerminalAutoReply } from "~/lib/terminal-user-input";

// Cursor CLI installs .cursor/hooks.json (beforeSubmitPrompt/stop/sessionStart),
// but beforeSubmitPrompt still does not fire in cursor-agent — only stop /
// sessionStart / tool hooks do. Capture submitted prompts from the terminal so
// titles and icons can still be generated, and read a turn's start from the
// terminal too — from a prompt the operator SUBMITS, never from a bare newline
// (issue 386).
const HARNESSES_WITH_TERMINAL_PROMPT_FALLBACK = new Set<Harness>(["cursor-cli"]);

export function harnessUsesTerminalPromptFallback(agent: Harness): boolean {
  return HARNESSES_WITH_TERMINAL_PROMPT_FALLBACK.has(agent);
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const BACKSPACE = "\x7f";
const CTRL_H = "\b";
const CTRL_C = "\x03";
const CTRL_U = "\x15";
const CTRL_W = "\x17";
const ESC = "\x1b";
const DELETE = "\x1b[3~";
// Up / Down, in both the normal and application-cursor encodings.
const RECALL_KEYS = new Set(["\x1b[A", "\x1b[B", "\x1bOA", "\x1bOB"]);

// Anchored at the cursor, so the scanner can step over a complete escape
// sequence instead of over its first byte. Same shapes `terminal-user-input`
// classifies, plus a catch-all for ESC + one byte (Alt-b, Shift+Enter's
// `ESC CR`, …).
const ESCAPE_AT =
  /(?:\x1b\[[0-9:;<=>?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[\s\S]*?\x1b\\|\x1bO[\s\S]|\x1b[\s\S]?)/y;

// A sequence that has begun and has not yet been terminated — the tail of a
// chunk that was split mid-escape. Deliberately does NOT match a lone ESC:
// that is the Esc *key*, which cancels a composition, and waiting for a byte
// that will never come would swallow it.
const INCOMPLETE_TAIL = /^(?:\x1b\[[0-9:;<=>?]*[ -/]*|\x1b\][^\x07\x1b]*|\x1bP[\s\S]*|\x1bO)$/;

// A stream that never terminates a sequence must not grow this without bound.
// Past the cap the tail is dropped: it is terminal noise, not composition.
const MAX_PARTIAL_ESCAPE = 256;

/**
 * What the operator has entered into this pane but not yet submitted.
 *
 * - `composed` — the printable text standing at the harness's own prompt.
 * - `recalled` — text is standing there that this pane never saw: the operator
 *   pressed Up to recall a previous prompt. Enter submits it just the same.
 * - `pasting` — inside a bracketed paste (ESC[200~ … ESC[201~), where newlines
 *   are pasted *text*, never a submit.
 * - `partial` — a trailing escape sequence cut in half by a chunk boundary,
 *   held over so the next chunk can complete it.
 */
export type TerminalTurnState = {
  composed: string;
  recalled: boolean;
  pasting: boolean;
  partial: string;
};

export const IDLE_TERMINAL_TURN: TerminalTurnState = {
  composed: "",
  recalled: false,
  pasting: false,
  partial: "",
};

/** Is there input standing at the prompt for a newline to submit? */
function hasPendingInput(state: { composed: string; recalled: boolean }): boolean {
  return state.recalled || state.composed.trim().length > 0;
}

/** Drop the trailing word, as Ctrl+W does at a readline prompt. */
function killWord(composed: string): string {
  return composed.replace(/\s*\S*$/, "");
}

/**
 * Fold one chunk of terminal input into the turn state.
 *
 * `submittedTurn` is the fresh turn-start signal the running fallback is gated
 * on (issue 386). It is NOT "the bytes contained a CR or an LF": after a
 * Session settles, a stray Enter, a pasted path, or a drop-path write all
 * carry a newline while starting nothing, and each one used to PATCH the row
 * back to `running`. A turn starts only when a newline submits input that is
 * actually standing at the prompt.
 *
 * Which means the cancels have to be honoured too, or the mirror drifts from
 * the harness's real prompt in both directions. Ctrl+C, Ctrl+U and Esc empty
 * the line; Ctrl+W kills the trailing word; Delete and Backspace take one
 * character. Model them and "typed, changed my mind, pressed Enter" stops
 * posting `running` — while an edit that leaves text behind still posts, which
 * clearing on every edit key would have broken.
 */
export function advanceTerminalTurn(
  state: TerminalTurnState,
  data: string,
): { state: TerminalTurnState; submittedTurn: boolean } {
  const input = state.partial + data;
  // Focus reports, cursor-position and device-attribute replies ride the same
  // stream as keystrokes; none of them is the operator entering anything.
  if (isTerminalAutoReply(input)) return { state: { ...state, partial: "" }, submittedTurn: false };
  let composed = state.composed;
  let recalled = state.recalled;
  let pasting = state.pasting;
  let partial = "";
  let submittedTurn = false;
  let i = 0;
  while (i < input.length) {
    if (input.startsWith(PASTE_START, i)) {
      pasting = true;
      i += PASTE_START.length;
      continue;
    }
    if (input.startsWith(PASTE_END, i)) {
      pasting = false;
      i += PASTE_END.length;
      continue;
    }
    const char = input[i]!;
    if (char === ESC) {
      const tail = input.slice(i);
      // Cut in half by the chunk boundary — hold it over rather than letting
      // the `200` of a split `ESC[200~` land in the composition as text, or the
      // `201` of a split closing marker leave the pane pasting for ever.
      if (tail.length > 1 && INCOMPLETE_TAIL.test(tail)) {
        partial = tail.length <= MAX_PARTIAL_ESCAPE ? tail : "";
        break;
      }
    }
    if (pasting) {
      // Everything between the markers is literal text, newlines included.
      if (char >= " " || char === "\t" || char === "\r" || char === "\n") composed += char;
      i += 1;
      continue;
    }
    if (char === ESC) {
      const tail = input.slice(i);
      if (tail === ESC) {
        // The Esc key: back out of the composer, exactly as the harness does.
        composed = "";
        recalled = false;
        i += 1;
        continue;
      }
      ESCAPE_AT.lastIndex = i;
      const escape = ESCAPE_AT.exec(input);
      const sequence = escape ? escape[0] : ESC;
      if (sequence === DELETE) composed = composed.slice(0, -1);
      else if (RECALL_KEYS.has(sequence)) recalled = true;
      i += sequence.length;
      continue;
    }
    if (char === "\r" || char === "\n") {
      if (hasPendingInput({ composed, recalled })) submittedTurn = true;
      composed = "";
      recalled = false;
      i += 1;
      continue;
    }
    if (char === CTRL_C || char === CTRL_U) {
      composed = "";
      recalled = false;
      i += 1;
      continue;
    }
    if (char === CTRL_W) {
      composed = killWord(composed);
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
  return { state: { composed, recalled, pasting, partial }, submittedTurn };
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

/**
 * Fold text the pane wrote to the pty ON the operator's behalf into the same
 * turn — a path dropped from the Panel's own UI, a key-map sequence like
 * Cmd+Backspace. None of it passes through xterm's keyboard, so `onData` never
 * sees it, and before this the pane's mirror of the prompt did not either: drop
 * a path onto a finished Cursor CLI Session and press Enter and a real turn
 * started with the card still reading `finished`.
 *
 * It composes but never posts. The submit that starts the turn is the
 * operator's Enter, and that still arrives through `onData`.
 */
export function noteTerminalWrite(
  state: TerminalRunningFallback,
  data: string,
): TerminalRunningFallback {
  return { ...state, turn: advanceTerminalTurn(state.turn, data).state };
}
