import { describe, expect, it } from "vitest";
import { HarnessPromptDelivery, type PromptDeliveryTimers } from "../harness-prompt-delivery";
import { sanitizeInitialInput } from "../pty-manager";
import { appendPromptBlock, buildPromptBlock } from "../prompt-standard-block";

// The block rides the one delivery path ADR 0026 defines: it is part of the
// string `HarnessPromptDelivery` types, so these tests drive that module with
// each harness and read what it wrote to the PTY.

const COMPOSER = {
  "claude-code": 'Try "fix the bug"',
  codex: "Ask Codex to do anything",
  opencode: "Ask anything",
  "cursor-cli": "Plan, search, build",
  pi: "12.5%/200k",
} as const;
const HARNESSES = Object.keys(COMPOSER) as (keyof typeof COMPOSER)[];
const BLOCK = buildPromptBlock({ sessionId: "t-abc", turn: 1 });

/** Virtual time, as in harness-prompt-delivery.test.ts. */
class Clock implements PromptDeliveryTimers {
  time = 0;
  private timers: { at: number; fn: () => void }[] = [];
  now = (): number => this.time;
  setTimer = (fn: () => void, ms: number): (() => void) => {
    const t = { at: this.time + ms, fn };
    this.timers.push(t);
    return () => {
      this.timers = this.timers.filter((x) => x !== t);
    };
  };
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = due.at;
      due.fn();
    }
    this.time = end;
  }
}

/** Boot, show the composer, and (when `echo`) let the harness echo what was typed. */
function deliver(harness: keyof typeof COMPOSER, raw: string, echo: boolean): string[] {
  const writes: string[] = [];
  const clock = new Clock();
  const delivery = new HarnessPromptDelivery({
    harness,
    prompt: appendPromptBlock(sanitizeInitialInput(raw)!, { sessionId: "t-abc", turn: 1 }),
    write: (d) => writes.push(d),
    onEvent: () => {},
    timers: clock,
  });
  delivery.onOutput(COMPOSER[harness]);
  for (let second = 0; second < 40; second++) {
    clock.advance(1_000);
    const typed = writes.filter((w) => w !== "\r").at(-1);
    if (echo && typed) delivery.onOutput(`\u001B[2J\u001B[H${COMPOSER[harness]}\n> ${typed}`);
    else if (!echo) delivery.onOutput(COMPOSER[harness]);
  }
  return writes;
}

describe("the block at delivery", () => {
  it.each(HARNESSES)("%s is typed the user's text, then the block, once", (harness) => {
    const writes = deliver(harness, "fix the bug\nand add a test", true);
    expect({ harness, writes }).toMatchSnapshot();
    expect(writes[0]).toBe(`fix the bug and add a test ${BLOCK}`);
    expect(writes.at(-1)).toBe("\r");
  });

  it.each(HARNESSES)("%s re-types a swallowed prompt with one block each time, never two", (harness) => {
    const writes = deliver(harness, "fix the bug", false);
    const typed = writes.filter((w) => w !== "\r");
    expect(typed.length).toBeGreaterThan(1);
    for (const w of typed) expect(w.split(BLOCK)).toHaveLength(2);
  });
});
