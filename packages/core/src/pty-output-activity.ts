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
// Each burst of output is normalised the way a reader would skim it: escape
// sequences and control bytes dropped, spinner glyphs dropped, **digits
// dropped** (the counter is the one thing a spinner frame changes), whitespace
// collapsed. What is left is the frame's words. The burst counts as real
// output when it carries a word the last {@link REMEMBERED_BURSTS} bursts do
// not already contain, and as a redraw when every word in it was already on
// screen a moment ago.
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
// Two shapes of real output read as repaints, and both are stated here rather
// than discovered later. Output that differs from the burst before it only in
// its digits — `Compiled 41 files`, then `Compiled 42 files`, second after
// second, with nothing else on screen — is indistinguishable from a counter,
// because that is what it is. And a turn whose tool prints nothing at all is
// indistinguishable from a turn that ended.
//
// Both matter only for a harness whose hooks are *also* not arriving: a hook
// is real activity whatever it says, so Claude Code with its hooks installed
// is never judged on bytes alone. And the cost is the same trade the
// fifteen-minute window already made, which this only shortens: the row is
// settled early, nothing is killed, no process is touched, and the next hook
// or the next new thing on screen puts the row back on `running`.

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

/** Cap on the words kept per remembered burst. A frame is far smaller. */
const MAX_REMEMBERED_CHARS = 4 * 1024;

/** Words shorter than this are noise once digits and glyphs are gone. */
const MIN_WORD_LENGTH = 3;

/** Cap on the words compared per burst, so a huge paste stays cheap. */
const MAX_WORDS_PER_BURST = 400;

// OSC (`ESC ] … BEL` / `ESC ] … ESC \`), CSI (`ESC [ … final`), and the
// two-byte escapes. Ordered widest-first: an OSC payload can contain what
// looks like a CSI.
const OSC_PATTERN = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const CSI_PATTERN = /\x1b\[[0-9;:?<>=!]*[ -/]*[@-~]/g;
const ESCAPE_PATTERN = /\x1b[\s\S]?/g;
// Control bytes, tab and newline included: line breaks are layout, not words.
const CONTROL_PATTERN = /[\x00-\x1f\x7f]/g;
// Glyphs a spinner cycles through, and the rules a frame is drawn with:
// braille, block elements, geometric shapes, box drawing, dingbats, bullets.
const FRAME_GLYPH_PATTERN = /[\u2022\u00b7\u2500-\u25ff\u2700-\u27bf\u2800-\u28ff]/g;

/**
 * Reduce a burst of PTY output to the words on screen: no escapes, no control
 * bytes, no spinner glyphs, **no digits**, single-spaced. Exported for the
 * tests, which are the only readers that care what the reduction looks like.
 */
export function normalizePtyOutput(text: string): string {
  return text
    .replace(OSC_PATTERN, " ")
    .replace(CSI_PATTERN, " ")
    .replace(ESCAPE_PATTERN, " ")
    .replace(CONTROL_PATTERN, " ")
    .replace(FRAME_GLYPH_PATTERN, " ")
    .replace(/\d/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * One per agent PTY. Fed every chunk; answers at most once per
 * {@link OUTPUT_ACTIVITY_WINDOW_MS} with what the bytes since the last answer
 * were — and `null` in between, which is the throttle the PTY data path needs.
 */
export class PtyOutputActivityWatcher {
  private pending = "";
  private reportedAt = 0;
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
    const onScreen = this.remembered.join(" ");
    const words = normalized.split(" ");
    let novel = false;
    for (let i = 0; i < words.length && i < MAX_WORDS_PER_BURST; i += 1) {
      const word = words[i];
      // Fragments are what a burst boundary inside a word leaves behind, and
      // they say nothing either way.
      if (word.length < MIN_WORD_LENGTH) continue;
      if (onScreen.includes(word)) continue;
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
