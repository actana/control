import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BLOCKING_DIALOGS,
  DEFAULT_PROMPT_DELIVERY_PROFILE,
  HARNESS_READINESS,
  HarnessPromptDelivery,
  chooseDialogOption,
  composerOnScreen,
  dialogsForHarness,
  highlightIsOn,
  lastScreenClearIndex,
  matchBlockingDialog,
  promptEchoed,
  readDialogOptions,
  readinessFor,
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

/**
 * The same trust dialog after the harness *took* the digit: the highlight has
 * moved onto the affirmative option, and only now is an Enter a confirm rather
 * than a `No, exit`.
 */
const TRUST_DIALOG_SELECTED =
  `${ESC}[2J${ESC}[H` +
  `${ESC}[1mDo you trust the files in this folder?${ESC}[0m\n` +
  `\n` +
  `/home/operator/projects/api\n` +
  `\n` +
  `Claude Code may read, run and modify files in this folder.\n` +
  `\n` +
  `  1. No, exit\n` +
  `${ESC}[7m❯ 2. Yes, proceed${ESC}[0m\n`;

const READY_SCREEN =
  `${ESC}[2J${ESC}[H` +
  `╭──────────────────────────────────────╮\n` +
  `│ > Try "refactor the auth module"     │\n` +
  `╰──────────────────────────────────────╯\n`;

/**
 * The composer with the prompt in it — what the harness paints back a beat
 * after the write lands.
 *
 * Issue 232 put `claude-code` in {@link HARNESS_READINESS} with `confirmEcho`
 * set, so its carriage return is now owed evidence that the text arrived. That
 * turns "write, then the harness says nothing, then `\r`" from the healthy
 * path into a description of the swallowed-prompt failure itself — which is
 * the whole bug. So every case below that goes on to assert a `\r` paints this
 * first, because a real harness does.
 */
function echoed(prompt: string): string {
  return (
    `${ESC}[2J${ESC}[H` +
    `╭──────────────────────────────────────╮\n` +
    `│ > ${prompt}\n` +
    `╰──────────────────────────────────────╯\n`
  );
}

/** The dialog a session hits when the menu is prose rather than a numbered list. */
const UNREADABLE_TRUST = "Do you trust the files in this folder?\n\n  Yes / No\n";

/**
 * The folder-trust dialog as `claude` 2.1.228 actually paints it, captured
 * byte-for-byte from a live session on this branch (only the project path is
 * substituted). Two things in it are not guessable from a hand-written
 * fixture, and both of them decided a real prompt's fate:
 *
 * - the menu is laid out with column moves rather than spaces, so a screen
 *   reader that deletes every escape sees `1.Yes,Itrustthisfolder`;
 * - the affirmative option is numbered **1** and is the highlighted default,
 *   the opposite of the ordering #154 recorded — which is the case D4 is
 *   built for, and a hard-coded `2` would have chosen `No, exit`.
 */
const REAL_TRUST_DIALOG = readFileSync(
  path.resolve(__dirname, "fixtures/claude-code-2.1.228-folder-trust.txt"),
  "utf8",
);

/**
 * The composer that harness paints once the dialog is answered, captured from
 * the same live session. It opens with the harness's idea of clearing the
 * screen — a run of erase-line-and-go-up, and not one `ESC[2J` anywhere.
 */
const REAL_COMPOSER = readFileSync(
  path.resolve(__dirname, "fixtures/claude-code-2.1.228-composer.txt"),
  "utf8",
);

/**
 * The two chunks that bracket the hole issue 232 reports for claude-code, off
 * one live PTY capture of `claude` 2.1.235 taken while writing this fix (the
 * account name and project path are substituted; the transcript-saving warning
 * row is there because the capture was taken from inside another session).
 *
 * The timings are the point and they are not reconstructed — they come from
 * `script --log-timing` on that same run:
 *
 *   435 ms  the folder-trust dialog
 *  5051 ms  {@link CC_TRUST_ACK} — the dialog acknowledging the digit. Content,
 *           so a paint; no composer, so nothing is listening yet.
 *  5623 ms  {@link CC_COMPOSER} — the composer, 572 ms later.
 * 15635 ms  the `⏵⏵ … (shift+tab to cycle)` footer, ten seconds after that.
 *
 * The 350 ms quiet gap expires at 5401 ms. Everything this fix is about lives
 * in the 222 ms between there and 5623 ms, and no larger constant closes it
 * without taxing the boots that were already fine — the same run's dialog
 * appeared in 435 ms.
 */
const CC_TRUST_ACK = readFileSync(
  path.resolve(__dirname, "fixtures/claude-code-2.1.235-trust-ack.txt"),
  "utf8",
);

const CC_COMPOSER = readFileSync(
  path.resolve(__dirname, "fixtures/claude-code-2.1.235-composer.txt"),
  "utf8",
);

/**
 * cursor-agent's boot banner and its idle composer.
 *
 * **Provenance, and the two halves of it differ.** The composer is the real
 * screen: cursor-agent 2026.08.11-e8db854 — the same build as the trust fixture
 * — prints `→ Plan, search, build anything` when it is signed in and idle, and
 * {@link HARNESS_READINESS}'s marker matches it on 5 of 5 cold boots. That text
 * is committed as `fixtures/cursor-agent-2026.08.11-e8db854-composer.txt` and
 * read from there, so the marker is asserted against the screen rather than
 * against a literal written next to it.
 *
 * It is not a capture taken on this branch's machine, and the trust fixture
 * below arrived the same way (issue 177, PR #272): cursor-agent is installed
 * here at that build but stops at its sign-in screen without credentials, so
 * the text is the one quoted off a live signed-in install in the review of
 * PR #275. Being text rather than bytes, it carries no escape sequences — the
 * screen-clear below is this test's own scaffolding for "the TUI repainted",
 * not part of the capture.
 *
 * The boot banner is still synthesised from issue 232's description; nothing
 * asserts its bytes, only that no composer marker is anywhere on it.
 */
