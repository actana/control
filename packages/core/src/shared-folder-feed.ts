// The Shared folder's change feed: `shared:changed` events on the Core's event
// log (#561, ADR 0041 D5, D6).
//
// **On the existing log, not a channel of its own.** A change is appended as an
// ordinary event with `kind: "shared:changed"`. The log gives it a monotonic
// `eventId`, a connected client receives it through the live push every other
// event uses, and a client that was away replays it by cursor with the rules every
// other event has. Nothing here knows about connections or cursors.
//
// **Who watches.** On metal the daemon is the operator and watches in process. In
// the container the daemon is `actana` and `~/shared` is inside `core`'s 0750 home,
// which it cannot read, so the watcher is a child started through `asCore`
// (`shared-folder-watch-main.ts`) that reports on stdout. That child's output is
// the data of a process that runs as the Sessions' user, in a folder Sessions
// write to, so every field is checked before it becomes an event and a bad one is
// dropped, not repaired.
//
// The folder is made here, at boot, if it is missing: in process on metal, by the
// child as `core` in the container. The watcher makes it again if it is deleted
// while the Core runs.

import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import log from "@actana/shared/log";
import { ensureSharedFolder } from "@actana/shared/shared-folder";
import { asCore, coreIdentity, killAsCoreQuietly, type KillAsCoreOptions, type SpawnSpec } from "./core-identity";
import type { AsCoreOptions } from "@actana/shared/core-home";
import { sharedCapability, type CoreSharedCapability } from "./shared-capability";
import {
  watchSharedFolder,
  type SharedChange,
  type SharedFolderWatcher,
  type SharedFolderWatcherOptions,
} from "./shared-folder-watcher";

/** The event's kind on the log. */
export const SHARED_CHANGED_EVENT_KIND = "shared:changed";

/** The watcher's bundle, beside `core-entry.cjs` (`build.mjs` emits both into `dist`). */
export const CORE_SHARED_WATCH_BUNDLE = "core-shared-watch.cjs";

/** Longest path an event carries. A longer one is not a path any filesystem here made. */
const MAX_PATH_LENGTH = 4096;
/** One stdout line from the watcher. A change batch is far under this. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
/** Boot waits this long for the watcher to say it is ready, then goes on without announcing. */
export const READY_TIMEOUT_MS = 10_000;
const RESTART_MIN_MS = 1_000;
const RESTART_MAX_MS = 30_000;

export type AppendEvent = (
  kind: string,
  payload: string,
  opts?: { ptyId?: string | null; sessionId?: string | null },
) => number;

export type SharedFolderFeedOptions = AsCoreOptions & {
  /** `core`'s home: the folder is `<home>/shared`. */
  home: string;
  appendEvent: AppendEvent;
  /** Where the watcher bundle is. Tests point it elsewhere. */
  helperPath?: string;
  /** Builds the launch spec. Tests pass an identity function, since they cannot `setpriv`. */
  wrap?: typeof asCore;
  /** Starts the watcher child. Tests stub it. */
  spawnChild?: (spec: SpawnSpec & { args: string[] }) => ChildProcess;
  /** Options for the kill of the watcher (`killAsCore`). Tests pass a runner. */
  killOptions?: KillAsCoreOptions;
  readyTimeoutMs?: number;
  restartMinMs?: number;
  /** In-process watching (metal): the timings, for a test. */
  watchOptions?: Partial<Pick<SharedFolderWatcherOptions, "debounceMs" | "maxWaitMs" | "fallbackScanMs" | "safetyScanMs" | "watch" | "scan">>;
};

export type SharedFolder = {
  /**
   * What to announce on `ready`, read at the moment a connection is made: null
   * until the watcher has its baseline, null again while it is down, and the
   * capability whenever it is up. It follows the watcher, so a watcher that was
   * slow to start is announced to the next connection, not never.
   */
  readonly capability: CoreSharedCapability | null;
  stop: () => void;
};

/** A path the feed will put in an event: relative, inside the folder, nothing odd. */
export function isEventPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH) return false;
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** One change from the watcher, checked, or null. */
export function parseSharedChange(value: unknown): SharedChange | null {
  if (typeof value !== "object" || value === null) return null;
  const c = value as Record<string, unknown>;
  if (!isEventPath(c.path)) return null;
  if (typeof c.deleted !== "boolean") return null;
  const { size, mtime } = c;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return null;
  if (typeof mtime !== "number" || !Number.isFinite(mtime) || mtime < 0) return null;
  return { path: c.path, size, mtime, deleted: c.deleted };
}

/** Append one change as a `shared:changed` event. Returns the event id, 0 when the log is unavailable. */
export function appendSharedChange(appendEvent: AppendEvent, change: SharedChange): number {
  return appendEvent(
    SHARED_CHANGED_EVENT_KIND,
    JSON.stringify({ path: change.path, size: change.size, mtime: change.mtime, deleted: change.deleted }),
    { ptyId: null, sessionId: null },
  );
}

/**
 * Make the Shared folder exist and start feeding its changes into the event log.
 * Resolves once the watcher has its baseline (or has failed, or timed out), with
 * the capability to announce: `null` when the Core could not set the folder up,
 * in which case it runs without one and says so in its log.
 */
export async function startSharedFolder(opts: SharedFolderFeedOptions): Promise<SharedFolder> {
  if (!coreIdentity(opts.identityEnv ?? process.env)) return startInProcess(opts);
  return startAsCore(opts);
}

