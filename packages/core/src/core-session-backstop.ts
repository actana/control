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
// same words — is `redraw`. Hooks are always `output`; nothing a harness
// bothers to POST is a repaint.
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
// The trade is stated plainly: a harness that works in total silence for
// longer than the quiet window gets a card that says `finished` while it is
// still going. Nothing is killed, no process is touched, and the next turn's
// `UserPromptSubmit` puts the row back on `running`. Against that: before this
// file, a lost `Stop` wedged a Session on `running` until a human edited the
// row by hand — and the whole failure mode is that the Panel says otherwise.
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
 * Five minutes, and the two directions it is chosen against are not the ones
 * above. Below it sits the gap between one piece of real output and the next
 * within a live turn: a tool call that prints as it goes, a model streaming
 * prose, a build logging its steps — all of them beat five minutes by orders
 * of magnitude, and any of them re-stamps the window. Above it sits the only
 * thing this rule is for: a harness that ended its turn, never said so, and is
 * now painting a clock at an operator who is waiting on a card. Five minutes
 * is a wait; fifteen was the whole Fleet view losing its meaning.
 *
 * What it costs: a turn whose tool prints nothing at all for five minutes, on
 * a harness whose hooks are also not arriving, reads `finished` while it runs.
 * Nothing is killed, and the next hook or byte of real output puts the row
 * back on `running`.
 */
const IDLE_REDRAW_SETTLE_MS = 5 * 60 * 1000;

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
  intervalMs?: number;
};

/**
 * What a Session was heard doing. `output` is a hook, or a burst of PTY output
 * that put something new on screen; `redraw` is a burst that repainted what
 * was already there. Only `output` holds the idle rule off.
 */
export type SessionActivityKind = "output" | "redraw";

/**
 * The Core's quiet-Session backstop. One instance per Core process; the hook
 * receiver and the PTY output path feed it, and it feeds the task writer.
 */
export class CoreSessionBackstop {
  /**
   * Per Session: when it was last heard at all, and when it was last heard
   * saying something new. A redraw moves `heardAt` only.
   */
  private readonly lastActivity = new Map<string, { heardAt: number; outputAt: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: CoreSessionBackstopDeps) {}

  /**
   * This Session just did something observable — a hook landed, or its PTY
   * wrote output. Cheap on purpose: it is called from the PTY data path (the
   * caller throttles and classifies) and from every accepted hook.
   *
   * `kind` says which of the two rules at the top of this file the call feeds.
   * It defaults to `output` because every caller that has an opinion is
   * reporting real work: a hook that landed is not a repaint.
   */
  noteActivity(taskId: string, kind: SessionActivityKind = "output"): void {
    if (!taskId) return;
    const now = this.now();
    const prior = this.lastActivity.get(taskId);
    // Re-insert so insertion order approximates recency for the cap below.
    this.lastActivity.delete(taskId);
    this.lastActivity.set(taskId, {
      heardAt: now,
      // A redraw is the harness being there, not the turn getting anywhere:
      // it keeps the quiet rule off and leaves the idle rule's clock running.
      outputAt: kind === "output" ? now : (prior?.outputAt ?? 0),
    });
    while (this.lastActivity.size > MAX_TRACKED_TASKS) {
      const oldest = this.lastActivity.keys().next().value;
      if (oldest === undefined) break;
      this.lastActivity.delete(oldest);
    }
  }

  /** Forget a Session — its process is gone and something else settled it. */
  forget(taskId: string): void {
    this.lastActivity.delete(taskId);
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
      // Idle: the harness is demonstrably still painting, and nothing new has
      // appeared on screen for the short window (issue 391).
      const painting = stamps !== undefined && now - stamps.heardAt <= paintingMs;
      const lastOutput = Math.max(stamps?.outputAt ?? 0, task.updatedAt);
      const idle = painting && now - lastOutput >= idleMs;
      if (!quiet && !idle) continue;
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
