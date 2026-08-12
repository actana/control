import { describe, expect, it } from "vitest";
import {
  BLOCKING_DIALOGS,
  DEFAULT_PROMPT_DELIVERY_PROFILE,
  HarnessPromptDelivery,
  chooseDialogOption,
  dialogsForHarness,
  matchBlockingDialog,
  readDialogOptions,
  redrawSignature,
  stripAnsi,
  submitPauseMs,
  type PromptDeliveryEvent,
  type PromptDeliveryTimers,
} from "../harness-prompt-delivery";

const ESC = "\u001B";
const PROFILE = DEFAULT_PROMPT_DELIVERY_PROFILE;

/**
 * Virtual time. Every assertion below is about *when* something is written
 * relative to what the harness printed, so a real timer would make the suite
 * both slow and flaky about exactly the thing it is testing.
 */
class FakeClock implements PromptDeliveryTimers {
  time = 0;
  private seq = 0;
  private timers: { at: number; id: number; fn: () => void }[] = [];

  now = (): number => this.time;

  setTimer = (fn: () => void, ms: number): (() => void) => {
    const timer = { at: this.time + ms, id: ++this.seq, fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  };

  /** Run every timer due within `ms`, in order, advancing time as they fire. */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = Math.max(this.time, due.at);
      due.fn();
    }
    this.time = target;
  }
}

type Fixture = {
  clock: FakeClock;
  writes: string[];
  events: PromptDeliveryEvent[];
  delivery: HarnessPromptDelivery;
};

function startDelivery(
  prompt: string,
  opts: { harness?: string } = {},
): Fixture {
  const clock = new FakeClock();
  const writes: string[] = [];
  const events: PromptDeliveryEvent[] = [];
  const delivery = new HarnessPromptDelivery({
    harness: opts.harness ?? "claude-code",
    prompt,
    write: (data) => writes.push(data),
    onEvent: (event) => events.push(event),
    timers: clock,
  });
  return { clock, writes, events, delivery };
}

/** A spinner frame: a different glyph and a different elapsed second, every tick. */
function spinnerFrame(glyph: string, seconds: number): string {
  return `${ESC}[2K\r${glyph} Thinking… (${seconds}s · esc to interrupt)`;
}

const SPINNER_GLYPHS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴"];

/**
 * Boot chatter that genuinely changes — more distinct lines than the
 * signature ring holds, so cycling them never looks like a repaint.
 */
const BOOT_LINES = [
  "settings",
  "the workspace index",
  "MCP servers",
  "skills",
  "the session transcript",
  "hooks",
  "the model list",
  "project memory",
  "the status line",
  "output styles",
];

/** Paint spinner frames for `ms`, one every 100 ms, exactly as a real TUI does. */
function spinFor(h: Fixture, ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    h.delivery.onOutput(
      spinnerFrame(SPINNER_GLYPHS[(elapsed / 100) % SPINNER_GLYPHS.length]!, elapsed / 1000),
    );
    h.clock.advance(100);
  }
}

const TRUST_DIALOG =
  `${ESC}[2J${ESC}[H` +
  `${ESC}[1mDo you trust the files in this folder?${ESC}[0m\n` +
  `\n` +
  `/home/operator/projects/api\n` +
  `\n` +
  `Claude Code may read, run and modify files in this folder.\n` +
  `\n` +
  `${ESC}[7m❯ 1. No, exit${ESC}[0m\n` +
  `  2. Yes, proceed\n`;

const BYPASS_DIALOG =
  `${ESC}[2J${ESC}[H` +
  `${ESC}[1mWARNING: Claude Code is running in Bypass Permissions mode${ESC}[0m\n` +
  `\n` +
  `In this mode Claude will not ask before running commands.\n` +
  `Do you want to proceed?\n` +
  `\n` +
  `${ESC}[7m❯ 1. No, exit${ESC}[0m\n` +
  `  2. Yes, I accept\n`;

const READY_SCREEN =
  `${ESC}[2J${ESC}[H` +
  `╭──────────────────────────────────────╮\n` +
  `│ > Try "refactor the auth module"     │\n` +
  `╰──────────────────────────────────────╯\n`;

