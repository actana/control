import { noteCoreCap } from "../services/core-capacity";
import { CoreSharedError, type CoreShared } from "@actana/sdk/shared";
import { NotFoundError } from "../errors";
import {
  CoreHarnessesUnavailableError,
  HarnessNotReadyError,
  getAgent,
  resolveAgent,
  type Agent,
  type ResolvedAgent,
} from "../services/agents";
import {
  addTaskComment,
  claimTask,
  failTaskDispatch,
  findCurrentTaskSession,
  getTask,
  listTaskComments,
  listTasks,
  markTaskWaiting,
  releaseTaskClaim,
  type Task,
  type TaskComment,
} from "../services/tasks";
import { archivedTaskName, classifyTaskEntry, taskFolder } from "~/shared/task-report";
import { formatTaskDispatchComment, parseTaskDispatchComment, sessionStateForCoreStatus, taskWaitingReason } from "~/shared/tasks";
import { ResultWatcher } from "./result-watcher";
import { lazyShared, type SharedFor } from "./shared-factory";
import { buildTaskPointer, buildTaskPrompt, taskPromptPath } from "./task-prompt";
import { consoleDispatchLog, messageOf, type Clock, type DispatchLog, type SessionStarter, type SessionStopper } from "./types";

/**
 * The dispatcher (#570): claims `assigned` Tasks, starts a Session on the Agent's
 * Core with the Task, its comments and the result instructions, and hands the
 * running Task to the result watcher.
 *
 * The Session is told only a short pointer; the Task itself is a file in the Task's folder (`prompt-attempt-<n>.md`).
 *
 * Per Task, in this order:
 *  0. WAIT while the Agent's Harness is still being checked (#706), before any claim; see below.
 *  1. CLAIM with one conditional update (`claimTask`): assigned to in_progress,
 *     attempt + 1, dispatch time set. Of two dispatchers only one gets the Task.
 *  2. RESOLVE the Task's Agent to the harness and Core it has right now.
 *  3. On a re-run, rename the older results to `attempt-<n>-<name>` (client PR 41).
 *  4. WRITE the prompt file through the Core's Files API and read it back, then START the Session through the Core's client, then add a system comment.
 *  5. WATCH its result files.
 * Any failure before the Session runs moves the Task to `failed` with the reason
 * as its last error and a system comment (`failTaskDispatch`), so no Task is left
 * `in_progress` with nothing running and none is claimed again in a loop.
 *
 * The wait (step 0): a Harness that is `checking`, or whose check failed in a way that may pass (a probe that
 * timed out, a Core that is restarting and does not answer), is not a reason to fail a Task. The Task is left
 * `assigned`, with no claim, attempt, comment or history, and looked at again on the next poll, for up to
 * `harnessWaitMs` from the first time this dispatcher saw it waiting. Then it is claimed and fails with the
 * reason as usual. A Harness that is missing, outdated or needs setup fails at once. The wait lives in memory:
 * a Panel restart starts it again. It is separate from the result watcher's run timeout, which only starts
 * at dispatch.
 *
 * An attempt is counted only when a Session started (#962). A dispatch that ends before that leaves `attemptCount` as it
 * was, whether the Task is failed (the reasons above) or kept waiting:
 *  - a Core that cannot be asked (not connected) or whose Session start is refused for a full Core
 *    (`pty:spawn refused: ... live harness PTYs`) leaves the Task `assigned` with the reason in `lastError`,
 *    `waiting: Core not connected` / `waiting: Core full (n/max)`, and it is dispatched again by itself. One system
 *    comment when it starts waiting, none per retry. A refused start is found out by trying: the claim is given back
 *    (`releaseTaskClaim`), the Core is marked full in memory, and the other Tasks of that Core wait without a claim
 *    until a slot frees (`slotFreed`, called by the watcher) or a probe is due (15 s, doubling to 5 min).
 *  - a Harness that is not ready (`waiting: Harness not ready (...)`) waits as before, up to `harnessWaitMs`, then fails
 *    with the attempt given back.
 *
 * Every query is the owner's (`ownerId`).
 */

export type AgentLookup = {
  get(ownerId: number, id: string): Promise<Agent>;
  resolve(ownerId: number, id: string): Promise<ResolvedAgent>;
};

