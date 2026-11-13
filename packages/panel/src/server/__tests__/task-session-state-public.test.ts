import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ALL_API_KEY_PERMISSIONS } from "~/shared/api-key-permissions";
import { closePanelTestDb, openPanelTestDb } from "./_panel-test-db";
import { McpTestClient, dataOf, textOf } from "./_mcp-client";

/**
 * A Task's Session state and watch URL over REST and MCP (#951): `sessionState`, `sessionStateAt` and, for an
 * active attempt, `watch: { url, expiresAt, pollAfterSeconds }`; the `sessionState` filter; the instructions.
 */

process.env.AC_SECRETS_KEY = "44".repeat(32);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-task-session-state-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const testDb = await openPanelTestDb();
const { operatorSessionCookie } = await import("./_operator-session");
const { createApiKey } = await import("../services/api-keys");

const ORIGIN = "http://panel.example.test";
const NOW = Date.now();

async function seed(id: string, status: string, sessionState: string | null, updatedAt: number, coreId = "core-a") {
  await testDb.pool.query(
    `insert into tasks (id, owner_id, title, description, status, core_id, agent, attempt_count, dispatched_at, timeout_minutes,
       session_state, session_state_at, created_at, updated_at)
     values ($1, 1, $2, 'the long text', $3, $4, 'agent-a', 1, $5, 60, $6, $7, 1, $8)`,
    [
      id,
      `t ${id}`,
      status,
      coreId,
      NOW - 1000,
      sessionState,
      sessionState === null ? null : NOW - 60_000,
      updatedAt,
    ],
  );
}

async function rest(key: string, pathAndQuery: string, init: RequestInit = {}): Promise<Response> {
  const res = await handleApiRequest(
    new Request(`${ORIGIN}${pathAndQuery}`, { ...init, headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) } }),
  );
  if (!res) throw new Error("no api response");
  return res;
}

async function mcp(): Promise<McpTestClient> {
  const c = new McpTestClient(key);
  await c.connect();
  return c;
}

let key: string;

beforeAll(async () => {
  await operatorSessionCookie();
  await testDb.pool.query(
    "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ('core-a', 1, 'a', 'https://a', 1, 1)",
  );
  await testDb.pool.query(
    "insert into agents (id, owner_id, core_id, name, harness, flags, is_default, created_at, updated_at) values ('agent-a', 1, 'core-a', 'Agent A', 'claude-code', '{}', false, 1, 1)",
  );
  await seed("t-work", "in_progress", "working", 10);
  await seed("t-ask", "in_progress", "needs-input", 20);
  await seed("t-idle", "in_progress", "idle-no-result", 30);
  await seed("t-done", "done", null, 40);
  await seed("t-draft", "draft", null, 50);
  key = (await createApiKey(1, { name: "k", permissions: ALL_API_KEY_PERMISSIONS })).key;
});

afterEach(() => {
  delete process.env.AC_PANEL_PUBLIC_URL;
});

afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

type TaskBody = {
  task: Record<string, unknown> & { watch?: { url: string; expiresAt: number; pollAfterSeconds: number } };
};

describe("watch on a Task over REST", () => {
  it("an active Task carries a watch URL that the watch route accepts, with no key", async () => {
    const { task } = (await (await rest(key, "/api/v1/tasks/t-work")).json()) as TaskBody;
    expect(task.sessionState).toBe("working");
    expect(task.sessionStateAt).toEqual(expect.any(Number));
    expect(task.watch).toBeDefined();
    expect(task.watch!.url.startsWith(`${ORIGIN}/api/watch/`)).toBe(true);
    expect(task.watch!.expiresAt).toBeGreaterThan(Date.now());
    expect(task.watch!.pollAfterSeconds).toEqual(expect.any(Number));
    const watched = await handleApiRequest(new Request(task.watch!.url));
    expect(watched!.status).toBe(200);
    expect(await watched!.json()).toMatchObject({ taskId: "t-work", attempt: 1, status: "in_progress", sessionState: "working" });
  });

  it("builds the URL on AC_PANEL_PUBLIC_URL when it is set", async () => {
    process.env.AC_PANEL_PUBLIC_URL = "https://control.example.org/";
    const { task } = (await (await rest(key, "/api/v1/tasks/t-ask")).json()) as TaskBody;
    expect(task.watch!.url.startsWith("https://control.example.org/api/watch/")).toBe(true);
  });

  it("a finished or draft Task carries no watch, and still has sessionState null", async () => {
    for (const id of ["t-done", "t-draft"]) {
      const { task } = (await (await rest(key, `/api/v1/tasks/${id}`)).json()) as TaskBody;
      expect("watch" in task, id).toBe(false);
      expect(task.sessionState).toBeNull();
      expect(task.sessionStateAt).toBeNull();
    }
  });

  it("keeps every field a caller had before", async () => {
    const { task } = (await (await rest(key, "/api/v1/tasks/t-work")).json()) as TaskBody;
    for (const f of [
      "id", "title", "description", "status", "coreId", "agent", "attemptCount", "dispatchedAt",
      "lastError", "waiting", "timeoutMinutes", "createdAt", "updatedAt",
    ]) {
      expect(f in task, f).toBe(true);
    }
  });
});

