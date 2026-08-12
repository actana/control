// A terminal, small enough to live in an SDK and faithful enough to read a
// harness with (#129 D2, issue 155).
//
// The reason this file exists rather than a call to `stripAnsi`: a harness does
// not lay text out with spaces and newlines, it lays it out with cursor moves.
// Claude Code draws its folder-trust dialog as
// `ESC[4G1.ESC[7GYes,ESC[12GIESC[14Gtrust`, repaints its spinner by walking the
// cursor back up and erasing lines, and rewrites the same row eighty times a
// second. Delete the escapes from that stream and you get one very long line of
// concatenated spinner frames with the words jammed together — not a screen, and
// nothing a caller can read an answer out of. The only way to know what a
// terminal would be showing is to be one.
//
// So: a grid, a cursor, a scroll region, two buffers, and the subset of the
// escape vocabulary a TUI actually uses to position and erase — cursor movement,
// erase display/line/characters, insert and delete lines and characters, scroll
// up and down, the alternate screen. Colour is parsed and dropped, because the
// answer this returns is text.
//
// **Scrolled-off lines are kept, and that is the point.** A harness's
// conversation is not on the screen — it went past the top of it minutes ago.
// The transcript *is* the scrollback, so a line that leaves the top of the grid
// is joined, trimmed and pushed onto {@link TerminalScreen.scrollbackLines}
// rather than dropped. `experiment/action.md` §4 is where that was learned the
// hard way.
//
// Two rules about what is kept, and they are not the same rule:
//
//   - **An erased screen is erased.** `ESC[2J` wipes the grid in place and adds
//     nothing to the scrollback, because that is what a terminal does with it —
//     erasing is not scrolling. Content reaches the scrollback by scrolling off
//     the top, which is how a harness that prints a conversation produces one.
//     (Claude Code 2.1.228 never emits `ED2` at all; it clears by walking
//     line-erases up the screen, and that path scrolls nothing either.)
//   - **The alternate screen keeps its scrolled-off lines too**, which a real
//     terminal does not, and the difference is deliberate. A terminal drops them
//     because a human can scroll a full-screen app with the app's own keys; a
//     script cannot, and the lines are the transcript it was asked to read. Each
//     buffer keeps its own history, so switching back to the main screen does not
//     mix a full-screen app's output into the shell's. Everything else about the
//     alternate screen is ordinary: it starts blank and the main buffer is
//     untouched underneath it.
//
// One consequence worth knowing before reading `screen()`: a harness that
// switches to the alternate screen and then *exits* it (`ESC[?1049l`, which
// Claude Code sends on quit) puts the main buffer back, and the main buffer is
// whatever was on it before the harness started — near enough empty. Read the
// screen while the Session is alive, not after killing it.
//
// Nothing here reads or writes a file descriptor. It is fed strings and hands
// back strings; the process it runs in may have no terminal at all, which is
// D11 and the whole reason the session layer can be used from a script.

/** How many scrolled-off lines are kept by default. */
export const DEFAULT_SCROLLBACK_LINES = 5_000;
/** Grid width used when a caller names none — the Core's own PTY default. */
export const DEFAULT_COLS = 100;
/** Grid height used when a caller names none — the Core's own PTY default. */
export const DEFAULT_ROWS = 30;

export type TerminalScreenOptions = {
  /** Grid width. Must match the PTY's, or wrapping here disagrees with there. */
  cols?: number;
  /** Grid height. Same. */
  rows?: number;
  /**
   * How many scrolled-off lines to keep. The oldest are dropped past this.
   * Zero keeps none — a caller that only ever reads the viewport.
   */
  scrollback?: number;
};

/** A cell's contents: one character, `" "` for blank, `""` for a wide char's second column. */
type Cell = string;

type Buffer = {
  grid: Cell[][];
  /** This buffer's own scrolled-off lines. Both buffers keep theirs — see the header. */
  scrollback: string[];
  savedRow: number;
  savedCol: number;
};