export type TaskDispatcherOptions = {
  ownerId: number;
  startSession: SessionStarter;
  sharedFor: SharedFor;
  /**
   * The Core's own Files API (the through-the-Core mode), where the Task's prompt file is written. A write there
   * is on the Core's disk when it returns, so the agent never reads a file that has not synced yet. Defaults to
   * `sharedFor`, which is right only where that is already the Core's disk.
   */
  coreFilesFor?: SharedFor;
  watcher: ResultWatcher;
  agents?: AgentLookup;
  /**
   * Stops a Session (#723): the one a Task was stopped under while it was still starting, and the previous
   * attempt's before a re-run. Best effort; without it neither is done.
   */
  stopSession?: SessionStopper;
  now?: Clock;
  /** How often to look for `assigned` Tasks. */
  pollMs?: number;
  /** How long an `assigned` Task waits for its Harness to finish being checked before it fails with that reason. */
  harnessWaitMs?: number;
  log?: DispatchLog;
};

export const DEFAULT_DISPATCH_POLL_MS = 2_000;
/** Covers a setup check (about 75 s), the probe retries and a Core link that reconnects. */
export const DEFAULT_HARNESS_WAIT_MS = 5 * 60_000;
/** After a start refused for a full Core, how long until another Task may try it (doubles on each refusal, up to the maximum). */
export const FULL_CORE_RETRY_MIN_MS = 15_000;
export const FULL_CORE_RETRY_MAX_MS = 5 * 60_000;

/** What the Core says when it has no room: `pty:spawn refused: this Core already runs 8 live harness PTYs (the limit)`. */
const CORE_FULL = /already runs (\d+) live harness PTYs/;
const NO_LINK = /no live link to this Core/;

type FullCore = { max: number; retryAt: number; failures: number };

/** `waiting: Core full (8/8)`; the refusal comes at the cap, so the count is the cap. */
const fullReason = (max: number) => `waiting: Core full (${max}/${max})`;
const NOT_CONNECTED = "waiting: Core not connected";

const realAgents: AgentLookup = { get: getAgent, resolve: (ownerId, id) => resolveAgent(ownerId, id) };

export class TaskDispatcher {
  private readonly ownerId: number;
  private readonly startSession: SessionStarter;
  private readonly sharedFor: SharedFor;
  private readonly coreFilesFor: SharedFor;
  private readonly watcher: ResultWatcher;
  private readonly agents: AgentLookup;
  private readonly stopSession: SessionStopper | null;
  private readonly now: Clock;
  private readonly pollMs: number;
  private readonly harnessWaitMs: number;
  /** Task id to the first time it was seen waiting for its Harness; dropped once it is claimed or leaves `assigned`. */
  private readonly waitingSince = new Map<string, number>();
  /** Tasks already logged as waiting for a Core that is not connected (logged once; not a Harness window). */
  private readonly notConnectedLogged = new Set<string>();
  /** Core id to what the last refused start said; the Tasks of that Core wait without a claim until it clears. */
  private readonly fullCores = new Map<string, FullCore>();
  private readonly log: DispatchLog;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cycling: Promise<number> | null = null;
  private adopted = false;
  private stopped = false;

  constructor(opts: TaskDispatcherOptions) {
    this.ownerId = opts.ownerId;
    this.startSession = opts.startSession;
    this.sharedFor = opts.sharedFor;
    this.coreFilesFor = opts.coreFilesFor ?? opts.sharedFor;
    this.watcher = opts.watcher;
    this.agents = opts.agents ?? realAgents;
    this.stopSession = opts.stopSession ?? null;
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? DEFAULT_DISPATCH_POLL_MS;
    this.harnessWaitMs = opts.harnessWaitMs ?? DEFAULT_HARNESS_WAIT_MS;
    this.log = opts.log ?? consoleDispatchLog;
  }

