import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "../../__tests__/_panel-test-db";

process.env.AC_SECRETS_KEY = "11".repeat(32);

const testDb = await openPanelTestDb();
const { resetSecretsKeyForTests } = await import("../secrets-at-rest");
const { createOperator } = await import("../operator");
const { insertTaskWithHistory } = await import("../../repositories/tasks.repo");
const { panelDb } = await import("~/db/panel-db-handle");
const { tasks, taskStatusHistory } = await import("~/db/pg-schema");
const { eq } = await import("drizzle-orm");
const {
  WATCH_GRACE_MS,
  NO_LIMIT_WATCH_TTL_MS,
  mintWatchToken,
  verifyWatchToken,
  watchExpiresAt,
  taskWatchToken,
  nextAttemptWatchToken,
  nextAttemptWatchExpiresAt,
  taskWatchUrl,
  readWatch,
  pollAfterSeconds,
} = await import("../task-watch");

const MIN = 60_000;
const T0 = 1_000_000_000_000;

beforeAll(async () => {
  await resetPanelState(testDb);
  await createOperator({ name: "Test Operator", password: "test-password" });
});
beforeEach(async () => {
  await panelDb().delete(tasks);
  delete process.env.AC_PANEL_PUBLIC_URL;
  process.env.AC_SECRETS_KEY = "11".repeat(32);
  resetSecretsKeyForTests();
});
afterAll(async () => {
  await closePanelTestDb(testDb);
});

type Over = Partial<typeof tasks.$inferInsert>;
async function seed(over: Over = {}) {
  const row = {
    id: "task-1",
    ownerId: 1,
    title: "SECRET TITLE",
    description: "SECRET DESCRIPTION",
    status: "in_progress",
    coreId: null,
    agent: null,
    attemptCount: 1,
    dispatchedAt: T0,
    lastError: null,
    sessionState: "working",
    sessionStateAt: T0 + 1000,
    autoRetry: null,
    timeoutMinutes: 60,
    createdAt: T0 - 1000,
    updatedAt: T0 + 1000,
    ...over,
  };
  await insertTaskWithHistory(row, `h-${row.id}-0`);
  return row;
}
/** Move the Task to a finished status at `at`, the way the service does: row plus a history row. */
async function finish(status: "done" | "failed" | "partial", at: number, over: Over = {}) {
  await panelDb()
    .update(tasks)
    .set({ status, updatedAt: at, sessionState: null, sessionStateAt: null, ...over })
    .where(eq(tasks.id, "task-1"));
  await panelDb()
    .insert(taskStatusHistory)
    .values({ id: `h-${status}-${at}`, taskId: "task-1", ownerId: 1, fromStatus: "in_progress", toStatus: status, changedAt: at });
}

describe("watch token", () => {
  it("round-trips taskId, attempt and expiresAt", () => {
    const token = mintWatchToken("task-1", 3, T0 + 5 * MIN);
    expect(token).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(verifyWatchToken(token)).toEqual({ taskId: "task-1", attempt: 3, expiresAt: T0 + 5 * MIN });
  });

  it("rejects a tampered signature, a tampered payload, and garbage", () => {
    const token = mintWatchToken("task-1", 1, T0 + MIN);
    const [payload, sig] = token.split(".");
    const flipped = `${payload}.${sig!.slice(0, -2)}${sig!.endsWith("AA") ? "BB" : "AA"}`;
    const other = Buffer.from("task-2.1." + (T0 + MIN)).toString("base64url");
    expect(verifyWatchToken(flipped)).toBeNull();
    expect(verifyWatchToken(`${other}.${sig}`)).toBeNull();
    expect(verifyWatchToken("")).toBeNull();
    expect(verifyWatchToken("nonsense")).toBeNull();
    expect(verifyWatchToken(`${payload}.`)).toBeNull();
  });

  it("accepts only the canonical spelling of a token", () => {
    const token = mintWatchToken("task-1", 1, T0 + MIN);
    const [payload, sig] = token.split(".") as [string, string];
    for (const variant of [`${token}=`, `${token}\n`, `${token}!`, `${payload}.${sig.slice(0, 5)}*${sig.slice(5)}`, ` ${token}`]) {
      expect(verifyWatchToken(variant)).toBeNull();
    }
    expect(verifyWatchToken(token)).not.toBeNull();
  });

  it("is bound to the Panel's secrets key", () => {
    const token = mintWatchToken("task-1", 1, T0 + MIN);
    process.env.AC_SECRETS_KEY = "22".repeat(32);
    resetSecretsKeyForTests();
    expect(verifyWatchToken(token)).toBeNull();
  });

  it("expires at the attempt's time limit plus 10 minutes", () => {
    expect(watchExpiresAt({ timeoutMinutes: 60, dispatchedAt: T0 }, T0 + 5)).toBe(T0 + 60 * MIN + WATCH_GRACE_MS);
    expect(WATCH_GRACE_MS).toBe(10 * MIN);
  });

  it("for No limit expires 24 hours from minting, and every mint is fresh", () => {
    const a = watchExpiresAt({ timeoutMinutes: null, dispatchedAt: T0 }, T0 + 100);
    const b = watchExpiresAt({ timeoutMinutes: null, dispatchedAt: T0 }, T0 + 7 * MIN);
    expect(a).toBe(T0 + 100 + NO_LIMIT_WATCH_TTL_MS);
    expect(NO_LIMIT_WATCH_TTL_MS).toBe(24 * 60 * MIN);
    expect(b).toBeGreaterThan(a);
    expect(mintWatchToken("task-1", 1, a)).not.toBe(mintWatchToken("task-1", 1, b));
  });
});

