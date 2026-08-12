// Prompt delivery — how a starting prompt reaches a harness TUI that was
// spawned a millisecond ago.
//
// This is a Core responsibility and not a client one (ADR 0026). A Panel, the
// `actana` CLI and an SDK automation all send the same thing — a string — and
// none of them knows which harness is on the other end, what it paints while
// it boots, or which dialog it opens first. The Core does, because the Core is
// the machine the harness runs on, and CONTEXT.md is explicit that differences
// between harnesses live inside the Core process.
//
// What replaced what: a flat 450 ms timer armed on the first byte of output.
// It lost prompts for three separate observed reasons, and the sequence below
// answers them one at a time.
//
//   1. WAIT FOR THE PAINTING TO STOP. Not for silence — a harness spinner
//      redraws forever, so "no output at all" never arrives. The signal is a
//      gap between *substantive* redraws: chunks whose content, normalised for
//      the spinner glyph and its ticking elapsed-time counter, say something
//      the previous chunks did not. See `redrawSignature`.
//
//   2. ANSWER THE BLOCKING DIALOG DELIBERATELY. Claude Code's folder-trust
//      dialog highlights a default that *exits the harness*, so an Enter typed
//      into it is not a no-op — it is the end of the session, in under three
//      seconds, before the harness has done anything. This module therefore
//      never presses Enter to get past a dialog. It reads the menu off the
//      screen, finds the option whose label means "go ahead", and presses that
//      option's own number. If it cannot read the menu it presses nothing at
//      all and lets the operator finish the dialog by hand — a session waiting
//      on a visible dialog is recoverable, a session that answered it wrong is
//      gone.
//
//   3. SUBMIT AS A SEPARATE KEYSTROKE, AFTER THE PASTE SETTLES. Text long
//      enough to arrive as a burst is treated as a paste: the harness renders
//      `[Pasted text #1 +N lines]` and swallows a `\r` that rides in behind
//      it. So the carriage return is its own write, after a pause that scales
//      with the length of the prompt *and* after the echo has stopped
//      repainting.
//
// Everything here is driven by injected timers so the sequence is testable
// without sleeping: see `harness-prompt-delivery.test.ts`.

import type { Harness } from "@actana/shared/domain";

// ─── Screen reading ──────────────────────────────────────────────────

// CSI/OSC/two-byte escapes. The PTY stream is a terminal program's output, so
// most of every chunk is cursor movement and colour, and none of it is content.
const ANSI = new RegExp(
  [
    "\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)", // OSC … BEL / ST
    "\\u001B\\[[0-?]*[ -/]*[@-~]", // CSI
    "\\u001B[@-Z\\\\-_0-9=><]", // two-byte escapes (ESC 7 / ESC 8 included)
  ].join("|"),
  "g",
);

/** Spinner frames — the glyphs a harness cycles while it is busy. */
const SPINNER_GLYPHS = /[⠀-⣿◐-◓◜-◟✻✽✳✢·•∴⋆]/g;

/** The rendered screen, minus the escape sequences that drew it. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "").replace(/\r/g, "\n");
}

/**
 * What a chunk of output *says*, with the parts that change on their own
 * removed.
 *
 * Two consecutive spinner frames differ — a different braille glyph, a
 * different elapsed-second count, a token meter that moved — while saying
 * nothing new. Normalising the glyph away and flattening every run of digits to
 * a single `0` collapses them onto one signature, which is what lets
 * {@link HarnessPromptDelivery} tell a TUI that is still painting from one that
 * is merely still alive.
 *
 * The digit rule is deliberate and it is the whole trick: **a line on which
 * only a counter changed is a tick, not a paint.** An elapsed timer, a spinner,
 * a token count and a percentage all move on their own and none of them means
 * the layout is still settling.
 *
 * An empty signature means the chunk was pure cursor movement.
 */