  /** Dispatch every `assigned` Task once, oldest first. Resolves with how many this call claimed. Never throws. */
  dispatchOnce(): Promise<number> {
    if (this.cycling) return this.cycling;
    const run = (async () => {
      let claimed = 0;
      if (!this.adopted) {
        try {
          await this.adoptInProgress();
          this.adopted = true;
        } catch (err) {
          // Tried again next cycle: the ones that were taken over are skipped, the rest get another go.
          this.log.error(`task dispatch: could not take over running Tasks yet: ${messageOf(err)}`);
        }
      }
      let waiting: Task[];
      try {
        waiting = (await listTasks(this.ownerId, ["assigned"])).reverse();
      } catch (err) {
        this.log.error(`task dispatch: could not list assigned Tasks: ${messageOf(err)}`);
        return 0;
      }
      const ids = new Set(waiting.map((t) => t.id));
      for (const id of this.waitingSince.keys()) if (!ids.has(id)) this.waitingSince.delete(id);
      for (const id of this.notConnectedLogged) if (!ids.has(id)) this.notConnectedLogged.delete(id);
      for (const task of waiting) {
        if (this.stopped) break;
        try {
          if (await this.dispatch(task)) claimed += 1;
        } catch (err) {
          this.log.error(`task ${task.id}: dispatch failed unexpectedly: ${messageOf(err)}`);
        }
      }
      return claimed;
    })().finally(() => {
      this.cycling = null;
    });
    this.cycling = run;
    return run;
  }

  /**
   * A slot on this Core was freed (a harness ended) or the Core connected: forget that it was full and look at the
   * waiting Tasks now instead of at the next probe.
   */
  slotFreed(coreId: string): void {
    if (!this.fullCores.delete(coreId)) return;
    if (this.timer && !this.stopped) void this.dispatchOnce();
  }

  /** `waiting: Core full (n/max)` while this Core's last start was refused and no slot has freed since; else null. */
  coreWaitingReason(coreId: string): string | null {
    const full = this.fullCores.get(coreId);
    return full ? fullReason(full.max) : null;
  }

  /**
   * Dispatch on a timer while the Panel is up. Tasks a previous Panel process left `in_progress` are taken over
   * by the watcher at the start of the first cycle that can read them, and every cycle until one does.
   */
  start(): void {
    if (this.timer || this.stopped) return;
    this.watcher.start();
    this.timer = setInterval(() => void this.dispatchOnce(), this.pollMs);
    this.timer.unref?.();
    void this.dispatchOnce();
  }

  /**
   * Watch the Tasks that are `in_progress` and not watched by this process: the Panel restarted while their
   * Sessions ran. Their exit cannot be heard any more, so a result file, the Task's time limit (from the original
   * dispatch time) or the watcher's liveness check ends them. One with no known Session cannot be probed; with
   * No limit it stays until an operator stops it. No Task is left with nothing watching it:
   * - an Agent that is gone (deleted while its Task ran) falls back to the Task's own Core;
   * - a Task with no Core to look on fails with the reason;
   * - a Core whose Shared folder cannot be reached right now is still watched, through a handle that asks again
   *   each time it is used, so the timeout ends the Task whatever happens.
   * Resolves with how many were taken over; throws if the Tasks could not be read, or one could not be failed.
   */
  async adoptInProgress(): Promise<number> {
    let adopted = 0;
    let unfinished: unknown = null;
    for (const task of await listTasks(this.ownerId, ["in_progress"])) {
      if (this.watcher.isTracking(task.id)) continue;
      try {
        let agent: Agent | null = null;
        if (task.agent) {
          try {
            agent = await this.agents.get(this.ownerId, task.agent);
          } catch (err) {
            if (!(err instanceof NotFoundError)) throw err;
            this.log.error(`task ${task.id}: its Agent is gone, looking on the Task's own Core`);
          }
        }
        const coreId = agent?.coreId ?? task.coreId;
        if (!coreId) {
          await failTaskDispatch(this.ownerId, task.id, "this Task was running when the Panel stopped, and has no Core to look for its result on", this.now());
          continue;
        }
        // The Core's Shared folder as it is now, when it can be reached; otherwise a handle that asks again on each use.
        const shared = await this.sharedFor(coreId).catch(() => lazyShared(() => this.sharedFor(coreId)));
        const session = await findCurrentTaskSession(this.ownerId, task.id).catch(() => null);
        this.watcher.track({
          taskId: task.id,
          sessionId: session?.sessionId ?? null,
          attempt: task.attemptCount,
          dispatchedAt: task.dispatchedAt ?? this.now(),
          coreId,
          shared,
          authorName: agent?.name ?? "agent",
          timeoutMinutes: task.timeoutMinutes,
        });
        await this.watcher.readSessionState(task.id); // no handle to hear the Session's status on: ask the Core once
        adopted += 1;
      } catch (err) {
        unfinished = err;
        this.log.error(`task ${task.id}: could not be taken over after a restart: ${messageOf(err)}`);
      }
    }
    if (unfinished) throw unfinished;
    return adopted;
  }

