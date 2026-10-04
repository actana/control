import { CoreSharedError, type CoreShared } from "@actana/sdk/shared";
import { NotFoundError } from "../errors";
import { getAgent, resolveAgent, type Agent, type ResolvedAgent } from "../services/agents";
import {
  addTaskComment,
  claimTask,
  failTaskDispatch,
  listTaskComments,
  listTasks,
  type Task,
} from "../services/tasks";
import { archivedTaskName, classifyTaskEntry, taskFolder } from "~/shared/task-report";
import { formatTaskDispatchComment } from "~/shared/tasks";
import { ResultWatcher } from "./result-watcher";
import { lazyShared, type SharedFor } from "./shared-factory";
import { buildTaskPointer, buildTaskPrompt, taskPromptPath } from "./task-prompt";
import { consoleDispatchLog, messageOf, type Clock, type DispatchLog, type SessionStarter } from "./types";

/**
 * The dispatcher (#570): claims `assigned` Tasks, starts a Session on the Agent's
 * Core with the Task, its comments and the result instructions, and hands the
 * running Task to the result watcher.
 *
 * The Session is told only a short pointer; the Task itself is a file in the Task's folder (`prompt-attempt-<n>.md`).
 *
 * Per Task, in this order:
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
  now?: Clock;
  /** How often to look for `assigned` Tasks. */
  pollMs?: number;
  log?: DispatchLog;
};

export const DEFAULT_DISPATCH_POLL_MS = 2_000;

const realAgents: AgentLookup = { get: getAgent, resolve: (ownerId, id) => resolveAgent(ownerId, id) };

export class TaskDispatcher {
  private readonly ownerId: number;
  private readonly startSession: SessionStarter;
  private readonly sharedFor: SharedFor;
  private readonly coreFilesFor: SharedFor;
  private readonly watcher: ResultWatcher;
  private readonly agents: AgentLookup;
  private readonly now: Clock;
  private readonly pollMs: number;
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
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? DEFAULT_DISPATCH_POLL_MS;
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
   * Sessions ran. Their exit cannot be heard any more, so a result file or the timeout (from the original
   * dispatch time) ends them. No Task is left with nothing watching it:
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
        this.watcher.track({
          taskId: task.id,
          attempt: task.attemptCount,
          dispatchedAt: task.dispatchedAt ?? this.now(),
          coreId,
          shared,
          authorName: agent?.name ?? "agent",
        });
        adopted += 1;
      } catch (err) {
        unfinished = err;
        this.log.error(`task ${task.id}: could not be taken over after a restart: ${messageOf(err)}`);
      }
    }
    if (unfinished) throw unfinished;
    return adopted;
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

  /** True when this dispatcher claimed the Task (whether or not its Session then started). */
  private async dispatch(task: Task): Promise<boolean> {
    const claimed = await claimTask(this.ownerId, task.id, this.now());
    if (!claimed) return false; // another dispatcher got it, or it is no longer assigned
    const attempt = claimed.attemptCount;
    const fail = async (reason: string) => {
      this.log.error(`task ${claimed.id}: ${reason}`);
      await failTaskDispatch(this.ownerId, claimed.id, reason, this.now());
    };

    if (!claimed.agent) {
      await fail("this Task has no Agent to run it");
      return true;
    }
    let agent: Agent;
    let resolved: ResolvedAgent;
    try {
      agent = await this.agents.get(this.ownerId, claimed.agent);
      resolved = await this.agents.resolve(this.ownerId, claimed.agent);
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
      this.watcher.track(
        {
          taskId: claimed.id,
          attempt,
          dispatchedAt: claimed.dispatchedAt ?? this.now(),
          coreId: resolved.coreId,
          shared,
          authorName: agent.name,
        },
        () => session.dispose(),
      );
      session.onExit(({ exitCode }) => this.watcher.markExited(claimed.id, exitCode));
    } catch (err) {
      this.watcher.untrack(claimed.id);
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