export function redrawSignature(chunk: string): string {
  return stripAnsi(chunk)
    .replace(SPINNER_GLYPHS, "")
    .replace(/\d+/g, "0")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Blocking dialogs ────────────────────────────────────────────────

/**
 * One dialog a harness can open before it will accept typing.
 *
 * The family of harnesses is open (CONTEXT.md), so this is a table with a
 * default and not a switch: an entry with no `harnesses` applies to every
 * harness, including ones that do not exist yet.
 */
export type BlockingDialogSpec = {
  id: string;
  /** Harnesses this dialog belongs to; absent means all of them. */
  harnesses?: readonly string[];
  /** Every pattern must appear on screen for the dialog to be considered up. */
  match: readonly RegExp[];
  /** The option label that means "go ahead". */
  affirmative: RegExp;
  /** Labels that must never be chosen, whatever else they match. */
  refuse: RegExp;
};

export type DialogOption = { number: number; label: string };

export type BlockingDialogMatch = {
  spec: BlockingDialogSpec;
  /**
   * The option to press, or `null` when the dialog is up but its menu could
   * not be read. `null` is not "carry on" — it is "stop, and do not type into
   * this".
   */
  answer: DialogOption | null;
};

/**
 * The dialogs the Core knows how to get past.
 *
 * Both entries are the same shape and the same danger: the highlighted default
 * is the destructive one. Claude Code's folder-trust prompt defaults to
 * declining and *exiting*, and its bypass-permissions warning — the screen a
 * session launched with `--dangerously-skip-permissions` lands on — does the
 * same. Auto mode on its own survives, because nothing types into it; a prompt
 * on its own survives, because there is no dialog in the way. The two together
 * were what died, and this table is why they no longer do.
 */
export const BLOCKING_DIALOGS: readonly BlockingDialogSpec[] = [
  {
    id: "folder-trust",
    match: [/\btrust\b/i, /\b(folder|directory|files)\b/i, /\?/],
    affirmative: /\b(yes|proceed|trust|allow)\b/i,
    refuse: /\b(no|exit|quit|cancel|deny)\b/i,
  },
  {
    id: "bypass-permissions",
    match: [/bypass\s+permissions/i, /\?/],
    affirmative: /\b(yes|accept|proceed|continue)\b/i,
    refuse: /\b(no|exit|quit|cancel)\b/i,
  },
];

// `❯ 2. Yes, proceed` / `2) Yes, proceed` / `  2. No, exit`
const OPTION_LINE = /^[\s>❯➤→*·-]*(\d{1,2})[.)]\s+(\S.*?)\s*$/;

/**
 * Read a numbered menu off a screen.
 *
 * The screen is a scrollback of repaints, so the same dialog appears several
 * times over; the last paint of each option number wins, because that is the
 * one the operator would be looking at.
 */
export function readDialogOptions(screen: string): DialogOption[] {
  const byNumber = new Map<number, string>();
  for (const line of stripAnsi(screen).split("\n")) {
    const m = OPTION_LINE.exec(line);
    if (!m) continue;
    byNumber.set(Number(m[1]), m[2]!);
  }
  return [...byNumber.entries()]
    .map(([number, label]) => ({ number, label }))
    .sort((a, b) => a.number - b.number);
}

/**
 * Which option means "go ahead", or `null` when the menu does not offer an
 * unambiguous one.
 *
 * A menu qualifies only when it offers *both* an affirmative option and one
 * that refuses. That pairing is what distinguishes a real dialog from a
 * harness that merely printed the word "trust" in a paragraph of prose, and it
 * is the structural half of not answering a dialog by guessing.
 */
export function chooseDialogOption(
  options: readonly DialogOption[],
  spec: BlockingDialogSpec,
): DialogOption | null {
  const affirmative = options.filter(
    (o) => spec.affirmative.test(o.label) && !spec.refuse.test(o.label),
  );
  const refusing = options.filter((o) => spec.refuse.test(o.label));
  if (affirmative.length !== 1 || refusing.length === 0) return null;
  return affirmative[0]!;
}

/** The dialogs that apply to one harness, in table order. */
export function dialogsForHarness(harness: string): BlockingDialogSpec[] {
  return BLOCKING_DIALOGS.filter(
    (spec) => !spec.harnesses || spec.harnesses.includes(harness),
  );
}

/**
 * The blocking dialog currently on screen, if any.
 *
 * A non-null result with `answer: null` is the deliberately awkward case: the
 * Core is confident something is in the way and has no confident way past it.
 * The caller must not type into that.
 */
export function matchBlockingDialog(
  screen: string,
  specs: readonly BlockingDialogSpec[],
): BlockingDialogMatch | null {
  const text = stripAnsi(screen);
  for (const spec of specs) {
    if (!spec.match.every((pattern) => pattern.test(text))) continue;
    return { spec, answer: chooseDialogOption(readDialogOptions(text), spec) };
  }
  return null;
}