  /**
   * The waiting reason when a refused or impossible start is one that may pass: a full Core (also remembered, so the
   * Core's other Tasks do not each try it) or a link that is not there. Null for any other error, which fails the Task.
   */
  private startRefusal(coreId: string, err: unknown): string | null {
    const message = messageOf(err);
    const cap = CORE_FULL.exec(message);
    if (cap) {
      const max = Number(cap[1]);
      noteCoreCap(coreId, max);
      const failures = (this.fullCores.get(coreId)?.failures ?? 0) + 1;
      const retry = Math.min(FULL_CORE_RETRY_MIN_MS * 2 ** (failures - 1), FULL_CORE_RETRY_MAX_MS);
      this.fullCores.set(coreId, { max, failures, retryAt: this.now() + retry });
      return fullReason(max);
    }
    return NO_LINK.test(message) ? NOT_CONNECTED : null;
  }

  /** Write the prompt file through the Core's own Files API and read it back, so a short or missing file is an error here. */
  private async writePromptFile(coreId: string, taskId: string, attempt: number, text: string): Promise<void> {
    const files = await this.coreFilesFor(coreId);
    const path = taskPromptPath(taskId, attempt);
    await files.put(path, text);
    const written = await files.get(path);
    // Bytes, not strings: the Core holds what `put` encoded, and that is what a decode of `text` can differ from.
    const expected = new TextEncoder().encode(text);
    if (written.body.length !== expected.length || written.body.some((b, i) => b !== expected[i])) throw new Error(`${path} on the Core does not hold what was written`);
  }

  /** Stop cleanly: no new claim after this, the cycle in flight finishes, the watcher stops. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.cycling;
    await this.watcher.stop();
  }

  /**
   * An operator may stop the Task while its Session is still starting (#723): the stop found no Session to kill.
   * Now that this one is up, kill it and let go of it.
   */
  private async stopIfStoppedWhileStarting(taskId: string, attempt: number, target: { coreId: string; sessionId: string }): Promise<void> {
    try {
      // A Task stopped and then deleted while its Session was starting is as good as no longer in_progress.
      const now = await getTask(this.ownerId, taskId).catch((err) => {
        if (err instanceof NotFoundError) return null;
        throw err;
      });
      if (now && now.status === "in_progress" && now.attemptCount === attempt) return;
      this.watcher.untrack(taskId);
      this.log.info(`task ${taskId}: stopped while Session ${target.sessionId} was starting; stopping it`);
      if (this.stopSession) await this.stopSession(target);
    } catch (err) {
      this.log.error(`task ${taskId}: could not stop Session ${target.sessionId} of a Task stopped while starting: ${messageOf(err)}`);
    }
  }

  /**
   * Before attempt n: if attempt n-1 ended by an operator's stop or by the timeout, its Session may still be
   * running (the stop could not reach the Core, or the kill failed) and could write a `success.md` the new
   * attempt would count. Try to stop it again. Best effort and logged: a Core still unreachable does not hold
   * the new attempt back. An attempt that ended on its own result is left alone: the watcher ended its harness when it reported (#962).
   */
  private async stopPreviousSession(taskId: string, previous: number, comments: readonly TaskComment[]): Promise<void> {
    if (!this.stopSession) return;
    try {
      let at = -1;
      comments.forEach((c, i) => {
        if (c.authorKind === "system" && parseTaskDispatchComment(c.body)?.attempt === previous) at = i;
      });
      if (at < 0) return;
      const target = parseTaskDispatchComment(comments[at]!.body)!;
      // Only the Panel's own words count: "Stopped by" is a system comment, and the timeout is the Panel's
      // `fail.md` of that attempt (recorded as the agent's comment, but with that attempt's fail.md as its
      // source and the Panel's signature in the body). A user or agent comment with the same phrase is not it.
      const timeoutFile = archivedTaskName(previous, "fail.md");
      const cutShort = comments.slice(at + 1).some(
        (c) =>
          (c.authorKind === "system" && c.body.startsWith("Stopped by ")) ||
          (c.authorKind === "agent" && c.sourceFile === timeoutFile && c.body.includes("wrote no result within") && c.body.includes("written by the Panel")),
      );
      if (!cutShort) return;
      const result = await this.stopSession({ coreId: target.coreId, sessionId: target.sessionId });
      this.log.info(`task ${taskId}: previous Session ${target.sessionId} before attempt ${previous + 1}: ${result.outcome}${result.detail ? ` (${result.detail})` : ""}`);
    } catch (err) {
      this.log.error(`task ${taskId}: could not stop the previous attempt's Session: ${messageOf(err)}`);
    }
  }

