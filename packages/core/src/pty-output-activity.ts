// Telling a harness that is working from one that is only painting (issue 391).
//
// The quiet-Session backstop reads PTY output as proof that a turn is still
// running, and for a harness with working hooks that is nearly free: bytes and
// hooks agree. The failure this file exists for is the pair that disagree —
// Codex before its hooks have been reviewed with `/hooks`, or any harness
// whose terminal `Stop` was the POST that dropped. Both leave a TUI on screen
// that keeps repainting its spinner and its elapsed-time counter for as long
// as the process lives. Those bytes never stop, so "fifteen minutes with no
// output" never arrives, and the card claims `running` forever.
//
// So the bytes have to be read rather than counted. Not parsed — a TUI frame
// is cursor moves and colour, and every harness draws a different one — but
// reduced to the question the backstop actually asks: *did anything new appear
// on that screen?* A repaint of the same frame with a bigger number in it did
// not; a tool result, a diff, a line of assistant prose did.
//
// ─── How a repaint is told from real output ───
//
// Three tests, in the order they are cheapest to be sure of.
//
// **Did the burst erase anything?** A repaint is defined by what it destroys:
// a carriage return, an erase-line or erase-display, a cursor jump. Text that
// only appends — a log line, a diff, a row of pytest dots — destroys nothing
// and scrolls the screen, so it is new by construction and is `output` without
// looking at a single word. This is the test that keeps appended progress from
// reading as a spinner (review of PR 455, finding 2).
//
// **Do the digits belong to a clock?** Digits are how a counter changes, so
// they cannot count as new content — but only where they are a counter. They
// are dropped from a *line* that carries a spinner glyph or an elapsed-time
// pattern (`1m 12s`, `0:42`), and kept everywhere else, so `Downloading 41.2
// MB / 900 MB`, `Compiled 41 files` and `Tests 41 passed` stay the changing
// content they are while `⠹ Working (1m 12s)` reduces to its words.
//
// **Is any word new?** What survives — escapes, control bytes and spinner
// glyphs dropped, whitespace collapsed — is the frame's words. The burst is
// `output` when it carries a word the last {@link REMEMBERED_BURSTS} bursts do
// not already contain, and `redraw` when every word in it was already on
// screen a moment ago. The scan runs from the **end** of the burst, where a
// TUI puts what is new (review of PR 455, finding 3).
//
// The memory is deliberately short — about ten seconds of screen, not the
// whole turn. A harness that reads the same file twice in a turn, or prints a
// heading it printed five minutes ago, is working; only a screen that is
// *still* showing what it was showing seconds ago is idle. Comparing against
// everything ever printed would call that harness idle and settle it.
//
// The substring test — rather than a set of whole words — is deliberate: a
// burst boundary can fall inside a word, and `Think` + `ing` must not read as
// two new words every second. Both are substrings of a `Thinking` already
// remembered, so a split frame stays a redraw.
//
// ─── What this cannot tell apart ───
//
// Three limits, stated here rather than discovered later.
//
// A turn whose tool prints **nothing at all** is indistinguishable from a turn
// that ended. A progress line that is **both** spinner-prefixed and
// digits-only — `⠹ 41.2 MB / 900 MB` on one line, with nothing else changing —
// has its digits dropped as a clock and reads as a repaint. And the whole rule
// depends on the spinner phrase being **static**: a harness whose spinner
// rotates its gerund (`✻ Herding… / Simmering… / Pondering…`, Claude Code's
// shape) puts a new word on screen every rotation, so it produces `output`
// bursts while idle and the caller's idle rule never fires for it. That is
// deliberate — this file is for the Codex-shaped TUI #391 names, and a rule
// that never fires is safe in a way that a wrong finish is not.
//
// None of these is load-bearing on its own: the caller narrows further (it
// wants two consecutive idle sweeps, and it ignores this signal entirely for a
// harness whose hooks are arriving), and a `finished` it wrote for a Session
// that was only idle here is taken back by the next `output` burst — see
// `core-session-backstop.ts`.

/** What a burst of PTY output was: something new on screen, or a repaint. */
export type PtyOutputActivityKind = "output" | "redraw";