// ─── screen reading ──────────────────────────────────────────────────

describe("stripAnsi", () => {
  it("drops CSI, OSC and two-byte escapes and keeps the text", () => {
    const painted =
      `${ESC}]0;claude${ESC}\\` + `${ESC}[2J${ESC}[H` + `${ESC}[1;32mready${ESC}[0m` + `${ESC}7`;
    expect(stripAnsi(painted).trim()).toBe("ready");
  });

  it("turns a carriage-return redraw into a line break so menus parse", () => {
    expect(stripAnsi("a\rb").split("\n")).toEqual(["a", "b"]);
  });
});

describe("redrawSignature", () => {
  it("collapses spinner frames that differ only by glyph and elapsed time", () => {
    expect(redrawSignature(spinnerFrame("⠋", 3))).toBe(
      redrawSignature(spinnerFrame("⠹", 47)),
    );
  });

  it("is empty for pure cursor movement", () => {
    expect(redrawSignature(`${ESC}[2K${ESC}[1;1H`)).toBe("");
  });

  it("keeps two genuinely different paints apart", () => {
    expect(redrawSignature("Do you trust the files in this folder?")).not.toBe(
      redrawSignature("Welcome to Claude Code"),
    );
  });

  it("treats a line where only a counter moved as the same frame", () => {
    // Deliberate: an elapsed timer, a token meter and a percentage all move on
    // their own, and none of them means the layout is still settling.
    expect(redrawSignature("↑ 1.2k tokens · 4s")).toBe(redrawSignature("↑ 9.7k tokens · 51s"));
  });
});

// ─── dialog reading ──────────────────────────────────────────────────

describe("readDialogOptions", () => {
  it("reads a numbered menu through its highlight and cursor glyph", () => {
    expect(readDialogOptions(TRUST_DIALOG)).toEqual([
      { number: 1, label: "No, exit" },
      { number: 2, label: "Yes, proceed" },
    ]);
  });

  it("takes the most recent paint of a repeated option", () => {
    expect(readDialogOptions("1. No, exit\n1. No, exit (still)")).toEqual([
      { number: 1, label: "No, exit (still)" },
    ]);
  });
});

describe("chooseDialogOption", () => {
  const trust = BLOCKING_DIALOGS.find((d) => d.id === "folder-trust")!;

  it("picks the affirmative option and not the highlighted default", () => {
    // The observed default is `1. No, exit`, so "whatever is highlighted" and
    // "whatever is first" are both the wrong answer.
    expect(chooseDialogOption(readDialogOptions(TRUST_DIALOG), trust)).toEqual({
      number: 2,
      label: "Yes, proceed",
    });
  });

  it("picks by label even when the affirmative option is numbered first", () => {
    const flipped = "❯ 1. Yes, proceed\n  2. No, exit\n";
    expect(chooseDialogOption(readDialogOptions(flipped), trust)).toEqual({
      number: 1,
      label: "Yes, proceed",
    });
  });

  it("refuses a menu with no refusing option — that is not a trust dialog", () => {
    expect(chooseDialogOption([{ number: 1, label: "Yes, proceed" }], trust)).toBeNull();
  });

  it("refuses an ambiguous menu rather than guessing", () => {
    const ambiguous = [
      { number: 1, label: "Yes, proceed" },
      { number: 2, label: "Yes, and remember this folder" },
      { number: 3, label: "No, exit" },
    ];
    expect(chooseDialogOption(ambiguous, trust)).toBeNull();
  });
});