  /** True when this dispatcher claimed the Task and kept it (whether or not its Session then started). False when another dispatcher got it, or the Task keeps waiting (Harness, Core not connected or full), including a claim given back. */
  private async dispatch(task: Task): Promise<boolean> {
    const wasWaiting = taskWaitingReason(task) !== null;
    /** Say why the Task is not started, once: a system comment only when it was not waiting already. */
    const wait = async (reason: string) => {
      try {
        await markTaskWaiting(this.ownerId, task.id, reason, { comment: !wasWaiting }, this.now());
      } catch (err) {
        this.log.error(`task ${task.id}: could not record that it is waiting (${reason}): ${messageOf(err)}`);
      }
    };
    // Ask before claiming: a claimed Task counts an attempt, so the wait has to happen here.
    let early: { agentId: string; resolved?: ResolvedAgent; error?: unknown } | null = null;
    if (task.agent) {
      try {
        early = { agentId: task.agent, resolved: await this.agents.resolve(this.ownerId, task.agent) };
      } catch (err) {
        if (err instanceof CoreHarnessesUnavailableError) {
          // The Core is not connected: wait for it, with no limit, and say so. This wait is not the Harness
          // window: that starts at the first "not ready" answer after the Core is back.
          this.waitingSince.delete(task.id);
          if (!this.notConnectedLogged.has(task.id)) {
            this.notConnectedLogged.add(task.id);
            this.log.info(`task ${task.id}: waiting for its Agent's Core: ${messageOf(err)}`);
          }
          await wait(NOT_CONNECTED);
          return false;
        }
        if (err instanceof HarnessNotReadyError) {
          const since = this.waitingSince.get(task.id) ?? this.now();
          if (!this.waitingSince.has(task.id)) {
            this.waitingSince.set(task.id, since);
            this.log.info(`task ${task.id}: waiting for its Agent's Harness: ${messageOf(err)}`);
          }
          if (this.now() - since < this.harnessWaitMs) {
            await wait(`waiting: Harness not ready (${err.state})`);
            return false;
          }
        }
        early = { agentId: task.agent, error: err };
      }
    }
    this.waitingSince.delete(task.id);
    this.notConnectedLogged.delete(task.id);

    // A Core whose last start was refused for want of a slot: no claim until a slot frees or a probe is due.
    const coreId = early?.resolved?.coreId;
    const full = coreId ? this.fullCores.get(coreId) : undefined;
    if (coreId && full && this.now() < full.retryAt) {
      await wait(fullReason(full.max));
      return false;
    }

    const claimed = await claimTask(this.ownerId, task.id, this.now());
    if (!claimed) return false; // another dispatcher got it, or it is no longer assigned
    const attempt = claimed.attemptCount;
    let started = false;
    const fail = async (reason: string) => {
      this.log.error(`task ${claimed.id}: ${reason}`);
      // No Session started: the attempt the claim counted is given back.
      await failTaskDispatch(this.ownerId, claimed.id, reason, this.now(), { refundAttempt: !started });
    };

    if (!claimed.agent) {
      await fail("this Task has no Agent to run it");
      return true;
    }
    let agent: Agent;
    let resolved: ResolvedAgent;
    try {
      agent = await this.agents.get(this.ownerId, claimed.agent);
      if (early && early.agentId === claimed.agent) {
        if (early.error !== undefined) throw early.error;
        resolved = early.resolved!;
      } else {
        resolved = await this.agents.resolve(this.ownerId, claimed.agent); // reassigned since the list was read
      }
    } catch (err) {
      await fail(`its Agent cannot run it: ${messageOf(err)}`);
      return true;
    }

    let shared: CoreShared;
    try {
      shared = await this.sharedFor(resolved.coreId);
      if (attempt > 1) await archivePreviousResults(shared, claimed.id, attempt - 1);
    } catch (err) {
      await fail(`the Shared folder of Core ${resolved.coreId} is not reachable: ${messageOf(err)}`);
      return true;
    }

    let sessionId: string;
    try {
      const comments = await listTaskComments(this.ownerId, claimed.id);
      if (attempt > 1) await this.stopPreviousSession(claimed.id, attempt - 1, comments);
      // The whole Task goes into a file the agent reads, not into the composer. The file is on the Core before
      // the pointer is typed, so the agent cannot be told to read a file that is not there.
      try {
        await this.writePromptFile(resolved.coreId, claimed.id, attempt, buildTaskPrompt(claimed, comments, attempt));
      } catch (err) {
        await fail(`could not put the Task's prompt file on Core ${resolved.coreId}: ${messageOf(err)}`);
        return true;
      }
      const session = await this.startSession({
        coreId: resolved.coreId,
        harness: resolved.harness,
        model: resolved.model,
        flags: resolved.flags,
        title: `Task: ${claimed.title.trim().slice(0, 80)}`,
        prompt: buildTaskPointer(resolved.harness, claimed.id, attempt),
      });
      sessionId = session.sessionId;
      started = true;
      this.fullCores.delete(resolved.coreId);
      this.watcher.track(
        {
          taskId: claimed.id,
          attempt,
          dispatchedAt: claimed.dispatchedAt ?? this.now(),
          coreId: resolved.coreId,
          shared,
          authorName: agent.name,
          sessionId,
          timeoutMinutes: claimed.timeoutMinutes,
        },
        () => session.dispose(),
      );
      session.onExit(({ exitCode }) => this.watcher.markExited(claimed.id, exitCode));
      // The Core's status changes, one write at a time and in the order they came (#949). An unknown status is skipped.
      let writes: Promise<void> = Promise.resolve();
      session.onStatus((status) => {
        const state = sessionStateForCoreStatus(status);
        if (state) writes = writes.then(() => this.watcher.markSessionState(claimed.id, state));
      });
    } catch (err) {
      this.watcher.untrack(claimed.id);
      // Not an attempt, and not a failure: the Core has no room or no link right now. Wait for it.
      const refusal = started ? null : this.startRefusal(resolved.coreId, err);
      if (refusal) {
        this.log.info(`task ${claimed.id}: ${refusal}; back to assigned until it clears (${messageOf(err)})`);
        const released = await releaseTaskClaim(this.ownerId, claimed.id, attempt, refusal, { comment: !wasWaiting }, this.now()).catch((e) => {
          this.log.error(`task ${claimed.id}: could not give the claim back: ${messageOf(e)}`);
          return undefined;
        });
        if (released === undefined) await fail(`could not start a Session on Core ${resolved.coreId}: ${messageOf(err)}`);
        return false;
      }
      await fail(`could not start a Session on Core ${resolved.coreId}: ${messageOf(err)}`);
      return true;
    }

    try {
      await addTaskComment(
        this.ownerId,
        claimed.id,
        {
          authorKind: "system",
          authorName: "Panel",
          body: formatTaskDispatchComment({
            attempt,
            agentName: agent.name,
            harness: resolved.harness,
            coreId: resolved.coreId,
            sessionId,
          }),
        },
        this.now(),
      );
    } catch (err) {
      // The Session is running and being watched; a missing note is not a reason to fail the Task.
      this.log.error(`task ${claimed.id}: could not add the dispatch comment: ${messageOf(err)}`);
    }
    await this.stopIfStoppedWhileStarting(claimed.id, attempt, { coreId: resolved.coreId, sessionId });
    this.log.info(`task ${claimed.id}: attempt ${attempt} running as Session ${sessionId} on Core ${resolved.coreId}`);
    return true;
  }
}

/** Rename the results an earlier attempt left to `attempt-<n>-<name>`, so this attempt starts with none (client PR 41). */
export async function archivePreviousResults(shared: CoreShared, taskId: string, previousAttempt: number): Promise<void> {
  const folder = taskFolder(taskId);
  for (const entry of await shared.list(folder)) {
    if (entry.kind !== "file") continue;
    const name = entry.path.slice(folder.length);
    if (classifyTaskEntry(name).kind !== "result") continue;
    try {
      await shared.move(entry.path, `${folder}${archivedTaskName(previousAttempt, name)}`);
    } catch (err) {
      // Already archived under that name: leave it, the watcher's time filter ignores the old file anyway.
      if (!(err instanceof CoreSharedError && err.code === "exists")) throw err;
    }
  }
}