type ParserState = "ground" | "esc" | "csi" | "osc" | "string" | "consume-one";

/**
 * A terminal screen fed one PTY's bytes.
 *
 * Feed it every chunk in order with {@link write} and read {@link lines},
 * {@link text} or {@link viewportText}. Chunk boundaries are not respected by
 * the stream — an escape sequence is routinely split across two `data` frames —
 * so the parser is a state machine that carries its position between calls
 * rather than anything that re-scans a buffer.
 */
export class TerminalScreen {
  private colsValue: number;
  private rowsValue: number;
  private readonly scrollbackLimit: number;

  private main: Buffer;
  private alt: Buffer;
  private buffer: Buffer;
  private onAlt = false;

  private row = 0;
  private col = 0;
  /**
   * The cursor is parked on the last column with a character already written
   * there, and the *next* printable wraps before it lands (DEC's deferred wrap).
   * Without this, a line exactly `cols` wide scrolls one line too early and
   * every subsequent row is off by one.
   */
  private pendingWrap = false;

  /** Scroll region, inclusive, 0-based. Set by DECSTBM; full screen by default. */
  private scrollTop = 0;
  private scrollBottom: number;

  private state: ParserState = "ground";
  private csiBuf = "";

  constructor(opts: TerminalScreenOptions = {}) {
    this.colsValue = Math.max(1, Math.floor(opts.cols ?? DEFAULT_COLS));
    this.rowsValue = Math.max(1, Math.floor(opts.rows ?? DEFAULT_ROWS));
    this.scrollbackLimit = Math.max(0, Math.floor(opts.scrollback ?? DEFAULT_SCROLLBACK_LINES));
    this.main = this.freshBuffer();
    this.alt = this.freshBuffer();
    this.buffer = this.main;
    this.scrollBottom = this.rowsValue - 1;
  }

  get cols(): number {
    return this.colsValue;
  }

  get rows(): number {
    return this.rowsValue;
  }

  /** Where the cursor is, 0-based, for a caller that needs to know. */
  get cursor(): { row: number; col: number } {
    return { row: this.row, col: this.col };
  }

  /** True while a full-screen TUI has switched to the alternate buffer. */
  get alternateScreen(): boolean {
    return this.onAlt;
  }

  // ─── Feeding it ────────────────────────────────────────────────────────────

  /**
   * Write one chunk of PTY output. Call it with every chunk, in order.
   *
   * Iterated by code point rather than by UTF-16 unit, so an astral character
   * (an emoji, and harnesses print plenty) occupies one cell rather than two
   * halves of a surrogate pair in two.
   */
  write(data: string): void {
    for (const ch of data) {
      switch (this.state) {
        case "ground":
          this.ground(ch);
          break;
        case "esc":
          this.escape(ch);
          break;
        case "csi":
          this.csi(ch);
          break;
        case "osc":
          this.osc(ch);
          break;
        case "string":
          this.stringSequence(ch);
          break;
        case "consume-one":
          // A charset designator's payload (`ESC ( B`) or a DEC private
          // sequence's (`ESC # 8`). One character, dropped.
          this.state = "ground";
          break;
      }
    }
  }

