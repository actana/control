import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveSessionsOnCore, LIVENESS_TIMEOUT_MS } from "../session-liveness";

/** The liveness probe against a fake SDK client: no database, no Core. */

const linkOf = (findBySession: (id: string) => Promise<unknown>) => () => ({ sdk: { findBySession } as never });
const pty = (map: Record<string, string | null>) => async (id: string) => ({ ptyId: map[id] ?? null });

describe("liveSessionsOnCore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the Sessions that have a PTY, and only those", async () => {
    const find = vi.fn(pty({ a: "pty_1", b: null, c: "pty_3" }));
    expect(await liveSessionsOnCore("core_1", ["a", "b", "c"], linkOf(find))).toEqual(new Set(["a", "c"]));
    expect(find).toHaveBeenCalledTimes(3);
  });

  it("returns an empty set, not null, when no Session has a PTY", async () => {
    expect(await liveSessionsOnCore("core_1", ["a"], linkOf(pty({})))).toEqual(new Set());
    expect(await liveSessionsOnCore("core_1", [], linkOf(pty({})))).toEqual(new Set());
  });

  it("is null (no answer) when there is no live link, or the link has no SDK client", async () => {
    expect(await liveSessionsOnCore("core_1", ["a"], () => null)).toBeNull();
    expect(await liveSessionsOnCore("core_1", ["a"], () => ({}))).toBeNull();
  });

  it("is null, not thrown, when any probe errors", async () => {
    const find = async (id: string) => {
      if (id === "b") throw new Error("link dropped");
      return { ptyId: "pty_1" };
    };
    expect(await liveSessionsOnCore("core_1", ["a", "b"], linkOf(find))).toBeNull();
  });

  it("probes every Session in parallel", async () => {
    const started: string[] = [];
    const find = (id: string) => {
      started.push(id);
      return new Promise<never>(() => undefined);
    };
    void liveSessionsOnCore("core_1", ["a", "b", "c"], linkOf(find));
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["a", "b", "c"]);
  });

  it("is null when the link lookup itself throws", async () => {
    expect(
      await liveSessionsOnCore("core_1", ["a"], () => {
        throw new Error("no manager");
      }),
    ).toBeNull();
  });

  it("is null when the probes do not all answer in time", async () => {
    const pending = liveSessionsOnCore("core_1", ["a"], linkOf(() => new Promise<never>(() => undefined)));
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