describe("matchBlockingDialog", () => {
  const specs = dialogsForHarness("claude-code");

  it("finds the folder-trust dialog and its answer", () => {
    const match = matchBlockingDialog(TRUST_DIALOG, specs)!;
    expect(match.spec.id).toBe("folder-trust");
    expect(match.answer).toEqual({ number: 2, label: "Yes, proceed" });
  });

  it("finds the bypass-permissions warning behind auto mode", () => {
    const match = matchBlockingDialog(BYPASS_DIALOG, specs)!;
    expect(match.spec.id).toBe("bypass-permissions");
    expect(match.answer).toEqual({ number: 2, label: "Yes, I accept" });
  });

  it("does not fire on a ready composer", () => {
    expect(matchBlockingDialog(READY_SCREEN, specs)).toBeNull();
  });

  it("does not fire on prose that merely says the word", () => {
    const prose = "Loaded 3 trusted directories from settings. Ready?\n";
    expect(matchBlockingDialog(prose, specs)).toBeNull();
  });

  it("reports a dialog it cannot answer rather than reporting nothing", () => {
    const unreadable = "Do you trust the files in this folder?\n\n  Yes / No\n";
    const match = matchBlockingDialog(unreadable, specs)!;
    expect(match.spec.id).toBe("folder-trust");
    expect(match.answer).toBeNull();
  });
});

// ─── submit pause ────────────────────────────────────────────────────

describe("submitPauseMs", () => {
  it("scales with the length of the text", () => {
    expect(submitPauseMs("hi", PROFILE)).toBeLessThan(submitPauseMs("x".repeat(400), PROFILE));
  });

  it("never drops below the floor or above the ceiling", () => {
    expect(submitPauseMs("", PROFILE)).toBe(PROFILE.submitBaseMs);
    expect(submitPauseMs("x".repeat(100_000), PROFILE)).toBe(PROFILE.submitMaxMs);
  });
});

// ─── the sequence ────────────────────────────────────────────────────

