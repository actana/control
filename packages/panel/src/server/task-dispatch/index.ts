import { OPERATOR_ID } from "../services/operator";
import { TaskDispatcher } from "./dispatcher";
import { ResultWatcher, DEFAULT_TASK_TIMEOUT_MS } from "./result-watcher";
import { SharedChangeFeed, createSharedFactory, createThroughCoreFactory, type SharedFactoryDeps } from "./shared-factory";
import { startSessionOnCore } from "./session-starter";
import { coreLinkManager } from "../services/core-link-manager";
import { consoleDispatchLog } from "./types";

/**
 * Starting and stopping the dispatch loop with the Panel (#570). `bootPanel` calls
 * `startTaskDispatch` once the database is up and the links are dialing, and the
 * server's shutdown calls `stopTaskDispatch` before it closes the database.
 *
 * `AC_PANEL_TASK_TIMEOUT_MINUTES` sets how long a Task may run with no result
 * before the Panel writes `fail.md` (default 60).
 */

export const TASK_TIMEOUT_ENV = "AC_PANEL_TASK_TIMEOUT_MINUTES";

export function taskTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const minutes = Number(env[TASK_TIMEOUT_ENV]);
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : DEFAULT_TASK_TIMEOUT_MS;
}

let running: { dispatcher: TaskDispatcher; detachFeed: () => void } | null = null;

export function startTaskDispatch(opts: { s3?: SharedFactoryDeps["s3"]; env?: NodeJS.ProcessEnv } = {}): void {
  if (running) return;
  const feed = new SharedChangeFeed();
  const detachFeed = feed.attach(coreLinkManager());
  const watcher = new ResultWatcher({ ownerId: OPERATOR_ID, timeoutMs: taskTimeoutMs(opts.env) });
  const dispatcher = new TaskDispatcher({
    ownerId: OPERATOR_ID,
    startSession: startSessionOnCore,
    sharedFor: createSharedFactory({ s3: opts.s3 ?? null, throughCore: createThroughCoreFactory(feed, OPERATOR_ID) }),
    watcher,
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
