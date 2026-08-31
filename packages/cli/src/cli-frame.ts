// The framed, coloured shapes this CLI draws **only when stdout is a terminal**.
//
// These primitives arrived with `actana pair new` (#357) and lived inside
// `actana-pair.ts` because there was one framed block in the program. #360 adds
// the second one — `actana core pair`, the other end of the same exchange — and
// two copies of a border width, a padding rule and a colour table is how the two
// ends of one handshake start drawing different boxes. So they are here, and
// both callers import them.
//
// **The gate is `isatty(stdout)` and nothing else.** No flag, no environment
// variable beyond `NO_COLOR`, and deliberately no `--json`. A pipe, a file, a
// `$( )` and a CI log get exactly the lines the command printed before any of
// this existed; a terminal gets the frame. Nothing about *what* a command does
// may read that answer — a command that behaved differently down a pipe than it
// does at a terminal is a command no script can trust — and nothing here can
// help it to, because everything in this file is pure: values in, lines out.
// That is also what lets the suites assert on a frame without a terminal.

import type { ActanaCliDeps } from "./cli-deps.ts";

/** The escape sequences the frames use, and the only ANSI in this package. */
export const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  /** A value that is the whole point of the screen — a pairing code. */
  boldCyan: "\u001b[1;36m",
  /** The marker on a block that says something worked. */
  green: "\u001b[32m",
  /** The marker on a block that says something did not. */
  red: "\u001b[31m",
} as const;

/**
 * Whether to colour, given a terminal.
 *
 * `stdoutIsTty` is the gate; `NO_COLOR` is the standard opt-out on top of it
 * (https://no-color.org). Honouring it costs one clause and means an operator
 * whose terminal renders escapes badly still gets the instructions, rather than
 * having to choose between colour and a pipe.
 */
export function useColor(deps: ActanaCliDeps): boolean {
  const noColor = deps.env.NO_COLOR;
  return deps.stdoutIsTty && (noColor === undefined || noColor === "");
}

/** The frame's total width, borders included. Fixed, so the output is one shape. */
export const FRAME_WIDTH = 74;

/** How far in from the left border the content starts. */
export const FRAME_GUTTER = 3;

/**
 * How many columns a framed row's content may occupy.
 *
 * The two borders, the gutter, and one column held back on the right so the
 * closing bar is never flush against a word.
 */
export const FRAME_CONTENT_WIDTH = FRAME_WIDTH - 2 - FRAME_GUTTER - 1;

/** One run of styled text inside a framed line. */
export type Span = { text: string; style?: string };

/** The top or bottom rule. */
export function frameEdge(which: "top" | "bottom", color: boolean): string {
  const [left, right] = which === "top" ? ["╭", "╮"] : ["╰", "╯"];
  return style(`${left}${"─".repeat(FRAME_WIDTH - 2)}${right}`, ANSI.dim, color);
}

/**
 * One line between the two borders.
 *
 * The padding is measured on the **plain** text and the styling applied
 * afterwards, because an escape sequence has a length and no width — pad a
 * coloured string by `String.length` and the right border walks off by however
 * many bytes the colour cost.
 */
export function frameRow(spans: Span[], color: boolean): string {
  const plain = spans.map((span) => span.text).join("");
  const body = spans.map((span) => style(span.text, span.style, color)).join("");
  const fill = Math.max(1, FRAME_WIDTH - 2 - FRAME_GUTTER - displayWidth(plain));
  const bar = style("│", ANSI.dim, color);
  return `${bar}${" ".repeat(FRAME_GUTTER)}${body}${" ".repeat(fill)}${bar}`;
}

/**
 * How many terminal columns `text` occupies.
 *
 * `String.length` is UTF-16 code units and a frame padded by it is crooked for
 * anybody whose label is not Latin: three CJK characters are three code units
 * and six columns, so the right border lands three early (#357 review N1).
 * Counted per code point — a surrogate pair is one character, not two — with
 * the wide ranges at two and the zero-width ones at nothing.
 *
 * Deliberately not a full `wcwidth`. This measures the handful of things that
 * reach a frame row: ASCII, an operator's label, a UUID, colon-hex and a tick.
 * Emoji with joiners and skin tones can still measure a column off, and the
 * cost of that is a ragged border on one line — not a truncated fingerprint,
 * which is the thing these callers may never do.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    if (isZeroWidth(point)) continue;
    width += isWide(point) ? 2 : 1;
  }
  return width;
}

/** Combining marks and variation selectors: they attach, they take no column. */
function isZeroWidth(point: number): boolean {
  return (
    (point >= 0x0300 && point <= 0x036f) ||
    (point >= 0x200b && point <= 0x200f) ||
    (point >= 0xfe00 && point <= 0xfe0f) ||
    point === 0x2060 ||
    point === 0xfeff
  );
}