const CURSOR_BOOT =
  `${ESC}[2J${ESC}[H` +
  `  Cursor Agent 2026.08.11-e8db854\n` +
  `  /home/operator/projects/api\n` +
  `  Connecting…\n`;

const CURSOR_IDLE_COMPOSER =
  `${ESC}[2J${ESC}[H` +
  readFileSync(
    path.resolve(__dirname, "fixtures/cursor-agent-2026.08.11-e8db854-composer.txt"),
    "utf8",
  );

/**
 * cursor-agent 2026.08.11-e8db854's Workspace Trust screen, in a fresh
 * untrusted directory.
 *
 * **Provenance:** this is not a capture taken on this branch's machine —
 * cursor-agent is not installed there. It is the screen pasted into the
 * review of PR #272 by a reviewer who does have it installed and who took it
 * off a live PTY; the two lines ending `…` are elided in that paste, and it
 * carries no escape sequences because it arrived as text rather than as
 * bytes. It is committed anyway, because the one thing it settles it settles
 * conclusively and no amount of wording-independence in {@link
 * BLOCKING_DIALOGS} could have settled it: **the menu is letter-keyed.**
 *
 * `[a] Trust this workspace` / `[q] Quit` is a menu {@link readDialogOptions}
 * cannot read, because `OPTION_LINE` requires a digit followed by `.` or `)`.
 * So the entry that gives cursor-cli `folder-trust` makes the dialog
 * *recognised* — which is what routes it to the abandon path and a
 * `needs-input` Session instead of a prompt typed into a trust dialog — and it
 * does not make it *answerable*. Reading letter keys is issue #273.
 *
 * The synthesised numbered menu in the test above this one proves the digit
 * path works and is worth keeping; what it cannot do is stand in for this,
 * because it encodes an assumption about cursor-agent that this screen
 * contradicts.
 */
const CURSOR_TRUST_DIALOG = readFileSync(
  path.resolve(__dirname, "fixtures/cursor-agent-2026.08.11-folder-trust.txt"),
  "utf8",
);

/**
 * OpenCode 1.18.18's boot, up to the point where issue 229's prompt was lost —
 * captured byte-for-byte from a live PTY (only the project path substituted).
 *
 * Every chunk in it arrives inside the first 1.5 s, and the thing that makes it
 * worth keeping is what is *not* in it: after the capability probes and two
 * four-kilobyte frames, everything painted is whitespace. There is no composer,
 * no wordmark, no text of any kind — and then the harness says nothing at all
 * for the next four and a half seconds while the opencode server behind the
 * TUI starts. The quiet gap elapses in the middle of that hole.
 */
const OPENCODE_BOOT = readFileSync(
  path.resolve(__dirname, "fixtures/opencode-1.18.18-boot.txt"),
  "utf8",
);

/**
 * What that same session paints when it finally has a composer, ~4.4 s later:
 * the wordmark, the model footer, and `Ask anything... "<suggestion>"`.
 *
 * Typing before this frame is what issue 229 is: replayed live, text written at
 * 1.85 s never appeared, and the same text written after this frame echoed into
 * the composer and ran a turn.
 */
const OPENCODE_COMPOSER = readFileSync(
  path.resolve(__dirname, "fixtures/opencode-1.18.18-composer.txt"),
  "utf8",
);

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

describe("lastScreenClearIndex", () => {
  it("finds the clear that stripAnsi throws away", () => {
    const chunk = `stale dialog${ESC}[2J${ESC}[Hfresh`;
    expect(chunk.slice(lastScreenClearIndex(chunk))).toBe(`${ESC}[Hfresh`);
  });

  it("takes the last clear in a chunk that cleared twice", () => {
    const chunk = `a${ESC}[2Jb${ESC}[2Jc`;
    expect(chunk.slice(lastScreenClearIndex(chunk))).toBe("c");
  });

  it("counts home-then-erase-below, which is the same clear in two steps", () => {
    expect(lastScreenClearIndex(`${ESC}[H${ESC}[Jfresh`)).toBeGreaterThan(-1);
    expect(lastScreenClearIndex(`${ESC}[?1049h`)).toBeGreaterThan(-1);
  });

  it("counts a run of erase-line-and-go-up, which is how the real harness clears", () => {
    // Claude Code 2.1.228 never emits ED2. It walks back up the screen erasing
    // lines, and if that is not a clear then nothing it does ever is.
    const eraseUp = `${ESC}[2K${ESC}[1A`.repeat(8);
    expect(`stale dialog${eraseUp}fresh`.slice(lastScreenClearIndex(`stale dialog${eraseUp}fresh`))).toBe(
      "fresh",
    );
  });

  it("is not fooled by a line erase or a bare erase-below", () => {
    // Three erased lines is a status block repainting, not a screen going away.
    expect(lastScreenClearIndex(`${ESC}[2K${ESC}[1A`.repeat(3))).toBe(-1);
    // A spinner erases its own line every tick, and a composer erases below
    // the cursor. Treating either as a clear would make the Core forget a
    // dialog that is still on screen — the dangerous direction.
    expect(lastScreenClearIndex(spinnerFrame("⠋", 3))).toBe(-1);
    expect(lastScreenClearIndex(`${ESC}[0J`)).toBe(-1);
  });
});

