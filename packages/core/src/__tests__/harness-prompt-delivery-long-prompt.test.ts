import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROMPT_DELIVERY_PROFILE,
  HarnessPromptDelivery,
  composerOnScreen,
  deliveryProfileFor,
  promptEchoProbes,
  promptEchoed,
  readinessFor,
  submitPauseMs,
  type PromptDeliveryEvent,
  type PromptDeliveryTimers,
} from "../harness-prompt-delivery";
import { appendPromptBlock } from "../prompt-standard-block";

const ESC = "\u001B";
const PROFILE = DEFAULT_PROMPT_DELIVERY_PROFILE;

/** Virtual time, as in harness-prompt-delivery.test.ts. */
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

function startDelivery(prompt: string, opts: { harness?: string } = {}): Fixture {
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

const PI_102_BOOT = readFileSync(path.resolve(__dirname, "fixtures/pi-1.0.2-boot.raw"), "utf8");
const CODEX_160_BOOT = readFileSync(path.resolve(__dirname, "fixtures/codex-0.160.0-boot.raw"), "utf8");

const SENTENCE =
  "You have been given a Task by the operator's Panel. Do the work, then report the result as described at the end.";
/** Body text that never repeats the preamble, so a long prompt's tail does not contain its head probe. */
const body = (n: number, tag = "module"): string =>
  Array.from({ length: n }, (_, i) => `Step ${i + 1}: check ${tag} ${i} and note each finding.`).join(" ");
/** A ~4000-character Task prompt: the preamble once, then distinct steps, then the standard block (issue 697). */
const LONG = appendPromptBlock(`${SENTENCE} ${body(70)}`, { sessionId: "s-697", turn: 1 });
/** A different prompt that ends in the same fixed standard block. */
const OTHER = appendPromptBlock(`Fix the flaky scheduler test. ${body(70, "service")}`, { sessionId: "s-other", turn: 1 });
/** ~20 000 characters, well past the 8000-character screen window. */
const HUGE = appendPromptBlock(`${SENTENCE} ${body(350)}`, { sessionId: "s-697", turn: 1 });
const SHORT = "refactor the auth module";

// ── Synthetic screens, modelled on the pi 1.0.2 and codex 0.160 captures ──────────────────────────────────────

/** Greedy word wrap. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Pi's editor box repainted on its own (no footer): a rule, then the given wrapped rows, cursor on the last. */
function piEditor(lines: string[]): string {
  const rule = `${ESC}[?2026h${ESC}[42;1H${ESC}[2K${ESC}[38;5;5m${"─".repeat(160)}${ESC}[39m${ESC}[0m${ESC}]8;;\u0007`;
  const rows = lines.map((line, i) => {
    const text = i === lines.length - 1 ? `${line.padEnd(157)}${ESC}[7m ${ESC}[0m` : line.padEnd(157);
    return `${ESC}[${43 + i};1H${ESC}[2K${text}${ESC}[0m${ESC}]8;;\u0007`;
  });
  return `${rule}${rows.join("")}${ESC}[?25l${ESC}[?2026l`;
}

/** The last five wrapped rows: what pi shows once the cursor sits at the end of a long typed prompt. */
const piTail = (p: string): string => piEditor(wrap(p, 157).slice(-5));
/** The first five wrapped rows: only the shared preamble. */
const piHead = (p: string): string => piEditor(wrap(p, 157).slice(0, 5));

/** Codex 0.160's composer holding one `[Pasted Content N chars]` chip per number, drawn with cursor moves. */
function codexChips(...ns: number[]): string {
  let col = 3;
  let out = `${ESC}[?2026h${ESC}[46;1H${ESC}[2K›`;
  ns.forEach((n, i) => {
    if (i > 0) col += 1;
    for (const word of ["[Pasted", "Content", String(n), "chars]"]) {
      out += `${ESC}[46;${col}H${word}`;
      col += word.length + 1;
    }
  });
  return `${out}${ESC}[?2026l`;
}

const count = (h: Fixture, w: string): number => h.writes.filter((x) => x === w).length;

describe("promptEchoProbes", () => {
  it("lets the head alone count for a short prompt, and never for a long one", () => {
    expect(promptEchoProbes(SHORT).headCounts).toBe(true);
    const long = promptEchoProbes(LONG);
    expect(long.headCounts).toBe(false);
    expect(long.tail.endsWith("[/Actanastandardblockv1]")).toBe(true);
  });
});

describe("promptEchoed with a short prompt keeps the head probe", () => {
  it("sees a truncated head and a full-screen repaint", () => {
    expect(promptEchoed("┃ refactor the a", SHORT)).toBe(true);
    expect(promptEchoed(`${ESC}[2J┃ ${SHORT} ┃`, SHORT)).toBe(true);
  });
});

describe("promptEchoed with a long prompt", () => {
  it("reads the tail, not the shared preamble", () => {
    expect(promptEchoed(piTail(LONG), LONG)).toBe(true);
    expect(promptEchoed(piHead(LONG), LONG)).toBe(false);
    expect(promptEchoed(`unrelated output\n${"x".repeat(200)}`, LONG)).toBe(false);
  });

  it("shares the standard-block tail with other prompts, so only a fresh tail counts", () => {
    expect(promptEchoed(piTail(OTHER), LONG)).toBe(true);
    expect(promptEchoed(piTail(OTHER), LONG, piTail(OTHER))).toBe(false);
  });

  it("does not take a Codex chip with an implausible size for the prompt", () => {
    expect(promptEchoed(codexChips(999_999), LONG)).toBe(false);
  });

  it("counts a Codex chip, and each of two chips", () => {
    expect(promptEchoed(codexChips(3072), LONG)).toBe(true);
    expect(promptEchoed(codexChips(1024, 3072), LONG)).toBe(true);
  });
});

describe("pi 1.0.2 with a ~4500-character Task prompt (issue 697)", () => {
  const abandonReason = `pi composer never appeared within ${deliveryProfileFor("pi").composerWaitMs} ms`;
  const ceiling = deliveryProfileFor("pi").composerWaitMs + 1;

  function written(boot = PI_102_BOOT): Fixture {
    const h = startDelivery(LONG, { harness: "pi" });
    h.delivery.onOutput(boot);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual([LONG]);
    return h;
  }

  function swallowed(boot = PI_102_BOOT): Fixture {
    const h = written(boot);
    h.clock.advance(submitPauseMs(LONG, PROFILE) + PROFILE.quietGapMs + 1);
    expect(h.events).toContainEqual({ phase: "prompt-swallowed", attempt: 1 });
    return h;
  }

  it("presses Enter once when the editor tail repaints after the echo check", () => {
    const h = swallowed();
    h.delivery.onOutput(piTail(LONG));
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual([LONG, "\r"]);
    expect(h.events.some((e) => e.phase === "abandoned")).toBe(false);
  });

  it("presses Enter once when the editor tail arrives in time for the echo check", () => {
    const h = written();
    h.delivery.onOutput(piTail(LONG));
    h.clock.advance(submitPauseMs(LONG, PROFILE) + PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual([LONG, "\r"]);
  });

  it("does not take the shared preamble for the prompt landing", () => {
    const h = swallowed();
    h.delivery.onOutput(piHead(LONG));
    h.clock.advance(ceiling);
    expect(h.writes).toEqual([LONG]);
    expect(h.events.at(-1)).toEqual({ phase: "abandoned", reason: abandonReason });
  });

  it("does not take a preamble already on the boot screen for the prompt landing", () => {
    const h = swallowed(PI_102_BOOT + piHead(LONG));
    h.delivery.onOutput(piHead(LONG));
    h.clock.advance(ceiling);
    expect(count(h, "\r")).toBe(0);
    expect(h.events.at(-1)).toMatchObject({ phase: "abandoned" });
    expect(count(h, LONG)).toBeLessThanOrEqual(3);
  });

  it("does not take another prompt's shared standard-block tail already on screen for the prompt landing", () => {
    const h = swallowed(PI_102_BOOT + piTail(OTHER));
    h.delivery.onOutput(piTail(OTHER));
    h.clock.advance(ceiling);
    expect(count(h, "\r")).toBe(0);
    expect(h.events.at(-1)).toEqual({ phase: "abandoned", reason: abandonReason });
  });

  it("presses Enter once for a ~20 000-character prompt", () => {
    const h = startDelivery(HUGE, { harness: "pi" });
    h.delivery.onOutput(PI_102_BOOT);
    h.clock.advance(PROFILE.quietGapMs + 1);
    h.clock.advance(submitPauseMs(HUGE, PROFILE) + PROFILE.quietGapMs + 1);
    h.delivery.onOutput(piTail(HUGE));
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual([HUGE, "\r"]);
  });

  it("abandons honestly when nothing ever lands", () => {
    const h = swallowed();
    h.clock.advance(ceiling);
    expect(h.writes).toEqual([LONG]);
    expect(h.events.at(-1)).toEqual({ phase: "abandoned", reason: abandonReason });
  });
});

describe("codex 0.160 with a ~4500-character Task prompt pasted as a chip (issue 697)", () => {
  const ceiling = deliveryProfileFor("codex").composerWaitMs + 1;

  function written(boot = CODEX_160_BOOT): Fixture {
    const h = startDelivery(LONG, { harness: "codex" });
    h.delivery.onOutput(boot);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual([LONG]);
    return h;
  }

  function swallowed(boot = CODEX_160_BOOT): Fixture {
    const h = written(boot);
    h.clock.advance(submitPauseMs(LONG, PROFILE) + PROFILE.quietGapMs + 1);
    expect(h.events).toContainEqual({ phase: "prompt-swallowed", attempt: 1 });
    return h;
  }

  it("presses Enter once when the chip is painted after the echo check", () => {
    const h = swallowed();
    h.delivery.onOutput(codexChips(3072));
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual([LONG, "\r"]);
    expect(h.events.some((e) => e.phase === "abandoned")).toBe(false);
    expect(composerOnScreen(codexChips(3072), readinessFor("codex"))).toBe(false);
  });

  it("presses Enter once when the chip is painted in time for the echo check", () => {
    const h = written();
    h.delivery.onOutput(codexChips(3072));
    h.clock.advance(submitPauseMs(LONG, PROFILE) + PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual([LONG, "\r"]);
  });

  it("presses Enter for a prompt shown as two chips", () => {
    const h = swallowed();
    h.delivery.onOutput(codexChips(1024, 3072));
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual([LONG, "\r"]);
  });

  it("presses Enter once for a ~20 000-character prompt shown as several chips", () => {
    const h = startDelivery(HUGE, { harness: "codex" });
    h.delivery.onOutput(CODEX_160_BOOT);
    h.clock.advance(PROFILE.quietGapMs + 1);
    h.clock.advance(submitPauseMs(HUGE, PROFILE) + PROFILE.quietGapMs + 1);
    h.delivery.onOutput(codexChips(3072, 3072, 3072, 3072, 3072, 3072, 1500));
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual([HUGE, "\r"]);
  });

  it("does not take a chip already on the screen before the write for the prompt landing", () => {
    const h = swallowed(CODEX_160_BOOT + codexChips(3072));
    h.delivery.onOutput(codexChips(3072));
    h.clock.advance(ceiling);
    expect(count(h, "\r")).toBe(0);
    expect(h.events.at(-1)).toMatchObject({
      phase: "abandoned",
      reason: expect.stringMatching(/^codex composer never appeared within \d+ ms$/),
    });
  });

  it("does not take an unrelated composer repaint for the prompt landing", () => {
    const h = swallowed();
    h.delivery.onOutput(`${ESC}[46;1H${ESC}[2K› Working on something else`);
    h.clock.advance(ceiling);
    expect(count(h, "\r")).toBe(0);
    expect(h.events.at(-1)).toMatchObject({ phase: "abandoned" });
  });
});