describe("HarnessPromptDelivery", () => {
  it("waits for the painting to stop rather than for a fixed delay", () => {
    const h = startDelivery("ship it");
    h.delivery.onOutput(READY_SCREEN);

    // The old behaviour fired 450 ms after the first byte. Nothing may have
    // been written at that point beyond the quiet gap...
    h.clock.advance(PROFILE.quietGapMs - 1);
    expect(h.writes).toEqual([]);

    h.clock.advance(2);
    expect(h.writes[0]).toBe("ship it");
  });

  it("keeps waiting while the TUI is still painting, however long that takes", () => {
    const h = startDelivery("ship it");
    for (let i = 0; i < 40; i += 1) {
      // 40 distinct paints, 200 ms apart — eight seconds of boot, none of it a
      // spinner, and not one byte of prompt written into it.
      h.delivery.onOutput(`${ESC}[2J${ESC}[Hloading ${BOOT_LINES[i % BOOT_LINES.length]}`);
      h.clock.advance(200);
    }
    expect(h.writes).toEqual([]);

    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes[0]).toBe("ship it");
  });

  it("treats a spinner that never stops as quiet — the gap is in the redraws", () => {
    const h = startDelivery("ship it");
    h.delivery.onOutput(READY_SCREEN);
    // Five seconds of unbroken 100 ms spinner redraws: real output the whole
    // time, so "wait for silence" would wait forever.
    spinFor(h, 5_000);
    expect(h.writes[0]).toBe("ship it");
    // ...and it did not wait five seconds to decide that.
    const settled = h.events.find((e) => e.phase === "settled");
    expect(settled).toMatchObject({ phase: "settled" });
    expect((settled as { waitedMs: number }).waitedMs).toBeLessThan(1_000);
  });

  it("sends the carriage return as a separate keystroke, after the prompt", () => {
    const h = startDelivery("ship it");
    h.delivery.onOutput(READY_SCREEN);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["ship it"]);

    h.clock.advance(submitPauseMs("ship it", PROFILE) + PROFILE.quietGapMs);
    expect(h.writes).toEqual(["ship it", "\r"]);
  });

  it("waits longer before submitting a prompt long enough to arrive as a paste", () => {
    const long = "Refactor the authentication module. ".repeat(40);
    const h = startDelivery(long);
    h.delivery.onOutput(READY_SCREEN);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual([long]);

    // The harness renders `[Pasted text #1 +N lines]` and waits. A `\r` that
    // rode in behind the text would have been absorbed by that.
    h.delivery.onOutput(`${ESC}[2K\r[Pasted text #1 +12 lines]`);
    const wroteAt = h.clock.time;

    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual([long]);

    h.clock.advance(submitPauseMs(long, PROFILE));
    expect(h.writes).toEqual([long, "\r"]);
    expect(h.clock.time - wroteAt).toBeGreaterThan(submitPauseMs("ship it", PROFILE));
  });

  it("answers the trust dialog by its affirmative option, never by Enter", () => {
    const h = startDelivery("ship it");
    h.delivery.onOutput(TRUST_DIALOG);
    h.clock.advance(PROFILE.quietGapMs + 1);

    // The highlighted default is `1. No, exit`; an Enter here ends the session.
    expect(h.writes[0]).toBe("2");
    expect(h.writes).not.toContain("\r");
    expect(h.events[0]).toEqual({
      phase: "dialog",
      dialog: "folder-trust",
      option: 2,
      label: "Yes, proceed",
    });

    h.delivery.onOutput(READY_SCREEN);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["2", "ship it"]);
  });

  it("confirms the selection when the dialog stays up, and only then", () => {
    const h = startDelivery("ship it");
    h.delivery.onOutput(TRUST_DIALOG);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["2"]);

    // The harness moved the highlight and is waiting for a confirm.
    h.delivery.onOutput(TRUST_DIALOG.replace("❯ 1. No, exit", "  1. No, exit"));
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["2", "\r"]);
  });

  it("survives auto mode and an initial prompt together", () => {
    // The observed killer: `--dangerously-skip-permissions` opens a second
    // dialog behind the first, and each one's highlighted default exits.
    const h = startDelivery("ship it");
    h.delivery.onOutput(TRUST_DIALOG);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["2"]);

    h.delivery.onOutput(BYPASS_DIALOG);
    h.clock.advance(PROFILE.quietGapMs + 1);
    // A stale confirm from the first dialog would land on the second dialog's
    // `No, exit`. It must be the second dialog's own option number instead.
    expect(h.writes).toEqual(["2", "2"]);

    h.delivery.onOutput(READY_SCREEN);
    h.clock.advance(PROFILE.quietGapMs + 1);
    h.clock.advance(submitPauseMs("ship it", PROFILE) + PROFILE.quietGapMs);
    expect(h.writes).toEqual(["2", "2", "ship it", "\r"]);
    expect(h.delivery.currentPhase).toBe("delivered");
  });

  it("types nothing at all into a dialog it cannot read", () => {
    const h = startDelivery("ship it");
    h.delivery.onOutput("Do you trust the files in this folder?\n\n  Yes / No\n");
    h.clock.advance(PROFILE.maxWaitMs * 2);

    expect(h.writes).toEqual([]);
    expect(h.delivery.currentPhase).toBe("abandoned");
    expect(h.events).toContainEqual({ phase: "dialog-unreadable", dialog: "folder-trust" });
    expect(h.events.at(-1)).toEqual({ phase: "abandoned", reason: "blocked by folder-trust" });
  });

  it("delivers at the backstop when the harness never settles", () => {
    const h = startDelivery("ship it");
    for (let i = 0; i < 200; i += 1) {
      // A genuinely new paint every 100 ms, forever: quiet never arrives.
      h.delivery.onOutput(`${ESC}[2J${ESC}[Hstreaming ${BOOT_LINES[i % BOOT_LINES.length]}`);
      h.clock.advance(100);
    }
    expect(h.writes).toContain("ship it");
    h.clock.advance(submitPauseMs("ship it", PROFILE) + 1);
    expect(h.writes).toEqual(["ship it", "\r"]);
  });

  it("writes nothing after the PTY is gone", () => {
    const h = startDelivery("ship it");
    h.delivery.onOutput(READY_SCREEN);
    h.delivery.dispose();
    h.clock.advance(PROFILE.maxWaitMs * 2);
    expect(h.writes).toEqual([]);
    expect(h.delivery.currentPhase).toBe("abandoned");
  });

  it("delivers to a harness the dialog table says nothing about", () => {
    const h = startDelivery("ship it", { harness: "some-harness-invented-tomorrow" });
    h.delivery.onOutput(READY_SCREEN);
    h.clock.advance(PROFILE.quietGapMs + 1);
    h.clock.advance(submitPauseMs("ship it", PROFILE) + PROFILE.quietGapMs);
    expect(h.writes).toEqual(["ship it", "\r"]);
  });
});