  /**
   * Change the grid's size. A caller that resizes the PTY resizes this too, or
   * the two disagree about where every line wraps.
   *
   * Rows are added at the bottom and removed from the bottom; lines that a
   * shrink pushes off the top go to the scrollback, exactly as scrolling would.
   * Reflowing the existing text to a new width is deliberately not attempted —
   * a real terminal's reflow is its own subsystem, and a harness repaints on
   * `SIGWINCH` anyway, so the next frame is correct either way.
   */
  resize(cols: number, rows: number): void {
    const nextCols = Math.max(1, Math.floor(cols));
    const nextRows = Math.max(1, Math.floor(rows));
    for (const buffer of [this.main, this.alt]) {
      for (const line of buffer.grid) {
        while (line.length < nextCols) line.push(" ");
        line.length = nextCols;
      }
      while (buffer.grid.length < nextRows) buffer.grid.push(this.blankLine(nextCols));
      // The cursor lives on the active buffer, so only that one's shrink moves
      // it — and only the main buffer's keeps what it loses.
      const active = buffer === this.buffer;
      while (buffer.grid.length > nextRows) {
        // Take the blank rows below the cursor first. A terminal shrinking a
        // half-empty screen loses the padding, not the text — pushing those
        // blanks onto the scrollback instead would put empty lines in the middle
        // of a transcript, which is the one place they are read as content.
        const last = buffer.grid.length - 1;
        if ((!active || last > this.row) && isBlank(buffer.grid[last])) {
          buffer.grid.pop();
          continue;
        }
        const dropped = buffer.grid.shift();
        if (dropped) this.pushScrollback(buffer, dropped);
        if (active && this.row > 0) this.row -= 1;
      }
    }
    this.colsValue = nextCols;
    this.rowsValue = nextRows;
    this.scrollTop = 0;
    this.scrollBottom = nextRows - 1;
    this.row = Math.min(this.row, nextRows - 1);
    this.col = Math.min(this.col, nextCols - 1);
    this.pendingWrap = false;
  }

  // ─── Reading it ────────────────────────────────────────────────────────────

  /** The rows a terminal would be displaying now, top to bottom, right-trimmed. */
  viewportLines(): string[] {
    return this.buffer.grid.map((line) => trimEnd(line.join("")));
  }

  /** Every line that has scrolled off the top, oldest first. The transcript. */
  scrollbackLines(): string[] {
    return [...this.buffer.scrollback];
  }

  /** Scrollback then viewport: everything this terminal has been shown. */
  lines(): string[] {
    return [...this.buffer.scrollback, ...this.viewportLines()];
  }

  /**
   * {@link lines} as one string, with the blank rows below the last written one
   * trimmed off — a viewport is 30 rows whether or not a harness filled them,
   * and a caller reading a screen wants what is on it, not the padding.
   */
  text(): string {
    return joinTrimmed(this.lines());
  }

  /** The visible rows only, as one string. Same trailing-blank trim. */
  viewportText(): string {
    return joinTrimmed(this.viewportLines());
  }

  // ─── The parser ────────────────────────────────────────────────────────────

  private ground(ch: string): void {
    switch (ch) {
      case "\u001B":
        this.state = "esc";
        return;
      case "\r":
        this.col = 0;
        this.pendingWrap = false;
        return;
      case "\n":
      case "\u000B": // vertical tab
      case "\u000C": // form feed
        this.lineFeed();
        this.pendingWrap = false;
        return;
      case "\b":
        this.col = Math.max(0, this.col - 1);
        this.pendingWrap = false;
        return;
      case "\t":
        this.col = Math.min(this.colsValue - 1, (Math.floor(this.col / 8) + 1) * 8);
        this.pendingWrap = false;
        return;
      default:
        break;
    }
    const code = ch.codePointAt(0) ?? 0;
    // Remaining C0 controls and DEL paint nothing. A bell in the middle of a
    // word must not become a character, or every alert shifts the line.
    if (code < 0x20 || code === 0x7f) return;
    this.putChar(ch);
  }