// ─── Timing ──────────────────────────────────────────────────────────

export type PromptDeliveryProfile = {
  /**
   * How long a gap between substantive redraws counts as "the TUI has finished
   * painting". Not a delay before delivery — a window that every paint
   * restarts, so a harness that takes eight seconds to boot gets eight seconds
   * and one that is ready in two hundred milliseconds is not made to wait.
   */
  quietGapMs: number;
  /**
   * The backstop. A harness that never stops repainting still gets its prompt,
   * because losing it is worse than delivering it a beat early — with one
   * exception, which is that a dialog on screen at the deadline abandons
   * delivery instead (see {@link HarnessPromptDelivery}).
   */
  maxWaitMs: number;
  /** The floor on the gap between the prompt and its carriage return. */
  submitBaseMs: number;
  /** Added per character of prompt: the longer the paste, the longer the wait. */
  submitPerCharMs: number;
  /** The ceiling on that scaling. */
  submitMaxMs: number;
  /** How many keystrokes this module will spend getting past dialogs. */
  maxDialogKeystrokes: number;
};

export const DEFAULT_PROMPT_DELIVERY_PROFILE: PromptDeliveryProfile = {
  quietGapMs: 350,
  maxWaitMs: 15_000,
  submitBaseMs: 150,
  submitPerCharMs: 2,
  submitMaxMs: 3_000,
  maxDialogKeystrokes: 6,
};

/**
 * Per-harness timing overrides.
 *
 * Empty on purpose: every harness observed so far settles under the same
 * rules, and the profile is the *shape* of the knowledge, not a place to park
 * guesses. What differs between harnesses today is which dialogs they open,
 * and that lives in {@link BLOCKING_DIALOGS}. This table is where a harness
 * that genuinely needs different timing goes, so that finding one does not
 * mean redesigning anything.
 */
export const HARNESS_PROMPT_DELIVERY_PROFILES: Partial<
  Record<Harness, Partial<PromptDeliveryProfile>>
> = {};

export function deliveryProfileFor(harness: string): PromptDeliveryProfile {
  const override = HARNESS_PROMPT_DELIVERY_PROFILES[harness as Harness];
  return override
    ? { ...DEFAULT_PROMPT_DELIVERY_PROFILE, ...override }
    : DEFAULT_PROMPT_DELIVERY_PROFILE;
}

/**
 * How long to wait between the prompt and its carriage return.
 *
 * Scales with the length of the text because that is what decides whether the
 * harness treats the write as typing or as a paste, and a paste it is still
 * rendering swallows the `\r`. This is a floor, not the whole wait: delivery
 * also requires the echo to have stopped repainting.
 */
export function submitPauseMs(text: string, profile: PromptDeliveryProfile): number {
  const scaled = profile.submitBaseMs + text.length * profile.submitPerCharMs;
  return Math.min(profile.submitMaxMs, Math.max(profile.submitBaseMs, scaled));
}

// ─── The sequence ────────────────────────────────────────────────────

export type PromptDeliveryPhase =
  /** Watching the boot paint, waiting for a gap. */
  | "settling"
  /** A dialog is up and we are working through it. */
  | "answering"
  /** The prompt is written; waiting to send the carriage return. */
  | "typing"
  /** The carriage return went out. */
  | "delivered"
  /** Gave up without typing anything. The session is alive and untouched. */
  | "abandoned";

export type PromptDeliveryEvent =
  | { phase: "settled"; waitedMs: number }
  | { phase: "dialog"; dialog: string; option: number; label: string }
  | { phase: "dialog-unreadable"; dialog: string }
  | { phase: "delivered"; waitedMs: number; promptChars: number; submitPauseMs: number }
  | { phase: "abandoned"; reason: string };

export type PromptDeliveryTimers = {
  now: () => number;
  /** Returns a cancel function. */
  setTimer: (fn: () => void, ms: number) => () => void;
};

const REAL_TIMERS: PromptDeliveryTimers = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
};

export type PromptDeliveryOptions = {
  harness: string;
  /** The prompt, already sanitised of control characters by the caller. */
  prompt: string;
  /** Writes to the PTY. Must swallow "already exited". */
  write: (data: string) => void;
  onEvent?: (event: PromptDeliveryEvent) => void;
  profile?: PromptDeliveryProfile;
  timers?: PromptDeliveryTimers;
};