describe("readDialogOptions", () => {
  it("reads a numbered menu through its highlight and cursor glyph", () => {
    expect(readDialogOptions(TRUST_DIALOG)).toEqual([
      { number: 1, label: "No, exit", highlighted: true },
      { number: 2, label: "Yes, proceed", highlighted: false },
    ]);
  });

  it("reads reverse video as the highlight even with no pointer glyph", () => {
    expect(readDialogOptions(`  1. No, exit\n${ESC}[7m  2. Yes, proceed${ESC}[0m`)).toEqual([
      { number: 1, label: "No, exit", highlighted: false },
      { number: 2, label: "Yes, proceed", highlighted: true },
    ]);
  });

  it("does not read a bullet or a dash as a selection", () => {
    expect(readDialogOptions("- 1. No, exit\n* 2. Yes, proceed")).toEqual([
      { number: 1, label: "No, exit", highlighted: false },
      { number: 2, label: "Yes, proceed", highlighted: false },
    ]);
  });

  it("takes the most recent paint of a repeated option", () => {
    expect(readDialogOptions("1. No, exit\n1. No, exit (still)")).toEqual([
      { number: 1, label: "No, exit (still)", highlighted: false },
    ]);
  });
});

describe("the harness as it really paints", () => {
  it("reads a menu laid out with column moves instead of spaces", () => {
    // Deleting the column moves the way every other escape is deleted yields
    // `1.Yes,Itrustthisfolder` — one word, and no menu at all.
    expect(readDialogOptions(REAL_TRUST_DIALOG)).toEqual([
      { number: 1, label: "Yes, I trust this folder", highlighted: true },
      { number: 2, label: "No, exit", highlighted: false },
    ]);
  });

  it("answers the real dialog by its label, where the affirmative is option 1", () => {
    const match = matchBlockingDialog(REAL_TRUST_DIALOG, dialogsForHarness("claude-code"))!;
    expect(match.spec.id).toBe("folder-trust");
    expect(match.answer).toEqual({
      number: 1,
      label: "Yes, I trust this folder",
      highlighted: true,
    });
  });

  it("does not see a dialog in the composer of a session already in bypass mode", () => {
    // The footer of a `--dangerously-skip-permissions` session reads
    // "⏵⏵ bypass permissions on", and the placeholder is `Try "how do I log an
    // error?"`. A `bypass permissions` + `?` rule matches that pair for the
    // whole life of the session, and holds delivery on a dialog that is not
    // there.
    expect(matchBlockingDialog(REAL_COMPOSER, dialogsForHarness("claude-code"))).toBeNull();
  });

  it("waits through the silence between the answered dialog and the composer", () => {
    // A replay of the observed live boot (claude-code 2.1.228):
    //   274 ms  terminal setup, no content
    //   286 ms  the folder-trust dialog
    //   636 ms  the quiet gap elapses and we press `1`
    //   707 ms  300 bytes of escapes acknowledging it — still no content
    //  1204 ms  the composer, after 497 ms of complete silence
    // A gap-only rule fires at 986 ms, into a screen that does not exist yet,
    // and the prompt is swallowed. This is the run that lost it.
    const h = startDelivery("ship it");
    h.clock.advance(274);
    h.delivery.onOutput(`${ESC}[?25l${ESC}[?2004h`);
    h.clock.advance(12);
    h.delivery.onOutput(REAL_TRUST_DIALOG);
    h.clock.advance(357);
    expect(h.writes).toEqual(["1"]);

    h.clock.advance(64);
    h.delivery.onOutput(`${ESC}[2K${ESC}[1A${ESC}[2K`);
    h.clock.advance(497);
    expect(h.writes).toEqual(["1"]);

    h.delivery.onOutput(REAL_COMPOSER);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["1", "ship it"]);
  });

  it("still delivers at the backstop if the harness draws nothing after the digit", () => {
    // The other side of that rule: waiting for a paint must not become a wait
    // that never ends. D8's ceiling still applies.
    const h = startDelivery("ship it");
    h.delivery.onOutput(REAL_TRUST_DIALOG);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["1"]);

    h.clock.advance(PROFILE.maxWaitMs + 1);
    expect(h.writes).toContain("ship it");
  });

  it("opens the quiet window on the harness's first byte, not on the spawn", () => {
    // Observed live: the first chunk arrives at 368 ms and is pure terminal
    // setup — no text, so no signature, so not a paint. Measuring the gap from
    // the spawn made that chunk look like a settled screen, and the prompt was
    // typed into the folder-trust dialog and lost.
    const h = startDelivery("ship it");
    h.clock.advance(2_000);
    h.delivery.onOutput(`${ESC}[?25l${ESC}[?2004h`);
    h.clock.advance(PROFILE.quietGapMs - 1);
    expect(h.writes).toEqual([]);

    h.delivery.onOutput(REAL_TRUST_DIALOG);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["1"]);
  });
});

describe("highlightIsOn", () => {
  const options = readDialogOptions(TRUST_DIALOG_SELECTED);
  const affirmative = options.find((o) => o.number === 2)!;

  it("is true only when the harness put its selection on that option", () => {
    expect(highlightIsOn(options, affirmative)).toBe(true);
    expect(highlightIsOn(readDialogOptions(TRUST_DIALOG), affirmative)).toBe(false);
  });

  it("is false when nothing is highlighted, and when everything is", () => {
    const none = readDialogOptions("  1. No, exit\n  2. Yes, proceed");
    expect(highlightIsOn(none, affirmative)).toBe(false);
    const all = readDialogOptions("❯ 1. No, exit\n❯ 2. Yes, proceed");
    expect(highlightIsOn(all, affirmative)).toBe(false);
  });
});