  private escape(ch: string): void {
    switch (ch) {
      case "[":
        this.state = "csi";
        this.csiBuf = "";
        return;
      case "]":
        this.state = "osc";
        return;
      // DCS / SOS / PM / APC — a string until its terminator, none of which is
      // screen content. Consumed so its payload is not printed as text.
      case "P":
      case "X":
      case "^":
      case "_":
        this.state = "string";
        return;
      case "7":
        this.saveCursor();
        this.state = "ground";
        return;
      case "8":
        this.restoreCursor();
        this.state = "ground";
        return;
      case "D": // IND — down one line, scrolling at the bottom
        this.lineFeed();
        this.state = "ground";
        return;
      case "E": // NEL — carriage return and down one
        this.col = 0;
        this.lineFeed();
        this.state = "ground";
        return;
      case "M": // RI — up one line, scrolling at the top
        this.reverseIndex();
        this.state = "ground";
        return;
      case "c": // RIS — full reset
        this.reset();
        this.state = "ground";
        return;
      // Charset designators and DEC private sequences take one more byte.
      case "(":
      case ")":
      case "*":
      case "+":
      case "-":
      case ".":
      case "/":
      case "#":
        this.state = "consume-one";
        return;
      default:
        // Keypad modes and everything else with no payload.
        this.state = "ground";
        return;
    }
  }

  private csi(ch: string): void {
    const code = ch.codePointAt(0) ?? 0;
    // Parameter and intermediate bytes accumulate; the first byte in the final
    // range ends the sequence.
    if (code >= 0x30 && code <= 0x3f) {
      this.csiBuf += ch;
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.csiBuf += ch;
      return;
    }
    this.state = "ground";
    if (code >= 0x40 && code <= 0x7e) this.dispatchCsi(ch, this.csiBuf);
    this.csiBuf = "";
  }

  private osc(ch: string): void {
    // BEL-terminated, or ST (`ESC \`). The ESC is enough to end it here: no OSC
    // payload this cares about contains one, and treating it as the terminator
    // means a truncated sequence cannot swallow the rest of the stream.
    // Consumed and dropped either way: a window title, a hyperlink target and a
    // colour query are not screen content.
    if (ch === "\u0007") {
      this.state = "ground";
      return;
    }
    if (ch === "\u001B") this.state = "consume-one";
  }

  private stringSequence(ch: string): void {
    if (ch === "\u0007") {
      this.state = "ground";
      return;
    }
    if (ch === "\u001B") this.state = "consume-one";
  }

