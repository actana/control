import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";

/**
 * GET /api/watch/<token> (#950): the status URL of a Task attempt. Answered before the session gate, so every
 * call here carries no cookie and no key.
 */

process.env.AC_SECRETS_KEY = "33".repeat(32);

vi.mock("../repositories/task-watch.repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/task-watch.repo")>();
  return { ...actual, findTaskWatchRow: vi.fn(actual.findTaskWatchRow) };
});

const testDb = await openPanelTestDb();
const { handleApiRequest } = await import("../api-router");
const { createOperator } = await import("../services/operator");
const { insertTaskWithHistory } = await import("../repositories/tasks.repo");
const { taskWatchToken } = await import("../services/task-watch");
const { resetRateLimitsForTests } = await import("../services/rate-limits");
const { panelDb } = await import("~/db/panel-db-handle");
const { tasks } = await import("~/db/pg-schema");
const { eq } = await import("drizzle-orm");
const { findTaskWatchRow } = await import("../repositories/task-watch.repo");

const ORIGIN = "http://panel.example.test";

function get(token: string, method = "GET"): Request {
  return new Request(`${ORIGIN}/api/watch/${token}`, { method });
}

async function seed(id: string, over: Partial<typeof tasks.$inferInsert> = {}) {
  const now = Date.now();
  const row = {
    id,
    ownerId: 1,
    title: "SECRET TITLE",
    description: "SECRET DESCRIPTION",
    status: "in_progress",
    coreId: null,
    agent: null,
    attemptCount: 1,
    dispatchedAt: now - 1000,
    lastError: null,
    sessionState: "working",
    sessionStateAt: now - 60_000,
    timeoutMinutes: 60,
    createdAt: now - 2000,
    updatedAt: now - 500,
    ...over,
  };
  await insertTaskWithHistory(row, `h-${id}`);
  return row;
}

beforeAll(async () => {
  await resetPanelState(testDb);
  await createOperator({ name: "Test Operator", password: "test-password" });
});
beforeEach(async () => {
  await panelDb().delete(tasks);
  resetRateLimitsForTests();
  delete process.env.AC_TASK_WATCH_RATE_LIMIT_PER_MINUTE;
  delete process.env.AC_TASK_WATCH_GLOBAL_PER_MINUTE;
});
afterAll(async () => {
  await closePanelTestDb(testDb);
});

describe("GET /api/watch/<token>", () => {
  it("answers with no cookie and no key, no-store, JSON of exactly the contract", async () => {
    const row = await seed("t1");
    const res = await handleApiRequest(get(taskWatchToken(row)));
    expect(res?.status).toBe(200);
    expect(res?.headers.get("cache-control")).toBe("no-store");
    expect(res?.headers.get("content-type")).toContain("application/json");
    const body = await res!.json();
    expect(Object.keys(body).sort()).toEqual(
      ["attempt", "pollAfterSeconds", "result", "sessionState", "sessionStateAt", "status", "taskId", "updatedAt"],
    );
    expect(body).toMatchObject({ taskId: "t1", attempt: 1, status: "in_progress", sessionState: "working", result: null, pollAfterSeconds: 5 });
  });

  it("carries no title, description, comment or report text", async () => {
    const row = await seed("t2");
    const text = await (await handleApiRequest(get(taskWatchToken(row))))!.text();
    expect(text).not.toMatch(/SECRET|title|description|comment|report|lastError/i);
  });

  it("a finished Task answers its result", async () => {
    const row = await seed("t3");
    await panelDb().update(tasks).set({ status: "done", sessionState: null, sessionStateAt: null }).where(eq(tasks.id, "t3"));
    const { taskStatusHistory } = await import("~/db/pg-schema");
    await panelDb().insert(taskStatusHistory).values({ id: "h-t3-done", taskId: "t3", ownerId: 1, fromStatus: "in_progress", toStatus: "done", changedAt: Date.now() });
    const body = await (await handleApiRequest(get(taskWatchToken(row))))!.json();
    expect(body).toMatchObject({ status: "done", result: "done", pollAfterSeconds: 0 });
  });

  it("a bad signature is 404, no-store", async () => {
    const row = await seed("t4");
    const res = await handleApiRequest(get(`${taskWatchToken(row)}x`));
    expect(res?.status).toBe(404);
    expect(res?.headers.get("cache-control")).toBe("no-store");
  });

  it("a replaced attempt is 410, no-store", async () => {
    const row = await seed("t5");
    const token = taskWatchToken(row);
    await panelDb().update(tasks).set({ attemptCount: 2 }).where(eq(tasks.id, "t5"));
    const res = await handleApiRequest(get(token));
    expect(res?.status).toBe(410);
    expect(res?.headers.get("cache-control")).toBe("no-store");
  });

  it("an expired token is 410", async () => {
    const row = await seed("t6", { dispatchedAt: Date.now() - 2 * 60 * 60_000 });
    expect((await handleApiRequest(get(taskWatchToken(row))))?.status).toBe(410);
  });

  it("is a GET only route: POST falls through to the gate and is refused", async () => {
    const row = await seed("t7");
    expect((await handleApiRequest(get(taskWatchToken(row), "POST")))?.status).toBe(401);
  });

  it("a path with more segments is not a token", async () => {
    const row = await seed("t8");
    const res = await handleApiRequest(new Request(`${ORIGIN}/api/watch/${taskWatchToken(row)}/extra`));
    expect(res?.status).toBe(404);
  });
});