describe("chooseDialogOption", () => {
  const trust = BLOCKING_DIALOGS.find((d) => d.id === "folder-trust")!;

  it("picks the affirmative option and not the highlighted default", () => {
    // The observed default is `1. No, exit`, so "whatever is highlighted" and
    // "whatever is first" are both the wrong answer.
    expect(chooseDialogOption(readDialogOptions(TRUST_DIALOG), trust)).toMatchObject({
      number: 2,
      label: "Yes, proceed",
    });
  });

  it("picks by label even when the affirmative option is numbered first", () => {
    const flipped = "❯ 1. Yes, proceed\n  2. No, exit\n";
    expect(chooseDialogOption(readDialogOptions(flipped), trust)).toMatchObject({
      number: 1,
      label: "Yes, proceed",
    });
  });

  it("refuses a menu with no refusing option — that is not a trust dialog", () => {
    expect(
      chooseDialogOption([{ number: 1, label: "Yes, proceed", highlighted: false }], trust),
    ).toBeNull();
  });

  it("refuses an ambiguous menu rather than guessing", () => {
    const ambiguous = [
      { number: 1, label: "Yes, proceed", highlighted: false },
      { number: 2, label: "Yes, and remember this folder", highlighted: false },
      { number: 3, label: "No, exit", highlighted: true },
    ];
    expect(chooseDialogOption(ambiguous, trust)).toBeNull();
  });
});

describe("dialogsForHarness", () => {
  it("keeps Claude Code's bypass-permissions screen to Claude Code", () => {
    // That spec is a transcription of Claude Code's own warning screen, down
    // to the phrase `Bypass Permissions mode`. Applying it to a harness nobody
    // has observed would mean pressing a digit into another vendor's layout.
    expect(dialogsForHarness("claude-code").map((d) => d.id)).toEqual([
      "folder-trust",
      "bypass-permissions",
    ]);
    expect(dialogsForHarness("codex")).toEqual([]);
    expect(dialogsForHarness("opencode")).toEqual([]);
  });

  it("gives cursor-cli the folder-trust spec, and only that one (issue 177)", () => {
    // Finding 3: cursor-agent's trust prompt was never answered because the
    // matcher was scoped to a harness it is not. The entry it gets carries no
    // Claude-specific wording and, crucially, no Claude-specific *key* — the
    // digit comes off the menu on screen.
    expect(dialogsForHarness("cursor-cli").map((d) => d.id)).toEqual(["folder-trust"]);
  });
});

describe("cursor-agent's trust prompt (issue 177 finding 3)", () => {
  const specs = dialogsForHarness("cursor-cli");

  it("recognises a trust prompt worded differently from Claude Code's", () => {
    // Not a transcription of a screen anybody has observed — the point of the
    // assertion is that the matcher does not depend on one. `workspace` is a
    // noun Claude Code never uses, and the option order is reversed relative
    // to Claude's so a hard-coded `1` would be wrong here.
    const screen = [
      "Do you trust the files in this workspace?",
      "",
      "  1. No, exit",
      "❯ 2. Yes, I trust this workspace",
      "",
    ].join("\n");

    const match = matchBlockingDialog(screen, specs);
    expect(match?.spec.id).toBe("folder-trust");
    // The digit is read, not assumed. This is the exact failure the issue
    // warned a careless partial match would introduce.
    expect(match?.answer?.number).toBe(2);
    expect(match?.answer?.label).toContain("Yes");
  });

  it("answers nothing when the menu cannot be read", () => {
    // D5 unchanged: something is in the way and there is no confident way
    // past it, so `answer` is null and the caller must type nothing. That
    // path now ends in a `needs-input` Session rather than in silence.
    const screen = "Do you trust the files in this workspace?\n\n  [y/N]\n";
    const match = matchBlockingDialog(screen, specs);
    expect(match?.spec.id).toBe("folder-trust");
    expect(match?.answer).toBeNull();
  });

  it("does not fire on prose that merely contains the word trust", () => {
    const screen = "I do not trust this test to be meaningful without a menu.\n";
    expect(matchBlockingDialog(screen, specs)).toBeNull();
  });

  it("recognises the real trust screen and answers nothing on it", () => {
    // The fixture, not a synthesis. `matchBlockingDialog` fires — the widened
    // nouns catch `workspace` and `directory` — and `readDialogOptions` comes
    // back empty, because the menu offers `[a]` and `[q]` rather than `1.` and
    // `2.`. That combination is the whole of what this entry buys cursor-cli
    // today: the dialog is seen, so delivery abandons and the Session reports
    // `needs-input`; the dialog is not answered, and cannot be until
    // `readDialogOptions` learns letter keys (issue #273).
    const match = matchBlockingDialog(CURSOR_TRUST_DIALOG, specs);
    expect(match?.spec.id).toBe("folder-trust");
    expect(readDialogOptions(CURSOR_TRUST_DIALOG)).toEqual([]);
    expect(match?.answer).toBeNull();
  });

  it("replays the real screen into an abandoned delivery, writing nothing", () => {
    // What the entry is actually worth, end to end, on bytes rather than on a
    // description of them. Before this PR the same screen produced `settled` →
    // `delivered` and typed the prompt and a carriage return into the trust
    // dialog while reporting success; a `needs-input` Session is the honest
    // outcome and this is the test that holds the line at it.
    const h = startDelivery("refactor the picker", { harness: "cursor-cli" });
    h.delivery.onOutput(CURSOR_TRUST_DIALOG);
    h.clock.advance(PROFILE.maxWaitMs * 2);

    expect(h.writes).toEqual([]);
    expect(h.delivery.currentPhase).toBe("abandoned");
    expect(h.events).toContainEqual({ phase: "dialog-unreadable", dialog: "folder-trust" });
    expect(h.events.at(-1)).toEqual({ phase: "abandoned", reason: "blocked by folder-trust" });
    expect(h.events.some((e) => e.phase === "delivered")).toBe(false);
  });

  it("does not hand cursor-cli Claude Code's bypass-permissions screen", () => {
    const screen = [
      "Bypass Permissions mode",
      "Do you want to proceed?",
      "  1. No, exit",
      "  2. Yes, I accept",
    ].join("\n");
    // Nothing in the cursor-cli spec list matches it — that screen is Claude
    // Code's and stays Claude Code's.
    expect(matchBlockingDialog(screen, specs)?.spec.id).not.toBe("bypass-permissions");
  });
});

