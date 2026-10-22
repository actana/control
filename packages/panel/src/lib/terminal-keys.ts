// Pure helpers behind the phone terminal key row (Esc · Tab · Ctrl · arrows ·
// paste). They turn a key into the bytes xterm's own keyboard would have sent.

export type TerminalKey = "esc" | "tab" | "up" | "down" | "right" | "left";

export type KeySequenceOptions = {
  /** xterm's DECCKM state (`term.modes.applicationCursorKeysMode`). When a TUI
   * switches it on, arrows are `ESC O x` instead of `ESC [ x`. Default off. */
  applicationCursor?: boolean;
};

const ARROW_FINAL: Record<"up" | "down" | "right" | "left", string> = {
  up: "A",
  down: "B",
  right: "C",
  left: "D",
};

export function keySequence(key: TerminalKey, options: KeySequenceOptions = {}): string {
  if (key === "esc") return "\x1b";
  if (key === "tab") return "\t";
  return (options.applicationCursor ? "\x1bO" : "\x1b[") + ARROW_FINAL[key];
}

/** Ctrl applied to one character typed or sent. Only single characters have a
 * control form; anything else (multi-char data, escape sequences, unmapped
 * characters) is returned unchanged. */
export function applyCtrl(data: string): string {
  if (data.length !== 1) return data;
  if (/[a-zA-Z]/.test(data)) return String.fromCharCode(data.toUpperCase().charCodeAt(0) - 64);
  switch (data) {
    case "@":
    case " ":
      return "\x00";
    case "[":
      return "\x1b";
    case "\\":
      return "\x1c";
    case "]":
      return "\x1d";
    case "^":
      return "\x1e";
    case "_":
      return "\x1f";
    case "?":
      return "\x7f";
    default:
      return data;
  }
}