describe("rows of a Task list", () => {
  it("carry sessionState and no watch, with and without limit", async () => {
    const all = (await (await rest(key, "/api/v1/tasks")).json()) as { tasks: Record<string, unknown>[] };
    const paged = (await (await rest(key, "/api/v1/tasks?limit=10")).json()) as { tasks: Record<string, unknown>[] };
    for (const rows of [all.tasks, paged.tasks]) {
      expect(rows).toHaveLength(5);
      for (const r of rows) {
        expect("sessionState" in r).toBe(true);
        expect("watch" in r).toBe(false);
      }
    }
  });
});

describe("the sessionState filter", () => {
  const ids = async (query: string) =>
    ((await (await rest(key, `/api/v1/tasks${query}`)).json()) as { tasks: { id: string }[] }).tasks.map((t) => t.id).sort();

  it("returns only Tasks in that state, one value or a comma list", async () => {
    expect(await ids("?sessionState=needs-input")).toEqual(["t-ask"]);
    expect(await ids("?sessionState=needs-input,idle-no-result")).toEqual(["t-ask", "t-idle"]);
  });

  it("filters in SQL under paging: a page is full of matches and nextCursor follows them", async () => {
    const first = (await (await rest(key, "/api/v1/tasks?sessionState=working,needs-input,idle-no-result&limit=2")).json()) as {
      tasks: { id: string }[];
      nextCursor: string | null;
    };
    expect(first.tasks.map((t) => t.id)).toEqual(["t-idle", "t-ask"]);
    const second = (await (
      await rest(key, `/api/v1/tasks?sessionState=working,needs-input,idle-no-result&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`)
    ).json()) as { tasks: { id: string }[]; nextCursor: string | null };
    expect(second.tasks.map((t) => t.id)).toEqual(["t-work"]);
    expect(second.nextCursor).toBeNull();
  });

  it("is rejected with 400 for an unknown value", async () => {
    const res = await rest(key, "/api/v1/tasks?sessionState=sleeping");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("sessionState");
    expect((await rest(key, "/api/v1/tasks?sessionState=working,nope")).status).toBe(400);
    expect((await rest(key, "/api/v1/tasks?sessionState=")).status).toBe(400);
  });
});

describe("MCP", () => {
  it("get_task returns the watch URL of an active Task and none for a finished one", async () => {
    const c = await mcp();
    const active = dataOf(await c.call("get_task", { taskId: "t-work" }));
    expect(active.task.sessionState).toBe("working");
    expect(active.task.watch.url.startsWith(`${ORIGIN}/api/watch/`)).toBe(true);
    const watched = await handleApiRequest(new Request(active.task.watch.url));
    expect(watched!.status).toBe(200);
    const done = dataOf(await c.call("get_task", { taskId: "t-done" }));
    expect("watch" in done.task).toBe(false);
    expect(done.task.sessionState).toBeNull();
  });

  it("create_task, assign_task and comment_task (reassign) return the Task with the new fields", async () => {
    const c = await mcp();
    const created = dataOf(await c.call("create_task", { title: "new", coreId: "core-a", agent: "agent-a", startNow: true }));
    expect(created.task).toMatchObject({ status: "assigned", sessionState: null, sessionStateAt: null });
    expect("watch" in created.task).toBe(false);
    const assigned = dataOf(await c.call("assign_task", { taskId: "t-draft", status: "assigned" }));
    expect(assigned.task).toMatchObject({ id: "t-draft", sessionState: null });
    const reassigned = dataOf(await c.call("comment_task", { taskId: "t-done", body: "again", reassign: true }));
    expect(reassigned.task).toMatchObject({ id: "t-done", sessionState: null });
    expect("sessionStateAt" in reassigned.task).toBe(true);
  });

  it("get_tasks rows carry sessionState and no watch, and filter by sessionState", async () => {
    const c = await mcp();
    const rows = dataOf(await c.call("get_tasks", { sessionState: "needs-input,idle-no-result" })).tasks as Record<string, unknown>[];
    expect(rows.map((r) => r.id).sort()).toEqual(["t-ask", "t-idle"]);
    for (const r of rows) {
      expect(r.sessionState).toEqual(expect.any(String));
      expect("watch" in r).toBe(false);
    }
    const page = dataOf(await c.call("get_tasks", { sessionState: "working", limit: 5 })).tasks as Record<string, unknown>[];
    expect(page.map((r) => r.id)).toEqual(["t-work"]);
  });

  it("get_tasks rejects an unknown sessionState", async () => {
    const result = await (await mcp()).call("get_tasks", { sessionState: "sleeping" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("sessionState");
  });

  it("the instructions and the tool descriptions point to the watch URL and get_guide", async () => {
    const c = await mcp();
    const init = await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    const text = init.result.instructions as string;
    expect(text).toContain("watch.url");
    expect(text).toContain("get_guide");
    expect(text).toMatch(/never.*loop.*get_task|loop.*get_task/i);
    for (const state of ["working", "needs-input", "interrupted", "idle-no-result", "exited"]) expect(text).toContain(state);
    expect(text).toContain("comment_task");
    const tools = await c.listTools();
    const by = (n: string) => tools.find((t) => t.name === n)!.description;
    for (const n of ["create_task", "get_task", "get_tasks"]) expect(by(n), n).toContain("watch");
    expect(by("get_tasks")).toContain("sessionState");
  });
});
