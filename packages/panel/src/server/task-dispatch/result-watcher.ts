import { CoreSharedError, type CoreShared, type SharedChange } from "@actana/sdk/shared";
import { DuplicateTaskCommentSourceError, applyTaskResult } from "../services/tasks";
import { NotFoundError } from "../errors";
import {
  REPORT_END_MARKER,
  archivedTaskName,
  classifyTaskEntry,
  reportIsComplete,
  reportWithoutMarker,
  statusForResult,
  taskFolder,
  taskResultPath,
  type TaskResult,
} from "~/shared/task-report";
import { consoleDispatchLog, messageOf, type Clock, type DispatchLog } from "./types";

/**
 * The result watcher (#570): turns `success.md`, `fail.md` and `partial-<n>.md`
 * in a Task's Shared folder into ONE agent comment and ONE status move each,
 * through the Tasks service, so its legal-move rules still apply.
 *
 * It is written against `CoreShared` only (the public SDK's `shared` subpath),
 * so it does not know which mode it has: the S3 mode, which works while the Core
 * is paused, or the through-the-Core mode (`shared-factory.ts` picks).
 *
 * What counts:
 * - a file NEWER than the dispatch time (an older one is an earlier attempt's);
 * - a FINISHED file, its last non-blank line exactly `ACT-REPORT-END` (client
 *   PR 41), so a file still being written is read again when it changes;
 * - one file once: its comment's source file is `attempt-<n>-<name>`, unique per
 *   Task (PR 624 enforces it), so a restart that reads it again adds nothing.
 *
 * A Task whose agent exits without a result, or that runs out of time, gets a
 * `fail.md` written by the Panel and is then failed through the same path.
 *
 * Time is injected (`now`) and a tick is a plain method, so a test drives the
 * whole thing with a fake clock and no timers.
 */

export type WatchedDispatch = {
  taskId: string;
  /** The Task's attempt count at the claim. */
  attempt: number;
  /** The claim's dispatch time: only files newer than this count. */
  dispatchedAt: number;
  coreId: string;
  shared: CoreShared;
  /** Who the agent comment is by. */
  authorName: string;
};

export type ResultWatcherOptions = {
  ownerId: number;
  now?: Clock;
  /** How long a dispatch may run with no result before the Panel writes `fail.md`. */
  timeoutMs?: number;
  /**
   * After the agent exits, how long to keep looking for a result before the Panel
   * writes `fail.md`. The Shared folder reaches S3 a few seconds after it is
   * written on the Core, so a result written just before the exit can land after it.
   */
  exitGraceMs?: number;
  pollMs?: number;
  log?: DispatchLog;
};

export const DEFAULT_TASK_TIMEOUT_MS = 60 * 60_000;
export const DEFAULT_EXIT_GRACE_MS = 30_000;
export const DEFAULT_WATCH_POLL_MS = 2_000;
/** A report is read whole into memory and stored as a comment; a larger file is kept on the Shared folder and pointed to. */
export const MAX_REPORT_BYTES = 1024 * 1024;

type Tracked = WatchedDispatch & {
  /** Null until the first look, which is a `watch()` with no cursor: every file there is. */
  cursor: string | null;
  exit: { at: number; code: number } | null;
  /** Result files this dispatch has finished with. */
  done: Set<string>;
  release: () => void;
};

function oversizeNote(path: string, size: number): string {
  return `${REPORT_END_MARKER}\nThis result is ${size} bytes, over the ${MAX_REPORT_BYTES} the Panel keeps as a comment. Read it at ${path} in the Shared folder.\n${REPORT_END_MARKER}`;
}

function minutes(ms: number): string {
  const n = Math.max(1, Math.round(ms / 60_000));
  return `${n} minute${n === 1 ? "" : "s"}`;
}