describe("matchBlockingDialog", () => {
  const specs = dialogsForHarness("claude-code");

  it("finds the folder-trust dialog and its answer", () => {
    const match = matchBlockingDialog(TRUST_DIALOG, specs)!;
    expect(match.spec.id).toBe("folder-trust");
    expect(match.answer).toEqual({ number: 2, label: "Yes, proceed", highlighted: false });
  });

  it("keeps the highlight, which stripAnsi would have dropped", () => {
    const match = matchBlockingDialog(TRUST_DIALOG_SELECTED, specs)!;
    expect(match.answer).toEqual({ number: 2, label: "Yes, proceed", highlighted: true });
    expect(match.options.find((o) => o.number === 1)!.highlighted).toBe(false);
  });

  it("finds the bypass-permissions warning behind auto mode", () => {
    const match = matchBlockingDialog(BYPASS_DIALOG, specs)!;
    expect(match.spec.id).toBe("bypass-permissions");
    expect(match.answer).toEqual({ number: 2, label: "Yes, I accept", highlighted: false });
  });

  it("does not fire on a ready composer", () => {
    expect(matchBlockingDialog(READY_SCREEN, specs)).toBeNull();
  });

  it("does not fire on prose that merely says the word", () => {
    const prose = "Loaded 3 trusted directories from settings. Ready?\n";
    expect(matchBlockingDialog(prose, specs)).toBeNull();
  });

  it("reports a dialog it cannot answer rather than reporting nothing", () => {
    const match = matchBlockingDialog(UNREADABLE_TRUST, specs)!;
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

    // Eight seconds of `loading …` is a harness that is painting *and* has no
    // composer yet, and after issue 232 either one on its own is enough to
    // hold. The composer is what ends the wait.
    h.delivery.onOutput(READY_SCREEN);
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

    h.delivery.onOutput(echoed("ship it"));
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

  it("confirms the selection once the harness has moved its highlight onto it", () => {
    const h = startDelivery("ship it");
    h.delivery.onOutput(TRUST_DIALOG);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["2"]);

    // The harness took the digit and moved the highlight to `2. Yes, proceed`.
    // Enter now means "confirm that", and it is the only Enter this module
    // will ever send into a dialog.
    h.delivery.onOutput(TRUST_DIALOG_SELECTED);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["2", "\r"]);
  });

  it("never confirms a dialog whose highlight did not move — that Enter is No, exit", () => {
    // The reviewer's repro for #191: repaint the *identical* dialog after the
    // digit. The harness did not take it, so the selection is still on
    // `❯ 1. No, exit` and an Enter here ends the session in three seconds.
    const h = startDelivery("ship it");
    h.delivery.onOutput(TRUST_DIALOG);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["2"]);

    h.delivery.onOutput(TRUST_DIALOG);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["2"]);
    expect(h.writes).not.toContain("\r");
    expect(h.events).toContainEqual({ phase: "dialog-unconfirmed", dialog: "folder-trust" });

    // It holds there and abandons with the dialog on screen, rather than
    // spending an Enter it cannot justify.
    h.clock.advance(PROFILE.maxWaitMs * 2);
    expect(h.writes).toEqual(["2"]);
    expect(h.delivery.currentPhase).toBe("abandoned");
    expect(h.events.at(-1)).toEqual({ phase: "abandoned", reason: "blocked by folder-trust" });
  });

  it("still confirms a harness that moves its highlight late", () => {
    const h = startDelivery("ship it");
    h.delivery.onOutput(TRUST_DIALOG);
    h.clock.advance(PROFILE.quietGapMs + 1);
    h.delivery.onOutput(TRUST_DIALOG);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["2"]);

    // Holding is not giving up: the confirm is still owed, and the moment the
    // screen justifies it, it goes out.
    h.delivery.onOutput(TRUST_DIALOG_SELECTED);
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
    h.delivery.onOutput(echoed("ship it"));
    h.clock.advance(submitPauseMs("ship it", PROFILE) + PROFILE.quietGapMs);
    expect(h.writes).toEqual(["2", "2", "ship it", "\r"]);
    expect(h.delivery.currentPhase).toBe("delivered");
  });

  it("delivers after an operator answers by hand the dialog it could not read", () => {
    // The reviewer's repro A for #191, and the recovery ADR 0026 D5 promises:
    // "a session parked on a visible dialog is one keystroke from an operator
    // being fine". The keystroke is not ours, so the only evidence the dialog
    // is gone is the harness clearing the screen to paint its composer.
    const h = startDelivery("ship it");
    h.delivery.onOutput(UNREADABLE_TRUST);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual([]);
    expect(h.events).toContainEqual({ phase: "dialog-unreadable", dialog: "folder-trust" });

    h.delivery.onOutput(READY_SCREEN);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["ship it"]);

    h.delivery.onOutput(echoed("ship it"));
    h.clock.advance(submitPauseMs("ship it", PROFILE) + PROFILE.quietGapMs);
    expect(h.writes).toEqual(["ship it", "\r"]);
    expect(h.delivery.currentPhase).toBe("delivered");
  });

  it("presses no menu digit into a composer whose dialog someone else answered", () => {
    // The reviewer's repro B for #191: the operator answers inside the quiet
    // gap, before this module has acted. A screen buffer that only *we* can
    // empty would still parse the stale menu and type `2` into the composer,
    // leaving `2ship it` to be submitted.
    const h = startDelivery("ship it");
    h.delivery.onOutput(TRUST_DIALOG);
    h.clock.advance(PROFILE.quietGapMs - 100);
    expect(h.writes).toEqual([]);

    h.delivery.onOutput(READY_SCREEN);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["ship it"]);
    expect(h.writes).not.toContain("2");

    h.delivery.onOutput(echoed("ship it"));
    h.clock.advance(submitPauseMs("ship it", PROFILE) + PROFILE.quietGapMs);
    expect(h.writes).toEqual(["ship it", "\r"]);
  });

  it("holds while the dialog is still on screen behind an unrelated repaint", () => {
    // The other half of tracking the screen honestly: output that does *not*
    // clear must not lose the dialog either. A spinner ticking under the menu
    // is not the menu going away.
    const h = startDelivery("ship it");
    h.delivery.onOutput(UNREADABLE_TRUST);
    spinFor(h, 2_000);
    expect(h.writes).toEqual([]);
    expect(h.delivery.currentPhase).toBe("answering");
    expect(h.events).toContainEqual({ phase: "dialog-unreadable", dialog: "folder-trust" });
  });

  it("types nothing at all into a dialog it cannot read", () => {
    const h = startDelivery("ship it");
    h.delivery.onOutput(UNREADABLE_TRUST);
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

// ─── readiness (issue 229) ───────────────────────────────────────────

describe("HARNESS_READINESS", () => {
  it("gates only the harnesses whose composer somebody has actually read", () => {
    // The table is still the ONLY thing that turns any of this on, and the
    // default is still the pre-229 path. What changed in issue 232 is which
    // harnesses have a row, not the rule for getting one: a screen has to have
    // been looked at. codex has not been, so it keeps the untouched path — and
    // that is a gap, not a clearance. See the table's own note.
    for (const harness of ["codex", "invented-tomorrow"]) {
      expect(readinessFor(harness)).toEqual({
        composer: [],
        confirmEcho: false,
        maxPromptWrites: 1,
      });
      // No markers means no gate: any screen at all counts as ready.
      expect(composerOnScreen("", readinessFor(harness))).toBe(true);
    }
    expect(Object.keys(HARNESS_READINESS).sort()).toEqual([
      "claude-code",
      "cursor-cli",
      "opencode",
    ]);
  });

  it("recognises opencode's composer, and only once it is really there", () => {
    const readiness = readinessFor("opencode");
    // The frames the prompt was lost into carry no composer — they are
    // whitespace and escape sequences, four seconds before the real screen.
    expect(composerOnScreen(OPENCODE_BOOT, readiness)).toBe(false);
    expect(composerOnScreen(OPENCODE_COMPOSER, readiness)).toBe(true);
  });

  it("recognises claude-code's composer on both captured builds", () => {
    // 2.1.228 in bypass mode and 2.1.235 in auto mode: two builds, two
    // permission modes, one placeholder. That is what makes `Try "` worth
    // gating on rather than a string one capture happened to contain.
    const readiness = readinessFor("claude-code");
    expect(composerOnScreen(REAL_COMPOSER, readiness)).toBe(true);
    expect(composerOnScreen(CC_COMPOSER, readiness)).toBe(true);
    // Neither of the screens that precede it counts, and the second one is the
    // whole bug: it is a paint, with content, 572 ms before there is anywhere
    // to type.
    expect(composerOnScreen(REAL_TRUST_DIALOG, readiness)).toBe(false);
    expect(composerOnScreen(CC_TRUST_ACK, readiness)).toBe(false);
  });

  it("does not gate claude-code on the footer that paints ten seconds late", () => {
    // `⏵⏵ … (shift+tab to cycle)` is on the composer screen and looks like a
    // fine marker until it is timed: in the same capture it arrived at
    // 15 635 ms, ten seconds behind the composer and past the 15 s backstop.
    // Gating on it would have delayed every prompt it was meant to protect.
    const readiness = readinessFor("claude-code");
    expect(composerOnScreen("⏵⏵ auto mode on (shift+tab to cycle)", readiness)).toBe(false);
  });

  it("recognises cursor-agent's idle composer and not its trust screen", () => {
    const readiness = readinessFor("cursor-cli");
    expect(composerOnScreen(CURSOR_IDLE_COMPOSER, readiness)).toBe(true);
    expect(composerOnScreen(CURSOR_BOOT, readiness)).toBe(false);
    // The trust screen is handled a step earlier, by the dialog table; this
    // asserts the two do not overlap into each other.
    expect(composerOnScreen(CURSOR_TRUST_DIALOG, readiness)).toBe(false);
  });
});

describe("promptEchoed", () => {
  it("finds the prompt however the composer wrapped and decorated it", () => {
    // OpenCode draws the composer inside a box, so the echo comes back with
    // borders and line breaks through it. Comparing the raw strings would
    // report a swallowed prompt on a prompt that landed perfectly.
    const wrapped = `${ESC}[2J${ESC}[H┃ refactor the auth ┃\n┃ module today      ┃\n`;
    expect(promptEchoed(wrapped, "refactor the auth module today")).toBe(true);
  });

  it("says nothing landed when the composer is still empty", () => {
    expect(promptEchoed(OPENCODE_COMPOSER, "say hello")).toBe(false);
  });

  it("counts a paste placeholder as the prompt having landed", () => {
    // A harness that renders `[Pasted text #1 +40 lines]` took the write and
    // deliberately does not echo it. Re-typing into that doubles the prompt.
    const pasted = "┃ [Pasted text #1 +40 lines] ┃\n";
    expect(promptEchoed(pasted, "Refactor the authentication module. ".repeat(40))).toBe(true);
  });

  it("does not re-type forever on a prompt with nothing to look for", () => {
    expect(promptEchoed("", "   ")).toBe(true);
  });
});

describe("delivering to opencode (issue 229)", () => {
  /**
   * The live boot, replayed at its captured timings:
   *
   *   1426 ms  capability probes — the first chunk with any content in it
   *   1493 ms  two four-kilobyte frames of pure whitespace
   *   1843 ms  the quiet gap elapses. THIS is where the prompt was typed.
   *   5915 ms  the composer, after 4.4 s of complete silence
   *
   * Verified against the real harness, not reasoned about: text written at
   * 1.85 s never reached the composer and no turn started, while the same text
   * written after the 5.9 s frame echoed and ran.
   */
  function bootOpencode(prompt: string): Fixture {
    const h = startDelivery(prompt, { harness: "opencode" });
    h.clock.advance(1_426);
    h.delivery.onOutput(OPENCODE_BOOT);
    return h;
  }

  it("does not type into the hole where the prompt used to be lost", () => {
    const h = bootOpencode("say hello");
    // Four and a half seconds of the harness saying nothing — thirteen times
    // the quiet gap, and far past the 1–1.4 s the Core used to report
    // `delivered` at.
    h.clock.advance(4_422);
    expect(h.writes).toEqual([]);
    expect(h.events).toContainEqual({ phase: "waiting-for-composer", waitedMs: 1_776 });
    // It says so once, not once per idle tick.
    expect(h.events.filter((e) => e.phase === "waiting-for-composer")).toHaveLength(1);
  });

  it("types as soon as the composer is really on screen", () => {
    const h = bootOpencode("say hello");
    h.clock.advance(4_422);
    h.delivery.onOutput(OPENCODE_COMPOSER);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["say hello"]);
    expect(h.events).toContainEqual({ phase: "settled", waitedMs: 6_198 });
  });

  it("holds the carriage return until the composer shows the prompt back", () => {
    const h = bootOpencode("say hello");
    h.clock.advance(4_422);
    h.delivery.onOutput(OPENCODE_COMPOSER);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["say hello"]);

    // The composer echoes it, exactly as the live session did.
    h.delivery.onOutput(`${ESC}[2J${ESC}[H┃ say hello ┃\n`);
    h.clock.advance(submitPauseMs("say hello", PROFILE) + PROFILE.quietGapMs);
    expect(h.writes).toEqual(["say hello", "\r"]);
    expect(h.delivery.currentPhase).toBe("delivered");
  });

  it("re-types rather than submitting into a composer the text never reached", () => {
    const h = bootOpencode("say hello");
    h.clock.advance(4_422);
    h.delivery.onOutput(OPENCODE_COMPOSER);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["say hello"]);

    // The write was swallowed: the harness re-paints its idle composer with
    // nothing in it. Submitting here is what made a Session look stillborn —
    // a `\r` into an empty composer, and a `delivered` line in the log.
    h.delivery.onOutput(OPENCODE_COMPOSER);
    h.clock.advance(submitPauseMs("say hello", PROFILE) + PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["say hello"]);
    expect(h.events).toContainEqual({ phase: "prompt-swallowed", attempt: 1 });

    // Going back to `settling` re-imposes the whole gate, so the second write
    // waits for a fresh paint rather than firing straight back at a TUI that
    // is demonstrably not listening.
    h.delivery.onOutput(OPENCODE_COMPOSER);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["say hello", "say hello"]);

    h.delivery.onOutput(`${ESC}[2J${ESC}[H┃ say hello ┃\n`);
    h.clock.advance(submitPauseMs("say hello", PROFILE) + PROFILE.quietGapMs);
    expect(h.writes).toEqual(["say hello", "say hello", "\r"]);
  });

  it("delivers at the backstop when the composer never appears", () => {
    // The marker is a transcription of one version's screen. If opencode
    // rewords it — or an operator runs it in another language — delivery must
    // degrade to late, never to lost.
    const h = bootOpencode("say hello");
    // Up to the backstop and one millisecond past it — the boot replay has
    // already spent 1 426 ms of the ceiling.
    h.clock.advance(PROFILE.maxWaitMs - 1_426 + 1);
    expect(h.writes).toEqual(["say hello"]);
    h.clock.advance(submitPauseMs("say hello", PROFILE) + 1);
    expect(h.writes).toEqual(["say hello", "\r"]);
    expect(h.delivery.currentPhase).toBe("delivered");
  });

  it("stops re-typing rather than filling the composer with copies", () => {
    const h = bootOpencode("say hello");
    h.clock.advance(4_422);
    // A composer that takes the text and never shows it would otherwise be a
    // loop. Three writes is the budget, and the backstop closes it out.
    for (let i = 0; i < 12; i += 1) {
      h.delivery.onOutput(OPENCODE_COMPOSER);
      h.clock.advance(PROFILE.quietGapMs + submitPauseMs("say hello", PROFILE) + 1);
    }
    h.clock.advance(PROFILE.maxWaitMs);
    expect(h.writes.filter((w) => w === "say hello")).toHaveLength(3);
    expect(h.writes.at(-1)).toBe("\r");
  });
});

