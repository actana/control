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

/**
 * The style a section heading **under** a frame carries.
 *
 * `From the Panel` on the Core's handout and `Next steps` on the client's
 * result are the same element doing the same job, and #366's review caught them
 * rendering differently — one bold, one dim — which is the exact drift this
 * module exists to stop. Bold, because that is what #364 shipped and `pair new`
 * has an operator reading it in the wild today; a heading that is dimmer than
 * the prose beneath it is also the wrong way round.
 *
 * Field labels *inside* a frame stay {@link ANSI.dim}. They are a column, not a
 * heading — the eye finds them by position.
 */
export const FRAME_HEADING = ANSI.bold;

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
 * names — a label is a name the operator chose and can read back from where
 * they chose it. A fingerprint wraps instead, and nothing routes one through
 * here.
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
 * is short, and a diagnostic relayed from the SDK is a sentence of whatever
 * length that sentence is — with, sometimes, an unbreakable value sitting in
 * the middle of it.
 *
 * **This function may not shorten its input.** Every caller is printing
 * something an operator has to read exactly — a path to their own credential,
 * an address, a fingerprint they are being asked to *compare* — and a wrap that
 * drops characters is a truncation wearing a different name.
 *
 * So a word too long for a line of its own is broken on {@link WORD_BREAKS} —
 * `/`, `:` and `.`, the separators the values reaching a frame are built out
 * of: a path, an origin, a `host:port`, colon-hex, a domain name. The
 * separator stays at the end of the line it breaks after, which is what tells a
 * reader the value continues — the same move `wrapFingerprint` makes on the
 * Core's side.
 *
 * Neither is an edge case. A credential lands under the operator's home
 * directory, and a home deep enough to overflow a 74-column box is an ordinary
 * machine; the SDK's `fingerprint-mismatch` sentence carries **two** 95-column
 * colon-hex fingerprints, and that is the one class on this screen whose whole
 * subject is a value being compared character by character (#366 review 1).
 *
 * **The residual, stated rather than hidden:** a word with neither separator in
 * it and no room to fit is left whole and over-long, and the border beside it
 * runs one column past the rest. That is deliberate. There is nowhere left to
 * break that would not put a line ending in the middle of a name, and a ragged
 * border is a cheaper failure than a value an operator cannot trust. It is
 * pinned by a test so it stays a decision.
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
    // chunk open so anything after it — `(mode 0600)`, `was expected — the
    // pairing code was not sent` — can share that line rather than starting
    // another.
    const chunks = breakLongWord(word, width);
    lines.push(...chunks.slice(0, -1));
    line = chunks.at(-1) ?? "";
  }
  if (line !== "") lines.push(line);
  return lines.length > 0 ? lines : [""];
}

/**
 * The separators an over-long word may be broken after.
 *
 * Three, because between them they are what every unbreakable value this
 * program prints is built out of:
 *
 *   - `/` — a filesystem path, and the path half of a URL;
 *   - `:` — `host:port`, an `https://` scheme, and colon-hex: a SHA-256
 *     fingerprint is 95 columns and is the reason this list is not just `/`
 *     (#366 review 1);
 *   - `.` — a domain name, which is the long slash-free value an endpoint row
 *     is made of and the one the review asked about by name. Found by a test:
 *     `https://a-very-long-host-name.example.invalid:8443/…` has 38 columns
 *     between its `//` and its port, and neither of the first two separators
 *     is anywhere in them.
 *
 * A sentence-ending full stop is a break point too, in principle. In practice
 * it never is: a word is only broken here when it is longer on its own than
 * the whole line, and the last word of a sentence is not.
 */
const WORD_BREAKS = /(?<=[/:.])/;

/**
 * One over-long word, split after its separators, each line keeping its own.
 *
 * The separator stays at the end of the line it breaks after, which is what
 * tells a reader that the value continues — the same reason `wrapFingerprint`
 * keeps its colons on the Core's side.
 *
 * **Lossless by construction.** The split is a zero-width lookbehind, so the
 * pieces are the input partitioned rather than tokenised: nothing is consumed
 * as a delimiter and `chunks.join("")` is the word it was handed. A word with
 * no separator in it comes back as one over-long chunk — see the residual in
 * {@link wrapText}.
 */
function breakLongWord(word: string, width: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const piece of word.split(WORD_BREAKS)) {
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
