// Watches the Shared folder and reports what changed in it (#561).
//
// **The scan is the truth; the watcher is only a nudge.** `fs.watch` says "something
// under here moved", and says it differently on every platform, in bursts, and
// sometimes not at all. So an event never becomes a change report by itself: it
// schedules a debounced scan, the scan is diffed against the last snapshot, and
// the diff is the report. That is what coalesces a burst (a hundred writes to one
// file are one change), what makes a write-then-delete inside one window report
// nothing, and what makes the fallback the same code with a timer instead of a
// nudge: where recursive watching is unsupported (older Linux Node, some network
// filesystems) a periodic scan does the whole job, and a slow safety scan runs
// beside the watcher in case it drops an event.
//
// **Nothing leaves the folder.** The scan walks with `lstat` semantics and never
// follows a symbolic link: a link is neither reported nor descended into, so a
// Session that plants `shared/out -> /etc` makes nothing under `/etc` appear in
// the feed, and no path reported is anything but a path the walk built from names
// inside the root. Reported paths are relative to the root, with `/` separators.
//
// **Files only.** A change is a file's size or mtime moving, or a file gone. A
// directory is not an entry of its own: a new empty folder reports nothing, and a
// removed folder reports the files that were in it.
//
// The first scan is the baseline and reports nothing: a file that was already
// there is not a change. A client that wants the current state asks the Files API.
//
// This module runs in whichever process may read the folder: the daemon on metal,
// a helper started as `core` in the container (`shared-folder-feed.ts`).

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

/** One file's change, as the event's payload says it. */
export type SharedChange = {
  /** Relative to the Shared folder, `/` separated. Never starts with `/` or contains `..`. */
  path: string;
  /** Bytes; 0 for a deleted file. */
  size: number;
  /** Milliseconds since the epoch: the file's mtime, or when the deletion was seen. */
  mtime: number;
  deleted: boolean;
};

type Entry = { size: number; mtime: number };
export type SharedSnapshot = Map<string, Entry>;

/** Debounce window: a burst of writes is one scan this long after the last of it. */
export const DEFAULT_DEBOUNCE_MS = 150;
/** A scan runs at least this often while events keep coming: a steady writer is not starved. */
export const DEFAULT_MAX_WAIT_MS = 1_000;
/** The poll where recursive watching is unavailable. */
export const DEFAULT_FALLBACK_SCAN_MS = 2_000;
/** The net under a working watcher. */
export const DEFAULT_SAFETY_SCAN_MS = 30_000;

/**
 * Walk the folder without following links. A missing or unreadable part is left
 * out (a file removed mid-walk is the next scan's change), and a root that is
 * missing, a link or not a directory is an empty snapshot with `rootMissing` set.
 */
export async function scanSharedFolder(root: string): Promise<{ snapshot: SharedSnapshot; rootMissing: boolean }> {
  const snapshot: SharedSnapshot = new Map();
  const top = await fsp.lstat(root).catch(() => null);
  if (!top || !top.isDirectory()) return { snapshot, rootMissing: true };

  const pending: string[] = [""];
  while (pending.length > 0) {
    const rel = pending.pop()!;
    const dirents = await fsp.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const dirent of dirents) {
      const childRel = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
      // `isDirectory()` and `isFile()` on a Dirent describe the entry itself, so a
      // link is neither: it is skipped here, never statted through.
      if (dirent.isDirectory()) {
        pending.push(childRel);
      } else if (dirent.isFile()) {
        const stat = await fsp.lstat(path.join(root, childRel)).catch(() => null);
        if (stat?.isFile()) snapshot.set(childRel, { size: stat.size, mtime: Math.floor(stat.mtimeMs) });
      }
    }
  }
  return { snapshot, rootMissing: false };
}

