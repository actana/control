import type { Task } from "../services/tasks";
import type { TaskSessionStopDto } from "~/shared/task-wire";
import { OPERATOR_ID } from "../services/operator";
import { TaskDispatcher } from "./dispatcher";
import { ResultWatcher } from "./result-watcher";
import { SharedChangeFeed, createS3Factory, createSharedFactory, createThroughCoreFactory, type SharedFactoryDeps } from "./shared-factory";
import { startSessionOnCore } from "./session-starter";
import { liveSessionsOnCore } from "./session-liveness";
import { sessionStatusesOnCore } from "./session-status";
import { sessionStopper } from "./session-stopper";
import { stopTaskRun } from "./stop-task";
import { closeTaskSession } from "./close-session";
import { coreLinkManager } from "../services/core-link-manager";
import type { CoreS3Shared } from "../services/core-s3-shared";
import { consoleDispatchLog, type Clock, type DispatchLog, type SessionLiveness, type SessionStarter, type SessionStatusReader, type SessionStopper } from "./types";
import type { AgentLookup } from "./dispatcher";

/**
 * Starting and stopping the dispatch loop with the Panel (#570). `bootPanel` calls
 * `startTaskDispatch` once the database is up and the links are dialing, and the
 * server's shutdown calls `stopTaskDispatch` before it closes the database.
 *
 * How long a Task may run with no result is the Task's own time limit (#724), not a Panel setting.
 *
 * The result files are read in S3 with the Core's server-held key whenever storage is configured, so a result is seen
 * while the Core is paused; the through-the-Core mode is the fallback when it is not.
 */

let running: { dispatcher: TaskDispatcher; detachFeed: () => void; watcher: ResultWatcher; stopSession: SessionStopper; now?: Clock } | null = null;

/** What `bootPanel` leaves alone; a test hands in fakes for the Core, the clock and the object store. */
export type StartTaskDispatchOptions = {
  /** The S3 mode for a Core. The Files tab's per-Core mode over the Panel's storage settings by default. */
  s3?: SharedFactoryDeps["s3"];
  modes?: CoreS3Shared;
  throughCore?: SharedFactoryDeps["throughCore"];
  startSession?: SessionStarter;
  /** How a Session is stopped (#723). The Panel's own link to the Core by default. */
  stopSession?: SessionStopper;
  /** Which Sessions are live on a Core, for the watcher's once-a-minute check. The Panel's own link by default. */
  liveSessions?: SessionLiveness;
  /** The Core's status of each Session, read on adoption and once a minute (#949). The Panel's own link by default. */
  sessionStatuses?: SessionStatusReader;
  minutePassMs?: number;
  agents?: AgentLookup;
  now?: Clock;
  pollMs?: number;
  watchPollMs?: number;
  exitGraceMs?: number;
  log?: DispatchLog;
};

export function startTaskDispatch(opts: StartTaskDispatchOptions = {}): void {
  if (running) return;
  const feed = new SharedChangeFeed();
  const detachFeed = feed.attach(coreLinkManager());
  const stopSession = opts.stopSession ?? sessionStopper;
  let dispatcher: TaskDispatcher | null = null;
  const watcher = new ResultWatcher({
    stopSession,
    onSlotFreed: (coreId) => dispatcher?.slotFreed(coreId),
    ownerId: OPERATOR_ID,
    liveSessions: opts.liveSessions ?? liveSessionsOnCore,
    sessionStatuses: opts.sessionStatuses ?? sessionStatusesOnCore,
    ...(opts.minutePassMs !== undefined ? { minutePassMs: opts.minutePassMs } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.watchPollMs ? { pollMs: opts.watchPollMs } : {}),
    ...(opts.exitGraceMs !== undefined ? { exitGraceMs: opts.exitGraceMs } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });
  const throughCore = opts.throughCore ?? createThroughCoreFactory(feed, OPERATOR_ID);
  dispatcher = new TaskDispatcher({
    ownerId: OPERATOR_ID,
    startSession: opts.startSession ?? startSessionOnCore,
    sharedFor: createSharedFactory({
      s3: opts.s3 ?? createS3Factory(OPERATOR_ID, opts.modes),
      throughCore,
    }),
    // The prompt file goes in through the Core itself, never the object store: see `coreFilesFor`.
    coreFilesFor: async (coreId) => throughCore(coreId),
    watcher,
    stopSession,
    ...(opts.agents ? { agents: opts.agents } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.pollMs ? { pollMs: opts.pollMs } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });
  running = { dispatcher, detachFeed, watcher, stopSession, ...(opts.now ? { now: opts.now } : {}) };
  dispatcher.start();
  consoleDispatchLog.info("task dispatch is running");
}

/** Stop dispatching and watching. Safe when it never started. In-flight Tasks stay `in_progress` and are picked up on the next start. */
export async function stopTaskDispatch(): Promise<void> {
  const current = running;
  running = null;
  if (!current) return;
  current.detachFeed();
  await current.dispatcher.stop();
}

/**
 * Stop a running Task (#723): fail it with a system comment, let the watcher go of it, kill its Session.
 * Works whether or not dispatch is running in this process (then there is no watcher to tell).
 * Throws NotFoundError, or TaskNotRunningError when the Task is not `in_progress`.
 */
export async function stopTask(
  ownerId: number,
  id: string,
  input: { stoppedBy: string; reason?: string | null },
): Promise<{ task: Task; session: TaskSessionStopDto | null }> {
  const stopped = await stopTaskRun(ownerId, id, input, {
    watcher: running?.watcher ?? null,
    stopSession: running?.stopSession ?? sessionStopper,
    ...(running?.now ? { now: running.now } : {}),
  });
  // The stopped Session's slot is free (#962): wake the Tasks waiting for one.
  const coreId = stopped.session?.coreId ?? stopped.task.coreId;
  if (coreId) running?.dispatcher.slotFreed(coreId);
  return stopped;
}

/** `close_session` (#962): end a finished Task's harness and free its slot; see {@link closeTaskSession}. */
export async function closeSession(ownerId: number, id: string, input: { closedBy: string }): Promise<{ task: Task; session: TaskSessionStopDto }> {
  return closeTaskSession(ownerId, id, input, {
    stopSession: running?.stopSession ?? sessionStopper,
    slotFreed: (coreId) => running?.dispatcher.slotFreed(coreId),
    ...(running?.now ? { now: running.now } : {}),
  });
}

/**
 * `waiting: Core full (n/max)` when the dispatcher knows this Core refused its last start for want of a slot and none
 * has freed since (#962); null otherwise, or when dispatch is not running. `create_task` with `startNow` says it queued.
 */
export function coreWaitingReason(coreId: string): string | null {
  return running?.dispatcher.coreWaitingReason(coreId) ?? null;
}

/**
 * Why a Task just created with `startNow` on this Core will not start at once (#962): the Core is full, or has no live
 * link. Null when nothing is known against it. The Task is queued either way and starts by itself.
 */
export function queuedReasonForNewTask(coreId: string): string | null {
  const full = coreWaitingReason(coreId);
  if (full) return full;
  return coreLinkManager().client(coreId)?.sdk ? null : "waiting: Core not connected";
}

/** What a `startNow` answer adds when the Task was queued: `{}` when it starts at once. */
export function queuedAnswer(startNow: boolean | undefined, coreId: string | null | undefined): { queued: true; waiting: string; message: string } | Record<string, never> {
  const waiting = startNow && coreId ? queuedReasonForNewTask(coreId) : null;
  if (!waiting) return {};
  return { queued: true, waiting, message: `Queued, ${waiting}. The Task stays assigned and starts by itself when that clears.` };
}
