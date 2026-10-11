import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROMPT_DELIVERY_PROFILE,
  HarnessPromptDelivery,
  deliveryProfileFor,
  promptEchoProbes,
  promptEchoed,
  pastePlaceholderShown,
  splitUtf8,
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

/** Real long-prompt captures at 160x50 (issue 697): codex 0.160.0 and Pi 1.0.2, and the prompts that produced them. */
const fixture = (name: string): string => readFileSync(path.resolve(__dirname, "fixtures", name), "utf8");
const PROMPT_4K = fixture("long-prompt-4k.txt");
const PROMPT_20K = fixture("long-prompt-20k.txt");
const CODEX_4K_ONE_WRITE = fixture("codex-0.160.0-long-4k-one-write.raw");
const CODEX_20K_ONE_WRITE = fixture("codex-0.160.0-long-20k-one-write.raw");
const CODEX_4K_CHUNKED = fixture("codex-0.160.0-long-4k-chunked.raw");
const PI_4K_ONE_WRITE = fixture("pi-1.0.2-long-4k-one-write.raw");
const PI_20K_ONE_WRITE = fixture("pi-1.0.2-long-20k-one-write.raw");
const FRAME = `${ESC}[?2026h`;
/**
 * The chunked capture (the 4k prompt written as 1024, 1024, 1024 and 877
 * characters, 1.2 s apart, then one Enter) cut at the frames where each piece's
 * read begins: after piece 1, 2, 3, 4, and what the Enter caused.
 */
const CODEX_4K_CHUNKED_STEPS = ((): string[] => {
  const frames = CODEX_4K_CHUNKED.split(FRAME);
  const cuts = [0, 10, 14, 18, 20, frames.length];
  return cuts.slice(0, -1).map((from, i) =>
    frames.slice(from, cuts[i + 1]).map((f) => (f ? `${FRAME}${f}` : f)).join(""),
  );
})();

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

  it("does not take a partly read Codex paste chip for the prompt (real 0.160.0 captures)", () => {
    // One write is read only in part: `[Pasted Content 1024 chars]` for 3 949 characters.
    expect(pastePlaceholderShown(CODEX_4K_ONE_WRITE, PROMPT_4K)).toBe(false);
    expect(promptEchoed(CODEX_4K_ONE_WRITE, PROMPT_4K)).toBe(false);
    expect(pastePlaceholderShown(CODEX_20K_ONE_WRITE, PROMPT_20K)).toBe(false);
    expect(promptEchoed(CODEX_20K_ONE_WRITE, PROMPT_20K)).toBe(false);
  });

  it("counts Codex chips in characters, once each, and only when they cover the prompt", () => {
    const chip = (n: number, k = 1) => `[Pasted Content ${n} chars]${k > 1 ? ` #${k}` : ""}`;
    const prompt = "x".repeat(2000);
    expect(pastePlaceholderShown(chip(1936), prompt)).toBe(false);
    // The same chip repainted is still one chip.
    expect(pastePlaceholderShown(chip(1024) + chip(1024) + chip(1024), prompt)).toBe(false);
    expect(pastePlaceholderShown(chip(1024) + chip(976, 2), prompt)).toBe(true);
    expect(pastePlaceholderShown(chip(2000), prompt)).toBe(true);
    // Characters, not bytes: 600 two-byte characters are 1 200 bytes, and a chip of 600 covers them.
    expect(pastePlaceholderShown(chip(600), "é".repeat(600))).toBe(true);
    expect(pastePlaceholderShown(chip(300), "é".repeat(600))).toBe(false);
  });
});