export class ResultWatcher {
  private readonly ownerId: number;
  private readonly now: Clock;
  private readonly timeoutMs: number;
  private readonly exitGraceMs: number;
  private readonly pollMs: number;
  private readonly log: DispatchLog;
  private readonly tracked = new Map<string, Tracked>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(opts: ResultWatcherOptions) {
    this.ownerId = opts.ownerId;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    this.exitGraceMs = opts.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS;
    this.pollMs = opts.pollMs ?? DEFAULT_WATCH_POLL_MS;
    this.log = opts.log ?? consoleDispatchLog;
  }

  /** Start watching one dispatch. `release` runs when the dispatch is over, however it ended. */
  track(dispatch: WatchedDispatch, release: () => void = () => undefined): void {
    this.tracked.set(dispatch.taskId, {
      ...dispatch,
      cursor: null,
      exit: null,
      done: new Set(),
      release,
    });
  }

  /** Stop watching a dispatch that did not get as far as running. */
  untrack(taskId: string): void {
    const t = this.tracked.get(taskId);
    if (t) this.drop(t);
  }

  isTracking(taskId: string): boolean {
    return this.tracked.has(taskId);
  }

  get size(): number {
    return this.tracked.size;
  }

  /** The agent's process exited. If it left no result, `fail.md` follows once the grace has passed. */
  markExited(taskId: string, exitCode: number): void {
    const t = this.tracked.get(taskId);
    if (t && !t.exit) t.exit = { at: this.now(), code: exitCode };
  }

  /** Poll on a timer until `stop`. A tick that is still running when the next is due is not started twice. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref?.();
  }

  /** Stop polling, wait for the tick in flight, and let go of every dispatch. The Tasks stay `in_progress`; the next start picks them up. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
    for (const t of [...this.tracked.values()]) this.drop(t);
  }

  /** One pass over every dispatch. Never throws: a failing Task is logged and the others go on. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    const run = (async () => {
      for (const t of [...this.tracked.values()]) {
        if (this.stopped) return;
        try {
          await this.step(t);
        } catch (err) {
          this.log.error(`task ${t.taskId}: result watch failed: ${messageOf(err)}`);
        }
      }
    })().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  private drop(t: Tracked): void {
    if (this.tracked.get(t.taskId) === t) this.tracked.delete(t.taskId);
    t.release();
  }

  private async step(t: Tracked): Promise<void> {
    let finished = false;
    try {
      const watched = await t.shared.watch(t.cursor ?? undefined);
      finished = await this.consume(t, watched.changes);
      // Only once every change is dealt with: a read that failed is read again from the same cursor next tick.
      t.cursor = watched.cursor;
    } catch (err) {
      // The Shared folder cannot be read right now (a Core that is down, a key that expired), or the result could not
      // be recorded. Timeout and exit below do not depend on it, so a Task is never stuck behind it.
      this.log.error(`task ${t.taskId}: could not read or record its results: ${messageOf(err)}`);
    }
    if (finished || this.tracked.get(t.taskId) !== t) {
      this.drop(t);
      return;
    }
    const now = this.now();
    if (t.exit && now - t.exit.at >= this.exitGraceMs) {
      await this.synthesize(t, `The agent exited (code ${t.exit.code}) without writing a result file.`);
    } else if (now - t.dispatchedAt >= this.timeoutMs) {
      await this.synthesize(t, `The agent wrote no result within ${minutes(this.timeoutMs)} of dispatch.`);
    }
  }

  /** Result files among the changes, oldest first. True when one of them ended the dispatch. */
  private async consume(t: Tracked, changes: readonly SharedChange[]): Promise<boolean> {
    const folder = taskFolder(t.taskId);
    const results = changes
      .filter((c) => c.kind === "file" && !c.deleted && c.path.startsWith(folder) && !c.path.slice(folder.length).includes("/"))
      .map((c) => ({ change: c, entry: classifyTaskEntry(c.path.slice(folder.length)) }))
      .flatMap(({ change, entry }) => (entry.kind === "result" ? [{ change, result: entry.result }] : []))
      .sort((a, b) => (a.change.modifiedAt?.getTime() ?? 0) - (b.change.modifiedAt?.getTime() ?? 0) || (a.change.path < b.change.path ? -1 : 1));
    let finished = false;
    for (const { change, result } of results) {
      const name = change.path.slice(folder.length);
      if (t.done.has(name)) continue;
      // Older than the dispatch: an earlier attempt's. Not remembered, so a newer write of the same name is still seen.
      if (change.modifiedAt && change.modifiedAt.getTime() <= t.dispatchedAt) continue;
      if (change.size !== undefined && change.size > MAX_REPORT_BYTES) {
        await this.apply(t, name, result, oversizeNote(change.path, change.size));
        t.done.add(name);
        finished = true;
        continue;
      }
      let file;
      try {
        file = await t.shared.get(change.path);
      } catch (err) {
        // Created and gone again within one poll: nothing to read, and no reason to hold up the files behind it.
        if (err instanceof CoreSharedError && err.code === "not-found") continue;
        throw err;
      }
      const modifiedAt = file.modifiedAt ?? change.modifiedAt;
      if (!modifiedAt || modifiedAt.getTime() <= t.dispatchedAt) continue;
      const body = new TextDecoder().decode(file.body);
      // Still being written: it will be reported changed again when it is done.
      if (!reportIsComplete(body)) continue;
      await this.apply(t, name, result, body);
      t.done.add(name);
      finished = true;
    }
    return finished;
  }

