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
// Both are in scope, on different clocks. A harness this Core has never had a
// hook from is read from its screen straight away; one whose hooks arrive is
// deferred to while a tool call could still plausibly be running, and read
// from its screen after that — see `HOOK_DEFERENCE_MS` in
// `core-session-backstop.ts`. What this file must never do is let either wait
// forever.
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
// they cannot count as new content — but only where they are a counter. Every
// digit goes from a line a *spinner* is drawing, because the whole line is a
// frame; everywhere else only the duration token itself goes (`12.3s`,
// `1m 12s`). So `⠹ Working (1m 12s)` reduces to its words, while `Downloading
// 41.2 MB / 900 MB`, `Compiled 41 files in 3.2s` and `✔ 43 passed in 12.3s`
// keep the counts that are the only thing changing on them.
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
// wants two consecutive idle sweeps, and it stands down while a hooked
// harness's hooks are still speaking for it — for a bounded time, after which
// it reads the screen anyway), and a `finished` it wrote for a Session that was
// only idle here is taken back by the next `output` burst — see
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

/**
 * How much of a burst is compared, counted in characters from its end.
 *
 * Tied to {@link MAX_REMEMBERED_CHARS} on purpose, and that is the whole rule:
 * compare about as much of the burst as was remembered of the screen. A scan
 * shallower than the memory hides novelty painted above a static footer (the
 * mirror of the front-first scan the review of PR 455 found); a scan deeper
 * than the memory reports the part it cannot remember as new, which would
 * leave a full-viewport repaint reading as work forever. The margin keeps the
 * scan inside the memory even when the two disagree by a word.
 */
const MAX_SCANNED_CHARS = MAX_REMEMBERED_CHARS - 1024;

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
/**
 * The glyphs a spinner actually cycles through: braille frames, the sparkle
 * and asterisk set, and the circle-fill and circle-quadrant frames.
 *
 * Narrowed after the review of PR 455 found the whole Dingbats block in here:
 * `✔ 43 passed` and `❯ step 43 of 900` are a status mark and a prompt, not
 * spinner frames, and a line marked as a clock loses the digits that are its
 * only changing content. Box drawing is a border and is not here either — it
 * says nothing about whether a line is counting.
 */
const SPINNER_GLYPH_PATTERN = /[\u2800-\u28ff\u2731-\u273d\u25d0-\u25d3\u25e2-\u25e5\u25f0-\u25f7]/;
/**
 * An elapsed-time counter: `12s`, `1m 12s`, `12.3s`, `2h`.
 *
 * A unit letter is required, and it must end the token. That keeps `900 MB`
 * and `3.1 MB/s` — sizes and rates, which are content — off this pattern, and
 * it is also why `0:42` is not here: `\d+:\d{2}` matches the wall-clock stamp
 * a build prints in front of every line (`[12:34:07] Compiled 43 files`), and
 * calling that a clock loses the count beside it (review of PR 455). A colon
 * counter with no spinner glyph beside it is left as content, which is the
 * direction that fails safe.
 *
 * Global, because what it matches is what gets dropped: a duration is removed
 * as a *token*, not as a licence to drop every digit on its line. `✔ 43 passed
 * in 12.3s` and `Compiled 41 files in 3.2s` are the standard build-progress
 * shapes, and their counts are the only thing changing — taking those with the
 * elapsed time settles a live build (review of PR 455, round 3).
 */
const ELAPSED_PATTERN = /\d+(?:[.,]\d+)?\s*[hms]\b/g;

/**
 * Did this burst erase or move anything, or did it only append?
 *
 * A repaint destroys: a bare carriage return, an erase (`ESC [ … J/K`), a
 * cursor move or jump (`ESC [ … A-H`), a screen switch. Text that only appends
 * has none of those — it scrolled the screen, so it is new by construction.
 * Exported for the tests.
 */
/** An erase of the whole display (or its scrollback), which leaves it blank. */
const ERASE_DISPLAY_PATTERN = /\x1b\[[0-3]?J/;

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
    // A line a spinner is drawing is a frame, and every number on it is part
    // of the frame — the elapsed time, the token count, the context percentage.
    // A line without one is content, and only the duration token on it is a
    // clock; the count beside it is what changes when work happens.
    const words = line.replace(FRAME_GLYPH_PATTERN, " ");
    return SPINNER_GLYPH_PATTERN.test(line)
      ? words.replace(/\d/g, "")
      : words.replace(ELAPSED_PATTERN, " ");
  });
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * One per agent PTY. Fed every chunk; answers at most once per
 * {@link OUTPUT_ACTIVITY_WINDOW_MS} with what the bytes since the last answer
 * were — and `null` in between, which is the throttle the PTY data path needs.
 */
export class PtyOutputActivityWatcher {
  /**
   * Chunks since the last report, oldest first, and their total length. A list
   * rather than one growing string: the cap is enforced by dropping whole
   * chunks off the front, so a chatty PTY never re-copies the whole buffer per
   * chunk on the Core's hottest path.
   */
  private readonly pending: string[] = [];
  private pendingChars = 0;
  private reportedAt = 0;
  private repaintedLast = false;
  private readonly remembered: string[] = [];
  /** {@link remembered} as a word set, rebuilt when it changes. */
  private rememberedSet: Set<string> | null = null;