describe("splitUtf8", () => {
  it("cuts on character boundaries within the byte limit and loses nothing", () => {
    const text = `${"é".repeat(700)}${"😀".repeat(300)}${"日本語".repeat(200)}tail`;
    const pieces = splitUtf8(text, 1024);
    expect(pieces.join("")).toBe(text);
    for (const piece of pieces) {
      expect(Buffer.byteLength(piece, "utf8")).toBeLessThanOrEqual(1024);
      expect(piece).not.toContain("\uFFFD");
      expect(Buffer.from(piece, "utf8").toString("utf8")).toBe(piece);
    }
    expect(pieces.length).toBeGreaterThan(Math.floor(Buffer.byteLength(text, "utf8") / 1024));
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

describe("pi 1.0.2 real long-prompt captures (issue 697)", () => {
  it.each([
    ["4k", PROMPT_4K, PI_4K_ONE_WRITE],
    ["20k", PROMPT_20K, PI_20K_ONE_WRITE],
  ])("sees the %s prompt echoed through its tail and presses Enter once", (_name, prompt, capture) => {
    expect(promptEchoed(capture, prompt, PI_102_BOOT)).toBe(true);
    const h = startDelivery(prompt, { harness: "pi" });
    h.delivery.onOutput(PI_102_BOOT);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual([prompt]);
    h.delivery.onOutput(capture);
    h.clock.advance(submitPauseMs(prompt, PROFILE) + PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual([prompt, "\r"]);
    expect(h.events.at(-1)).toMatchObject({ phase: "delivered" });
  });
});

describe("codex 0.160 with a long Task prompt (issue 697, real captures)", () => {
  const ceiling = deliveryProfileFor("codex").composerWaitMs + 1;

  /** A repaint with text no earlier frame had: a piece the composer has taken in. */
  let paints = 0;
  const painted = (): string => {
    // Letters, not digits: a redraw that differs only in numbers is the same frame to the paint detector.
    const word = (++paints).toString(26).replace(/[0-9]/g, (d) => String.fromCharCode(113 + Number(d)));
    return `${ESC}[?2026h${ESC}[47;3H[Pasted Content ${word}]${ESC}[?2026l`;
  };

  function started(prompt: string): Fixture {
    const h = startDelivery(prompt, { harness: "codex" });
    h.delivery.onOutput(CODEX_160_BOOT);
    h.clock.advance(PROFILE.quietGapMs + 1);
    return h;
  }

  const bytes = (w: string): number => Buffer.byteLength(w, "utf8");

  it.each([
    ["4k", PROMPT_4K, CODEX_4K_ONE_WRITE],
    ["20k", PROMPT_20K, CODEX_20K_ONE_WRITE],
  ])("does not report the %s prompt delivered when codex read only its first part", (_name, prompt, capture) => {
    const h = started(prompt);
    // The first piece is read (the real partial chip), and nothing after it ever is.
    h.delivery.onOutput(capture);
    h.clock.advance(ceiling);
    expect(h.events.some((e) => e.phase === "delivered")).toBe(false);
    expect(h.events.at(-1)).toMatchObject({ phase: "abandoned" });
    // Nothing submits what is unread, nothing retypes what was read.
    expect(count(h, "\r")).toBe(0);
    expect(h.writes.join("")).toBe(prompt.slice(0, h.writes.join("").length));
    expect(h.writes).toHaveLength(2);
    for (const w of h.writes) expect(bytes(w)).toBeLessThanOrEqual(1024);
    expect(h.delivery.currentPhase).toBe("abandoned");
  });

  it("writes the 4k prompt in confirmed pieces, then submits once (real chunked capture)", () => {
    const h = started(PROMPT_4K);
    const [after1, after2, after3, after4, afterEnter] = CODEX_4K_CHUNKED_STEPS;
    expect(h.writes).toHaveLength(1);
    for (const step of [after1, after2, after3, after4]) {
      // No next piece before this one has been read and the screen has gone quiet.
      h.clock.advance(PROFILE.quietGapMs + 1);
      const before = h.writes.length;
      h.delivery.onOutput(step);
      h.clock.advance(PROFILE.quietGapMs - 1);
      expect(h.writes).toHaveLength(before);
      h.clock.advance(2_000);
    }
    expect(h.writes.slice(0, -1).map((w) => w.length)).toEqual([1024, 1024, 1024, 877]);
    expect(h.writes.slice(0, -1).join("")).toBe(PROMPT_4K);
    expect(h.writes.at(-1)).toBe("\r");
    expect(count(h, "\r")).toBe(1);
    h.delivery.onOutput(afterEnter);
    h.clock.advance(ceiling);
    expect(h.events.filter((e) => e.phase === "delivered")).toHaveLength(1);
    expect(h.events.some((e) => e.phase === "prompt-swallowed" || e.phase === "abandoned")).toBe(false);
  });

  it("waits for each piece to be read and writes nothing more when one is not", () => {
    const h = started(PROMPT_20K);
    h.delivery.onOutput(painted());
    h.clock.advance(PROFILE.quietGapMs + 2_000);
    expect(h.writes).toHaveLength(2);
    // Piece 2 gets no paint at all: no third piece, no Enter, no retype of piece 2.
    h.clock.advance(60_000);
    expect(h.writes).toHaveLength(2);
    expect(h.writes[0]).toBe(PROMPT_20K.slice(0, 1024));
    expect(h.writes[1]).toBe(PROMPT_20K.slice(1024, 2048));
    expect(h.events.some((e) => e.phase === "prompt-swallowed")).toBe(false);
    expect(h.events.at(-1)).toEqual({
      phase: "abandoned",
      reason: expect.stringMatching(/^codex did not read piece 2 of \d+ of the prompt/),
    });
  });

  it("does not write the next piece while the screen is still repainting", () => {
    const h = started(PROMPT_4K);
    for (let i = 0; i < 10; i++) {
      h.delivery.onOutput(painted());
      h.clock.advance(PROFILE.quietGapMs - 50);
    }
    expect(h.writes).toHaveLength(1);
  });

  it("splits a multibyte prompt on character boundaries, at most 1024 bytes a write", () => {
    const prompt = `${"é".repeat(1500)}${"😀".repeat(500)}${"日本語".repeat(300)}end`;
    const h = started(prompt);
    for (let i = 0; i < 100 && count(h, "\r") === 0; i++) {
      h.delivery.onOutput(painted());
      h.clock.advance(PROFILE.quietGapMs + 2_000);
    }
    const pieces = h.writes.slice(0, -1);
    expect(h.writes.at(-1)).toBe("\r");
    expect(pieces.join("")).toBe(prompt);
    expect(pieces.length).toBeGreaterThan(Math.floor(bytes(prompt) / 1024));
    for (const w of pieces) {
      expect(bytes(w)).toBeLessThanOrEqual(1024);
      expect(w).not.toContain("\uFFFD");
    }
  });

  it("keeps the single write for a prompt that fits one write", () => {
    const prompt = "refactor the auth module and report the result".repeat(10);
    expect(bytes(prompt)).toBeLessThanOrEqual(1024);
    const h = started(prompt);
    expect(h.writes).toEqual([prompt]);
  });

  it("does not take a chip already on the screen before the write for the prompt landing", () => {
    const prompt = "p".repeat(900);
    const chip = `${ESC}[46;3H[Pasted Content 900 chars]`;
    const h = startDelivery(prompt, { harness: "codex" });
    h.delivery.onOutput(CODEX_160_BOOT + chip);
    h.clock.advance(PROFILE.quietGapMs + 1);
    h.clock.advance(submitPauseMs(prompt, PROFILE) + PROFILE.quietGapMs + 1);
    h.delivery.onOutput(chip);
    h.clock.advance(ceiling);
    expect(count(h, "\r")).toBe(0);
    expect(h.events.at(-1)).toMatchObject({ phase: "abandoned" });
  });
});
