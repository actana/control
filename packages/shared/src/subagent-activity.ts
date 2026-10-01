// Tracks which Claude Code subagents are still running, per session.
//
// Claude Code fires the top-level Stop hook when the FOREGROUND turn ends —
// including while background subagents it launched are still working. Each
// completion re-invokes the main agent, whose eventual Stop (with nothing
// left active here) is the session's real finish. The hooks controller
// records SubagentStart/SubagentStop here and downgrades a Stop to "running"
// while any subagent remains active, so the finish ding doesn't fire mid-work.
//
// Claude Code also runs internal helper agents AFTER a session finishes
// (away-summary generation on refocus, title helpers) whose subagent events
// carry the parent session id but precede no further Stop. A finished session is
// healed back to "running" only for work it can still plausibly be doing —
// a tracked subagent from the turn is still in flight, or the finish is
// younger than FINISH_RACE_WINDOW_MS (sessionFinishedWithinRaceWindow) — so those
// helpers cannot resurrect a finished card. The drain grace in
// armDeferredFinish un-wedges anything that still slips through.
//
// In-memory and bounded like the controller's other per-session maps: losing
// state (app restart) merely restores the legacy finish-on-Stop behavior.

const MAX_TRACKED_SESSIONS = 500;
const MAX_IDS_PER_SESSION = 512;

// Backstop for a SubagentStop that never arrives (lost POST, killed process):
// entries older than this stop counting as active, so a session can't be held on
// "running" forever. Kept long because its only cost is how long that rare
// wedge can last — while a SHORT ttl would prematurely finish sessions whose
// subagents legitimately run long (deep-research fan-outs).
const ACTIVE_SUBAGENT_TTL_MS = 2 * 60 * 60 * 1000;

// Cadence of the deferred-finish recheck armed when a Stop is held or a
// finished session was healed back to running by a subagent event.
const DEFERRED_FINISH_RECHECK_MS = 60 * 1000;

// Once a held/healed session's tracked subagents have all drained (real stops or
// expiry), wait this long for a main-agent Stop to land the finish itself
// before the backstop promotes the session. Long enough for a re-invoked main
// agent to compose its follow-up turn in the common case; short enough that a
// subagent event with no follow-up turn (Claude Code's internal helpers —
// away-summary generation and friends — fire SubagentStart/Stop with no Stop
// after) can't leave the session wedged on "running".
const DRAIN_FINISH_GRACE_MS = 3 * 60 * 1000;

// How long after a session finishes a subagent event can still be the turn's own
// lifecycle POST that LOST the race to the Stop POST. One second, inclusive
// (the comparison below is `<=`).
//
// Be honest about what this measures. It is sized on EMISSION: the Stop and
// the turn's own SubagentStart leave the same harness process microseconds
// apart. It is evaluated on ARRIVAL — noteSessionFinished stamps when the Stop
// POST was HANDLED, and the comparison runs when the subagent POST is handled.
// Delivery is not microseconds. The hook command in
// packages/core/src/harness-hooks.ts is
// `curl -sS -f -m 3 --retry 2 --retry-delay 1`, and its own comment puts the
// worst case at "about eleven seconds", triggered by "a Core busy serving PTY
// fan-out and SQLite writes" — precisely the condition a fan-out turn creates.
//
// So this window does NOT cover a retry-delayed in-turn SubagentStart. One
// that eats a `-m 3` timeout lands ~4s after a Stop that already wrote
// "finished": it finds an empty tracked set and a 4s-old finish, so it is
// dropped AND never tracked, and the card reads finished through a live
// fan-out with no backstop (every backstop here corrects a session stuck on
// "running", none corrects one stuck on "finished"). That is knowingly traded
// away — see issue 440, filed for the residual.
//
// The trade: the window was 30s (issue 385), which meant every post-turn
// helper subagent — the away-summary and title helpers Claude Code fires when
// the operator refocuses or clicks a just-finished pin — resurrected the
// finished card for half a minute after EVERY finish. Widening this back to
// absorb the ~11s retry budget puts a pin click at +5s inside it again and
// re-opens 385. A single scalar clock cannot tell a retry-delayed in-turn
// event from a post-turn helper, so one of the two has to lose; the
// operator-visible-on-every-finish one is the one that was fixed. Telling them
// apart needs evidence rather than elapsed time (a payload discriminator, an
// emission timestamp, or the W1 status arbiter) — issue 440 sketches those.
export const FINISH_RACE_WINDOW_MS = 1_000;

