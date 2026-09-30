import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FINISH_RACE_WINDOW_MS,
  armDeferredFinish,
  clearSubagentActivity,
  disarmDeferredFinish,
  hasActiveSubagents,
  noteSubagentStart,
  noteSubagentStop,
  noteSessionFinished,
  sessionFinishedWithinRaceWindow,
} from "../services/subagent-activity";

const TTL_MS = 2 * 60 * 60 * 1000;
const RECHECK_MS = 60 * 1000;
const DRAIN_GRACE_MS = 3 * 60 * 1000;

const realNow = Date.now;

afterEach(() => {
  Date.now = realNow;
  vi.useRealTimers();
});

describe("subagent activity tracking", () => {
  it("tracks start/stop pairs by agent id", () => {
    const sessionId = "session-pairs";
    expect(hasActiveSubagents(sessionId)).toBe(false);

    noteSubagentStart(sessionId, "a");
    noteSubagentStart(sessionId, "b");
    expect(hasActiveSubagents(sessionId)).toBe(true);

    noteSubagentStop(sessionId, "a");
    expect(hasActiveSubagents(sessionId)).toBe(true);
    noteSubagentStop(sessionId, "b");
    expect(hasActiveSubagents(sessionId)).toBe(false);
  });

  it("is idempotent for repeated stops of the same subagent", () => {
    const sessionId = "session-idempotent";
    noteSubagentStart(sessionId, "a");
    // A resumed subagent can stop more than once; repeats must not underflow
    // and mask another still-active subagent.
    noteSubagentStop(sessionId, "a");
    noteSubagentStop(sessionId, "a");
    noteSubagentStart(sessionId, "b");
    noteSubagentStop(sessionId, "a");
    expect(hasActiveSubagents(sessionId)).toBe(true);
    noteSubagentStop(sessionId, "b");
    expect(hasActiveSubagents(sessionId)).toBe(false);
  });

  it("floors the anonymous count at zero", () => {
    const sessionId = "session-anon";
    noteSubagentStop(sessionId, undefined);
    expect(hasActiveSubagents(sessionId)).toBe(false);

    noteSubagentStart(sessionId, undefined);
    noteSubagentStart(sessionId, undefined);
    noteSubagentStop(sessionId, undefined);
    expect(hasActiveSubagents(sessionId)).toBe(true);
    noteSubagentStop(sessionId, undefined);
    expect(hasActiveSubagents(sessionId)).toBe(false);
  });

  it("expires stale entries so a lost SubagentStop cannot hold a session forever", () => {
    const sessionId = "session-ttl";
    noteSubagentStart(sessionId, "lost");
    noteSubagentStart(sessionId, undefined);
    expect(hasActiveSubagents(sessionId)).toBe(true);

    // Beyond the 2h TTL: the never-stopped entries stop counting as active.
    Date.now = () => realNow() + TTL_MS + 1;
    expect(hasActiveSubagents(sessionId)).toBe(false);
  });

  it("cross-cancels mismatched keyed/anonymous start-stop pairs", () => {
    // Keyed start, anonymous stop (payload-shape skew): any stop should
    // cancel SOME start, biased toward finishing.
    const skewA = "session-skew-a";
    noteSubagentStart(skewA, "a");
    noteSubagentStop(skewA, undefined);
    expect(hasActiveSubagents(skewA)).toBe(false);

    // Anonymous start, keyed stop.
    const skewB = "session-skew-b";
    noteSubagentStart(skewB, undefined);
    noteSubagentStop(skewB, "b");
    expect(hasActiveSubagents(skewB)).toBe(false);
  });

  it("clears all tracked subagents for a session", () => {
    const sessionId = "session-clear";
    noteSubagentStart(sessionId, "a");
    noteSubagentStart(sessionId, undefined);
    clearSubagentActivity(sessionId);
    expect(hasActiveSubagents(sessionId)).toBe(false);
  });
});

