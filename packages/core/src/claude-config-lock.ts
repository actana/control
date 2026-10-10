// Holding Claude Code's own lock on `~/.claude.json` while Core rewrites it (#699).
//
// Core pre-trusts a workspace by editing `~/.claude.json`, and Claude Code
// rewrites that same file while a Session runs. Claude Code 2.1.296 saves it in
// `saveConfigWithLock`, under a `proper-lockfile` lock whose `lockfilePath` is
// `${configPath}.lock`. proper-lockfile's lock is a DIRECTORY made with mkdir
// (atomic, and it works on filesystems with no flock) and released with rmdir.
// The path is the config path as given, not realpath-resolved, so a symlinked
// `~/.claude.json` gets its lock beside the link, and so does ours.
//
// Speaking the same protocol means Claude Code waits for us and we wait for it.
// When Claude Code finds the lock held it retries with backoff (200, 400, 800,
// 1600, 3200, 4000 ms, each times 1 + random) and then re-reads the file under
// the lock, so it never overwrites a change we made while holding it.
//
// proper-lockfile calls a lock stale when the lock directory's mtime is older
// than `stale` (10 s by default, which Claude Code keeps). A live holder
// refreshes that mtime every 5 s with utimes. Our hold is a read, a rename and
// a release, far shorter than that, so we never need to refresh it. And because
// we break a lock only once it is stale, the only holder we ever take over from
// is a dead one.
//
// We are deliberately stricter than proper-lockfile where a mistake would cost
// someone's data: breaking is `rmdir` alone, never a recursive remove, so a
// lock directory with something in it is reported and left; and anything at the
// lock path that is not a directory (a file, a symlink) is not ours to remove.
//
// The wait is async (`setTimeout` from `node:timers/promises`), never a blocking
// one. This code runs in the one-shot `core-home-ops` helper when the Core has a
// separate identity, and inside the daemon itself on metal installs (`coreIdentity`
// null: `coreHomeOp` runs the op in process). A lock held for the whole budget
// would otherwise freeze every Session's output for that long. The lock is a
// directory, not a descriptor, so holding it across an `await` is safe; it is
// released after the last await, whether `fn` returns or throws.

import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** proper-lockfile's default `stale`, which Claude Code's lock uses: a lock dir whose mtime is older than this is abandoned. */
export const CLAUDE_CONFIG_LOCK_STALE_MS = 10_000;

/** Pauses between attempts while another writer holds the lock (~3.1 s in all, well under the helper's 15 s timeout; async, so the event loop keeps running). */
export const CLAUDE_CONFIG_LOCK_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800, 1600];

export type ClaudeConfigLockOptions = {
  delays?: readonly number[];
  staleMs?: number;
  /** Resolves after ms. Default: `setTimeout` from `node:timers/promises`. Tests inject one (it may also change the lock between attempts). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** The lock directory Claude Code uses for this config file: beside the path as given, never realpath-resolved. */
export function claudeConfigLockPath(file: string): string {
  return `${file}.lock`;
}

function timerSleep(ms: number): Promise<void> {
  return delay(ms);
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/** Run `fn` holding Claude Code's config lock; always released afterwards. */
export async function withClaudeConfigLock<T>(
  file: string,
  fn: () => T | Promise<T>,
  options: ClaudeConfigLockOptions = {},
): Promise<T> {
  const delays = options.delays ?? CLAUDE_CONFIG_LOCK_DELAYS_MS;
  const staleMs = options.staleMs ?? CLAUDE_CONFIG_LOCK_STALE_MS;
  const sleep = options.sleep ?? timerSleep;
  const now = options.now ?? Date.now;
  for (const d of delays) {
    if (typeof d !== "number" || !Number.isFinite(d) || d < 0) {
      throw new TypeError(`claude config lock: delays must be finite non-negative numbers, got ${String(d)}`);
    }
  }
  if (typeof staleMs !== "number" || !Number.isFinite(staleMs) || staleMs <= 0) {
    throw new TypeError(`claude config lock: staleMs must be a finite number above 0, got ${String(staleMs)}`);
  }

  const lockPath = claudeConfigLockPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let waited = 0;
  let next = 0;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
    }
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(lockPath);
    } catch (err) {
      if (errorCode(err) === "ENOENT") continue; // released between our mkdir and our look
      throw err;
    }
    if (!stat.isDirectory()) {
      throw new Error(`${lockPath} exists and is not a lock directory; left as it is`);
    }
    if (now() - stat.mtimeMs > staleMs) {
      try {
        fs.rmdirSync(lockPath);
      } catch (err) {
        if (errorCode(err) !== "ENOENT") throw err;
      }
      continue;
    }
    if (next >= delays.length) {
      throw new Error(
        `${lockPath} is held by another writer (Claude Code saves ${file} under it); gave up after waiting ${waited} ms`,
      );
    }
    const pause = delays[next++]!;
    await sleep(pause);
    waited += pause;
  }

  let result: T;
  try {
    result = await fn();
  } catch (err) {
    // Released on the way out; fn's error is the one worth reporting, so a release failure is dropped.
    try {
      fs.rmdirSync(lockPath);
    } catch {
      // nothing to add
    }
    throw err;
  }
  try {
    fs.rmdirSync(lockPath);
  } catch (err) {
    if (errorCode(err) !== "ENOENT") throw err;
  }
  return result;
}
