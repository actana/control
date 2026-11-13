import { describe, expect, it } from "vitest";
import {
  AUTO_RETRY_MIN_RUN_MS,
  AUTO_RETRY_PROGRESS_RUN_MS,
  attemptShowedProgress,
  autoRetryBackoffMs,
  autoRetryCauseSignature,
  clampAutoRetryMaxAttempts,
  decideAutoRetry,
  exitCodeOfCause,
  formatAutoRetryComment,
  formatAutoRetryWaiting,
  newTaskAutoRetry,
  taskAutoRetryView,
  type AutoRetryDecisionInput,
} from "../auto-retry";

const MIN = 60_000;
function input(over: Partial<AutoRetryDecisionInput> = {}): AutoRetryDecisionInput {
  return {
    enabled: true,
    ceiling: 3,
    corePaused: false,
    autoRetry: newTaskAutoRetry(3),
    attemptCount: 1,
    runMs: 30 * MIN,
    progress: true,
    cause: "143|killed",
    exitCode: 143,
    ...over,
  };
}

describe("decideAutoRetry", () => {
  it("retries an opted-in Task whose attempt ran, made progress and failed the first time", () => {
    expect(decideAutoRetry(input())).toEqual({ kind: "retry", n: 2, max: 3, delayMs: MIN });
  });

  it("backs off 1, 5 then 15 minutes by the retries used", () => {
    expect([0, 1, 2, 3].map(autoRetryBackoffMs)).toEqual([MIN, 5 * MIN, 15 * MIN, 15 * MIN]);
    const second = decideAutoRetry(input({ attemptCount: 2, autoRetry: { ...newTaskAutoRetry(3), retries: 1, lastCause: "1|x" } }));
    expect(second).toMatchObject({ kind: "retry", n: 3, delayMs: 5 * MIN });
  });

  it("stops quietly when the kill switch is off, even for a Task that opted in", () => {
    expect(decideAutoRetry(input({ enabled: false }))).toEqual({ kind: "stop", reason: "disabled", message: null });
  });

  it("stops when the Core is paused, with a message only for a Task that opted in", () => {
    expect(decideAutoRetry(input({ corePaused: true }))).toMatchObject({ kind: "stop", reason: "core-paused", message: expect.stringContaining("paused") });
    expect(decideAutoRetry(input({ corePaused: true, autoRetry: null }))).toEqual({ kind: "stop", reason: "core-paused", message: null });
  });

  it("does nothing for a Task without autoRetry", () => {
    expect(decideAutoRetry(input({ autoRetry: null }))).toEqual({ kind: "stop", reason: "not-opted-in", message: null });
  });

  it("does not count an attempt shorter than 2 minutes (no message)", () => {
    expect(decideAutoRetry(input({ runMs: AUTO_RETRY_MIN_RUN_MS - 1 }))).toEqual({ kind: "stop", reason: "too-short", message: null });
    expect(decideAutoRetry(input({ runMs: AUTO_RETRY_MIN_RUN_MS })).kind).toBe("retry");
  });

  it("guard 1: stops at maxAttempts and at the instance ceiling", () => {
    expect(decideAutoRetry(input({ attemptCount: 3, autoRetry: { ...newTaskAutoRetry(3), retries: 1 } }))).toMatchObject({ kind: "stop", reason: "cap" });
    expect(decideAutoRetry(input({ attemptCount: 2, autoRetry: newTaskAutoRetry(2) }))).toMatchObject({ kind: "stop", reason: "cap" });
    expect(decideAutoRetry(input({ attemptCount: 2, ceiling: 2, autoRetry: newTaskAutoRetry(3) }))).toMatchObject({ kind: "stop", reason: "cap" });
    expect(decideAutoRetry(input({ attemptCount: 1, autoRetry: newTaskAutoRetry(1) }))).toMatchObject({ kind: "stop", reason: "cap" });
  });

  it("guard 2: stops when the attempt showed no progress, naming the attempt", () => {
    expect(decideAutoRetry(input({ progress: false, attemptCount: 2, autoRetry: { ...newTaskAutoRetry(3), retries: 1 } }))).toEqual({
      kind: "stop",
      reason: "no-progress",
      message: "Auto-retry stopped: no progress in attempt 2",
    });
  });

  it("guard 3: stops when the same exit code and last line repeat", () => {
    const autoRetry = { ...newTaskAutoRetry(3), retries: 1, lastCause: "143|killed" };
    expect(decideAutoRetry(input({ attemptCount: 2, autoRetry }))).toEqual({
      kind: "stop",
      reason: "same-cause",
      message: "Auto-retry stopped: the same exit twice (code 143)",
    });
    expect(decideAutoRetry(input({ attemptCount: 2, autoRetry, cause: "137|killed" })).kind).toBe("retry");
    expect(decideAutoRetry(input({ attemptCount: 2, autoRetry, cause: "143|other" })).kind).toBe("retry");
  });

  it("guard 4: the lineage total never exceeds ceiling - 1 retries", () => {
    expect(decideAutoRetry(input({ autoRetry: { ...newTaskAutoRetry(3, 2) } }))).toMatchObject({ kind: "stop", reason: "cap" });
    expect(decideAutoRetry(input({ autoRetry: { ...newTaskAutoRetry(3, 1) } })).kind).toBe("retry");
    expect(decideAutoRetry(input({ ceiling: 1 }))).toMatchObject({ kind: "stop", reason: "cap" });
  });

  it("applies the checks in order: kill switch before paused before opt-in before short before cap", () => {
    const worst = input({ enabled: false, corePaused: true, autoRetry: null, runMs: 1 });
    expect(decideAutoRetry(worst)).toMatchObject({ reason: "disabled" });
    expect(decideAutoRetry({ ...worst, enabled: true })).toMatchObject({ reason: "core-paused" });
    expect(decideAutoRetry({ ...worst, enabled: true, corePaused: false })).toMatchObject({ reason: "not-opted-in" });
    const optedIn = { ...worst, autoRetry: newTaskAutoRetry(1), enabled: true, corePaused: false };
    expect(decideAutoRetry(optedIn)).toMatchObject({ reason: "too-short" });
    expect(decideAutoRetry({ ...optedIn, runMs: 30 * MIN, progress: false })).toMatchObject({ reason: "cap" });
  });
});