/** The double-width blocks: CJK, Hangul, kana, fullwidth forms, and emoji. */
function isWide(point: number): boolean {
  return (
    (point >= 0x1100 && point <= 0x115f) ||
    (point >= 0x2e80 && point <= 0xa4cf) ||
    (point >= 0xac00 && point <= 0xd7a3) ||
    (point >= 0xf900 && point <= 0xfaff) ||
    (point >= 0xfe30 && point <= 0xfe6f) ||
    (point >= 0xff00 && point <= 0xff60) ||
    (point >= 0xffe0 && point <= 0xffe6) ||
    (point >= 0x1f300 && point <= 0x1f64f) ||
    (point >= 0x1f900 && point <= 0x1f9ff) ||
    (point >= 0x20000 && point <= 0x3fffd)
  );
}

/**
 * `text` shortened to `columns` display columns, marked when it was shortened.
 *
 * **Only ever called on something the operator can read back somewhere else.**
 * Truncation is a lie about a value, and the values worth telling it about are
 * names — a label is a name the operator chose and can read off `pair ls`. A
 * fingerprint wraps instead, and nothing routes one through here.
 */
export function clip(text: string, columns: number): string {
  if (displayWidth(text) <= columns) return text;
  let kept = "";
  let width = 0;
  for (const character of text) {
    const next = width + displayWidth(character);
    // One column held back for the marker, which is one column wide.
    if (next > columns - 1) break;
    kept += character;
    width = next;
  }
  return `${kept}…`;
}

/** Wrap `text` in an escape sequence, or hand it back untouched. */
export function style(text: string, code: string | undefined, color: boolean): string {
  return color && code ? `${code}${text}${ANSI.reset}` : text;
}

/**
 * `text` broken across lines at spaces, measured in display columns.
 *
 * Prose is the one thing a frame holds that has no natural break in it: a label
 * is short, a fingerprint splits on its own colons, and a diagnostic relayed
 * from the SDK is a sentence of whatever length that sentence is.
 *
 * **This function may not shorten its input.** Every caller is printing
 * something an operator has to read exactly — a path to their own credential, a
 * URL, an address — and a wrap that drops characters is a truncation wearing a
 * different name. So a word too long for a line of its own is broken on its
 * slashes rather than cut, which is the same move `wrapFingerprint` makes on
 * colons: the separator stays at the end of the line, so a reader can see there
 * is more. That is not an edge case. A credential lands under the operator's
 * home directory, and a home directory deep enough to overflow a 74-column box
 * is an ordinary machine, not a pathological one.
 *
 * A word with no slash in it and no room to fit is left over-long. A ragged
 * border is the acceptable cost; a lost character is not.
 */
export function wrapText(text: string, columns: number): string[] {
  const width = Math.max(1, columns);
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((piece) => piece !== "")) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (displayWidth(candidate) <= width) {
      line = candidate;
      continue;
    }
    if (line !== "") lines.push(line);
    line = "";
    if (displayWidth(word) <= width) {
      line = word;
      continue;
    }
    // Too long for any line. Break it where it has a break, and leave the last
    // chunk open so anything after it — `(mode 0600)`, a trailing note — can
    // share that line rather than starting another.
    const chunks = breakOnSlashes(word, width);
    lines.push(...chunks.slice(0, -1));
    line = chunks.at(-1) ?? "";
  }
  if (line !== "") lines.push(line);
  return lines.length > 0 ? lines : [""];
}

/**
 * One over-long word, split on its slashes, each line keeping its separator.
 *
 * The separator stays at the end of the line it breaks after, which is what
 * tells a reader that the value continues — the same reason `wrapFingerprint`
 * keeps its colons. A single segment with no slash and no room is handed back
 * over-long: there is nowhere left to break, and breaking anyway would put a
 * line ending in the middle of a directory name.
 */
function breakOnSlashes(word: string, width: number): string[] {
  const parts = word.split("/");
  const chunks: string[] = [];
  let chunk = "";
  for (const [index, part] of parts.entries()) {
    const piece = index < parts.length - 1 ? `${part}/` : part;
    if (piece === "") continue;
    if (chunk !== "" && displayWidth(chunk + piece) > width) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += piece;
  }
  if (chunk !== "") chunks.push(chunk);
  return chunks.length > 0 ? chunks : [word];
}
