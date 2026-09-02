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

  it("keeps the digits that are a count rather than a clock", () => {
    // Review of PR 455, finding 2. Digits are dropped only from a line that is
    // carrying a clock — a spinner glyph, or an elapsed-time pattern. On every
    // other line the number is the content, and `41` → `42` is the change.
    const watcher = new PtyOutputActivityWatcher();
    let now = WINDOW + 1;
    expect(watcher.push("\x1b[2K\x1b[GCompiled 41 files", now)).toBe("output");
    for (let files = 42; files < 60; files += 1) {
      now += WINDOW + 1;
      expect(watcher.push(`\x1b[2K\x1b[GCompiled ${files} files`, now)).toBe("output");
    }
  });

  it("keeps a coloured frame on one line, glyph and clock together", () => {
    // Colour codes sit inside a line and often inside a word. If they ended
    // the line, the spinner glyph and the counter would land on different
    // ones, the counter's digits would read as content, and an idle harness
    // would look busy forever.
    const watcher = new PtyOutputActivityWatcher();
    let now = WINDOW + 1;
    const coloured = (spinner: string, seconds: number) =>
      `\x1b[2K\x1b[G\x1b[33m${spinner}\x1b[0m \x1b[1mWork\x1b[0ming\x1b[0m (${seconds}s)`;
    expect(watcher.push(coloured("⠹", 0), now)).toBe("output");
    for (let tick = 1; tick < 20; tick += 1) {
      now += WINDOW + 1;
      expect(watcher.push(coloured("⠸", tick * 5), now)).toBe("redraw");
    }
  });

  it("still reads a clock as a clock when its line carries one", () => {
    // The other side of the same rule, and the limitation it leaves: a line
    // that is *both* spinner-prefixed and nothing but numbers has its digits
    // dropped, and reads as the repaint it looks like.
    const watcher = new PtyOutputActivityWatcher();
    let now = WINDOW + 1;
    expect(watcher.push(idleFrame("⠹", "0s"), now)).toBe("output");
    for (let tick = 1; tick < 20; tick += 1) {
      now += WINDOW + 1;
      expect(watcher.push(idleFrame("⠸", `${tick}m ${tick}s`), now)).toBe("redraw");
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

// The shapes the review of PR 455 ran the shipped classifier over: twelve
// minutes of one burst per five-second window, each of them a live turn that
// the first cut settled anyway. Every one of them must read as work.
describe("the burst shapes a live turn actually produces", () => {
  /** Twelve minutes of five-second bursts; returns how many read as `output`. */
  const runFor12Minutes = (frame: (tick: number) => string) => {
    const watcher = new PtyOutputActivityWatcher();
    let now = WINDOW + 1;
    let output = 0;
    let longestRedrawRun = 0;
    let run = 0;
    for (let tick = 0; tick < (12 * 60) / 5; tick += 1) {
      const kind = watcher.push(frame(tick), now);
      now += WINDOW + 1;
      if (kind === "output") {
        output += 1;
        run = 0;
      } else {
        run += 1;
        longestRedrawRun = Math.max(longestRedrawRun, run);
      }
    }
    return { output, longestRedrawRun };
  };

  it("reads a download's changing size and rate as work", () => {
    const { output } = runFor12Minutes(
      (tick) =>
        `\r\x1b[KDownloading ${(41.2 + tick).toFixed(1)} MB / 900 MB at 3.${tick % 9} MB/s`,
    );
    expect(output).toBe(144);
  });

  it("reads a compile count as work", () => {
    const { output } = runFor12Minutes((tick) => `\r\x1b[KCompiled ${tick} files`);
    expect(output).toBe(144);
  });

  it("reads a test tally as work, though its duration line is a clock", () => {
    const { output } = runFor12Minutes(
      (tick) => `\r\x1b[K Tests ${tick} passed (400)\r\n Duration ${tick * 5}s`,
    );
    expect(output).toBe(144);
  });

  it("reads appended dot progress as work", () => {
    // Nothing is erased: the dots scrolled onto the screen, so they are new
    // whatever they say.
    const { output } = runFor12Minutes(() => ".....");
    expect(output).toBe(144);
  });

  it("reads distinct log lines as work", () => {
    const { output } = runFor12Minutes(
      (tick) => `\r\x1b[K[core] resolved harness manifest for project alpha-${tick}\r\n`,
    );
    expect(output).toBe(144);
  });

  it("still reads the Codex idle spinner as the repaint it is", () => {
    // The target case, unchanged: one output burst as the frame appears, then
    // nothing but redraws for the rest of the twelve minutes.
    const { output, longestRedrawRun } = runFor12Minutes(
      (tick) => `\x1b[2K\x1b[G${tick % 2 ? "⠹" : "⠸"} Working (${tick}s • Esc to interrupt)`,
    );
    expect(output).toBe(1);
    expect(longestRedrawRun).toBe(143);
  });

  it("never settles on a spinner whose phrase rotates, and says so", () => {
    // Documented limitation, pinned: a rotating gerund puts a new word on
    // screen every rotation, so the idle rule never fires for that harness.
    const phrases = ["Herding", "Simmering", "Pondering", "Noodling"];
    const { output } = runFor12Minutes(
      (tick) => `\x1b[2K\x1b[G✻ ${phrases[Math.floor(tick / 6) % phrases.length]}… (${tick}s)`,
    );
    expect(output).toBeGreaterThan(20);
  });
});

describe("finding what is new at the end of a very large burst", () => {
  it("sees a new tool line under a full-viewport repaint", () => {
    // Review of PR 455, finding 3: the scan was front-first and capped, but
    // `push` keeps the tail of an oversized burst and a TUI paints what is new
    // at the bottom. A thousand words of unchanged screen must not hide it.
    const watcher = new PtyOutputActivityWatcher();
    let now = WINDOW + 1;
    const viewport = Array.from(
      { length: 1200 },
      (_, i) => `line${i}word${i % 7}`,
    ).join(" ");
    expect(watcher.push(`\x1b[2J\x1b[H${viewport}`, now)).toBe("output");

    now += WINDOW + 1;
    expect(watcher.push(`\x1b[2J\x1b[H${viewport}`, now)).toBe("redraw");

    now += WINDOW + 1;
    expect(
      watcher.push(`\x1b[2J\x1b[H${viewport} Ran pnpm vitest packages/core`, now),
    ).toBe("output");
  });
});
