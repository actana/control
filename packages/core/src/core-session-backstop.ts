// The backstop for a turn whose end nobody reported (issue 243, part 2).
//
// The drain backstop in `subagent-activity.ts` is armed by a hook that
// ARRIVED: `armDeferredFinish` is reached from the subagent-lifecycle branch
// and from the held-`Stop` branch, and both need a POST to have landed. So the
// one case that most needs a backstop has none — when the terminal `Stop` is
// itself the POST that dropped, nothing is armed, no timer is watching the
// row, and it claims `running` for as long as the database exists.
//
// This is the unconditional one. It arms nothing and needs nothing armed: once
// a minute it asks the database which rows still claim to be working, and
// settles the ones that have gone quiet. A row nobody ever reported a hook for
// is as much in scope as one that reported ten.
//
// ─── What "quiet" means, and why it is not just elapsed time ───
//
// A turn may legitimately run for hours, so "running for longer than N" is not
// a signal — it is a way to finish live work. What separates a finished turn
// from a long one is that a live harness never stops talking: every tool call
// fires an unmatched `PostToolUse` (see `harness-hooks.ts`), and the harness's
// own TUI redraws its spinner and elapsed-time counter into the PTY roughly
// every second while it works. A Session that has emitted neither a hook nor a
// byte of output for a quarter of an hour, while its row says `running`, is a
// turn that ended without anyone being told.
//
// Both signals feed {@link CoreSessionBackstop.noteActivity}; the row's own
// `updatedAt` is the floor for a Session this process has heard nothing about
// yet (it was written when the row last changed), so a Core that just booted
// does not settle a Session it has simply not met.
//
// ─── Why silence alone is not enough (issue 391) ───
//
// That reasoning has a hole in it, and it is the case an operator hits most:
// the harness whose hooks are not arriving is usually the harness whose TUI is
// still on screen. Codex before its hooks have been reviewed with `/hooks`
// paints a spinner and an elapsed-time counter into the PTY for as long as the
// process lives, turn or no turn. Those bytes are a redraw, not work — but
// counted as activity they mean a quarter of an hour of total silence never
// arrives, and the card claims `running` until someone edits the row.
//
// So output is read rather than counted (`pty-output-activity.ts`): a burst
// that puts a word on screen that was not already there is `output`, and a
// burst that repaints what is already there — spinner glyph, bigger number,
// same words — is `redraw`. A hook is its own kind and always counts as
// progress; nothing a harness bothers to POST is a repaint.
//
// That gives this file two rules rather than one, and a Session settles on
// whichever fires first:
//
//   * **Quiet** — nothing at all, no hook and no byte of any kind, for
//     {@link QUIET_SETTLE_MS}. Unchanged, and it is the only rule that can
//     reach a Session this process has never heard from.
//   * **Idle** — bytes are still arriving (the TUI is painting, so the
//     harness is there), but nothing new has appeared on screen and no hook
//     has landed for {@link IDLE_REDRAW_SETTLE_MS}. This is the finish-class
//     backstop the fifteen-minute rule cannot be: it does not wait for the
//     redraws to stop, because they never do.
//
// A turn that is genuinely printing output re-stamps the second rule with
// every burst, so the rule that can end it is the same one that always could.
//
// ─── What a wrong idle settle costs, and how it is paid back ───
//
// The first cut of this said the mistake was cheap because "the next hook or
// byte of real output puts the row back on `running`". That was not true, and
// the review of PR 455 was right to block on it: `harness-hook-events.ts` maps
// only `UserPromptSubmit`, `CursorBeforeSubmitPrompt` and `PermissionReplied`
// to `running` — `PostToolUse`, `SubagentStart` and `SubagentStop` map to
// nothing — and the PTY output path writes no status at all. A row settled
// early stayed `finished` until the operator's next prompt.
//
// So the rule now pays its own bill, three ways.
//
//   1. **It takes the finish back.** A `finished` written by the *idle* rule
//      is marked, and the next `output`-class burst returns the row to
//      `running`
//      ({@link IDLE_REOPEN_MS}). Nothing else is marked, so an operator's
//      finish and the quiet rule's finish are never reopened by stray bytes;
//      no hook of any kind reopens anything, because a post-turn helper
//      healing a finished card is the bug #385 closed; and the marker is
//      dropped the moment any hook arrives or anyone else writes the row, so
//      a finish that a real `Stop` wrote is never taken back either.
//   2. **It defers to hooks, for a while.** A Session whose hooks arrive has a
//      better witness than its pixels: if it has printed anything real since
//      its last hook it is mid-turn — a single `Bash` call emits no hook until
//      it completes — and the idle rule stands down. But only for
//      {@link HOOK_DEFERENCE_MS}: deferring forever would mean a dropped
//      `Stop` on a hooked harness is never settled at all, which is the other
//      half of #391. Past the bound the screen is the only evidence left, and
//      the rule reads it.
//   3. **It asks twice.** {@link IDLE_SWEEPS_REQUIRED} consecutive sweeps must
//      agree before a row moves.
//
// What still costs, and is not claimed otherwise: the settle emits
// `session:finished` (the operator's completion toast, and the signal
// `actana session wait` unblocks on) and clears the tracked subagent set. The
// reopen puts the status back; it cannot un-send a notification or restore
// that set, which expires on its own (#464). And a harness parked on a
// permission dialog nobody pattern-matched repaints it statically, which is
// this rule's condition exactly — it is settled like any idle screen, and that
// is #469.
//
// Only `running` is in scope. `needs-input` is a Session waiting on a human,
// which is a state it is allowed to sit in indefinitely and silently; a card
// that says the operator is being waited on is not made truer by a timer.

