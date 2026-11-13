import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionStatusesOnCore, STATUS_TIMEOUT_MS } from "../session-status";

/** The status read against a fake SDK client: no database, no Core. */

const linkOf = (sessionsList: () => Promise<unknown>) => () => ({ sdk: { sessionsList } as never });
const row = (sessionId: string, status: string) => ({ sessionId, ptyId: null, status, updatedAt: 1 });

describe("sessionStatusesOnCore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the status of each asked-for Session the Core lists, and only those", async () => {
    const list = vi.fn(async () => [row("a", "running"), row("b", "finished"), row("other", "running")]);
    expect(await sessionStatusesOnCore("core_1", ["a", "b", "gone"], linkOf(list))).toEqual(
      new Map([
        ["a", "running"],
        ["b", "finished"],
      ]),
    );
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("is null (no answer) when there is no live link, or the link has no SDK client", async () => {
    expect(await sessionStatusesOnCore("core_1", ["a"], () => null)).toBeNull();
    expect(await sessionStatusesOnCore("core_1", ["a"], () => ({}))).toBeNull();
  });

  it("is null, not thrown, when the list errors", async () => {
    expect(await sessionStatusesOnCore("core_1", ["a"], linkOf(async () => Promise.reject(new Error("boom"))))).toBeNull();
  });

  it("is null when the Core does not answer in time", async () => {
    const pending = sessionStatusesOnCore("core_1", ["a"], linkOf(() => new Promise(() => {})));
    await vi.advanceTimersByTimeAsync(STATUS_TIMEOUT_MS);
    expect(await pending).toBeNull();
  });
});