// ─── the same race, two more harnesses (issue 232) ───────────────────

describe("delivering to claude-code (issue 232)", () => {
  /**
   * The live capture, replayed at its measured timings. See {@link CC_TRUST_ACK}.
   *
   * The dialog itself is skipped deliberately: answering it is issue 191's
   * sequence and is covered above, and replaying it here would put the
   * assertions about *this* bug behind five unrelated ones. What matters is the
   * state the harness is in at 5051 ms — a screen that has just painted, with
   * no composer on it — and that is what this sets up.
   */
  function bootClaudeCode(prompt: string): Fixture {
    const h = startDelivery(prompt, { harness: "claude-code" });
    h.clock.advance(5_051);
    h.delivery.onOutput(CC_TRUST_ACK);
    return h;
  }

  it("types nothing into the 572 ms hole the capture measured", () => {
    const h = bootClaudeCode("say hello");
    // Straight to 5623 ms — the instant the composer really arrived. Before
    // this fix the quiet gap fired at 5401 ms and the prompt went out here,
    // into a harness with no input reader attached, and was never seen again.
    h.clock.advance(572);
    expect(h.writes).toEqual([]);
    expect(h.events).toContainEqual({ phase: "waiting-for-composer", waitedMs: 5_401 });
    // Once per settling round, not once per idle tick.
    expect(h.events.filter((e) => e.phase === "waiting-for-composer")).toHaveLength(1);
  });

  it("types as soon as the composer is really on screen", () => {
    const h = bootClaudeCode("say hello");
    h.clock.advance(572);
    h.delivery.onOutput(CC_COMPOSER);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["say hello"]);
    expect(h.events).toContainEqual({ phase: "settled", waitedMs: 5_973 });
  });

  it("re-types rather than submitting into a composer that swallowed the write", () => {
    const h = bootClaudeCode("say hello");
    h.clock.advance(572);
    h.delivery.onOutput(CC_COMPOSER);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["say hello"]);

    // The field signature, exactly: the harness repaints its idle composer with
    // the text nowhere on it. A `\r` here is the Core reporting a delivery that
    // did not happen, and it is what left a Session in `ready` for 46 minutes.
    h.delivery.onOutput(CC_COMPOSER);
    h.clock.advance(submitPauseMs("say hello", PROFILE) + PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["say hello"]);
    expect(h.writes).not.toContain("\r");
    expect(h.events).toContainEqual({ phase: "prompt-swallowed", attempt: 1 });
    expect(h.delivery.currentPhase).toBe("settling");
  });

  it("submits once the composer shows the prompt back", () => {
    const h = bootClaudeCode("say hello");
    h.clock.advance(572);
    h.delivery.onOutput(CC_COMPOSER);
    h.clock.advance(PROFILE.quietGapMs + 1);
    h.delivery.onOutput(echoed("say hello"));
    h.clock.advance(submitPauseMs("say hello", PROFILE) + PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["say hello", "\r"]);
    expect(h.delivery.currentPhase).toBe("delivered");
  });

  it("delivers late rather than never if the placeholder is ever reworded", () => {
    // The failure this fix is allowed to have. A build whose composer says
    // something else stops matching, and the backstop — not the marker — is
    // what guarantees the prompt still goes out.
    const h = bootClaudeCode("say hello");
    h.clock.advance(PROFILE.maxWaitMs);
    expect(h.writes).toEqual(["say hello", "\r"]);
    expect(h.delivery.currentPhase).toBe("delivered");
  });
});