import log from "@actana/shared/log";
import {
  clearSubagentActivity,
  noteTaskFinished,
} from "@actana/shared/subagent-activity";
import type { CoreLinkTaskSnapshot } from "@actana/sdk/core-link-frames";
import type { CoreTaskWriter } from "./core-task-writer";

/**
 * How long a `running` Session must go without a hook or a byte of output
 * before this settles it.
 *
 * Fifteen minutes is chosen against the two failure directions rather than
 * from taste. Below it sits every silence a live turn actually produces (a
 * spinner tick is a second, a tool call ends in a `PostToolUse`), and above it
 * sits nothing an operator would call responsive: a Session wedged for a
 * quarter of an hour has already cost the Fleet view its meaning. It is also
 * well under the two hours a lost `SubagentStop` costs today.
 */
const QUIET_SETTLE_MS = 15 * 60 * 1000;

/**
 * How long a `running` Session whose harness is still painting may go without
 * anything new on screen and without a hook before this settles it (issue
 * 391).
 *
 * Eight minutes, raised from the five this shipped for review. The direction
 * it is chosen against is not the quiet rule's: below it sits the gap between
 * one piece of real output and the next inside a live turn, and the review of
 * PR 455 found that gap is longer than a spinner tick suggests. A single
 * `Bash` tool call emits no hook until it completes — Claude Code installs
 * `PreToolUse` with an `AskUserQuestion` matcher — so a six-minute build on a
 * harness whose hooks work perfectly has nothing but its TUI to say so.
 * Eight minutes plus {@link IDLE_SWEEPS_REQUIRED} sweeps clears that build,
 * and is still a wait an operator can sit through where "never" is not.
 *
 * Above it sits the only thing this rule is for: a harness that ended its turn,
 * never said so, and is now painting a clock at an operator waiting on a card.
 *
 * What it costs is bounded three ways rather than argued away: while a hooked
 * Session's hooks are still speaking for it the rule stands down entirely (see
 * `outputSinceHook` and {@link HOOK_DEFERENCE_MS}, which is what ends that);
 * the condition must hold across two sweeps; and a `finished` it writes is
 * taken back by the next `output`-class burst — {@link IDLE_REOPEN_MS}.
 */
const IDLE_REDRAW_SETTLE_MS = 8 * 60 * 1000;

/**
 * How many consecutive sweeps must agree before the idle rule settles a row.
 *
 * The sweep runs once a minute, so this is a minute of confirmation on top of
 * the window — cheap, and it costs a mis-timed settle nothing but a minute.
 * The review of PR 455 asked for it by name: one sweep is one sample of a
 * screen, and a screen can be between frames.
 */
const IDLE_SWEEPS_REQUIRED = 2;

/**
 * How long after an idle-rule settle the same Session may be un-finished by
 * new output.
 *
 * The whole argument for a window shorter than fifteen minutes is that the
 * mistake is cheap. It was not: a hook does not un-finish a row
 * (`harness-hook-events.ts` maps only `UserPromptSubmit`,
 * `CursorBeforeSubmitPrompt` and `PermissionReplied` to `running`), and the PTY
 * output path writes no status at all — so before this, a row the idle rule
 * settled early stayed `finished` until the operator's next prompt. Now the
 * rule that wrote it takes it back: any `output`-class burst or hook inside
 * this window puts the row back on `running`.
 *
 * Half an hour, because the thing being recovered from is a long tool call, and
 * because the marker is only ever set by this rule — an operator's finish, a
 * hook's finish and the quiet rule's finish are never reopened, whatever the
 * harness writes to its PTY afterwards.
 */