describe("helpers", () => {
  it("progress is a comment, a file or a 10 minute run", () => {
    const none = { newComments: 0, newFiles: 0, runMs: 1 };
    expect(attemptShowedProgress(none)).toBe(false);
    expect(attemptShowedProgress({ ...none, newComments: 1 })).toBe(true);
    expect(attemptShowedProgress({ ...none, newFiles: 1 })).toBe(true);
    expect(attemptShowedProgress({ ...none, runMs: AUTO_RETRY_PROGRESS_RUN_MS - 1 })).toBe(false);
    expect(attemptShowedProgress({ ...none, runMs: AUTO_RETRY_PROGRESS_RUN_MS })).toBe(true);
  });

  it("clamps a request to the ceiling and says so", () => {
    expect(clampAutoRetryMaxAttempts(3, 2)).toEqual({ maxAttempts: 2, clamped: true });
    expect(clampAutoRetryMaxAttempts(2, 3)).toEqual({ maxAttempts: 2, clamped: false });
  });

  it("builds signatures, comments and views", () => {
    expect(autoRetryCauseSignature(null, " boom \n")).toBe("unknown|boom");
    expect(exitCodeOfCause("143|x")).toBe(143);
    expect(exitCodeOfCause("unknown|x")).toBeNull();
    expect(formatAutoRetryComment({ n: 2, max: 3, exitCode: null })).toBe("Auto-retry 2/3: previous Session exited (code unknown) without a result");
    expect(formatAutoRetryWaiting(10 * MIN, 0)).toBe("waiting: auto-retry in 10 min");
    expect(formatAutoRetryWaiting(1, 0)).toBe("waiting: auto-retry in 1 min");
    expect(taskAutoRetryView(null)).toBeNull();
    expect(taskAutoRetryView({ ...newTaskAutoRetry(2), notBefore: 5 })).toEqual({ maxAttempts: 2, retries: 0, pendingAt: 5, notice: null });
  });
});