/**
 * How often a talking PTY reports that it is talking. The consumer only asks
 * "was there anything new in the last few minutes", so a five-second floor
 * loses nothing and keeps a chatty harness from calling out per chunk. Also
 * the window whose bytes are classified together — a frame split across
 * chunks is one burst here, not two.
 */
export const OUTPUT_ACTIVITY_WINDOW_MS = 5_000;

/** Cap on the bytes held between reports. A frame is far smaller than this. */
const MAX_PENDING_CHARS = 64 * 1024;

/**
 * How many reported bursts count as "already on screen". Two, which is about
 * ten seconds: long enough that a frame split across a burst boundary still
 * finds its other half, short enough that output repeated a minute later is
 * read as the new work it is.
 */
const REMEMBERED_BURSTS = 2;

/**
 * Cap on the words kept per remembered burst. Sized to hold a full-viewport
 * repaint — a wide screen is some fifteen thousand characters — because a
 * memory shorter than the burst it is compared against reports the difference
 * between them as new content.
 */
const MAX_REMEMBERED_CHARS = 16 * 1024;

/**
 * Words shorter than this are noise once glyphs are gone — unless they carry a
 * digit. A digit that survived normalisation is content, not a clock (the
 * clock's were dropped with its line), and `41` → `42` is the whole of what
 * changes in `Compiled 41 files`.
 */
const MIN_WORD_LENGTH = 3;

/** Cap on the words compared per burst, so a huge paste stays cheap. */
const MAX_WORDS_PER_BURST = 400;

