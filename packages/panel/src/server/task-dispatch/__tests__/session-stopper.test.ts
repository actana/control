import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopSessionOnCore, STOP_TIMEOUT_MS } from "../session-stopper";

/** The stopper against a fake SDK client: no database, no Core. */

const TARGET = { coreId: "core_1", sessionId: "session_1" };

type Fake = {
  findBySession: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  forceTakeover: ReturnType<typeof vi.fn>;
};
const fake = (over: Partial<Fake> = {}): Fake => ({
  findBySession: vi.fn(async () => ({ ptyId: "pty_1" })),
  kill: vi.fn(async () => true),
  forceTakeover: vi.fn(async () => ({ supported: true, takenFrom: "other" })),
  ...over,
});
const linkOf = (sdk: Fake) => () => ({ sdk: sdk as never });

describe("stopSessionOnCore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is unreachable when there is no live link, or the link has no SDK client", async () => {
    expect(await stopSessionOnCore(TARGET, () => null)).toMatchObject({ outcome: "unreachable" });
    expect(await stopSessionOnCore(TARGET, () => ({}))).toMatchObject({ outcome: "unreachable" });
  });

  it("is not-running when the Core has no PTY for the Session", async () => {
    const sdk = fake({ findBySession: vi.fn(async () => ({ ptyId: null })) });
    expect(await stopSessionOnCore(TARGET, linkOf(sdk))).toEqual({ outcome: "not-running", detail: null });
    expect(sdk.kill).not.toHaveBeenCalled();
  });

  it("kills the PTY and is stopped", async () => {
    const sdk = fake();
    expect(await stopSessionOnCore(TARGET, linkOf(sdk))).toEqual({ outcome: "stopped", detail: null });
    expect(sdk.findBySession).toHaveBeenCalledWith("session_1");
    expect(sdk.kill).toHaveBeenCalledWith("pty_1");
    expect(sdk.forceTakeover).not.toHaveBeenCalled();
  });

  it("takes the lock over once when the Session is locked, then kills again", async () => {
    const locked = Object.assign(new Error("Another Core client holds this Session's lock"), { code: "session-locked" });
    const kill = vi.fn().mockRejectedValueOnce(locked).mockResolvedValueOnce(true);
    const sdk = fake({ kill });
    expect(await stopSessionOnCore(TARGET, linkOf(sdk))).toEqual({ outcome: "stopped", detail: null });
    expect(sdk.forceTakeover).toHaveBeenCalledWith("session_1");
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it("is failed when the kill is refused again after the takeover", async () => {
    const locked = Object.assign(new Error("locked"), { code: "session-locked" });
    const sdk = fake({ kill: vi.fn().mockRejectedValue(locked) });
    expect(await stopSessionOnCore(TARGET, linkOf(sdk))).toEqual({ outcome: "failed", detail: "locked" });
    expect(sdk.kill).toHaveBeenCalledTimes(2);
  });

  it("is failed when the Core says the kill did not happen", async () => {
    const sdk = fake({ kill: vi.fn(async () => false) });
    expect(await stopSessionOnCore(TARGET, linkOf(sdk))).toMatchObject({ outcome: "failed" });
  });

  it("is failed, not thrown, for any other error", async () => {
    const sdk = fake({ findBySession: vi.fn(async () => { throw new Error("link dropped"); }) });
    expect(await stopSessionOnCore(TARGET, linkOf(sdk))).toEqual({ outcome: "failed", detail: "link dropped" });
    expect(sdk.kill).not.toHaveBeenCalled();
  });

  it("is unreachable when the Core never answers", async () => {
    const sdk = fake({ findBySession: vi.fn(() => new Promise<never>(() => undefined)) });
    const pending = stopSessionOnCore(TARGET, linkOf(sdk));
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ outcome: "unreachable", detail: expect.stringContaining("10 seconds") });
  });
});