const IDLE_REOPEN_MS = 30 * 60 * 1000;

/**
 * How long a hook keeps the idle rule off a Session that has printed something
 * since it.
 *
 * The deference exists because a hooked harness mid-tool-call and a hooked
 * harness whose `Stop` dropped look identical from here, and settling the
 * first is the worse mistake. But an unbounded deference settles neither: the
 * review of PR 455 drove four hours of spinner on a Session whose `Stop` had
 * dropped and got `running`, which is the second failure #391 names, put back.
 *
 * So it is bounded, at the same quarter of an hour the quiet rule already
 * calls long enough to be over. Under it, a tool call that has printed nothing
 * new is protected — and it does not need to be protected for long, because
 * the eight-minute window plus its confirming sweep already clears a
 * six-minute call with no hook gate at all. Over it, the screen is the only
 * evidence left and the idle rule reads it, so a dropped `Stop` on a hooked
 * harness settles at about sixteen minutes rather than never.
 */
const HOOK_DEFERENCE_MS = 15 * 60 * 1000;

/**
 * How recently bytes must have arrived for the idle rule to apply at all.
 *
 * The idle rule's whole premise is "the harness is still there, and painting".
 * A Session that has gone properly silent is the other rule's business, at the
 * window that rule was tuned for — so a lull in a chatty harness never gets
 * settled on the shorter clock by accident. A painting TUI redraws about once
 * a second, so two minutes is slack, not a threshold.
 */
const STILL_PAINTING_MS = 2 * 60 * 1000;

/** How often the sweep runs. Matches the deferred-finish recheck's cadence. */
const SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * Cap on remembered activity stamps — one per Session that has reported
 * anything since boot. Bounded like every other per-task map in this path; the
 * cost of dropping the oldest is that its row falls back to its `updatedAt`.
 */
const MAX_TRACKED_TASKS = 500;

export type CoreSessionBackstopDeps = {
  /** Every row this Core still claims is working. */
  listActiveTasks: () => CoreLinkTaskSnapshot[];
  /** The one seam a task row changes through, events included. */
  writer: CoreTaskWriter;
  /**
   * Does this Core currently have a live PTY for the task? Optional; when it
   * answers `false` the Session is settled as `disconnected` rather than
   * `finished`, because a turn whose process is gone did not finish — that is
   * the PTY-exit settle's answer, arriving late because its exit went
   * unrecorded. Absent, every settle is a `finished`.
   */
  hasLivePty?: (taskId: string) => boolean;
  /** Injected in tests. */
  now?: () => number;
  quietMs?: number;
  /** Overrides {@link IDLE_REDRAW_SETTLE_MS}. */
  idleMs?: number;
  /** Overrides {@link STILL_PAINTING_MS}. */
  paintingMs?: number;
  /** Overrides {@link IDLE_REOPEN_MS}. */
  reopenMs?: number;
  /** Overrides {@link HOOK_DEFERENCE_MS}. */
  hookDeferenceMs?: number;
  intervalMs?: number;
};

/**
 * What a Session was heard doing.
 *
 * `hook` is any accepted hook. It is activity — it keeps both rules off, and
 * it is the evidence that this harness can report itself — and it is also the
 * end of any claim this file has on the row: a hook means the pipeline is
 * deciding the status now, so the idle rule's marker is dropped and a finish
 * it wrote is no longer this file's to take back. A `Stop` is a hook.
 *
 * `output` is a burst of PTY output that put something new on screen. It is
 * activity, and it is the one kind that may reopen an idle-settled row,
 * because new content on screen with no hook behind it is the harness itself
 * saying the turn was not over.
 *
 * `redraw` is a burst that repainted what was already there, and is the only
 * kind that leaves the idle rule's clock running.
 */
export type SessionActivityKind = "hook" | "output" | "redraw";

/** What this Core has heard from one Session, and what it made of it. */
type SessionActivity = {
  /** Last time anything at all arrived — a hook, or any byte. */
  heardAt: number;
  /** Last time something new appeared: a hook, or an `output` burst. */
  outputAt: number;
  /** Last hook, or `0` if this Core has never had one for this Session. */
  hookAt: number;
  /**
   * `output` bursts since that hook. The idle rule needs this to be zero for a
   * Session whose hooks work: a harness that printed something real since its
   * last hook is mid-turn, and its next hook is the tool call finishing.
   */
  outputSinceHook: number;
  /** Consecutive sweeps in which the idle condition has held. */
  idleSweeps: number;
};