type SessionSubagents = {
  /** agent_id → start time, for payloads that identify the subagent. */
  ids: Map<string, number>;
  /** Count for payloads without agent_id (older Claude builds). */
  anonCount: number;
  /** Last change to anonCount, for TTL pruning. */
  anonTouchedAt: number;
};

type RecheckState = {
  timer: ReturnType<typeof setInterval>;
  /** When the tracked set was first seen idle; null while work is active. */
  idleSince: number | null;
};

const activeBySession = new Map<string, SessionSubagents>();
const recheckTimers = new Map<string, RecheckState>();

// Last hook-driven "finished" per session, for the recent-finish heal window.
// In-memory and bounded like activeBySession; losing it (app restart) just means
// subagent events on finished sessions stop healing until the next real finish —
// the safe direction for the away-summary class of post-turn helper events.
const finishedAtBySession = new Map<string, number>();

/** Record that a hook just landed this session on "finished". */
export function noteSessionFinished(sessionId: string): void {
  finishedAtBySession.delete(sessionId);
  finishedAtBySession.set(sessionId, Date.now());
  while (finishedAtBySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = finishedAtBySession.keys().next().value;
    if (oldest === undefined) break;
    finishedAtBySession.delete(oldest);
  }
}

/**
 * True only while a subagent event can still mean "the finished Stop raced the
 * turn's own subagent lifecycle POSTs" — one second inclusive, a race window
 * and not a grace period. It measures ARRIVAL, not emission; see
 * FINISH_RACE_WINDOW_MS above for what that costs. Unknown sessions report false:
 * after a restart the heal stays off until a real finish is observed again.
 */
export function sessionFinishedWithinRaceWindow(sessionId: string): boolean {
  const finishedAt = finishedAtBySession.get(sessionId);
  if (finishedAt === undefined) return false;
  return Date.now() - finishedAt <= FINISH_RACE_WINDOW_MS;
}

/**
 * Drop a session's recent-finish mark. Used when its session PROCESS died: no
 * re-invocation can follow a dead process, so a laggard subagent POST still in
 * flight must read as stale (ignored) rather than heal the session to "running"
 * — a heal there would wedge until the TTL, since its stop can never arrive.
 */
export function clearSessionFinished(sessionId: string): void {
  finishedAtBySession.delete(sessionId);
}

function touch(sessionId: string): SessionSubagents {
  let entry = activeBySession.get(sessionId);
  if (entry) {
    // Re-insert so insertion order approximates recency for the cap below.
    activeBySession.delete(sessionId);
  } else {
    entry = { ids: new Map(), anonCount: 0, anonTouchedAt: 0 };
  }
  activeBySession.set(sessionId, entry);
  while (activeBySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = activeBySession.keys().next().value;
    if (oldest === undefined) break;
    activeBySession.delete(oldest);
  }
  return entry;
}

export function noteSubagentStart(sessionId: string, harnessId: string | undefined): void {
  const entry = touch(sessionId);
  const now = Date.now();
  // Fresh activity ends any drain grace in progress — the set is live again.
  const recheck = recheckTimers.get(sessionId);
  if (recheck) recheck.idleSince = null;
  if (harnessId) {
    entry.ids.delete(harnessId);
    entry.ids.set(harnessId, now);
    while (entry.ids.size > MAX_IDS_PER_SESSION) {
      const oldest = entry.ids.keys().next().value;
      if (oldest === undefined) break;
      entry.ids.delete(oldest);
    }
  } else {
    entry.anonCount += 1;
    entry.anonTouchedAt = now;
  }
}