  private dispatchCsi(final: string, raw: string): void {
    const isPrivate = raw.startsWith("?");
    const body = isPrivate ? raw.slice(1) : raw;
    const params = body
      .split(";")
      .map((p) => (p === "" ? NaN : Number.parseInt(p, 10)))
      .map((n) => (Number.isFinite(n) ? n : NaN));
    const p = (index: number, fallback: number): number => {
      const value = params[index];
      return value === undefined || Number.isNaN(value) ? fallback : value;
    };

    if (isPrivate) {
      // The alternate screen, in and out. 1049 also saves/restores the cursor;
      // 47 and 1047 are the older spellings and swap the buffer alone.
      if (final === "h" || final === "l") {
        const mode = p(0, 0);
        if (mode === 47 || mode === 1047 || mode === 1049) {
          this.setAlternateScreen(final === "h", mode === 1049);
        }
      }
      // Cursor visibility, bracketed paste, mouse reporting: nothing that
      // changes what the screen says.
      return;
    }

    switch (final) {
      case "A":
        this.row = Math.max(this.scrollTop, this.row - Math.max(1, p(0, 1)));
        this.pendingWrap = false;
        return;
      case "B":
        this.row = Math.min(this.scrollBottom, this.row + Math.max(1, p(0, 1)));
        this.pendingWrap = false;
        return;
      case "C":
        this.col = Math.min(this.colsValue - 1, this.col + Math.max(1, p(0, 1)));
        this.pendingWrap = false;
        return;
      case "D":
        this.col = Math.max(0, this.col - Math.max(1, p(0, 1)));
        this.pendingWrap = false;
        return;
      case "E":
        this.col = 0;
        this.row = Math.min(this.scrollBottom, this.row + Math.max(1, p(0, 1)));
        this.pendingWrap = false;
        return;
      case "F":
        this.col = 0;
        this.row = Math.max(this.scrollTop, this.row - Math.max(1, p(0, 1)));
        this.pendingWrap = false;
        return;
      case "G":
      case "`": // HPA, the same move under another name
        this.col = clamp(p(0, 1) - 1, 0, this.colsValue - 1);
        this.pendingWrap = false;
        return;
      case "d": // VPA
        this.row = clamp(p(0, 1) - 1, 0, this.rowsValue - 1);
        this.pendingWrap = false;
        return;
      case "H":
      case "f":
        this.row = clamp(p(0, 1) - 1, 0, this.rowsValue - 1);
        this.col = clamp(p(1, 1) - 1, 0, this.colsValue - 1);
        this.pendingWrap = false;
        return;
      case "J":
        this.eraseInDisplay(p(0, 0));
        return;
      case "K":
        this.eraseInLine(p(0, 0));
        return;
      case "L":
        this.insertLines(Math.max(1, p(0, 1)));
        return;
      case "M":
        this.deleteLines(Math.max(1, p(0, 1)));
        return;
      case "@":
        this.insertChars(Math.max(1, p(0, 1)));
        return;
      case "P":
        this.deleteChars(Math.max(1, p(0, 1)));
        return;
      case "X":
        this.eraseChars(Math.max(1, p(0, 1)));
        return;
      case "S":
        this.scrollUp(Math.max(1, p(0, 1)));
        return;
      case "T":
        this.scrollDown(Math.max(1, p(0, 1)));
        return;
      case "r": {
        // DECSTBM. An out-of-order or out-of-range region is ignored rather
        // than clamped into something the TUI did not ask for.
        const top = clamp(p(0, 1) - 1, 0, this.rowsValue - 1);
        const bottom = clamp(p(1, this.rowsValue) - 1, 0, this.rowsValue - 1);
        if (top >= bottom) return;
        this.scrollTop = top;
        this.scrollBottom = bottom;
        this.row = 0;
        this.col = 0;
        this.pendingWrap = false;
        return;
      }
      case "s":
        this.saveCursor();
        return;
      case "u":
        this.restoreCursor();
        return;
      default:
        // SGR (`m`), device reports, mode sets: colour and protocol, not layout.
        return;
    }
  }

  // ─── The grid ──────────────────────────────────────────────────────────────

  private putChar(ch: string): void {
    const width = charWidth(ch);
    if (width === 0) {
      // A combining mark belongs to the character before it, not to a cell of
      // its own — otherwise an accent shifts the rest of the line one column.
      const prev = this.col - 1;
      if (prev >= 0) {
        const line = this.buffer.grid[this.row];
        if (line) line[prev] = (line[prev] ?? " ") + ch;
      }
      return;
    }
    if (this.pendingWrap) {
      this.col = 0;
      this.lineFeed();
      this.pendingWrap = false;
    }
    if (this.col + width > this.colsValue) {
      this.col = 0;
      this.lineFeed();
    }
    const line = this.buffer.grid[this.row];
    if (!line) return;
    line[this.col] = ch;
    // A wide character owns two columns; the second holds nothing so that
    // joining the row reproduces the glyph once and the width still lines up.
    if (width === 2 && this.col + 1 < this.colsValue) line[this.col + 1] = "";
    this.col += width;
    if (this.col >= this.colsValue) {
      this.col = this.colsValue - 1;
      this.pendingWrap = true;
    }
  }

  private lineFeed(): void {
    if (this.row === this.scrollBottom) {
      this.scrollUp(1);
      return;
    }
    if (this.row < this.rowsValue - 1) this.row += 1;
  }

  private reverseIndex(): void {
    if (this.row === this.scrollTop) {
      this.scrollDown(1);
      return;
    }
    if (this.row > 0) this.row -= 1;
  }

