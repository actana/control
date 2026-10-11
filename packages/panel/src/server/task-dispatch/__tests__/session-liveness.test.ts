import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveSessionsOnCore, LIVENESS_TIMEOUT_MS } from "../session-liveness";

/** The liveness probe against a fake SDK client: no database, no Core. */

const snap = (sessionId: string, ptyId: string | null) => ({ sessionId, ptyId, status: "running", updatedAt: 1 });
const linkOf = (sessionsList: () => Promise<unknown>) => () => ({ sdk: { sessionsList } as never });

describe("liveSessionsOnCore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the Sessions that have a live PTY, and only those", async () => {
    const list = vi.fn(async () => [snap("a", "pty_1"), snap("b", null), snap("c", "pty_3")]);
    expect(await liveSessionsOnCore("core_1", linkOf(list))).toEqual(new Set(["a", "c"]));
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("returns an empty set, not null, for a Core with no live Session", async () => {
    expect(await liveSessionsOnCore("core_1", linkOf(async () => []))).toEqual(new Set());
  });

  it("is null (no answer) when there is no live link, or the link has no SDK client", async () => {
    expect(await liveSessionsOnCore("core_1", () => null)).toBeNull();
    expect(await liveSessionsOnCore("core_1", () => ({}))).toBeNull();
  });

  it("is null, not thrown, when the Core errors", async () => {
    const list = async () => {
      throw new Error("link dropped");
    };
    expect(await liveSessionsOnCore("core_1", linkOf(list))).toBeNull();
  });

  it("is null when the link lookup itself throws", async () => {
    expect(
      await liveSessionsOnCore("core_1", () => {
        throw new Error("no manager");
      }),
    ).toBeNull();
  });

  it("is null when the Core does not answer in time", async () => {
    const pending = liveSessionsOnCore("core_1", linkOf(() => new Promise<never>(() => undefined)));
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(LIVENESS_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeNull();
  });
});
