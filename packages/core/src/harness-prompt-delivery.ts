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
//      gone. The one Enter it will send is the confirm behind a digit, and
//      only once the harness has moved its highlight onto the option that
//      digit chose: an Enter is justified by what is on screen or not at all.
//
//      Which means the screen has to be tracked honestly. The buffer here is
//      an approximation of a terminal, and the one thing it must not do is go
//      on believing in a dialog that is no longer displayed — an operator who
//      answers by hand, or a harness that dismisses its own dialog, both leave
//      by way of a full-screen clear. See `lastScreenClearIndex`.
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

/**
 * Sequences after which nothing painted before them is on screen any more.
 *
 * `stripAnsi` throws these away with every other escape, which is right for
 * reading text and wrong for deciding what is *currently* displayed — so
 * {@link lastScreenClearIndex} looks for them in the raw chunk first.
 *
 * `ESC[2J` / `ESC[3J` erase the display; the alternate-screen switches swap
 * the whole buffer out; `ESC[H` with `ESC[J` straight after it is the same
 * clear written in two steps; and a long run of erase-line-and-go-up is that
 * clear written by a TUI that never emits ED2 at all, which is what Claude
 * Code 2.1.228 does. A bare `ESC[0J` is *not* in the list: it
 * erases from wherever the cursor happens to be, and treating it as a clear
 * would let the Core forget a dialog that is still on screen — the one error
 * worse than remembering one that is gone.
 */
const SCREEN_CLEAR = new RegExp(
  [
    "\\u001B\\[[23]J", // ED2 / ED3 — erase the display
    "\\u001B\\[\\?(?:47|1047|1049)[hl]", // the alternate screen, in and out
    "\\u001B\\[(?:1;1)?H\\u001B\\[0?J", // home, then erase everything below it
    // A run of line-erases walking back up the screen: how Claude Code 2.1.228
    // actually clears, since it never emits ED2 at all. Five is well past any
    // incremental repaint — a spinner erases one line, a status block a few —
    // and the frame that replaces it arrives after the run in the same chunk,
    // so what survives the reset is the new screen.
    "(?:\\u001B\\[2K(?:\\u001B\\[[0-9]*G)?\\u001B\\[[0-9]*A){5,}",
  ].join("|"),
  "g",
);

/**
 * Where in `chunk` the last full-screen clear ends, or `-1` if it has none.
 *
 * Everything before that index was wiped by the harness and must not be
 * matched against again.
 */
export function lastScreenClearIndex(chunk: string): number {
  SCREEN_CLEAR.lastIndex = 0;
  let end = -1;
  for (let m = SCREEN_CLEAR.exec(chunk); m; m = SCREEN_CLEAR.exec(chunk)) {
    end = m.index + m[0].length;
  }
  return end;
}

/**
 * Horizontal cursor positioning: `ESC[<n>G` (go to column) and `ESC[<n>C`
 * (move forward).
 *
 * These are *layout*, not decoration. A TUI that lays a menu out with them
 * writes `ESC[4G1.ESC[7GYes,ESC[12GIESC[14Gtrust`, and deleting them the way
 * every other escape is deleted yields `1.Yes,Itrust` — one word, no menu,
 * and nothing a numbered-option pattern can read. Claude Code 2.1.228 draws
 * its folder-trust dialog exactly like that, which on its own is enough to
 * make the dialog unreadable, the answer `null`, and the prompt abandoned on
 * a session that was perfectly healthy. So they become one space each.
 */
const CURSOR_SPACING = new RegExp("\\u001B\\[[0-9]*[GC]", "g");

/** The rendered screen, minus the escape sequences that drew it. */
export function stripAnsi(text: string): string {
  return text.replace(CURSOR_SPACING, " ").replace(ANSI, "").replace(/\r/g, "\n");
}

/**
 * The marker a TUI uses for "this row is selected", kept as one character.
 *
 * Reverse video (`ESC[7m`, alone or as one parameter of a longer SGR run) is
 * how the harnesses observed here highlight a menu row, and `stripAnsi` would
 * drop it along with the colour. Substituting a sentinel keeps the *fact* of
 * the highlight attached to its line while the rest of the escape goes away.
 *
 * A harness that highlights with a background colour instead leaves no mark,
 * and the caller then reads "no option is highlighted" — which holds rather
 * than confirms. That is the safe direction to be wrong in.
 */
const HIGHLIGHT_MARK = "\u0001";

const SGR = new RegExp("\\u001B\\[([0-9;]*)m", "g");