  /**
   * Scroll the region up by `n`, which is where the scrollback comes from.
   *
   * A line only reaches the scrollback when the *whole screen* scrolls: a TUI
   * scrolling a three-row region in the middle of its layout is animating a
   * pane, not producing history, and a terminal keeps none of it either. Which
   * buffer it scrolled on does not matter — see the header on why the alternate
   * screen keeps its history here when a terminal would not.
   */
  private scrollUp(n: number): void {
    const keepsHistory = this.scrollTop === 0 && this.scrollBottom === this.rowsValue - 1;
    for (let i = 0; i < n; i += 1) {
      const dropped = this.buffer.grid.splice(this.scrollTop, 1)[0];
      if (dropped && keepsHistory) this.pushScrollback(this.buffer, dropped);
      this.buffer.grid.splice(this.scrollBottom, 0, this.blankLine(this.colsValue));
    }
  }

  private scrollDown(n: number): void {
    for (let i = 0; i < n; i += 1) {
      this.buffer.grid.splice(this.scrollBottom, 1);
      this.buffer.grid.splice(this.scrollTop, 0, this.blankLine(this.colsValue));
    }
  }

  private insertLines(n: number): void {
    if (this.row < this.scrollTop || this.row > this.scrollBottom) return;
    for (let i = 0; i < n; i += 1) {
      this.buffer.grid.splice(this.scrollBottom, 1);
      this.buffer.grid.splice(this.row, 0, this.blankLine(this.colsValue));
    }
    this.col = 0;
    this.pendingWrap = false;
  }

  private deleteLines(n: number): void {
    if (this.row < this.scrollTop || this.row > this.scrollBottom) return;
    for (let i = 0; i < n; i += 1) {
      this.buffer.grid.splice(this.row, 1);
      this.buffer.grid.splice(this.scrollBottom, 0, this.blankLine(this.colsValue));
    }
    this.col = 0;
    this.pendingWrap = false;
  }

  private insertChars(n: number): void {
    const line = this.buffer.grid[this.row];
    if (!line) return;
    for (let i = 0; i < n; i += 1) {
      line.splice(this.col, 0, " ");
      line.length = this.colsValue;
    }
    this.pendingWrap = false;
  }

  private deleteChars(n: number): void {
    const line = this.buffer.grid[this.row];
    if (!line) return;
    for (let i = 0; i < n; i += 1) {
      line.splice(this.col, 1);
      line.push(" ");
    }
    this.pendingWrap = false;
  }

  private eraseChars(n: number): void {
    const line = this.buffer.grid[this.row];
    if (!line) return;
    for (let i = 0; i < n && this.col + i < this.colsValue; i += 1) line[this.col + i] = " ";
    this.pendingWrap = false;
  }

  private eraseInLine(mode: number): void {
    const line = this.buffer.grid[this.row];
    if (!line) return;
    if (mode === 1) {
      for (let i = 0; i <= this.col && i < this.colsValue; i += 1) line[i] = " ";
    } else if (mode === 2) {
      for (let i = 0; i < this.colsValue; i += 1) line[i] = " ";
    } else {
      for (let i = this.col; i < this.colsValue; i += 1) line[i] = " ";
    }
    this.pendingWrap = false;
  }

  private eraseInDisplay(mode: number): void {
    if (mode === 1) {
      for (let r = 0; r < this.row; r += 1) this.buffer.grid[r] = this.blankLine(this.colsValue);
      const line = this.buffer.grid[this.row];
      if (line) for (let i = 0; i <= this.col && i < this.colsValue; i += 1) line[i] = " ";
      this.pendingWrap = false;
      return;
    }
    if (mode === 2) {
      // Erased, not scrolled: nothing goes to the scrollback. See the header.
      for (let r = 0; r < this.rowsValue; r += 1) this.buffer.grid[r] = this.blankLine(this.colsValue);
      this.pendingWrap = false;
      return;
    }
    if (mode === 3) {
      // ED3 is the one sequence whose whole job is to discard the scrollback.
      this.buffer.scrollback.length = 0;
      return;
    }
    const line = this.buffer.grid[this.row];
    if (line) for (let i = this.col; i < this.colsValue; i += 1) line[i] = " ";
    for (let r = this.row + 1; r < this.rowsValue; r += 1) {
      this.buffer.grid[r] = this.blankLine(this.colsValue);
    }
    this.pendingWrap = false;
  }