describe("taskWatchToken and taskWatchUrl", () => {
  it("mints for the Task's current attempt", async () => {
    const row = await seed({ attemptCount: 2 });
    const token = taskWatchToken(row, T0 + 10);
    expect(verifyWatchToken(token)).toMatchObject({ taskId: "task-1", attempt: 2, expiresAt: T0 + 70 * MIN });
  });

  it("builds the URL from the request origin when AC_PANEL_PUBLIC_URL is unset", () => {
    expect(taskWatchUrl("tok", "https://panel.internal:7420")).toBe("https://panel.internal:7420/api/watch/tok");
  });

  it("builds the URL from AC_PANEL_PUBLIC_URL when set, without doubling a trailing slash", () => {
    process.env.AC_PANEL_PUBLIC_URL = "https://actana.example.com/";
    expect(taskWatchUrl("tok", "http://127.0.0.1:7420")).toBe("https://actana.example.com/api/watch/tok");
    process.env.AC_PANEL_PUBLIC_URL = "https://actana.example.com/base";
    expect(taskWatchUrl("tok", "http://127.0.0.1:7420")).toBe("https://actana.example.com/base/api/watch/tok");
  });
});

describe("readWatch", () => {
  it("answers an active attempt with exactly the contract payload", async () => {
    const row = await seed();
    const token = taskWatchToken(row, T0 + 10);
    const read = await readWatch(token, T0 + 10 * 1000 + 40_000);
    expect(read).toEqual({
      kind: "ok",
      payload: {
        taskId: "task-1",
        attempt: 1,
        status: "in_progress",
        sessionState: "working",
        sessionStateAt: T0 + 1000,
        result: null,
        updatedAt: T0 + 1000,
        pollAfterSeconds: 5,
      },
    });
    expect(JSON.stringify(read)).not.toMatch(/SECRET|title|description|comment|report/i);
  });

  it("a bad signature is not-found", async () => {
    const row = await seed();
    const token = taskWatchToken(row, T0);
    expect(await readWatch(`${token}x`, T0)).toEqual({ kind: "not-found" });
    expect(await readWatch("junk", T0)).toEqual({ kind: "not-found" });
  });

  it("a new attempt makes the old token gone", async () => {
    const row = await seed();
    const old = taskWatchToken(row, T0);
    await panelDb().update(tasks).set({ attemptCount: 2 }).where(eq(tasks.id, "task-1"));
    expect(await readWatch(old, T0 + 1)).toEqual({ kind: "gone" });
  });

  it("a stopped Task is gone at once", async () => {
    const row = await seed();
    const token = taskWatchToken(row, T0);
    await finish("failed", T0 + 2000, { lastError: "Stopped by Operator." });
    expect(await readWatch(token, T0 + 2001)).toEqual({ kind: "gone" });
  });

  it("a deleted Task is gone", async () => {
    const row = await seed();
    const token = taskWatchToken(row, T0);
    await panelDb().delete(tasks).where(eq(tasks.id, "task-1"));
    expect(await readWatch(token, T0 + 1)).toEqual({ kind: "gone" });
  });

  it("a Task sent back to assigned is gone", async () => {
    const row = await seed();
    const token = taskWatchToken(row, T0);
    await panelDb().update(tasks).set({ status: "assigned", sessionState: null, sessionStateAt: null }).where(eq(tasks.id, "task-1"));
    expect(await readWatch(token, T0 + 1)).toEqual({ kind: "gone" });
  });

  it("past expiresAt is gone even while the attempt runs", async () => {
    const row = await seed();
    const token = taskWatchToken(row, T0);
    expect((await readWatch(token, T0 + 70 * MIN - 1)).kind).toBe("ok");
    expect(await readWatch(token, T0 + 70 * MIN)).toEqual({ kind: "gone" });
  });

  it("a finished attempt can be read for 10 minutes after it ended, then is gone", async () => {
    const row = await seed();
    const token = taskWatchToken(row, T0);
    await finish("done", T0 + 5 * MIN);
    const inside = await readWatch(token, T0 + 15 * MIN);
    expect(inside).toMatchObject({
      kind: "ok",
      payload: { status: "done", result: "done", sessionState: null, sessionStateAt: null, pollAfterSeconds: 0 },
    });
    expect(await readWatch(token, T0 + 15 * MIN + 1)).toEqual({ kind: "gone" });
  });

  it.each(["failed", "partial"] as const)("reports a %s result", async (status) => {
    const row = await seed();
    const token = taskWatchToken(row, T0);
    await finish(status, T0 + MIN);
    expect(await readWatch(token, T0 + 2 * MIN)).toMatchObject({ kind: "ok", payload: { status, result: status } });
  });

  it("a No-limit Task's older token keeps working until its own expiry", async () => {
    const row = await seed({ timeoutMinutes: null });
    const first = taskWatchToken(row, T0);
    const second = taskWatchToken(row, T0 + 3600_000);
    expect(second).not.toBe(first);
    expect((await readWatch(first, T0 + 23 * 3600_000)).kind).toBe("ok");
    expect(await readWatch(first, T0 + 24 * 3600_000)).toEqual({ kind: "gone" });
    expect((await readWatch(second, T0 + 24 * 3600_000)).kind).toBe("ok");
  });
});