/** What moved between two snapshots, sorted by path. `now` stamps the deletions. */
export function diffSharedSnapshots(before: SharedSnapshot, after: SharedSnapshot, now: number): SharedChange[] {
  const changes: SharedChange[] = [];
  for (const [file, entry] of after) {
    const was = before.get(file);
    if (!was || was.size !== entry.size || was.mtime !== entry.mtime) {
      changes.push({ path: file, size: entry.size, mtime: entry.mtime, deleted: false });
    }
  }
  for (const file of before.keys()) {
    if (!after.has(file)) changes.push({ path: file, size: 0, mtime: now, deleted: true });
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export type SharedFolderWatcherOptions = {
  root: string;
  onChanges: (changes: SharedChange[]) => void;
  /** Called when the folder is found missing, to make it again. A throw is reported to `onError`. */
  ensureRoot?: () => void;
  onError?: (what: string, error: unknown) => void;
  debounceMs?: number;
  maxWaitMs?: number;
  fallbackScanMs?: number;
  safetyScanMs?: number;
  /** Tests inject `fs.watch`. */
  watch?: typeof fs.watch;
  now?: () => number;
};

export type SharedFolderWatcher = {
  /** `recursive` when `fs.watch` is doing the nudging, `scan` when only the timer is. */
  readonly mode: "recursive" | "scan";
  stop: () => void;
};

/**
 * Start watching. Resolves once the baseline scan is taken, so a file written
 * after this resolves is always reported.
 */
export async function watchSharedFolder(opts: SharedFolderWatcherOptions): Promise<SharedFolderWatcher> {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const fallbackScanMs = opts.fallbackScanMs ?? DEFAULT_FALLBACK_SCAN_MS;
  const safetyScanMs = opts.safetyScanMs ?? DEFAULT_SAFETY_SCAN_MS;
  const watchFn = opts.watch ?? fs.watch;
  const now = opts.now ?? Date.now;
  const report = (what: string, error: unknown) => opts.onError?.(what, error);

  let stopped = false;
  let scanning = false;
  let dirty = false;
  let current: SharedSnapshot = new Map();
  let fsWatcher: fs.FSWatcher | null = null;
  let mode: "recursive" | "scan" = "scan";
  let debounceTimer: NodeJS.Timeout | null = null;
  let firstNudgeAt = 0;

  function arm(): void {
    if (stopped || fsWatcher) return;
    try {
      const w = watchFn(opts.root, { recursive: true, persistent: true }, () => nudge());
      w.on("error", (error) => {
        // A deleted root ends the watch. Let go of it; the scan this schedules
        // finds the root missing, makes it again and arms a new watch.
        report("shared.watch-error", error);
        disarm();
        nudge();
      });
      fsWatcher = w;
      mode = "recursive";
    } catch (error) {
      // Recursive watching is not available here (ERR_FEATURE_UNAVAILABLE_ON_PLATFORM,
      // a missing root, a filesystem that cannot). The timer does the job.
      mode = "scan";
      report("shared.watch-unavailable", error);
    }
  }

  function disarm(): void {
    try {
      fsWatcher?.close();
    } catch {
      /* already closed */
    }
    fsWatcher = null;
  }

  function nudge(): void {
    if (stopped) return;
    const t = now();
    if (debounceTimer === null) firstNudgeAt = t;
    else clearTimeout(debounceTimer);
    // Trailing debounce, capped: a writer that never pauses still gets a scan.
    const wait = Math.max(0, Math.min(debounceMs, firstNudgeAt + maxWaitMs - t));
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void scan();
    }, wait);
  }

  async function scan(): Promise<void> {
    if (stopped) return;
    if (scanning) {
      dirty = true;
      return;
    }
    scanning = true;
    try {
      do {
        dirty = false;
        const { snapshot, rootMissing } = await scanSharedFolder(opts.root);
        if (stopped) return;
        const changes = diffSharedSnapshots(current, snapshot, now());
        current = snapshot;
        if (changes.length > 0) {
          try {
            opts.onChanges(changes);
          } catch (error) {
            report("shared.on-changes-failed", error);
          }
        }
        if (rootMissing) {
          // Never missing: put it back, and watch the new one.
          disarm();
          try {
            opts.ensureRoot?.();
          } catch (error) {
            report("shared.ensure-failed", error);
          }
        }
        if (!fsWatcher) arm();
      } while (dirty && !stopped);
    } catch (error) {
      report("shared.scan-failed", error);
    } finally {
      scanning = false;
    }
  }

  const baseline = await scanSharedFolder(opts.root);
  current = baseline.snapshot;
  if (baseline.rootMissing) {
    try {
      opts.ensureRoot?.();
    } catch (error) {
      report("shared.ensure-failed", error);
    }
  }
  arm();

  // The poll that is the whole mechanism in `scan` mode and a safety net in
  // `recursive` mode. `unref`: it never keeps the process alive.
  const timers: NodeJS.Timeout[] = [];
  const pollEvery = () => (mode === "scan" ? fallbackScanMs : safetyScanMs);
  const poll = (): void => {
    const t = setTimeout(() => {
      void scan().finally(() => {
        if (!stopped) poll();
      });
    }, pollEvery());
    t.unref();
    timers.push(t);
    if (timers.length > 1) timers.shift();
  };
  poll();

  return {
    get mode() {
      return mode;
    },
    stop: () => {
      stopped = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      for (const t of timers) clearTimeout(t);
      disarm();
    },
  };
}
