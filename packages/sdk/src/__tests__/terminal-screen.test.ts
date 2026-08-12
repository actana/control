// What a terminal would be showing — including the part that scrolled away.
//
// The cases below are the ones that decide whether `session.screen()` returns a
// transcript or a jumble. Several are transcribed from real harness output
// rather than invented: the cursor-positioned menu and the erase-and-walk-up
// clear are how Claude Code 2.1.228 actually draws, and both are unreadable to
// anything that deletes escape sequences instead of interpreting them.

import { describe, it, expect } from "vitest";
import { TerminalScreen, charWidth } from "../terminal-screen.ts";

const ESC = "\u001B";
const CSI = `${ESC}[`;
/** What the Core substitutes for a reverse-video run before it strips escapes. */
const HIGHLIGHT_SENTINEL = "\u0001";

describe("TerminalScreen", () => {
  describe("the thing stripping escape codes gets wrong", () => {
    it("reads a menu a harness laid out with cursor moves, not spaces", () => {
      // Claude Code's folder-trust dialog, in the shape the Core's prompt
      // delivery had to learn to read: every column is a `CSI n G`, and there
      // is not one space character in the payload.
      const screen = new TerminalScreen({ cols: 40, rows: 4 });
      screen.write(`${CSI}4G1.${CSI}7GYes,${CSI}12GI${CSI}14Gtrust`);

      // Stripping the escapes yields `1.Yes,Itrust`. Interpreting them yields a
      // line whose words are where the harness put them.
      expect(screen.viewportLines()[0]).toBe("   1. Yes, I trust");
    });

    it("shows the last spinner frame, not every frame concatenated", () => {
      const screen = new TerminalScreen({ cols: 20, rows: 3 });
      for (const frame of ["⠋", "⠙", "⠹", "⠸"]) {
        screen.write(`\r${CSI}2K${frame} Working…`);
      }

      expect(screen.viewportLines()[0]).toBe("⠸ Working…");
      expect(screen.text()).toBe("⠸ Working…");
    });

    it("repaints a row in place when the cursor is addressed backwards", () => {
      const screen = new TerminalScreen({ cols: 20, rows: 3 });
      screen.write("hello world");
      screen.write(`${CSI}1;1H`);
      screen.write("HELLO");

      expect(screen.viewportLines()[0]).toBe("HELLO world");
    });
  });

  describe("the scrollback is the transcript", () => {
    it("keeps every line that scrolled off the top", () => {
      const screen = new TerminalScreen({ cols: 20, rows: 3 });
      for (let i = 1; i <= 10; i += 1) screen.write(`line ${i}\r\n`);

      // Ten lines each ending in a newline leaves the cursor on an eleventh,
      // so the bottom row is blank and the top two hold the last two lines.
      expect(screen.viewportLines().filter(Boolean)).toEqual(["line 9", "line 10"]);
      // …and the other seven are exactly where a caller reading a transcript
      // needs them to be.
      expect(screen.scrollbackLines()).toEqual([
        "line 1",
        "line 2",
        "line 3",
        "line 4",
        "line 5",
        "line 6",
        "line 7",
        "line 8",
      ]);
      expect(screen.text().split("\n")).toEqual([
        "line 1",
        "line 2",
        "line 3",
        "line 4",
        "line 5",
        "line 6",
        "line 7",
        "line 8",
        "line 9",
        "line 10",
      ]);
    });

    it("drops the oldest lines past the scrollback limit and keeps the rest", () => {
      const screen = new TerminalScreen({ cols: 20, rows: 2, scrollback: 3 });
      for (let i = 1; i <= 10; i += 1) screen.write(`line ${i}\r\n`);

      expect(screen.scrollbackLines()).toEqual(["line 7", "line 8", "line 9"]);
    });

    it("keeps nothing when a caller asks for no scrollback", () => {
      const screen = new TerminalScreen({ cols: 20, rows: 2, scrollback: 0 });
      for (let i = 1; i <= 5; i += 1) screen.write(`line ${i}\r\n`);

      expect(screen.scrollbackLines()).toEqual([]);
      expect(screen.text()).toBe("line 5");
    });

    it("does not mistake a scrolled pane for history", () => {
      // A TUI animating a three-row region in the middle of its layout is not
      // producing a transcript, and a terminal keeps none of it either.
      const screen = new TerminalScreen({ cols: 20, rows: 6 });
      screen.write(`${CSI}2;4r`); // scroll region: rows 2..4
      screen.write(`${CSI}4;1Hbottom of pane\n`);
      screen.write("next\n");

      expect(screen.scrollbackLines()).toEqual([]);
    });

    it("erases the screen without pushing it to the scrollback", () => {
      // ED2 is an erase, not a scroll. A terminal loses that content too.
      const screen = new TerminalScreen({ cols: 20, rows: 4 });
      screen.write("keep me\r\n");
      screen.write(`${CSI}2J${CSI}1;1H`);
      screen.write("fresh");

      expect(screen.scrollbackLines()).toEqual([]);
      expect(screen.text()).toBe("fresh");
    });

    it("discards the scrollback only when asked to, with ED3", () => {
      const screen = new TerminalScreen({ cols: 20, rows: 2 });
      for (let i = 1; i <= 5; i += 1) screen.write(`line ${i}\r\n`);
      expect(screen.scrollbackLines().length).toBeGreaterThan(0);

      screen.write(`${CSI}3J`);

      expect(screen.scrollbackLines()).toEqual([]);
    });

    it("survives the clear Claude Code actually emits — erase-line and walk up", () => {
      // The harness never sends ED2; it erases each line and moves up, five or
      // more times, then paints the new frame. Nothing scrolls, so the
      // transcript that scrolled off earlier is still there afterwards.
      const screen = new TerminalScreen({ cols: 20, rows: 3 });
      for (let i = 1; i <= 6; i += 1) screen.write(`line ${i}\r\n`);
      const before = screen.scrollbackLines();

      let clear = "";
      for (let i = 0; i < 5; i += 1) clear += `${CSI}2K${CSI}1G${CSI}1A`;
      screen.write(clear);
      screen.write(`${CSI}1;1H${CSI}Jrepainted`);

      expect(screen.scrollbackLines()).toEqual(before);
      expect(screen.viewportText()).toBe("repainted");
    });
  });

  describe("the alternate screen", () => {
    it("shows the alternate buffer and keeps the main one intact underneath", () => {
      const screen = new TerminalScreen({ cols: 20, rows: 3 });
      screen.write("shell line 1\r\nshell line 2\r\n");

      screen.write(`${CSI}?1049h`);
      screen.write("full screen app");
      expect(screen.alternateScreen).toBe(true);
      expect(screen.viewportText()).toBe("full screen app");
      // The alternate screen starts blank: the main buffer's history is not
      // visible through it.
      expect(screen.scrollbackLines()).toEqual([]);

      screen.write(`${CSI}?1049l`);
      expect(screen.alternateScreen).toBe(false);
      expect(screen.viewportText()).toBe("shell line 1\nshell line 2");
    });

    it("keeps what scrolls off the alternate screen, which a terminal does not", () => {
      // Deliberate, and the reason is in the header: a human scrolls a
      // full-screen app with the app's own keys, a script cannot, and those
      // lines are the transcript it was asked to read.
      const screen = new TerminalScreen({ cols: 20, rows: 3 });
      screen.write("main screen\r\n");
      screen.write(`${CSI}?1049h`);
      for (let i = 1; i <= 6; i += 1) screen.write(`tui ${i}\r\n`);

      expect(screen.scrollbackLines()).toEqual(["tui 1", "tui 2", "tui 3", "tui 4"]);
      expect(screen.text()).toContain("tui 1");
      // Each buffer keeps its own, so the app's output never lands in the
      // shell's history.
      screen.write(`${CSI}?1049l`);
      expect(screen.scrollbackLines()).toEqual([]);
      expect(screen.text()).toBe("main screen");
    });
  });

  describe("editing the grid", () => {
    it("inserts and deletes lines within the scroll region", () => {
      const screen = new TerminalScreen({ cols: 10, rows: 4 });
      screen.write("a\r\nb\r\nc\r\nd");

      screen.write(`${CSI}2;1H${CSI}L`); // insert a blank line at row 2
      expect(screen.viewportLines()).toEqual(["a", "", "b", "c"]);

      screen.write(`${CSI}2;1H${CSI}M`); // and take it back out
      expect(screen.viewportLines()).toEqual(["a", "b", "c", ""]);
    });

    it("inserts, deletes and erases characters", () => {
      const screen = new TerminalScreen({ cols: 12, rows: 1 });
      screen.write("abcdef");

      screen.write(`${CSI}3G${CSI}2@`); // two blanks in front of `c`
      expect(screen.viewportLines()[0]).toBe("ab  cdef");

      screen.write(`${CSI}3G${CSI}2P`); // take them out again
      expect(screen.viewportLines()[0]).toBe("abcdef");

      screen.write(`${CSI}2G${CSI}3X`); // blank three cells in place
      expect(screen.viewportLines()[0]).toBe("a   ef");
    });

    it("erases to the end of a line, to its start, and all of it", () => {
      const screen = new TerminalScreen({ cols: 12, rows: 1 });

      screen.write("abcdef");
      screen.write(`${CSI}4G${CSI}0K`);
      expect(screen.viewportLines()[0]).toBe("abc");

      screen.write(`${CSI}1Gabcdef${CSI}3G${CSI}1K`);
      expect(screen.viewportLines()[0]).toBe("   def");

      screen.write(`${CSI}2K`);
      expect(screen.viewportLines()[0]).toBe("");
    });

    it("scrolls up and down on request, and the scroll feeds the transcript", () => {
      const screen = new TerminalScreen({ cols: 10, rows: 3 });
      screen.write("a\r\nb\r\nc");

      screen.write(`${CSI}1S`);
      expect(screen.viewportLines()).toEqual(["b", "c", ""]);
      expect(screen.scrollbackLines()).toEqual(["a"]);

      screen.write(`${CSI}1T`);
      expect(screen.viewportLines()).toEqual(["", "b", "c"]);
    });
  });

  describe("the parser", () => {
    it("carries an escape sequence split across chunks", () => {
      // Chunk boundaries land wherever the PTY's read did. A parser that
      // re-scanned each chunk on its own would print `[3;5H` as text.
      const screen = new TerminalScreen({ cols: 20, rows: 5 });
      screen.write(`hello${ESC}`);
      screen.write("[3");
      screen.write(";5");
      screen.write("Hthere");

      expect(screen.viewportLines()[0]).toBe("hello");
      expect(screen.viewportLines()[2]).toBe("    there");
    });

    it("swallows an OSC title and prints nothing of it", () => {
      const screen = new TerminalScreen({ cols: 30, rows: 2 });
      screen.write(`${ESC}]0;a window title\u0007visible`);

      expect(screen.viewportLines()[0]).toBe("visible");
    });

    it("swallows an OSC terminated by ST rather than BEL", () => {
      const screen = new TerminalScreen({ cols: 30, rows: 2 });
      screen.write(`${ESC}]8;;https://example.test${ESC}\\link`);

      expect(screen.viewportLines()[0]).toBe("link");
    });

    it("drops colour without dropping the text it was colouring", () => {
      const screen = new TerminalScreen({ cols: 30, rows: 2 });
      screen.write(`${CSI}1;31mred${CSI}0m plain`);

      expect(screen.viewportLines()[0]).toBe("red plain");
    });

    it("drops reverse video too, so a highlighted menu row reads like the rest", () => {
      // Pinning the deferral in the header, not endorsing it (#156). `ESC[7m`
      // is how a harness marks the row an Enter would take — the Core reads
      // exactly that when it answers the folder-trust dialog — and this screen
      // hands a caller the options with no sign of which one is selected. A
      // caller answering through `send()` answers by number until the session
      // layer decides what shape the selection should arrive in.
      const screen = new TerminalScreen({ cols: 40, rows: 3 });
      screen.write(`  1. No, exit\r\n${CSI}7m❯ 2. Yes, proceed${CSI}0m`);

      expect(screen.viewportLines().slice(0, 2)).toEqual([
        "  1. No, exit",
        "❯ 2. Yes, proceed",
      ]);
      // The highlight left nothing behind — not the escape, and not a sentinel
      // standing in for it. The two rows differ by their text and by nothing
      // else, which is the whole of what the deferral costs a caller.
      expect(screen.text()).not.toContain(ESC);
      expect(screen.text()).not.toContain(HIGHLIGHT_SENTINEL);
    });

    it("prints no character for a bell, a backspace or a stray control byte", () => {
      const screen = new TerminalScreen({ cols: 20, rows: 2 });
      screen.write("ab\u0007c");
      expect(screen.viewportLines()[0]).toBe("abc");

      screen.write("\b\bXY");
      expect(screen.viewportLines()[0]).toBe("aXY");
    });

    it("moves to the next tab stop rather than printing a tab", () => {
      const screen = new TerminalScreen({ cols: 24, rows: 2 });
      screen.write("ab\tcd");

      expect(screen.viewportLines()[0]).toBe("ab      cd");
    });

    it("saves and restores the cursor both ways it is spelled", () => {
      const screen = new TerminalScreen({ cols: 20, rows: 3 });
      screen.write(`${CSI}2;3H${ESC}7`);
      screen.write(`${CSI}1;1Htop${ESC}8here`);
      expect(screen.viewportLines()[1]).toBe("  here");

      screen.write(`${CSI}3;1H${CSI}s${CSI}1;1H${CSI}u`);
      expect(screen.cursor).toEqual({ row: 2, col: 0 });
    });
  });

  describe("the grid's geometry", () => {
    it("wraps at the last column and not one character early", () => {
      // Deferred wrap: a line exactly `cols` wide fills its row and the *next*
      // character starts the row below. Getting this wrong shifts every line
      // after the first full one.
      const screen = new TerminalScreen({ cols: 5, rows: 3 });
      screen.write("abcde");
      expect(screen.viewportLines()).toEqual(["abcde", "", ""]);

      screen.write("f");
      expect(screen.viewportLines()).toEqual(["abcde", "f", ""]);
    });

    it("gives a wide character two columns and a combining mark none", () => {
      expect(charWidth("漢")).toBe(2);
      expect(charWidth("a")).toBe(1);
      expect(charWidth("́")).toBe(0);

      const screen = new TerminalScreen({ cols: 6, rows: 2 });
      screen.write("漢字ab");
      expect(screen.viewportLines()[0]).toBe("漢字ab");
      expect(screen.cursor.col).toBe(5);

      const accented = new TerminalScreen({ cols: 6, rows: 1 });
      // `e` plus a combining acute: two code points, one cell, one column.
      accented.write("e\u0301x");
      expect(accented.viewportLines()[0]).toBe("e\u0301x");
    });

    it("resizes, keeping what a shrink pushes off the top", () => {
      const screen = new TerminalScreen({ cols: 20, rows: 4 });
      screen.write("a\r\nb\r\nc\r\nd");

      screen.resize(20, 2);

      expect(screen.rows).toBe(2);
      expect(screen.scrollbackLines()).toEqual(["a", "b"]);
      expect(screen.viewportLines()).toEqual(["c", "d"]);
    });

    it("resets everything on RIS", () => {
      const screen = new TerminalScreen({ cols: 10, rows: 2 });
      screen.write("a\r\nb\r\nc");
      expect(screen.scrollbackLines().length).toBeGreaterThan(0);

      screen.write(`${ESC}c`);

      expect(screen.text()).toBe("");
      expect(screen.scrollbackLines()).toEqual([]);
      expect(screen.cursor).toEqual({ row: 0, col: 0 });
    });
  });
});
