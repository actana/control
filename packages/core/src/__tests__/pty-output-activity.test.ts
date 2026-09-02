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

// Review of PR 455, round 2, finding 3: "is this line carrying a clock" was
// over-matching, and every over-match is a live turn read as idle.
describe("telling a clock from the numbers that are the content", () => {
  const runFor12Minutes = (frame: (tick: number) => string) => {
    const watcher = new PtyOutputActivityWatcher();
    let now = WINDOW + 1;
    let output = 0;
    for (let tick = 0; tick < (12 * 60) / 5; tick += 1) {
      if (watcher.push(frame(tick), now) === "output") output += 1;
      now += WINDOW + 1;
    }
    return output;
  };

  it("does not call a wall-clock log stamp an elapsed-time counter", () => {
    // `\d+:\d{2}` matches the timestamp a build prints in front of every line,
    // and calling that a clock took the count beside it with it.
    expect(
      runFor12Minutes((tick) => `\x1b[2K\r[12:34:${String(tick % 60).padStart(2, "0")}] Compiled ${tick} files`),
    ).toBe(144);
  });

  it("does not call a check mark or a prompt caret a spinner", () => {
    // ✔ and ❯ were inside the Dingbats block the pattern used to take whole.
    expect(runFor12Minutes((tick) => `\x1b[2K\r✔ ${tick} passed`)).toBe(144);
    expect(runFor12Minutes((tick) => `\x1b[2K\r❯ step ${tick} of 900`)).toBe(144);
    expect(runFor12Minutes((tick) => `\x1b[2K\r• ${tick} passed`)).toBe(144);
  });

  it("keeps a count that shares its line with an elapsed time", () => {
    // Review of PR 455, round 3: one duration token used to take every digit
    // on its line with it, and a count beside an elapsed time is the standard
    // build-progress shape — Bazel, Gradle and every watch-mode runner print
    // it. Each of those was a live turn read as idle.
    expect(runFor12Minutes((tick) => `\x1b[2K\r✔ ${tick} passed in ${tick / 10}s`)).toBe(144);
    expect(
      runFor12Minutes((tick) => `\x1b[2K\rCompiled ${tick} files in ${tick / 10}s`),
    ).toBe(144);
    expect(
      runFor12Minutes((tick) => `\x1b[2K\r[${tick},234 / 5,678] Compiling foo.cc; ${tick}s`),
    ).toBe(144);
  });

  it("drops the duration itself, and only that", () => {
    expect(normalizePtyOutput("\x1b[2K\r✔ 43 passed in 12.3s")).toBe("43 passed in");
    expect(normalizePtyOutput("\x1b[2K\rCompiled 41 files in 3.2s")).toBe("Compiled 41 files in");
    // A wall-clock stamp is not a duration, so nothing on that line is
    // dropped at all — the stamp changes, and so does the count.
    expect(normalizePtyOutput("\x1b[2K\r[12:34:07] Compiled 43 files")).toBe(
      "[12:34:07] Compiled 43 files",
    );
    // A spinner's line is a frame, and every number on it belongs to the
    // frame — the clock, the token count, the context percentage.
    expect(normalizePtyOutput("\x1b[2K\r⠹ Working (1m 12s · ↑ 1.2k tokens)")).toBe(
      "Working (m s ↑ .k tokens)",
    );
  });

  it("still calls a braille or sparkle spinner's counter a clock", () => {
    expect(runFor12Minutes((tick) => `\x1b[2K\r⠹ Working (${tick}s)`)).toBe(1);
    expect(runFor12Minutes((tick) => `\x1b[2K\r✻ Thinking (${tick}s)`)).toBe(1);
  });
});

describe("what the last burst was, when the last burst said nothing", () => {
  it("still counts as a repaint for the burst that follows it", () => {
    // Review of PR 455, round 2, finding 4: the empty-normalisation return
    // used to skip re-arming the flag, so an appended line after a bare screen
    // clear lost its "nothing was erased, so it is new" path.
    const watcher = new PtyOutputActivityWatcher();
    let now = WINDOW + 1;
    expect(watcher.push("\x1b[2K\rSpinner Working here", now)).toBe("output");
    now += WINDOW + 1;
    expect(watcher.push("\x1b[H\x1b[2J", now)).toBe("redraw");
    now += WINDOW + 1;
    expect(watcher.push("Spinner Working here\n", now)).toBe("output");
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

  it("sees a new line painted above the bottom of the screen", () => {
    // Review of PR 455, round 2, finding 5: the scan is tail-first, which is
    // the right bias, but a cap below a viewport's worth of words hid novelty
    // painted above the static footer under it.
    const watcher = new PtyOutputActivityWatcher();
    let now = WINDOW + 1;
    const body = Array.from({ length: 900 }, (_, i) => `body${i}text${i % 5}`).join(" ");
    const footer = Array.from({ length: 500 }, (_, i) => `footer${i}row${i % 3}`).join(" ");
    expect(watcher.push(`\x1b[2J\x1b[H${body} ${footer}`, now)).toBe("output");

    now += WINDOW + 1;
    expect(watcher.push(`\x1b[2J\x1b[H${body} ${footer}`, now)).toBe("redraw");

    now += WINDOW + 1;
    expect(
      watcher.push(`\x1b[2J\x1b[H${body} Edited packages/core/src/thing.ts ${footer}`, now),
    ).toBe("output");
  });

  it("keeps its footing on a burst larger than either cap", () => {
    // A hundred-row viewport on a wide terminal is well past both the pending
    // cap (64 KB) and the remembered cap (16 KB). The tail is what is kept and
    // the tail is what is compared, so the same screen twice is still a
    // repaint, and a line appended under it is still work.
    const watcher = new PtyOutputActivityWatcher();
    let now = WINDOW + 1;
    const huge = Array.from(
      { length: 12_000 },
      (_, i) => `cell${i}col${i % 11}`,
    ).join(" ");
    expect(huge.length).toBeGreaterThan(128 * 1024);
    expect(watcher.push(`\x1b[2J\x1b[H${huge}`, now)).toBe("output");

    now += WINDOW + 1;
    expect(watcher.push(`\x1b[2J\x1b[H${huge}`, now)).toBe("redraw");

    now += WINDOW + 1;
    expect(watcher.push(`\x1b[2J\x1b[H${huge} Ran pnpm build`, now)).toBe("output");
  });

  it("drops the oldest chunks of an over-long window, never the newest", () => {
    // The cap is enforced by dropping whole chunks off the front rather than
    // re-slicing one string per chunk, which is what the PTY data path can
    // afford. What survives is the end of the window.
    const watcher = new PtyOutputActivityWatcher();
    let now = WINDOW + 1;
    expect(watcher.push("\x1b[2J\x1b[Hopening frame", now)).toBe("output");

    // 128 chunks of a kilobyte inside one window: the oldest fall off the
    // front, and none of them costs a report.
    for (let i = 0; i < 128; i += 1) {
      expect(watcher.push(`\r\x1b[K${`filler${i} `.repeat(90)}`, now + i)).toBeNull();
    }
    now += WINDOW + 1;
    expect(watcher.push("\r\x1b[Ktail line that nobody has seen", now)).toBe("output");
  });
});