describe("delivering to cursor-cli (issue 232)", () => {
  /**
   * The three back-to-back Sessions in the issue settled at 3.1 s, 1.6 s and
   * 2.5 s, and only the 1.6 s one lost its prompt. So the boot is parameterised
   * by how long the TUI takes to paint its composer, and the same delivery is
   * driven through a fast boot and a slow one: the distinction the old code
   * could not draw is exactly that one.
   */
  function bootCursor(prompt: string, composerAtMs: number): Fixture {
    const h = startDelivery(prompt, { harness: "cursor-cli" });
    h.clock.advance(1_250);
    h.delivery.onOutput(CURSOR_BOOT);
    h.clock.advance(composerAtMs - 1_250);
    h.delivery.onOutput(CURSOR_IDLE_COMPOSER);
    return h;
  }

  it("types nothing at the 1.6 s settle that swallowed the prompt", () => {
    const h = startDelivery("say hello", { harness: "cursor-cli" });
    h.clock.advance(1_250);
    h.delivery.onOutput(CURSOR_BOOT);
    // 1600 ms: the settle the issue timed on the run that failed. The screen is
    // genuinely quiet and genuinely not ready, and telling those apart is the
    // whole of this fix — no quiet window can, because the run that settled at
    // 2.5 s went down the identical path and worked.
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.clock.time).toBe(1_601);
    expect(h.writes).toEqual([]);
    expect(h.events).toContainEqual({ phase: "waiting-for-composer", waitedMs: 1_600 });
  });

  it("delivers on a slow boot and on a fast one, with no timing in the answer", () => {
    // 4 s is well past every settle in the issue's sample; 1.4 s is faster than
    // the run that failed. Both deliver, and neither waits on a constant.
    for (const composerAt of [1_400, 4_000]) {
      const h = bootCursor("say hello", composerAt);
      h.clock.advance(PROFILE.quietGapMs + 1);
      expect(h.writes).toEqual(["say hello"]);
      expect(h.events).toContainEqual({
        phase: "settled",
        waitedMs: composerAt + PROFILE.quietGapMs,
      });

      h.delivery.onOutput(echoed("say hello"));
      h.clock.advance(submitPauseMs("say hello", PROFILE) + PROFILE.quietGapMs + 1);
      expect(h.writes).toEqual(["say hello", "\r"]);
    }
  });

  it("holds through a TUI that boots far slower than any pause would allow", () => {
    // Ten seconds of nothing after the banner: two thirds of the backstop, and
    // twenty-eight times the quiet gap. Not one byte goes out.
    const h = startDelivery("say hello", { harness: "cursor-cli" });
    h.clock.advance(1_250);
    h.delivery.onOutput(CURSOR_BOOT);
    h.clock.advance(10_000);
    expect(h.writes).toEqual([]);

    h.delivery.onOutput(CURSOR_IDLE_COMPOSER);
    h.clock.advance(PROFILE.quietGapMs + 1);
    expect(h.writes).toEqual(["say hello"]);
  });

  it("still abandons on the trust screen instead of typing into it (issue 177)", () => {
    // Readiness is checked *after* the dialog table, so nothing here weakens
    // what #272 bought: cursor-agent's letter-keyed menu is unreadable, the
    // answer is null, and delivery abandons rather than typing the prompt into
    // the dialog and reporting success.
    const h = startDelivery("say hello", { harness: "cursor-cli" });
    h.delivery.onOutput(CURSOR_TRUST_DIALOG);
    h.clock.advance(PROFILE.maxWaitMs * 2);
    expect(h.writes).toEqual([]);
    expect(h.delivery.currentPhase).toBe("abandoned");
    expect(h.events.at(-1)).toEqual({ phase: "abandoned", reason: "blocked by folder-trust" });
  });
});