/**
 * The Core's quiet-Session backstop. One instance per Core process; the hook
 * receiver and the PTY output path feed it, and it feeds the task writer.
 */
export class CoreSessionBackstop {
  /** Per Session: what this Core has heard from it. A redraw moves `heardAt` only. */
  private readonly lastActivity = new Map<string, SessionActivity>();
  /**
   * Sessions this instance's *idle* rule wrote a `finished` for, and when.
   * Nothing else is ever in here — not the quiet rule, not a hook's finish,
   * not an operator's — so nothing else can be reopened by stray bytes.
   */
  private readonly idleSettled = new Map<string, { at: number; rowUpdatedAt: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: CoreSessionBackstopDeps) {}

  /**
   * This Session just did something observable — a hook landed, or its PTY
   * wrote output. Cheap on purpose: it is called from the PTY data path (the
   * caller throttles and classifies) and from every accepted hook.
   *
   * `kind` says what was heard, and the default is `output` because a caller
   * with no opinion is reporting real work. The hook receiver passes `hook`,
   * which additionally tells the idle rule that this harness can report
   * itself; the PTY path passes what the classifier made of the bytes.
   */
  noteActivity(taskId: string, kind: SessionActivityKind = "output"): void {
    if (!taskId) return;
    const now = this.now();
    const prior = this.lastActivity.get(taskId);
    // Re-insert so insertion order approximates recency for the cap below.
    this.lastActivity.delete(taskId);
    const progress = kind !== "redraw";
    const isHook = kind === "hook";
    this.lastActivity.set(taskId, {
      heardAt: now,
      // A redraw is the harness being there, not the turn getting anywhere:
      // it keeps the quiet rule off and leaves the idle rule's clock running.
      outputAt: progress ? now : (prior?.outputAt ?? 0),
      hookAt: isHook ? now : (prior?.hookAt ?? 0),
      // A hook resets the count; an `output` burst adds to it. Both are read
      // by the idle rule as "this harness has more to say".
      outputSinceHook: isHook ? 0 : (prior?.outputSinceHook ?? 0) + (kind === "output" ? 1 : 0),
      // Any progress breaks a run of idle sweeps.
      idleSweeps: progress ? 0 : (prior?.idleSweeps ?? 0),
    });
    while (this.lastActivity.size > MAX_TRACKED_TASKS) {
      const oldest = this.lastActivity.keys().next().value;
      if (oldest === undefined) break;
      this.lastActivity.delete(oldest);
    }
    // A hook hands the row back to the pipeline: whatever it writes — a
    // `Stop`'s finish, a `UserPromptSubmit`'s `running` — is authoritative,
    // and a finish this rule wrote before it is not this file's to take back
    // any more. Dropping the marker here is what keeps a post-turn composer
    // paint from reopening a row a real `Stop` has since finished (review of
    // PR 455, round 3).
    if (isHook) this.idleSettled.delete(taskId);
    else if (kind === "output") this.reopenIfIdleSettled(taskId, now);
  }

  /**
   * Take back a `finished` this instance's idle rule wrote, because the
   * harness has just proved the turn was still running.
   *
   * Three things must hold, and the third is what makes the claim above it
   * true: the row must be one this rule settled, the marker must be inside
   * {@link IDLE_REOPEN_MS}, and **the row must not have been written since**.
   * Asking only whether it still says `finished` is not enough — a real `Stop`
   * writes `finished` over a `finished`, and reopening that is exactly the
   * post-turn resurrection #385 closed. So the settle records the row's
   * `updatedAt` and the reopen requires it unchanged; anybody else's write,
   * whatever status it left behind, ends this rule's claim.
   *
   * The subagent set cleared by the settle cannot be restored, which is the
   * one part of a wrong idle settle that does not come back; it expires on
   * its own.
   */
  private reopenIfIdleSettled(taskId: string, now: number): void {
    const marker = this.idleSettled.get(taskId);
    if (marker === undefined) return;
    this.idleSettled.delete(taskId);
    if (now - marker.at > (this.deps.reopenMs ?? IDLE_REOPEN_MS)) return;
    try {
      const task = this.deps.writer.readTask(taskId);
      if (task?.status !== "finished") return;
      if (task.updatedAt !== marker.rowUpdatedAt) return;
      if (!this.deps.writer.mutate({ op: "update", taskId, status: "running" })) return;
      log.info("session-backstop.reopened", { taskId, quietForMs: now - marker.at });
    } catch (err) {
      log.warn("session-backstop.reopen-failed", { taskId, error: String(err) });
    }
  }