/** How much recent screen to keep for dialog matching. */
const SCREEN_WINDOW_CHARS = 8_000;
/** How many recent redraw signatures count as "we have seen this frame". */
const SIGNATURE_RING = 6;

/**
 * Delivers one starting prompt to one harness, driven by that harness's own
 * output.
 *
 * Feed it every chunk from the PTY and dispose it when the PTY exits. It
 * writes to the PTY at most: one digit and one carriage return per dialog, the
 * prompt, and the prompt's carriage return.
 */
export class HarnessPromptDelivery {
  private readonly profile: PromptDeliveryProfile;
  private readonly timers: PromptDeliveryTimers;
  private readonly specs: BlockingDialogSpec[];
  private readonly startedAt: number;

  private phase: PromptDeliveryPhase = "settling";
  private screen = "";
  private recentSignatures: string[] = [];
  private lastPaintAt: number;
  private sawOutput = false;
  private submitAt = 0;
  private dialogKeystrokes = 0;
  /** Set when the dialog's own number went out and the confirm may still be due. */
  private pendingConfirm: string | null = null;
  private answeringDialogId: string | null = null;
  private deadlinePassed = false;

  private cancelIdle: (() => void) | null = null;
  private cancelDeadline: (() => void) | null = null;

  constructor(private readonly opts: PromptDeliveryOptions) {
    this.profile = opts.profile ?? deliveryProfileFor(opts.harness);
    this.timers = opts.timers ?? REAL_TIMERS;
    this.specs = dialogsForHarness(opts.harness);
    this.startedAt = this.timers.now();
    this.lastPaintAt = this.startedAt;
    this.cancelDeadline = this.timers.setTimer(
      () => this.onDeadline(),
      this.profile.maxWaitMs,
    );
  }

  /** Every chunk the PTY produced, in order. */
  onOutput(chunk: string): void {
    if (this.finished) return;
    this.sawOutput = true;
    this.screen = (this.screen + chunk).slice(-SCREEN_WINDOW_CHARS);

    const signature = redrawSignature(chunk);
    const painted = signature !== "" && !this.recentSignatures.includes(signature);
    if (signature !== "") {
      this.recentSignatures.push(signature);
      if (this.recentSignatures.length > SIGNATURE_RING) this.recentSignatures.shift();
    }
    if (painted) this.lastPaintAt = this.timers.now();
    this.schedule();
  }

  /** The PTY is gone, or the caller is done with us. Writes nothing further. */
  dispose(): void {
    this.cancelIdle?.();
    this.cancelIdle = null;
    this.cancelDeadline?.();
    this.cancelDeadline = null;
    if (!this.finished) this.phase = "abandoned";
  }

  /** Exposed for tests and for logging; not a control surface. */
  get currentPhase(): PromptDeliveryPhase {
    return this.phase;
  }

  private get finished(): boolean {
    return this.phase === "delivered" || this.phase === "abandoned";
  }

  // The one timer. Re-armed on every paint and after every keystroke we send,
  // so "quiet" is always measured from the last thing that actually happened.
  private schedule(): void {
    if (this.finished || !this.sawOutput) return;
    const now = this.timers.now();
    const quietAt = this.deadlinePassed ? 0 : this.lastPaintAt + this.profile.quietGapMs;
    const floorAt = this.phase === "typing" ? this.submitAt : 0;
    const at = Math.max(quietAt, floorAt);
    this.cancelIdle?.();
    this.cancelIdle = this.timers.setTimer(() => this.onIdle(), Math.max(0, at - now));
  }

  private onIdle(): void {
    this.cancelIdle = null;
    if (this.finished) return;
    const now = this.timers.now();
    if (!this.deadlinePassed && now - this.lastPaintAt < this.profile.quietGapMs) {
      this.schedule();
      return;
    }
    if (this.phase === "typing") {
      if (now < this.submitAt) {
        this.schedule();
        return;
      }
      this.submit(now);
      return;
    }
    this.onQuiet();
  }

  /** The harness stopped painting. Decide what is on screen and act on it. */
  private onQuiet(): void {
    const dialog = matchBlockingDialog(this.screen, this.specs);

    if (this.phase === "answering" && !dialog) {
      // Whatever we pressed cleared it. Back to watching the paint that
      // answering caused — which has just gone quiet, so carry straight on.
      this.phase = "settling";
      this.answeringDialogId = null;
      this.pendingConfirm = null;
    }

    if (dialog) {
      this.handleDialog(dialog);
      return;
    }

    this.emit({ phase: "settled", waitedMs: this.timers.now() - this.startedAt });
    this.writePrompt();
  }