export function noteSubagentStop(sessionId: string, harnessId: string | undefined): void {
  const entry = activeBySession.get(sessionId);
  if (!entry) return;
  if (harnessId) {
    if (!entry.ids.delete(harnessId) && entry.anonCount > 0) {
      // Cross-cancel payload-shape skew (keyed stop after an anonymous
      // start): any stop should cancel SOME start, biased toward finishing.
      entry.anonCount -= 1;
      entry.anonTouchedAt = Date.now();
    }
  } else if (entry.anonCount > 0) {
    entry.anonCount -= 1;
    entry.anonTouchedAt = Date.now();
  } else {
    // Anonymous stop after keyed starts: cancel the oldest one.
    const oldest = entry.ids.keys().next().value;
    if (oldest !== undefined) entry.ids.delete(oldest);
  }
  if (isIdle(entry)) activeBySession.delete(sessionId);
}

export function hasActiveSubagents(sessionId: string): boolean {
  const entry = activeBySession.get(sessionId);
  if (!entry) return false;
  prune(entry);
  if (isIdle(entry)) {
    activeBySession.delete(sessionId);
    return false;
  }
  return true;
}

/**
 * Arm the "running with no Stop coming" backstop after a Stop was held on
 * "running", or after a finished session was healed back to "running" by a
 * subagent event.
 *
 * Each tick waits while tracked subagents are active. Once the set is idle —
 * emptied by real SubagentStops OR by expiry — a drain grace starts: if a
 * main-agent Stop lands the finish within it (the normal background-subagent
 * flow), the `finish` callback is a no-op for the caller (it guards on status
 * still being "running"). If nothing follows — a lost SubagentStop, or a
 * post-turn helper's subagent events that never precede another Stop — the
 * grace expires and `finish` promotes the session, so it can't stay wedged on
 * "running" forever.
 */
export function armDeferredFinish(sessionId: string, finish: (sessionId: string) => void): void {
  if (recheckTimers.has(sessionId)) return;
  const state: RecheckState = {
    timer: setInterval(() => {
      const entry = activeBySession.get(sessionId);
      if (entry) {
        prune(entry);
        if (!isIdle(entry)) {
          state.idleSince = null;
          return;
        }
        activeBySession.delete(sessionId);
      }
      const now = Date.now();
      if (state.idleSince === null) {
        state.idleSince = now;
        return;
      }
      if (now - state.idleSince < DRAIN_FINISH_GRACE_MS) return;
      disarmDeferredFinish(sessionId);
      finish(sessionId);
    }, DEFERRED_FINISH_RECHECK_MS),
    idleSince: null,
  };
  state.timer.unref?.();
  recheckTimers.set(sessionId, state);
}

/** Cancel a pending deferred finish (new user turn supersedes the held Stop). */
export function disarmDeferredFinish(sessionId: string): void {
  const state = recheckTimers.get(sessionId);
  if (state === undefined) return;
  clearInterval(state.timer);
  recheckTimers.delete(sessionId);
}

/** Drop all tracked subagents for a session (new session id = new Claude process). */
export function clearSubagentActivity(sessionId: string): void {
  activeBySession.delete(sessionId);
  disarmDeferredFinish(sessionId);
}

function prune(entry: SessionSubagents): void {
  const cutoff = Date.now() - ACTIVE_SUBAGENT_TTL_MS;
  for (const [id, startedAt] of entry.ids) {
    if (startedAt < cutoff) entry.ids.delete(id);
  }
  if (entry.anonCount > 0 && entry.anonTouchedAt < cutoff) entry.anonCount = 0;
}

function isIdle(entry: SessionSubagents): boolean {
  return entry.ids.size === 0 && entry.anonCount === 0;
}