  /**
   * Take a chunk. Returns the kind when the window has elapsed and this burst
   * is being reported, or `null` while it is still being accumulated.
   */
  push(chunk: string, now: number): PtyOutputActivityKind | null {
    this.pending.push(chunk);
    this.pendingChars += chunk.length;
    // Keep the tail, because that is where a TUI puts what is new. One chunk
    // always survives, however large it is on its own.
    while (this.pendingChars > MAX_PENDING_CHARS && this.pending.length > 1) {
      this.pendingChars -= this.pending.shift()?.length ?? 0;
    }
    if (now - this.reportedAt <= OUTPUT_ACTIVITY_WINDOW_MS) return null;
    this.reportedAt = now;
    const burst = this.pending.join("");
    this.pending.length = 0;
    this.pendingChars = 0;
    return this.classify(burst);
  }

  private classify(burst: string): PtyOutputActivityKind {
    // Read and re-arm before anything can return: a burst of pure cursor
    // movement is still a repaint, and leaving the flag stale would deny the
    // *next* burst the appended-text path that makes new output new by
    // construction (review of PR 455).
    const repainted = repaintsInPlace(burst);
    const wasRepainting = this.repaintedLast;
    this.repaintedLast = repainted;

    const normalized = normalizePtyOutput(burst);
    // A burst that reduces to nothing is pure cursor movement — a repaint of
    // the same characters, or of none. If it wiped the display and put nothing
    // in its place, the screen is now blank: what was on it is not "already on
    // screen" any more, and the next line to arrive is new (review of PR 455).
    if (!normalized) {
      if (ERASE_DISPLAY_PATTERN.test(burst)) this.forgetScreen();
      return "redraw";
    }
    // Nothing was erased, so nothing was replaced: this text scrolled onto the
    // screen and is new whatever it says. The exception is a screen that was
    // being repainted a moment ago — then a burst with no controls of its own
    // is the tail of a frame whose head arrived in the last burst, not a line
    // of appended output.
    if (!repainted && !wasRepainting) {
      this.remember(normalized);
      return "output";
    }

    const words = normalized.split(" ");
    const novel = this.hasNewWord(words);
    this.remember(normalized);
    return novel ? "output" : "redraw";
  }

  /**
   * Does this burst carry a word the screen did not already have?
   *
   * Scanned from the end, where a TUI puts what is new and where `push` keeps
   * the bytes of an oversized burst. The remembered words are a set, so the
   * scan is a hash lookup per word rather than a substring search, so it can
   * run as deep as the memory it is comparing against — deep enough to find a
   * new line painted above a static footer (review of PR 455). The substring
   * fallback is what tolerates a burst boundary inside a word — `Think` and
   * `ing` are both inside a remembered `Thinking` — and only a word the set
   * missed pays for it.
   */
  private hasNewWord(words: string[]): boolean {
    const onScreen = ` ${this.remembered.join(" ")} `;
    const onScreenWords = this.rememberedWords();
    let scanned = 0;
    for (let i = words.length - 1; i >= 0 && scanned < MAX_SCANNED_CHARS; i -= 1) {
      const word = words[i];
      scanned += word.length + 1;
      // Fragments are what a burst boundary inside a word leaves behind, and
      // they say nothing either way — but a short number is a count, not a
      // fragment.
      const numeric = /\d/.test(word) && !/[A-Za-z]/.test(word);
      if (word.length < MIN_WORD_LENGTH && !numeric) continue;
      if (onScreenWords.has(word)) continue;
      // A number is matched whole. `40` is a substring of `(400)`, and a count
      // that reads as already-seen is a live turn read as idle.
      if (!numeric && onScreen.includes(word)) continue;
      return true;
    }
    return false;
  }

  /** The remembered bursts' words, built once per burst and cached. */
  private rememberedWords(): Set<string> {
    if (!this.rememberedSet) {
      this.rememberedSet = new Set(this.remembered.join(" ").split(" "));
    }
    return this.rememberedSet;
  }

  /** The screen was wiped; nothing that was on it counts as being on it. */
  private forgetScreen(): void {
    this.remembered.length = 0;
    this.rememberedSet = null;
  }

  private remember(normalized: string): void {
    this.rememberedSet = null;
    let kept = normalized;
    if (kept.length > MAX_REMEMBERED_CHARS) {
      kept = kept.slice(-MAX_REMEMBERED_CHARS);
      // Start at a whole word: a slice through the middle of one leaves a
      // fragment that matches nothing, and the scan would read the word it
      // cut in half as new.
      const firstSpace = kept.indexOf(" ");
      if (firstSpace > 0) kept = kept.slice(firstSpace + 1);
    }
    this.remembered.push(kept);
    while (this.remembered.length > REMEMBERED_BURSTS) this.remembered.shift();
  }
}