  /** One comment and one move for one result. A file that already has its comment is done, not an error. */
  private async apply(t: Tracked, name: string, result: TaskResult, body: string): Promise<void> {
    try {
      const { moved } = await applyTaskResult(
        this.ownerId,
        t.taskId,
        {
          to: statusForResult(result),
          authorName: t.authorName,
          body: reportWithoutMarker(body) || `(${name} was empty)`,
          sourceFile: archivedTaskName(t.attempt, name),
        },
        this.now(),
      );
      this.log.info(`task ${t.taskId}: ${name} -> ${moved ? statusForResult(result) : "comment only (the Task had already finished)"}`);
    } catch (err) {
      if (err instanceof DuplicateTaskCommentSourceError) return;
      if (err instanceof NotFoundError) {
        this.log.error(`task ${t.taskId}: gone while its result was being recorded`);
        return;
      }
      throw err;
    }
  }

  /** The Panel's own `fail.md`: written to the Shared folder, then recorded like any other result. */
  private async synthesize(t: Tracked, reason: string): Promise<void> {
    // One last look at the folder itself, not at the change feed: a result whose event was missed still counts.
    try {
      const folder = taskFolder(t.taskId);
      const entries = await t.shared.list(folder);
      const changes: SharedChange[] = entries.map((e) => ({
        path: e.path,
        kind: e.kind,
        deleted: false,
        ...(e.size !== undefined ? { size: e.size } : {}),
        ...(e.modifiedAt ? { modifiedAt: e.modifiedAt } : {}),
      }));
      if (await this.consume(t, changes)) {
        this.drop(t);
        return;
      }
    } catch (err) {
      this.log.error(`task ${t.taskId}: last look before fail.md failed: ${messageOf(err)}`);
    }
    const path = taskResultPath(t.taskId, { kind: "fail" });
    const body = `# Failed\n\n${reason} (attempt ${t.attempt}; written by the Panel.)\n\n${REPORT_END_MARKER}\n`;
    try {
      await t.shared.put(path, body);
    } catch (err) {
      // A Core that cannot be written to is no reason to leave the Task running: it fails either way.
      this.log.error(`task ${t.taskId}: could not write ${path}: ${messageOf(err)}`);
    }
    // Recorded from what the Panel wrote, not read back: the store's clock is not the Panel's, and a `fail.md`
    // that looked older than the dispatch would leave the Task `in_progress` for ever.
    await this.apply(t, "fail.md", { kind: "fail" }, body);
    this.drop(t);
  }
}