function markHighlights(text: string): string {
  return text.replace(SGR, (seq, params: string) =>
    params.split(";").includes("7") ? HIGHLIGHT_MARK : seq,
  );
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

export type DialogOption = {
  number: number;
  label: string;
  /**
   * Whether this row is the one the harness has selected — a pointer glyph in
   * front of it, or reverse video on it.
   *
   * This is what makes a confirming Enter justifiable: the highlight is the
   * only evidence on screen that the harness took the digit, and the option it
   * sits on is the option that Enter would choose.
   */
  highlighted: boolean;
};

export type BlockingDialogMatch = {
  spec: BlockingDialogSpec;
  /** Every option read off the menu, including which one is highlighted. */
  options: readonly DialogOption[];
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
 *
 * Both are scoped to `claude-code`, because both are transcriptions of *that*
 * harness's screens: the wording, the option labels and the fact that the
 * highlighted default exits were all read off Claude Code and nothing else.
 * Applying them to a harness nobody has observed would mean pressing a digit
 * into a menu on the strength of another vendor's layout, which is the guess
 * D5 exists to refuse. A harness with no entry here still gets the quiet gap,
 * the separate carriage return and the length-scaled pause; what it does not
 * get is Claude Code's answers to questions it was never asked.
 */
export const BLOCKING_DIALOGS: readonly BlockingDialogSpec[] = [
  {
    id: "folder-trust",
    harnesses: ["claude-code"],
    match: [/\btrust\b/i, /\b(folder|directory|files)\b/i, /\?/],
    affirmative: /\b(yes|proceed|trust|allow)\b/i,
    refuse: /\b(no|exit|quit|cancel|deny)\b/i,
  },
  {
    id: "bypass-permissions",
    harnesses: ["claude-code"],
    // `mode` is load-bearing. A session already running in that mode says
    // "⏵⏵ bypass permissions on" in its status footer, for as long as it is
    // open, and the composer's own placeholder supplies a question mark — so
    // `bypass permissions` plus `?` matches a perfectly healthy screen and
    // parks delivery on a dialog that is not there. Observed on 2.1.228; the
    // warning screen itself says "Bypass Permissions mode".
    match: [/bypass\s+permissions\s+mode/i, /\?/],
    affirmative: /\b(yes|accept|proceed|continue)\b/i,
    refuse: /\b(no|exit|quit|cancel)\b/i,
  },
];

// `❯ 2. Yes, proceed` / `2) Yes, proceed` / `  2. No, exit` — the leading run
// is captured rather than skipped, because what is in it says which row the
// harness has selected.
const OPTION_LINE = new RegExp(
  "^([\\s>❯➤→*·\\-" + HIGHLIGHT_MARK + "]*)(\\d{1,2})[.)]\\s+(\\S.*?)\\s*$",
);

/** Pointer glyphs; a bullet or a dash is decoration, a pointer is a selection. */
const POINTER = /[>❯➤→]/;

/**
 * Read a numbered menu off a screen.
 *
 * The screen is a scrollback of repaints, so the same dialog appears several
 * times over; the last paint of each option number wins, because that is the
 * one the operator would be looking at.
 */
export function readDialogOptions(screen: string): DialogOption[] {
  const byNumber = new Map<number, DialogOption>();
  for (const line of stripAnsi(markHighlights(screen)).split("\n")) {
    const m = OPTION_LINE.exec(line);
    if (!m) continue;
    const marker = m[1]!;
    byNumber.set(Number(m[2]), {
      number: Number(m[2]),
      label: m[3]!,
      highlighted: marker.includes(HIGHLIGHT_MARK) || POINTER.test(marker),
    });
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
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
    // `screen` and not `text`: the highlight lives in the escapes that
    // `stripAnsi` removes, and it is what decides whether a confirming Enter
    // can ever be justified.
    const options = readDialogOptions(screen);
    return { spec, options, answer: chooseDialogOption(options, spec) };
  }
  return null;
}

/**
 * Whether the harness has visibly put its selection on `option`, and on
 * nothing else.
 *
 * Requiring exactly one highlighted row is the point: a screen where several
 * rows look selected is a screen this module cannot read, and a screen where
 * none does is a harness that has not acted on the digit yet.
 */
export function highlightIsOn(
  options: readonly DialogOption[],
  option: DialogOption,
): boolean {
  const highlighted = options.filter((o) => o.highlighted);
  return highlighted.length === 1 && highlighted[0]!.number === option.number;
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
  /** Its number went out and the harness did not move its highlight. */
  | { phase: "dialog-unconfirmed"; dialog: string }
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
  /** Whether anything with content has been drawn since our last keystroke. */
  private paintedSinceKeystroke = false;
  private submitAt = 0;
  private dialogKeystrokes = 0;
  /** Set when the dialog's own number went out and the confirm may still be due. */
  private pendingConfirm: string | null = null;
  private answeringDialogId: string | null = null;
  /** The dialog whose unmoved highlight has already been reported. */
  private unconfirmedDialogId: string | null = null;
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

    // The quiet window opens on the harness's first byte, not on the spawn.
    // Before there is any output there is nothing that could have gone quiet,
    // and a harness whose first chunk is pure terminal setup — no text, so no
    // signature, so not a paint — would otherwise be declared settled the
    // instant it spoke, on the strength of a gap it spent booting. Observed:
    // Claude Code 2.1.228's first chunk arrives at 368 ms and carries no
    // content at all, and the prompt went into the folder-trust dialog.
    if (!this.sawOutput) this.lastPaintAt = this.timers.now();
    this.sawOutput = true;

    // A full-screen clear is the harness saying that what came before is no
    // longer displayed, and it is the only way this module can tell that a
    // dialog *someone else* answered has gone. Without it the buffer is a
    // scrollback that only we can empty, and a dialog the operator dismissed
    // by hand stays matchable for the next 8 000 characters: long enough to
    // abandon delivery on a session sitting at a healthy composer, or to press
    // a menu digit into that composer.
    const cleared = lastScreenClearIndex(chunk);
    this.screen =
      cleared >= 0
        ? chunk.slice(cleared)
        : (this.screen + chunk).slice(-SCREEN_WINDOW_CHARS);

    // The signature ring is deliberately *not* reset with the screen: it
    // records which frames have been seen lately, which is a fact about the
    // output and not about the buffer. Emptying it on every clear would make a
    // harness that repaints one identical frame behind `ESC[2J` look like it
    // was painting forever, and D3 exists to keep that from happening.
    const signature = redrawSignature(chunk);
    const painted = signature !== "" && !this.recentSignatures.includes(signature);
    if (signature !== "") {
      this.recentSignatures.push(signature);
      if (this.recentSignatures.length > SIGNATURE_RING) this.recentSignatures.shift();
    }
    if (painted) {
      this.lastPaintAt = this.timers.now();
      this.paintedSinceKeystroke = true;
    }
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
    // "The painting stopped" presumes it started. If nothing with content has
    // been drawn since the last keystroke, this is not a settled screen — it
    // is a harness that has not got to its screen yet, and typing into that is
    // typing into whatever it puts there next.
    //
    // Observed on claude-code 2.1.228: the trust dialog is answered, the
    // harness acknowledges in escapes alone, and then says nothing at all for
    // 497 ms while it loads before painting its composer. Any gap shorter than
    // that silence — 350 ms here, and the 450 ms this module replaced — fires
    // into the hole. A longer gap is just a bigger guess about that hole; the
    // honest condition is that the harness has actually drawn something. The
    // backstop still overrides, so a harness that draws nothing at all after a
    // keystroke gets its prompt rather than losing it.
    if (!this.paintedSinceKeystroke && !this.deadlinePassed) return;

    const dialog = matchBlockingDialog(this.screen, this.specs);

    if (this.phase === "answering" && !dialog) {
      // Whatever we pressed cleared it. Back to watching the paint that
      // answering caused — which has just gone quiet, so carry straight on.
      this.phase = "settling";
      this.answeringDialogId = null;
      this.unconfirmedDialogId = null;
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

    // Same dialog still up after its number went out. Two different things
    // look like this, and only one of them may be confirmed: a harness that
    // wants the digit confirmed has *moved its highlight onto the affirmative
    // option*, and a harness that never took the digit at all has left the
    // highlight where it was — on `No, exit`. An Enter into the second is the
    // three-second death this module exists to prevent, so the highlight is
    // checked rather than assumed. The id has to match too: a *second* dialog
    // behind the first (the bypass-permissions warning behind folder-trust) is
    // a fresh menu whose highlighted default is dangerous again.
    if (
      this.phase === "answering" &&
      this.answeringDialogId === dialog.spec.id &&
      this.pendingConfirm
    ) {
      if (!highlightIsOn(dialog.options, dialog.answer)) {
        // No evidence the digit landed. Hold: the operator sees the dialog,
        // one keystroke fixes it, and the backstop abandons delivery rather
        // than sending an Enter this module cannot justify. `pendingConfirm`
        // stays set, so a harness that moves its highlight late still gets
        // confirmed on a later quiet.
        this.holdUnconfirmed(dialog.spec.id);
        return;
      }
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

  /** The dialog is still up and unmoved by our digit. Type nothing more. */
  private holdUnconfirmed(dialogId: string): void {
    this.phase = "answering";
    if (this.unconfirmedDialogId !== dialogId) {
      this.unconfirmedDialogId = dialogId;
      this.emit({ phase: "dialog-unconfirmed", dialog: dialogId });
    }
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
    this.paintedSinceKeystroke = false;
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
