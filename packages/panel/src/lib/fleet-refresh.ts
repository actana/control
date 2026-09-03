// The primitives a fleet-wide refresh is built from, in one place.
//
// Two surfaces fan out to every Core and have to stay honest under a burst of
// events: the Fleet view's task list (`useFleetTasks`) and the rail's pinned
// projects (`core-pins-engine`). They read different frames, but the shape of
// the refresh is identical — coalesce a burst into one trailing pass, keep the
// previous object when a pass settles on the same answer, and poll slowly for
// what no event covers. Sharing that here is what keeps the fix for #389 from
// existing in two copies that drift.

/**
 * How often a fan-out re-reads its Cores, absent an event saying to.
 *
 * The event stream covers task, session and PTY lifecycle; this catches what
 * it does not — a missed frame, a Core that changed while the tab was asleep.
 */
export const FLEET_POLL_MS = 15_000;

/** Event kinds that change what a `tasksList` would return. */
export const TASK_EVENT_KINDS = /^(task:|session:|pty:)/;

/**
 * Structural equality for the plain, JSON-shaped values a fan-out settles on.
 *
 * Task and project snapshots are flat records of scalars, one optional nested
 * `lock` deep, held in arrays — so a recursive own-key walk is the whole of it,
 * and it is bounded by the same row count the merge just paid for. Nothing here
 * needs to handle a Date, a Map or a cycle, and it must not pretend to: it is
 * used only to answer "did this read change anything".
 */
export function sameSnapshot(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(right, key)) return false;
    if (!sameSnapshot(left[key], right[key])) return false;
  }
  return true;
}

/**
 * Wrap a refresh pass in the coalescing loop from #389.
 *
 * The naive guard — return early while a pass is in flight — drops whatever the
 * event announced: the read already in flight was launched before it, so its
 * answers cannot carry it, and the row stays running until the next poll. This
 * remembers the dropped call instead and runs exactly one trailing pass per
 * burst, looping while more arrive.
 *
 * `pass` returns whether it succeeded. A failed pass stops the loop rather than
 * spinning on the error, and leaves the pending flag as the burst left it —
 * clearing it there would drop the backlog on the error path, which is #389
 * again in miniature. The next event or the poll picks it up.
 *
 * The flags live in the closure, not in the caller, so a caller that rebuilds
 * its pass function does not reset them mid-burst.
 */
export function createCoalescingRunner(pass: () => Promise<boolean>): () => Promise<void> {
  let running = false;
  let pending = false;
  return async () => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      do {
        // Cleared before the read, not after: anything that arrives while this
        // very pass is in flight has to survive into the next one.
        pending = false;
        if (!(await pass())) break;
      } while (pending);
    } finally {
      running = false;
    }
  };
}
