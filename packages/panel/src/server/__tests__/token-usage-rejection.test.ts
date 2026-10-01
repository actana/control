import { afterEach, describe, expect, it, vi } from "vitest";

// `syncTokenUsage` clears its single-flight slot with `p.finally(...)` (#600).
// That call makes a second promise which rejects whenever `p` does, and nothing
// listened to it: a failed sync was reported to the caller and, separately, as
// an unhandled rejection.

vi.mock("../repositories/tasks.repo", () => ({
  findTasksWithClaudeSessionId: () => {
    throw new Error("db unavailable");
  },
}));

describe("syncTokenUsage failure", () => {
  const listener = (reason: unknown) => unhandled.push(reason);
  const unhandled: unknown[] = [];

  afterEach(() => {
    process.off("unhandledRejection", listener);
    unhandled.length = 0;
  });

  it("rejects to the caller once, with no unhandled rejection left behind", async () => {
    const { syncTokenUsage, _resetSyncSingleton } = await import("../services/token-usage");
    _resetSyncSingleton();
    process.on("unhandledRejection", listener);

    await expect(syncTokenUsage()).rejects.toThrow("db unavailable");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(unhandled).toEqual([]);
    // The slot was released, so the next call starts a fresh run.
    await expect(syncTokenUsage()).rejects.toThrow("db unavailable");
  });
});