async function startInProcess(opts: SharedFolderFeedOptions): Promise<SharedFolder> {
  let root: string;
  try {
    root = ensureSharedFolder(opts.home);
  } catch (err) {
    log.error("shared.folder-unusable", { home: opts.home, error: String(err) });
    return { capability: null, stop: () => undefined };
  }
  const readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
  let up = false;
  let stopped = false;
  let watcher: SharedFolderWatcher | null = null;
  // The baseline scan walks the whole tree, so it can take as long as the tree is
  // big. Boot waits for it as long as the container path waits for its watcher and
  // no longer; a baseline that finishes later still turns the capability on.
  const started = watchSharedFolder({
    ...opts.watchOptions,
    root,
    ensureRoot: () => void ensureSharedFolder(opts.home),
    onChanges: (changes) => {
      for (const change of changes) appendSharedChange(opts.appendEvent, change);
    },
    onError: (what, error) => log.warn(what, { error: String(error) }),
  }).then(
    (w) => {
      if (stopped) {
        w.stop();
        return;
      }
      watcher = w;
      up = true;
      log.info("shared.watching", { root, mode: w.mode });
    },
    (err) => log.error("shared.watch-failed", { root, error: String(err) }),
  );
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log.error("shared.watcher-not-ready", { timeoutMs: readyTimeoutMs, inProcess: true });
      resolve();
    }, readyTimeoutMs);
  });
  await Promise.race([started, timedOut]);
  clearTimeout(timer);
  return {
    get capability() {
      return up ? sharedCapability("local") : null;
    },
    stop: () => {
      stopped = true;
      up = false;
      watcher?.stop();
    },
  };
}

function startAsCore(opts: SharedFolderFeedOptions): Promise<SharedFolder> {
  const helper = opts.helperPath ?? path.join(__dirname, CORE_SHARED_WATCH_BUNDLE);
  const readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
  let stopped = false;
  let child: ChildProcess | null = null;
  let restartTimer: NodeJS.Timeout | null = null;
  let delay = opts.restartMinMs ?? RESTART_MIN_MS;
  let announced = false;
  // Whether a watcher is up right now. The capability follows it, per connection.
  let up = false;

  return new Promise<SharedFolder>((resolve) => {
    // Boot waits for the first answer, bounded; what is announced is `up`, read later.
    const settle = () => {
      if (announced) return;
      announced = true;
      clearTimeout(timeout);
      resolve({
        get capability() {
          return up ? sharedCapability("local") : null;
        },
        stop,
      });
    };
    const timeout = setTimeout(() => {
      log.error("shared.watcher-not-ready", { timeoutMs: readyTimeoutMs });
      settle();
    }, readyTimeoutMs);

    function stop(): void {
      stopped = true;
      up = false;
      if (restartTimer) clearTimeout(restartTimer);
      const c = child;
      child = null;
      if (c) {
        // The child is `core`'s: the daemon has no CAP_KILL on it, so the signal goes
        // through `killAsCore`. Closing stdin is the watcher's own cue to exit as well.
        c.stdin?.destroy();
        killAsCoreQuietly(c, "SIGTERM", "shared.watcher-kill", opts.killOptions);
      }
    }

    function launch(): void {
      if (stopped) return;
      let spec: SpawnSpec & { args: string[] };
      try {
        // `env: {}` on purpose: `asCore` builds the child's environment and the
        // daemon's own is never the base.
        const base = { command: process.execPath, args: [helper], env: {} };
        spec = (opts.wrap ? opts.wrap(base, opts) : asCore(base, opts)) as SpawnSpec & { args: string[] };
      } catch (err) {
        log.error("shared.watcher-spawn-refused", { error: String(err) });
        up = false;
        settle();
        return;
      }
      const c = (opts.spawnChild ?? defaultSpawn)(spec);
      child = c;
      let buffer = "";
      let stderr = "";
      let overflow = false;
      c.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (overflow) {
            overflow = false;
            continue;
          }
          handleLine(line);
        }
        if (buffer.length > MAX_LINE_BYTES) {
          buffer = "";
          overflow = true;
          log.warn("shared.watcher-line-too-long", {});
        }
      });
      c.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString("utf8");
      });
      c.on("error", (err) => log.error("shared.watcher-error", { error: String(err) }));
      c.on("close", (status) => {
        if (child === c) child = null;
        up = false;
        if (stopped) return;
        log.warn("shared.watcher-exited", { status, stderr: stderr.trim().slice(0, 500), retryInMs: delay });
        settle();
        restartTimer = setTimeout(launch, delay);
        delay = Math.min(delay * 2, RESTART_MAX_MS);
      });
    }

    function handleLine(line: string): void {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        log.warn("shared.watcher-bad-line", {});
        return;
      }
      if (typeof message !== "object" || message === null) return;
      const m = message as Record<string, unknown>;
      if (m.type === "ready") {
        delay = opts.restartMinMs ?? RESTART_MIN_MS;
        log.info("shared.watching", { mode: m.mode === "scan" ? "scan" : "recursive", asCore: true });
        up = true;
        settle();
      } else if (m.type === "changes" && Array.isArray(m.changes)) {
        for (const raw of m.changes) {
          const change = parseSharedChange(raw);
          if (change) appendSharedChange(opts.appendEvent, change);
          else log.warn("shared.watcher-bad-change", {});
        }
      } else if (m.type === "log" && typeof m.what === "string") {
        log.warn(m.what.slice(0, 100), { error: typeof m.error === "string" ? m.error.slice(0, 500) : undefined });
      }
    }

    launch();
  });
}

function defaultSpawn(spec: SpawnSpec & { args: string[] }): ChildProcess {
  return spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
}