describe("readWatch for an assigned Task (next-attempt token)", () => {
  const assigned = { status: "assigned", sessionState: null, sessionStateAt: null, attemptCount: 0, dispatchedAt: null } as const;

  it("answers the queued attempt with status assigned, no state, no result and a 5 s poll", async () => {
    const row = await seed(assigned);
    const token = nextAttemptWatchToken(row, T0);
    expect(await readWatch(token, T0 + 1000)).toEqual({
      kind: "ok",
      payload: {
        taskId: "task-1",
        attempt: 1,
        status: "assigned",
        sessionState: null,
        sessionStateAt: null,
        result: null,
        updatedAt: T0 + 1000,
        pollAfterSeconds: 5,
      },
    });
  });

  it("outlives a queue wait: the time limit, the No-limit window and the grace all count", () => {
    const limit = { id: "task-1", attemptCount: 0, timeoutMinutes: 60 };
    expect(nextAttemptWatchExpiresAt(limit, T0)).toBe(T0 + NO_LIMIT_WATCH_TTL_MS + 60 * MIN + WATCH_GRACE_MS);
    expect(nextAttemptWatchExpiresAt({ ...limit, timeoutMinutes: null }, T0)).toBe(T0 + NO_LIMIT_WATCH_TTL_MS + WATCH_GRACE_MS);
  });

  it("is the running attempt's token once dispatch raises attemptCount", async () => {
    const row = await seed(assigned);
    const token = nextAttemptWatchToken(row, T0);
    await panelDb()
      .update(tasks)
      .set({ status: "in_progress", attemptCount: 1, dispatchedAt: T0 + 5000, sessionState: "working", sessionStateAt: T0 + 6000 })
      .where(eq(tasks.id, "task-1"));
    expect(await readWatch(token, T0 + 7000)).toMatchObject({
      kind: "ok",
      payload: { attempt: 1, status: "in_progress", sessionState: "working", result: null },
    });
  });

  it("a Task moved back to draft is gone", async () => {
    const row = await seed(assigned);
    const token = nextAttemptWatchToken(row, T0);
    await panelDb().update(tasks).set({ status: "draft" }).where(eq(tasks.id, "task-1"));
    expect(await readWatch(token, T0 + 1)).toEqual({ kind: "gone" });
  });

  it("an assigned Task does not answer a token for any other attempt", async () => {
    const row = await seed({ ...assigned, attemptCount: 1 });
    expect(await readWatch(taskWatchToken(row, T0), T0 + 1)).toEqual({ kind: "gone" });
    expect(await readWatch(nextAttemptWatchToken({ ...row, attemptCount: 5 }, T0), T0 + 1)).toEqual({ kind: "gone" });
    expect((await readWatch(nextAttemptWatchToken(row, T0), T0 + 1)).kind).toBe("ok");
  });
});

describe("pollAfterSeconds", () => {
  const at = T0 + 1_000_000;
  const base = { status: "in_progress" as const, sessionState: "working" as const, sessionStateAt: at - 60_000 };
  it("is 5 while working", () => expect(pollAfterSeconds(base, at)).toBe(5));
  it("is 2 for 30 s after a state change", () => {
    expect(pollAfterSeconds({ ...base, sessionStateAt: at - 29_999 }, at)).toBe(2);
    expect(pollAfterSeconds({ ...base, sessionStateAt: at - 30_000 }, at)).toBe(5);
  });
  it("is 15 while needs-input or idle-no-result", () => {
    expect(pollAfterSeconds({ ...base, sessionState: "needs-input" }, at)).toBe(15);
    expect(pollAfterSeconds({ ...base, sessionState: "idle-no-result" }, at)).toBe(15);
  });
  it("is 0 once finished, whatever the state", () => {
    expect(pollAfterSeconds({ status: "done", sessionState: null, sessionStateAt: null }, at)).toBe(0);
    expect(pollAfterSeconds({ status: "failed", sessionState: "exited", sessionStateAt: at - 1 }, at)).toBe(0);
  });
  it("is 5 for a running attempt with no state yet", () => {
    expect(pollAfterSeconds({ status: "in_progress", sessionState: null, sessionStateAt: null }, at)).toBe(5);
  });
});