  private handleDialog(dialog: BlockingDialogMatch): void {
    if (!dialog.answer) {
      // Something is in the way and the menu did not parse. Never guess: an
      // Enter here is the keystroke that exits the harness. Hold, and let the
      // deadline abandon delivery with the dialog still on screen for whoever
      // is watching.
      if (this.answeringDialogId !== dialog.spec.id) {
        this.emit({ phase: "dialog-unreadable", dialog: dialog.spec.id });
      }
      this.answeringDialogId = dialog.spec.id;
      this.phase = "answering";
      return;
    }

    if (this.dialogKeystrokes >= this.profile.maxDialogKeystrokes) {
      this.abandon(`dialog ${dialog.spec.id} did not clear`);
      return;
    }

    // Same dialog still up after its number went out: some harnesses select on
    // the digit, others want the digit confirmed. Send the confirm now — the
    // selection is already on the safe option, so this Enter cannot be the one
    // that exits. The id has to match: a *second* dialog behind the first (the
    // bypass-permissions warning behind folder-trust) is a fresh menu whose
    // highlighted default is dangerous again, and a stale confirm would be
    // exactly the Enter this module exists not to send.
    if (
      this.phase === "answering" &&
      this.answeringDialogId === dialog.spec.id &&
      this.pendingConfirm
    ) {
      const confirm = this.pendingConfirm;
      this.pendingConfirm = null;
      this.press(confirm);
      return;
    }

    this.phase = "answering";
    this.answeringDialogId = dialog.spec.id;
    this.pendingConfirm = "\r";
    this.emit({
      phase: "dialog",
      dialog: dialog.spec.id,
      option: dialog.answer.number,
      label: dialog.answer.label,
    });
    this.press(String(dialog.answer.number));
  }

  /**
   * Send a keystroke and start reading the screen again from scratch — the
   * scrollback still holds the dialog we just answered, and matching against
   * it would answer the same dialog forever.
   */
  private press(keys: string): void {
    this.dialogKeystrokes += 1;
    this.screen = "";
    this.recentSignatures = [];
    this.opts.write(keys);
    this.lastPaintAt = this.timers.now();
    this.schedule();
  }

  private writePrompt(): void {
    this.phase = "typing";
    this.screen = "";
    this.recentSignatures = [];
    this.opts.write(this.opts.prompt);
    const now = this.timers.now();
    this.lastPaintAt = now;
    this.submitAt = now + submitPauseMs(this.opts.prompt, this.profile);
    this.schedule();
  }

  private submit(now: number): void {
    this.opts.write("\r");
    this.phase = "delivered";
    this.cancelIdle?.();
    this.cancelIdle = null;
    this.cancelDeadline?.();
    this.cancelDeadline = null;
    this.emit({
      phase: "delivered",
      waitedMs: now - this.startedAt,
      promptChars: this.opts.prompt.length,
      submitPauseMs: submitPauseMs(this.opts.prompt, this.profile),
    });
  }

  private onDeadline(): void {
    this.cancelDeadline = null;
    if (this.finished) return;
    this.deadlinePassed = true;

    // The prompt is already in the composer; the carriage return has to land
    // whatever the screen is doing, or the operator is left with typed-but-
    // unsent text.
    if (this.phase === "typing") {
      this.schedule();
      return;
    }

    // A dialog at the deadline is the one case where delivering is worse than
    // not: the prompt would be typed into a menu whose highlighted default
    // exits the harness. Leave it for a human.
    const dialog = matchBlockingDialog(this.screen, this.specs);
    if (dialog) {
      this.abandon(`blocked by ${dialog.spec.id}`);
      return;
    }

    this.sawOutput = true;
    this.schedule();
  }

  private abandon(reason: string): void {
    this.phase = "abandoned";
    this.cancelIdle?.();
    this.cancelIdle = null;
    this.cancelDeadline?.();
    this.cancelDeadline = null;
    this.emit({ phase: "abandoned", reason });
  }

  private emit(event: PromptDeliveryEvent): void {
    try {
      this.opts.onEvent?.(event);
    } catch {
      /* a logging sink must never break delivery */
    }
  }
}
