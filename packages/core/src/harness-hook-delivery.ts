// Whether a harness's hooks actually reached this Core — and what to do when
// one did not (issue 243, part 1).
//
// Every status a Session card shows arrives as a fire-and-forget POST from a
// hook's shell command. Before this module the command ended in `|| true`,
// which swallowed a 3-second timeout, a connection refused, a 401 and a 500
// identically and silently: a lost hook left no trace on either side, so the
// wedged `running` row it produced had no explanation anywhere.
//
// Two halves fix that, and they meet in this file:
//
//  - **The ack.** The hook command now asks curl to fail on a non-2xx answer
//    (`-f`) and to retry a transient one, so "the Core took it" is a fact the
//    command can act on rather than an assumption. See `hookCommand` in
//    `harness-hooks.ts` — the sh is there, next to the other per-family hook
//    text, and the receiver's half is the `ack` counter it answers with.
//  - **The miss log.** When the ack never comes, the command appends one line
//    here instead of dropping the fact on the floor. The Core drains that file
//    into its own log with a running total, so a dropped hook is visible as a
//    log line on the machine it happened on.
//
// The file is the seam because the two ends cannot share memory: the writer is
// a short-lived `sh` the harness spawned, and it may be writing while this Core
// is down (a restart is exactly when hooks are refused). A file survives that,
// and the drain at boot is what makes the misses from a dead Core's window
// visible at all.
//
// Nothing here is on the hot path of a hook that SUCCEEDS: a delivered hook
// never opens this file.

import * as fs from "node:fs";
import * as path from "node:path";
import { CORE_HOOK_MISS_LOG } from "@actana/shared/actana-container-contract";
import log from "@actana/shared/log";

/** How often the Core folds new misses into its log. */
const DRAIN_INTERVAL_MS = 60_000;

/**
 * Stop reading a miss log bigger than this. A pathological loop (a harness
 * re-firing a hook at a Core that is refusing every one) must not turn a
 * diagnostic into a memory event; the count is still reported, the tail is
 * dropped with the truncation.
 */
const MAX_MISS_LOG_BYTES = 1_000_000;

/**
 * The longest line, and the longest field, that is believed. A hook writes
 * ~80 bytes; anything larger is not one of ours. The file is writable by every
 * Session, so it is input from a process we do not trust.
 */
const MAX_LINE_CHARS = 512;
const MAX_FIELD_CHARS = 128;

/** How many individual misses one drain names before it summarizes. */
const MAX_LOGGED_PER_DRAIN = 10;

export type HookMiss = {
  /** When the hook command gave up, as it stamped it (UTC, second-resolution). */
  at: string;
  taskId: string;
  event: string;
  /** curl's exit status — 28 is the timeout, 7 connection refused, 22 a 4xx/5xx. */
  code: string;
};

/**
 * Where a Core's hook commands record what they could not deliver.
 *
 * In the container this is the drop box, outside the state directory: the
 * writer is a Session and the daemon's state is not somewhere a Session may
 * write (#559). On metal the operator runs both, and the file stays beside the
 * database.
 */
export function hookMissLogPath(userDataDir: string, containerMode = false): string {
  return containerMode ? CORE_HOOK_MISS_LOG : path.join(userDataDir, "hook-misses.log");
}

/**
 * Make the drop box a Session can append to: the directory traversable, the
 * file world-appendable. Created here, by the daemon, because a Session's `>>`
 * can create nothing in a directory it may not write to, and the mode is set
 * with `chmod` because the daemon's umask would otherwise decide it.
 *
 * Never throws: a hook that cannot be recorded is already fail-soft, and a
 * daemon that will not boot over a diagnostic file is the wrong trade.
 */
export function ensureHookMissDropBox(missLogPath: string): boolean {
  try {
    const dir = path.dirname(missLogPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o711 });
    fs.chmodSync(dir, 0o711);
    const fd = fs.openSync(missLogPath, "a", 0o622);
    try {
      fs.fchmodSync(fd, 0o622);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err) {
    log.warn("hook-delivery.drop-box-failed", { path: missLogPath, error: String(err) });
    return false;
  }
}

/**
 * Read every miss recorded since the last drain and clear the file.
 *
 * Read-then-truncate, deliberately: the writers open with `>>` (O_APPEND), so
 * the worst a concurrent write can cost is one line landing in the gap between
 * the read and the truncate. Losing one diagnostic line is cheaper than a lock
 * a `sh` one-liner would have to take — and a hook must never block on us.
 *
 * A missing file is not an error: it is the normal state of a Core whose hooks
 * are all arriving.
 */