describe("a failing read", () => {
  it("is a 500 with no-store and writes no log line that holds the token", async () => {
    const token = taskWatchToken(await seed("t9"));
    vi.mocked(findTaskWatchRow).mockRejectedValueOnce(new Error("connection terminated"));
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      const res = await handleApiRequest(get(token));
      expect(res?.status).toBe(500);
      expect(res?.headers.get("cache-control")).toBe("no-store");
      expect(await res!.json()).toEqual({ error: "internal error" });
      const logged = spies.flatMap((spy) => spy.mock.calls).map((args) => args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(" "));
      expect(logged.join("\n")).not.toContain(token);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});

describe("rate limit", () => {
  it("the 31st call in a minute is 429 with Retry-After; another token is not affected", async () => {
    const a = taskWatchToken(await seed("ra"));
    const b = taskWatchToken(await seed("rb"));
    for (let i = 0; i < 30; i++) expect((await handleApiRequest(get(a)))?.status).toBe(200);
    const limited = await handleApiRequest(get(a));
    expect(limited?.status).toBe(429);
    expect(Number(limited?.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(limited?.headers.get("cache-control")).toBe("no-store");
    expect((await handleApiRequest(get(b)))?.status).toBe(200);
  });

  it("AC_TASK_WATCH_RATE_LIMIT_PER_MINUTE sets the per-token limit", async () => {
    process.env.AC_TASK_WATCH_RATE_LIMIT_PER_MINUTE = "2";
    const a = taskWatchToken(await seed("rc"));
    expect((await handleApiRequest(get(a)))?.status).toBe(200);
    expect((await handleApiRequest(get(a)))?.status).toBe(200);
    expect((await handleApiRequest(get(a)))?.status).toBe(429);
  });

  it("the global ceiling caps all tokens together, bad ones included", async () => {
    process.env.AC_TASK_WATCH_GLOBAL_PER_MINUTE = "3";
    const a = taskWatchToken(await seed("rd"));
    const b = taskWatchToken(await seed("re"));
    expect((await handleApiRequest(get(a)))?.status).toBe(200);
    expect((await handleApiRequest(get(b)))?.status).toBe(200);
    expect((await handleApiRequest(get("junk")))?.status).toBe(404);
    const limited = await handleApiRequest(get(b));
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get("retry-after")).toBeTruthy();
  });

  it("another spelling of a valid token is 404 and never gets a budget of its own", async () => {
    process.env.AC_TASK_WATCH_RATE_LIMIT_PER_MINUTE = "2";
    const a = taskWatchToken(await seed("rf"));
    expect((await handleApiRequest(get(a)))?.status).toBe(200);
    expect((await handleApiRequest(get(`${a}=`)))?.status).toBe(404);
    expect((await handleApiRequest(get(a)))?.status).toBe(200);
    expect((await handleApiRequest(get(`${a}=`)))?.status).toBe(404);
    expect((await handleApiRequest(get(a)))?.status).toBe(429);
  });

  it("a token that does not verify never gets a bucket of its own", async () => {
    process.env.AC_TASK_WATCH_RATE_LIMIT_PER_MINUTE = "1";
    for (let i = 0; i < 3; i++) expect((await handleApiRequest(get("junk")))?.status).toBe(404);
  });
});
