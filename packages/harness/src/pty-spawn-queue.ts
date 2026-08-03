/**
 * Concurrency limiter for agent PTY cold-boots.
 *
 * A Panel opening a session grid asks for every pane at once; unthrottled, N
 * agent CLIs cold-boot simultaneously (each a full Node process) and the
 * machine grinds. `pty.spawn` returns as soon as the process forks, so limiting
 * the spawn call alone wouldn't stagger the load — instead each spawn HOLDS its
 * slot until the agent produces its first output (it's mostly booted by then)
 * or a settle timeout elapses, whichever comes first.
 *
 * This lives on the Harness, not the Panel: the cores being contended are the
 * ones the agents boot on, and a browser has no standing to know how many that
 * is (ADR 0010). It also means the limit holds across every Panel tab and every
 * operator pointed at this Core — the one place that can be true.
 *
 * The slot count scales with the machine: each cold boot pins roughly one core
 * (Node startup + JIT), so half the logical cores can boot agents while the
 * other half keeps the Harness and already-running agents responsive. Clamped
 * so a weak machine still makes progress two at a time and a many-core machine
 * doesn't stampede disk/memory with a dozen Node boots.
 */

import * as os from "node:os";

const MIN_SPAWN_SLOTS = 2;
const MAX_SPAWN_SLOTS = 6;

/** Slot is released this long after spawn even if the agent stays silent. */
export const SPAWN_SETTLE_MS = 2_500;

/** Spawn slots for a machine with `cores` logical cores (half, clamped 2–6). */
export function spawnConcurrencyFor(cores: number | undefined): number {
  if (!cores || !Number.isFinite(cores) || cores < 1) return MIN_SPAWN_SLOTS;
  return Math.min(MAX_SPAWN_SLOTS, Math.max(MIN_SPAWN_SLOTS, Math.floor(cores / 2)));
}

let maxConcurrentSpawns = spawnConcurrencyFor(os.cpus()?.length);

/** Test-only: pin the slot count (returns the previous value). */
export function setSpawnConcurrencyForTests(n: number): number {
  const prev = maxConcurrentSpawns;
  maxConcurrentSpawns = n;
  return prev;
}

let active = 0;
const waiters: Array<() => void> = [];

/**
 * Wait for a spawn slot. Resolves to a release function; callers MUST call it
 * exactly once (calling it again is a no-op) when the spawned agent has
 * settled — on first PTY output, on spawn failure, or on teardown.
 *
 * The releaser hands its slot directly to the next waiter (the count stays
 * occupied across the handoff), so a fresh acquirer can't slip in between a
 * release and the wake-up.
 */
export async function acquireSpawnSlot(): Promise<() => void> {
  if (active < maxConcurrentSpawns) {
    active += 1;
  } else {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waiters.shift();
    if (next) next();
    else active -= 1;
  };
}