export function drainHookMisses(missLogPath: string): HookMiss[] {
  let fd: number;
  try {
    fd = fs.openSync(missLogPath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  } catch {
    return [];
  }
  try {
    const raw = readRegularFile(fd);
    if (raw === null) return [];
    try {
      fs.ftruncateSync(fd, 0);
    } catch (err) {
      // Could not clear it, so every line would be re-reported on the next
      // drain. Say so once and report nothing rather than loop on the same set.
      log.warn("hook-delivery.miss-log-truncate-failed", { error: String(err) });
      return [];
    }
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseMiss)
      .filter((miss): miss is HookMiss => miss !== null);
  } catch {
    return [];
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * At most {@link MAX_MISS_LOG_BYTES} of an open file, or null when there is
 * nothing to drain.
 *
 * Everything is done on the descriptor that was opened (`O_NOFOLLOW`): a
 * symlink to somewhere else is refused rather than followed, and only a regular
 * file is read. Only the cap is ever read into memory, however large a Session
 * made the file, and when the cap cut a line in two the torn half is dropped.
 */
function readRegularFile(fd: number): string | null {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.size === 0) return null;
  const buffer = Buffer.alloc(Math.min(stat.size, MAX_MISS_LOG_BYTES));
  const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
  const text = buffer.subarray(0, read).toString("utf8");
  if (stat.size <= MAX_MISS_LOG_BYTES) return text;
  return text.slice(0, text.lastIndexOf("\n") + 1);
}

/** A field with every control character gone and a length cap: it is about to be logged. */
function cleanField(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_FIELD_CHARS);
}

/**
 * One recorded line, as `hookCommand` writes it:
 * `<iso8601>\t<taskId>\t<event>\t<curl exit>`. A line this cannot read is
 * dropped rather than guessed at — the file is written by a shell in a Session,
 * and anything a Session can write to is input, not a record: too long a line
 * is not ours, extra fields are ignored, and the fields are stripped of control
 * characters and capped before they reach a log line.
 */
function parseMiss(line: string): HookMiss | null {
  if (line.length > MAX_LINE_CHARS) return null;
  const parts = line.split("\t");
  if (parts.length < 4) return null;
  const [at, taskId, event, code] = parts.map(cleanField);
  if (!taskId) return null;
  return { at, taskId, event, code };
}

export type HookDeliveryMonitorDeps = {
  /** The file `hookCommand` appends to. Usually {@link hookMissLogPath}. */
  missLogPath: string;
  /** Drain cadence. Only tests pass this. */
  intervalMs?: number;
};

/**
 * Folds the miss log into the Core's own log on a timer, with a running total.
 *
 * The total is what makes a rate legible: one miss in a week is a flake, forty
 * in an hour is a Core whose event loop is losing to its own PTY fan-out —
 * which is the failure this issue was filed about, and which no counter
 * anywhere could previously show.
 */
export class HookDeliveryMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private total = 0;

  constructor(private readonly deps: HookDeliveryMonitorDeps) {}

  /**
   * Drain once for whatever was recorded while this Core was down, then keep
   * draining on the interval. The boot drain is the point: a hook refused
   * during a restart is precisely the hook nobody would otherwise hear about.
   */
  start(): void {
    if (this.timer) return;
    this.drain();
    this.timer = setInterval(() => this.drain(), this.deps.intervalMs ?? DRAIN_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Misses reported since this process started. */
  missCount(): number {
    return this.total;
  }

  /** Drain now; returns what it found. Exposed for the boot path and tests. */
  drain(): HookMiss[] {
    const misses = drainHookMisses(this.deps.missLogPath);
    if (misses.length === 0) return misses;
    this.total += misses.length;
    for (const miss of misses.slice(0, MAX_LOGGED_PER_DRAIN)) {
      log.warn("hook-delivery.missed", {
        taskId: miss.taskId,
        event: miss.event,
        at: miss.at,
        curlExit: miss.code,
      });
    }
    log.warn("hook-delivery.missed-total", {
      drained: misses.length,
      total: this.total,
      ...(misses.length > MAX_LOGGED_PER_DRAIN
        ? { unlogged: misses.length - MAX_LOGGED_PER_DRAIN }
        : {}),
    });
    return misses;
  }
}