  /** Forget a Session — its process is gone and something else settled it. */
  forget(taskId: string): void {
    this.lastActivity.delete(taskId);
    // A process that is gone writes no more bytes, so nothing is left that
    // could justify reopening the row.
    this.idleSettled.delete(taskId);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweepOnce(), this.deps.intervalMs ?? SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Settle every `running` Session that has gone quiet, and return the ids
   * that moved. Public so the boot path and the tests can drive it directly
   * rather than waiting on a timer.
   */
  sweepOnce(): string[] {
    const quietMs = this.deps.quietMs ?? QUIET_SETTLE_MS;
    const idleMs = this.deps.idleMs ?? IDLE_REDRAW_SETTLE_MS;
    const paintingMs = this.deps.paintingMs ?? STILL_PAINTING_MS;
    const now = this.now();
    const settled: string[] = [];

    for (const task of this.deps.listActiveTasks()) {
      // `needs-input` is a Session waiting on a human, and may wait forever.
      if (task.status !== "running") continue;
      const stamps = this.lastActivity.get(task.taskId);
      const lastHeard = Math.max(stamps?.heardAt ?? 0, task.updatedAt);
      // Quiet: nothing of any kind for the long window. The row's own write is
      // the floor, so a Session this process has never met is judged on that
      // alone — and only ever by this rule, because a Core that has heard no
      // bytes cannot know whether the ones it missed were redraws.
      const quiet = now - lastHeard >= quietMs;
      if (!quiet && stamps) {
        // Idle: the harness is demonstrably still painting, nothing new has
        // appeared on screen for the window, and its hooks are not the thing
        // carrying the turn (issue 391, narrowed by the review of PR 455).
        const painting = now - stamps.heardAt <= paintingMs;
        const lastOutput = Math.max(stamps.outputAt, task.updatedAt);
        // A Session whose hooks arrive has a better witness than its pixels:
        // if it has printed anything real since its last hook, it is mid-turn
        // and the hook that ends the turn is still coming. A Session that has
        // never had a hook — the case #391 is about — has only its screen.
        // ...and only for as long as a tool call could plausibly still be
        // running. An unbounded deference never settles a dropped `Stop` on a
        // hooked harness, which is the other half of #391.
        const hookDeferenceMs = this.deps.hookDeferenceMs ?? HOOK_DEFERENCE_MS;
        const hooksSpeakForIt =
          stamps.hookAt > 0 &&
          stamps.outputSinceHook > 0 &&
          now - stamps.hookAt < hookDeferenceMs;
        const idleNow = painting && !hooksSpeakForIt && now - lastOutput >= idleMs;
        stamps.idleSweeps = idleNow ? stamps.idleSweeps + 1 : 0;
        if (stamps.idleSweeps < IDLE_SWEEPS_REQUIRED) continue;
      } else if (!quiet) {
        continue;
      }
      if (this.settle(task.taskId, quiet ? "quiet" : "idle")) settled.push(task.taskId);
    }
    return settled;
  }

  private settle(taskId: string, rule: "quiet" | "idle"): boolean {
    // A live PTY means the harness is there and either stopped talking or is
    // only repainting: the turn ended and its `Stop` never arrived. No PTY
    // means the process went away without its exit being recorded, which is
    // not a finish at all.
    const alive = this.deps.hasLivePty ? this.deps.hasLivePty(taskId) : true;
    const status = alive ? "finished" : "disconnected";
    try {
      const updated = this.deps.writer.mutate({ op: "update", taskId, status });
      if (!updated) return false;
      // The Session's subagents cannot outlive a turn we just called over, and
      // a finish that this decided must be timestamped like any other — that
      // is what tells a laggard subagent POST from resumed work.
      clearSubagentActivity(taskId);
      if (status === "finished") noteTaskFinished(taskId);
      this.forget(taskId);
      // Only the idle rule leaves a marker, and only a `finished` can be taken
      // back — a `disconnected` row has no process left to change its mind.
      if (rule === "idle" && status === "finished") {
        // The row as this rule left it. Anything that moves `updatedAt` after
        // this — a real `Stop`, an operator, the Panel — takes the row out of
        // this rule's hands for good.
        this.idleSettled.set(taskId, { at: this.now(), rowUpdatedAt: updated.updatedAt });
        while (this.idleSettled.size > MAX_TRACKED_TASKS) {
          const oldest = this.idleSettled.keys().next().value;
          if (oldest === undefined) break;
          this.idleSettled.delete(oldest);
        }
      }
      log.info("session-backstop.settled", { taskId, status, rule });
      return true;
    } catch (err) {
      log.warn("session-backstop.settle-failed", { taskId, status, rule, error: String(err) });
      return false;
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}