describe("deferred finish backstop", () => {
  it("finishes a held session once its never-stopped subagents expire", () => {
    vi.useFakeTimers();
    const sessionId = "session-backstop";
    const finished: string[] = [];
    noteSubagentStart(sessionId, "lost");
    armDeferredFinish(sessionId, (id) => finished.push(id));

    // While the entry is fresh, ticks wait — the subagent may be working.
    vi.advanceTimersByTime(RECHECK_MS * 3);
    expect(finished).toEqual([]);

    // Once the entry outlives the TTL with no SubagentStop, the set is idle;
    // after the drain grace passes with nothing new, promote.
    vi.advanceTimersByTime(TTL_MS + DRAIN_GRACE_MS + RECHECK_MS);
    expect(finished).toEqual([sessionId]);
    expect(hasActiveSubagents(sessionId)).toBe(false);

    // One-shot: no repeat promotions.
    vi.advanceTimersByTime(RECHECK_MS * 3);
    expect(finished).toEqual([sessionId]);
  });

  it("waits out the drain grace after real SubagentStops, then finishes", () => {
    vi.useFakeTimers();
    const sessionId = "session-real-stops";
    const finished: string[] = [];
    noteSubagentStart(sessionId, "a");
    armDeferredFinish(sessionId, (id) => finished.push(id));

    // A real stop usually means the main agent gets re-invoked and its own
    // Stop lands the finish — so the backstop must hold through the grace…
    noteSubagentStop(sessionId, "a");
    vi.advanceTimersByTime(RECHECK_MS * 2);
    expect(finished).toEqual([]);

    // …but when nothing follows (a post-turn helper's paired events, or a
    // re-invocation that never came), it must promote rather than leave the
    // session wedged on "running". The caller's finish guard makes this a no-op
    // whenever a real Stop already landed.
    vi.advanceTimersByTime(DRAIN_GRACE_MS + RECHECK_MS);
    expect(finished).toEqual([sessionId]);
  });

  it("resets the drain grace when a new subagent starts mid-grace", () => {
    vi.useFakeTimers();
    const sessionId = "session-grace-reset";
    const finished: string[] = [];
    noteSubagentStart(sessionId, "a");
    armDeferredFinish(sessionId, (id) => finished.push(id));
    noteSubagentStop(sessionId, "a");

    // Part-way into the grace, new work appears — the countdown must restart
    // around the live subagent instead of finishing under it.
    vi.advanceTimersByTime(RECHECK_MS * 2);
    noteSubagentStart(sessionId, "b");
    vi.advanceTimersByTime(DRAIN_GRACE_MS);
    expect(finished).toEqual([]);

    noteSubagentStop(sessionId, "b");
    vi.advanceTimersByTime(DRAIN_GRACE_MS + RECHECK_MS * 2);
    expect(finished).toEqual([sessionId]);
  });

  it("can be disarmed explicitly and by clearSubagentActivity", () => {
    vi.useFakeTimers();
    const sessionA = "session-disarm";
    const sessionB = "session-clear-disarm";
    const finished: string[] = [];
    noteSubagentStart(sessionA, "a");
    noteSubagentStart(sessionB, "b");
    armDeferredFinish(sessionA, (id) => finished.push(id));
    armDeferredFinish(sessionB, (id) => finished.push(id));

    disarmDeferredFinish(sessionA);
    clearSubagentActivity(sessionB);
    vi.advanceTimersByTime(TTL_MS + DRAIN_GRACE_MS + RECHECK_MS * 2);
    expect(finished).toEqual([]);
  });
});

describe("finish race window", () => {
  it("reports a finish as raced only within the window", () => {
    const sessionId = "session-finish-window";
    expect(sessionFinishedWithinRaceWindow(sessionId)).toBe(false);

    noteSessionFinished(sessionId);
    expect(sessionFinishedWithinRaceWindow(sessionId)).toBe(true);

    // Beyond the window, a subagent event is a post-turn helper, not a raced
    // lifecycle POST from the finished turn.
    Date.now = () => realNow() + FINISH_RACE_WINDOW_MS + 1;
    expect(sessionFinishedWithinRaceWindow(sessionId)).toBe(false);
  });

  it("stays at one second inclusive — a race window, not a grace period (issue 385)", () => {
    // The window was 30s, which let post-turn helper subagents resurrect a
    // finished card for half a minute after every finish. Widening it back to
    // absorb the hook curl's ~11s retry tail re-opens that bug — see
    // FINISH_RACE_WINDOW_MS and issue 440 for the residual that buys.
    expect(FINISH_RACE_WINDOW_MS).toBeLessThanOrEqual(1_000);
  });
});
