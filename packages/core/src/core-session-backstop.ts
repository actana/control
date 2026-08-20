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
  intervalMs?: number;
};

/**
 * The Core's quiet-Session backstop. One instance per Core process; the hook
 * receiver and the PTY output path feed it, and it feeds the task writer.
 */
export class CoreSessionBackstop {
  private readonly lastActivity = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: CoreSessionBackstopDeps) {}

  /**
   * This Session just did something observable — a hook landed, or its PTY
   * wrote output. Cheap on purpose: it is called from the PTY data path (the
   * caller throttles) and from every accepted hook.
   */
  noteActivity(taskId: string): void {
    if (!taskId) return;
    // Re-insert so insertion order approximates recency for the cap below.
    this.lastActivity.delete(taskId);
    this.lastActivity.set(taskId, this.now());
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
    const now = this.now();
    const settled: string[] = [];

    for (const task of this.deps.listActiveTasks()) {
      // `needs-input` is a Session waiting on a human, and may wait forever.
      if (task.status !== "running") continue;
      const lastHeard = Math.max(this.lastActivity.get(task.taskId) ?? 0, task.updatedAt);
      if (now - lastHeard < quietMs) continue;
      if (this.settle(task.taskId)) settled.push(task.taskId);
    }
    return settled;
  }

  private settle(taskId: string): boolean {
    // A live PTY means the harness is there and simply stopped talking: the
    // turn ended and its `Stop` never arrived. No PTY means the process went
    // away without its exit being recorded, which is not a finish at all.
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
      log.info("session-backstop.settled", { taskId, status });
      return true;
    } catch (err) {
      log.warn("session-backstop.settle-failed", { taskId, status, error: String(err) });
      return false;
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}