// OSC (`ESC ] … BEL` / `ESC ] … ESC \`), CSI (`ESC [ … final`), and the
// two-byte escapes. Ordered widest-first: an OSC payload can contain what
// looks like a CSI.
const OSC_PATTERN = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// Colour and style, which sit *inside* a line and often inside a word: they
// vanish without leaving a gap, so a coloured spinner keeps its clock on the
// same line as its glyph and a colour reset does not split a word in two.
const SGR_PATTERN = /\x1b\[[0-9;:]*m/g;
// Everything else a CSI does is layout — a jump, an erase, a scroll — so it
// ends the line it is in.
const CSI_PATTERN = /\x1b\[[0-9;:?<>=!]*[ -/]*[@-~]/g;
const ESCAPE_PATTERN = /\x1b[\s\S]?/g;
// Control bytes other than the line breaks, which become line boundaries.
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
// Glyphs a spinner cycles through, and the rules a frame is drawn with:
// braille, block elements, geometric shapes, box drawing, dingbats, bullets.
const FRAME_GLYPH_PATTERN = /[\u2022\u00b7\u2500-\u25ff\u2700-\u27bf\u2800-\u28ff]/g;
// The subset of those that a spinner actually cycles: braille and dingbats.
// Box drawing is a border and says nothing about whether a line is a clock.
const SPINNER_GLYPH_PATTERN = /[\u2800-\u28ff\u2700-\u27bf\u25d0-\u25d3\u25e2-\u25e5]/;
/**
 * An elapsed-time counter on a line: `12s`, `1m 12s`, `2h`, `0:42`, `1:02:03`.
 * Deliberately narrow — a unit letter must end the token, so `900 MB` and
 * `3.1 MB/s` are sizes and rates, which are content, not clocks.
 */
const ELAPSED_PATTERN = /\d+\s*[hms]\b|\d+:\d{2}/;

/**
 * Did this burst erase or move anything, or did it only append?
 *
 * A repaint destroys: a bare carriage return, an erase (`ESC [ … J/K`), a
 * cursor move or jump (`ESC [ … A-H`), a screen switch. Text that only appends
 * has none of those — it scrolled the screen, so it is new by construction.
 * Exported for the tests.
 */
export function repaintsInPlace(text: string): boolean {
  return (
    /\r(?!\n)/.test(text) ||
    /\x1b\[[0-9;?]*[JKABCDEFGHfd]/.test(text) ||
    /\x1b\[\?(?:47|1047|1049)[hl]/.test(text) ||
    /\x1b[78M]/.test(text)
  );
}

/**
 * Reduce a burst of PTY output to the words on screen: no escapes, no control
 * bytes, no spinner glyphs, single-spaced — and no digits *on a line that is
 * carrying a clock*, which is the only place a digit is a counter rather than
 * content. Exported for the tests, which are the only readers that care what
 * the reduction looks like.
 */
export function normalizePtyOutput(text: string): string {
  const plain = text
    .replace(OSC_PATTERN, " ")
    .replace(SGR_PATTERN, "")
    .replace(CSI_PATTERN, "\n")
    .replace(ESCAPE_PATTERN, " ")
    .replace(CONTROL_PATTERN, " ");
  const lines = plain.split(/[\r\n]+/).map((line) => {
    const isClock = SPINNER_GLYPH_PATTERN.test(line) || ELAPSED_PATTERN.test(line);
    const words = line.replace(FRAME_GLYPH_PATTERN, " ");
    return isClock ? words.replace(/\d/g, "") : words;
  });
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * One per agent PTY. Fed every chunk; answers at most once per
 * {@link OUTPUT_ACTIVITY_WINDOW_MS} with what the bytes since the last answer
 * were — and `null` in between, which is the throttle the PTY data path needs.
 */
export class PtyOutputActivityWatcher {
  private pending = "";
  private reportedAt = 0;
  private repaintedLast = false;
  private readonly remembered: string[] = [];

  /**
   * Take a chunk. Returns the kind when the window has elapsed and this burst
   * is being reported, or `null` while it is still being accumulated.
   */
  push(chunk: string, now: number): PtyOutputActivityKind | null {
    this.pending += chunk;
    if (this.pending.length > MAX_PENDING_CHARS) {
      this.pending = this.pending.slice(-MAX_PENDING_CHARS);
    }
    if (now - this.reportedAt <= OUTPUT_ACTIVITY_WINDOW_MS) return null;
    this.reportedAt = now;
    const burst = this.pending;
    this.pending = "";
    return this.classify(burst);
  }

  private classify(burst: string): PtyOutputActivityKind {
    const normalized = normalizePtyOutput(burst);
    // A burst that reduces to nothing is pure cursor movement — a repaint of
    // the same characters, or of none.
    if (!normalized) return "redraw";
    // Nothing was erased, so nothing was replaced: this text scrolled onto the
    // screen and is new whatever it says. The exception is a screen that was
    // being repainted a moment ago — then a burst with no controls of its own
    // is the tail of a frame whose head arrived in the last burst, not a line
    // of appended output.
    const repainted = repaintsInPlace(burst);
    const wasRepainting = this.repaintedLast;
    this.repaintedLast = repainted;
    if (!repainted && !wasRepainting) {
      this.remember(normalized);
      return "output";
    }
    const onScreen = ` ${this.remembered.join(" ")} `;
    const words = normalized.split(" ");
    let novel = false;
    // From the end: a TUI paints what is new at the bottom, and `push` keeps
    // the tail of an oversized burst, so the front is the wrong end to cap.
    let scanned = 0;
    for (let i = words.length - 1; i >= 0 && scanned < MAX_WORDS_PER_BURST; i -= 1) {
      const word = words[i];
      // Fragments are what a burst boundary inside a word leaves behind, and
      // they say nothing either way — but a short number is a count, not a
      // fragment.
      if (word.length < MIN_WORD_LENGTH && !/\d/.test(word)) continue;
      scanned += 1;
      // A number is matched whole. `40` is a substring of `(400)` and a
      // count that reads as already-seen is a live turn read as idle; a word
      // is matched loosely on purpose, so a split `Think`/`ing` still is.
      const numeric = /\d/.test(word) && !/[A-Za-z]/.test(word);
      if (numeric ? onScreen.includes(` ${word} `) : onScreen.includes(word)) continue;
      novel = true;
      break;
    }
    this.remember(normalized);
    return novel ? "output" : "redraw";
  }

  private remember(normalized: string): void {
    this.remembered.push(
      normalized.length > MAX_REMEMBERED_CHARS
        ? normalized.slice(-MAX_REMEMBERED_CHARS)
        : normalized,
    );
    while (this.remembered.length > REMEMBERED_BURSTS) this.remembered.shift();
  }
}
