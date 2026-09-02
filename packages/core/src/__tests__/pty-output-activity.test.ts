import { describe, expect, it } from "vitest";
import {
  normalizePtyOutput,
  OUTPUT_ACTIVITY_WINDOW_MS,
  PtyOutputActivityWatcher,
} from "../pty-output-activity";

// Issue 391: the bytes a harness writes while it is idle look exactly like the
// bytes it writes while it works — unless you read them. These pin the one
// distinction the quiet-Session backstop rests on: did anything new appear on
// screen, or was that the same frame again with a bigger number in it?

/** A Codex-shaped idle frame: erase the line, redraw a spinner and a clock. */
const idleFrame = (spinner: string, elapsed: string) =>
  `\x1b[2K\x1b[G${spinner} Working (${elapsed} • Esc to interrupt)`;

const WINDOW = OUTPUT_ACTIVITY_WINDOW_MS;

describe("normalizePtyOutput", () => {
  it("keeps the words and drops everything a repaint changes", () => {
    // Escapes, the spinner glyph and the counter all go; the words stay.
    expect(normalizePtyOutput(idleFrame("⠹", "1m 12s"))).toBe(
      "Working (m s Esc to interrupt)",
    );
    // Which is the whole point: the next second reduces to the same thing.
    expect(normalizePtyOutput(idleFrame("⠸", "1m 13s"))).toBe(
      normalizePtyOutput(idleFrame("⠹", "1m 12s")),
    );
  });

  it("reduces pure cursor movement to nothing at all", () => {
    expect(normalizePtyOutput("\x1b[2J\x1b[H\x1b[?25l\r\n\x1b[?25h")).toBe("");
  });

  it("keeps an OSC title's payload out of the words", () => {
    expect(normalizePtyOutput("\x1b]0;codex — ~/repos/control\x07ready")).toBe("ready");
  });
});

describe("telling an idle repaint from real output", () => {
  it("reports the first paint, then calls its repeats redraws", () => {
    const watcher = new PtyOutputActivityWatcher();
    let now = WINDOW + 1;

    // The frame arriving for the first time is something new on screen.
    expect(watcher.push(idleFrame("⠹", "0s"), now)).toBe("output");

    // Every second after that, the same frame with the clock moved on. Ten
    // minutes of it, and not one of them is work.
    for (let tick = 1; tick <= 120; tick += 1) {
      now += WINDOW + 1;
      expect(watcher.push(idleFrame("⠸", `${tick * 5}s`), now)).toBe("redraw");
    }
  });

  it("calls a burst with a word that was not on screen real output", () => {
    const watcher = new PtyOutputActivityWatcher();
    let now = WINDOW + 1;
    watcher.push(idleFrame("⠹", "0s"), now);

    now += WINDOW + 1;
    expect(watcher.push(idleFrame("⠸", "5s"), now)).toBe("redraw");

    // A tool call lands. Nothing about this was on screen a moment ago.
    now += WINDOW + 1;
    expect(
      watcher.push("\x1b[2K\x1b[G• Ran pnpm vitest packages/core\r\n  └ 47 passed", now),
    ).toBe("output");

    // And the spinner goes back to being a spinner.
    now += WINDOW + 1;
    expect(watcher.push(idleFrame("⠹", "11s"), now)).toBe("redraw");
  });

  it("stays a redraw when a frame is split across the reporting window", () => {
    // A burst boundary can fall inside a word. `Work` + `ing` must not read as
    // two new words every five seconds, or an idle harness never settles.
    const watcher = new PtyOutputActivityWatcher();
    let now = WINDOW + 1;
    watcher.push(idleFrame("⠹", "0s"), now);

    for (let tick = 1; tick <= 20; tick += 1) {
      now += WINDOW + 1;
      expect(watcher.push("\x1b[2K\x1b[G⠸ Work", now)).toBe("redraw");
      now += WINDOW + 1;
      expect(watcher.push(`ing (${tick}s • Esc to interrupt)`, now)).toBe("redraw");
    }
  });

  it("answers once per window and accumulates the chunks in between", () => {
    const watcher = new PtyOutputActivityWatcher();
    let now = WINDOW + 1;
    expect(watcher.push(idleFrame("⠹", "0s"), now)).toBe("output");

    // Sixty repaints inside one window cost the caller nothing.
    for (let i = 0; i < 60; i += 1) {
      now += 50;
      expect(watcher.push(idleFrame("⠸", `${i}s`), now)).toBeNull();
    }

    // A chunk held back inside the window is still read when the window ends:
    // real output that arrived mid-window is not lost to the throttle.
    now += 10;
    expect(watcher.push("release notes drafted", now)).toBeNull();
    now += WINDOW + 1;
    expect(watcher.push(idleFrame("⠹", "9s"), now)).toBe("output");
  });

  it("calls a line the screen showed a minute ago new work again", () => {
    // The memory is the last two bursts, not the whole turn: a harness that
    // reads the same file twice is working, and must not be read as a screen
    // that never changed.
    const watcher = new PtyOutputActivityWatcher();
    let now = WINDOW + 1;
    const toolLine = "\x1b[2K\x1b[G• Read packages/core/src/core-entry.ts\r\n";
    expect(watcher.push(toolLine, now)).toBe("output");

    // The spinner coming back over that line is itself something new, once.
    now += WINDOW + 1;
    expect(watcher.push(idleFrame("⠸", "0s"), now)).toBe("output");
    for (let tick = 1; tick < 12; tick += 1) {
      now += WINDOW + 1;
      expect(watcher.push(idleFrame("⠸", `${tick * 5}s`), now)).toBe("redraw");
    }

    now += WINDOW + 1;
    expect(watcher.push(toolLine, now)).toBe("output");
  });

  it("reads a burst that differs only in its digits as the counter it is", () => {
    // The stated cost, pinned rather than left to be found: digits are how a
    // spinner's clock changes, so they cannot count as new — and output whose
    // only change is a number is therefore read as a repaint. It settles the
    // row early; the next hook or new word puts it back on `running`.
    const watcher = new PtyOutputActivityWatcher();
    let now = WINDOW + 1;
    expect(watcher.push("\x1b[2K\x1b[GCompiled 41 files", now)).toBe("output");
    for (let files = 42; files < 60; files += 1) {
      now += WINDOW + 1;
      expect(watcher.push(`\x1b[2K\x1b[GCompiled ${files} files`, now)).toBe("redraw");
    }
  });

  it("does not mistake a long streamed answer for a repaint", () => {
    // A model streaming prose repaints the screen every chunk, but each
    // repaint carries words the last one did not.
    const watcher = new PtyOutputActivityWatcher();
    let now = WINDOW + 1;
    // Every word here is long enough to count: a burst that adds only `is`
    // adds nothing a reader would call new, and reads as a repaint.
    const sentence =
      "every release train gets cut manually, never from workflow, because nothing guesses versions".split(
        " ",
      );
    let shown = "";
    for (const word of sentence) {
      shown += `${word} `;
      now += WINDOW + 1;
      expect(watcher.push(`\x1b[2K\x1b[G${shown}▏`, now)).toBe("output");
    }
  });
});
