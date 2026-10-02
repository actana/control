import { OPERATOR_ID } from "../services/operator";
import { TaskDispatcher } from "./dispatcher";
import { ResultWatcher, DEFAULT_TASK_TIMEOUT_MS } from "./result-watcher";
import { SharedChangeFeed, createS3Factory, createSharedFactory, createThroughCoreFactory, type SharedFactoryDeps } from "./shared-factory";
import { startSessionOnCore } from "./session-starter";
import { coreLinkManager } from "../services/core-link-manager";
import type { CoreS3Shared } from "../services/core-s3-shared";
import { consoleDispatchLog, type Clock, type DispatchLog, type SessionStarter } from "./types";
import type { AgentLookup } from "./dispatcher";

/**
 * Starting and stopping the dispatch loop with the Panel (#570). `bootPanel` calls
 * `startTaskDispatch` once the database is up and the links are dialing, and the
 * server's shutdown calls `stopTaskDispatch` before it closes the database.
 *
 * `AC_PANEL_TASK_TIMEOUT_MINUTES` sets how long a Task may run with no result
 * before the Panel writes `fail.md` (default 60).
 *
 * The result files are read in S3 with the Core's server-held key whenever storage is configured, so a result is seen
 * while the Core is paused; the through-the-Core mode is the fallback when it is not.
 */

export const TASK_TIMEOUT_ENV = "AC_PANEL_TASK_TIMEOUT_MINUTES";

export function taskTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const minutes = Number(env[TASK_TIMEOUT_ENV]);
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : DEFAULT_TASK_TIMEOUT_MS;
}

let running: { dispatcher: TaskDispatcher; detachFeed: () => void } | null = null;

/** What `bootPanel` leaves alone; a test hands in fakes for the Core, the clock and the object store. */
export type StartTaskDispatchOptions = {
  env?: NodeJS.ProcessEnv;
  /** The S3 mode for a Core. The Files tab's per-Core mode over the Panel's storage settings by default. */
  s3?: SharedFactoryDeps["s3"];
  modes?: CoreS3Shared;
  throughCore?: SharedFactoryDeps["throughCore"];
  startSession?: SessionStarter;
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
  const watcher = new ResultWatcher({
    ownerId: OPERATOR_ID,
    timeoutMs: taskTimeoutMs(opts.env),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.watchPollMs ? { pollMs: opts.watchPollMs } : {}),
    ...(opts.exitGraceMs !== undefined ? { exitGraceMs: opts.exitGraceMs } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });
  const dispatcher = new TaskDispatcher({
    ownerId: OPERATOR_ID,
    startSession: opts.startSession ?? startSessionOnCore,
    sharedFor: createSharedFactory({
      s3: opts.s3 ?? createS3Factory(OPERATOR_ID, opts.modes),
      throughCore: opts.throughCore ?? createThroughCoreFactory(feed, OPERATOR_ID),
    }),
    watcher,
    ...(opts.agents ? { agents: opts.agents } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.pollMs ? { pollMs: opts.pollMs } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });
  running = { dispatcher, detachFeed };
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