  private setAlternateScreen(on: boolean, withCursor: boolean): void {
    if (on === this.onAlt) return;
    if (on) {
      if (withCursor) this.saveCursor();
      this.alt = this.freshBuffer();
      this.buffer = this.alt;
      this.onAlt = true;
      this.row = 0;
      this.col = 0;
    } else {
      this.buffer = this.main;
      this.onAlt = false;
      if (withCursor) this.restoreCursor();
    }
    this.scrollTop = 0;
    this.scrollBottom = this.rowsValue - 1;
    this.pendingWrap = false;
  }

  private saveCursor(): void {
    this.buffer.savedRow = this.row;
    this.buffer.savedCol = this.col;
  }

  private restoreCursor(): void {
    this.row = clamp(this.buffer.savedRow, 0, this.rowsValue - 1);
    this.col = clamp(this.buffer.savedCol, 0, this.colsValue - 1);
    this.pendingWrap = false;
  }

  private reset(): void {
    this.main = this.freshBuffer();
    this.alt = this.freshBuffer();
    this.buffer = this.main;
    this.onAlt = false;
    this.row = 0;
    this.col = 0;
    this.scrollTop = 0;
    this.scrollBottom = this.rowsValue - 1;
    this.pendingWrap = false;
  }

  private pushScrollback(buffer: Buffer, line: Cell[]): void {
    if (this.scrollbackLimit === 0) return;
    buffer.scrollback.push(trimEnd(line.join("")));
    const overflow = buffer.scrollback.length - this.scrollbackLimit;
    if (overflow > 0) buffer.scrollback.splice(0, overflow);
  }

  private blankLine(cols: number): Cell[] {
    return new Array<Cell>(cols).fill(" ");
  }

  private freshBuffer(): Buffer {
    return {
      grid: Array.from({ length: this.rowsValue }, () => this.blankLine(this.colsValue)),
      scrollback: [],
      savedRow: 0,
      savedCol: 0,
    };
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function isBlank(line: Cell[] | undefined): boolean {
  return line === undefined || line.every((cell) => cell === " " || cell === "");
}

function trimEnd(line: string): string {
  return line.replace(/\s+$/u, "");
}

/** Join lines, dropping the run of blank ones at the end. */
function joinTrimmed(lines: string[]): string {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  return lines.slice(0, end).join("\n");
}

/**
 * How many columns one character occupies: 0, 1 or 2.
 *
 * Not a full Unicode width table — that is a data file, and this is an SDK. It
 * is the three cases a harness's output actually contains: combining marks and
 * the zero-width joiners that build emoji sequences take no column, the East
 * Asian wide blocks and the emoji planes take two, and everything else takes
 * one. Getting this wrong does not corrupt the text, it shifts a line by a
 * column — which is why a box-drawing character (narrow, and everywhere in a
 * TUI) matters more here than a rare script does.
 */
export function charWidth(ch: string): 0 | 1 | 2 {
  const code = ch.codePointAt(0) ?? 0;
  if (code === 0x200b || code === 0x200d || code === 0xfeff) return 0;
  if (
    (code >= 0x0300 && code <= 0x036f) || // combining diacriticals
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x20d0 && code <= 0x20ff) || // combining marks for symbols
    (code >= 0xfe00 && code <= 0xfe0f) || // variation selectors
    (code >= 0xfe20 && code <= 0xfe2f)
  ) {
    return 0;
  }
  if (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) || // CJK radicals, Kangxi, punctuation
    (code >= 0x3041 && code <= 0x33ff) || // kana through CJK compatibility
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) || // fullwidth forms
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) || // emoji
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}
