import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALL_API_KEY_PERMISSIONS } from "~/shared/api-key-permissions";
import { closePanelTestDb, openPanelTestDb, resetPanelState, seedWebhook } from "./_panel-test-db";
import { McpTestClient, dataOf } from "./_mcp-client";

/**
 * The surface of auto-retry (#958): the Panel's Task routes, `/api/v1` and MCP accept `autoRetry` and `fromTaskId`, say when a
 * request was clamped to the ceiling and expose the `autoRetry` view; the instance settings route reads and changes the kill
 * switch and the ceiling and resumes a paused Core. The policy itself is the service's and the engine's.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-auto-retry-surface-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const testDb = await openPanelTestDb();
const { operatorSessionCookie, resetOperatorSessionForTests } = await import("./_operator-session");
const tasksService = await import("../services/tasks");
const settings = await import("../services/auto-retry-settings");
const { createApiKey } = await import("../services/api-keys");

const A = 1;
const ORIGIN = "http://panel.example.test";

async function call(pathname: string, init: { method?: string; json?: unknown; session?: boolean; bearer?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.session !== false && init.bearer === undefined) headers.cookie = await operatorSessionCookie();
  if (init.bearer !== undefined) headers.authorization = `Bearer ${init.bearer}`;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const res = await handleApiRequest(
    new Request(`${ORIGIN}${pathname}`, {
      method: init.method ?? "GET",
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    }),
  );
  if (!res) throw new Error(`no API response for ${pathname}`);
  return res;
}
type Body = { task: { id: string; status: string; autoRetry: unknown }; autoRetryClamped?: unknown; error?: string };
const bodyOf = async (res: Response) => (await res.json()) as Body;

async function key(): Promise<string> {
  return (await createApiKey(A, { name: "k", permissions: ALL_API_KEY_PERMISSIONS })).key;
}

beforeAll(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
});
beforeEach(async () => {
  await resetPanelState(testDb);
  resetOperatorSessionForTests();
  await operatorSessionCookie();
  await testDb.pool.query(
    "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ('core-a', 1, 'Core A', 'https://a', 1, 1)",
  );
  await testDb.pool.query(
    "insert into agents (id, owner_id, core_id, name, harness, flags, is_default, created_at, updated_at) values ('agent-a', 1, 'core-a', 'A', 'claude-code', '{}', true, 1, 1)",
  );
  await seedWebhook(testDb, 1);
});
afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("Panel Task routes", () => {
  it("create takes autoRetry and returns the view; without it the Task has none", async () => {
    const on = await bodyOf(await call("/api/tasks", { method: "POST", json: { title: "t", autoRetry: { maxAttempts: 2 } } }));
    expect(on.task.autoRetry).toEqual({ maxAttempts: 2, retries: 0, pendingAt: null, notice: null });
    expect(on.autoRetryClamped).toBeUndefined();
    const off = await bodyOf(await call("/api/tasks", { method: "POST", json: { title: "t" } }));
    expect(off.task.autoRetry).toBeNull();
  });

  it("refuses an autoRetry outside 1 to 3 with 400", async () => {
    for (const autoRetry of [{ maxAttempts: 0 }, { maxAttempts: 4 }, { maxAttempts: 1.5 }, { maxAttempts: "2" }, {}]) {
      expect((await call("/api/tasks", { method: "POST", json: { title: "t", autoRetry } })).status, JSON.stringify(autoRetry)).toBe(400);
    }
  });

  it("clamps a request above the ceiling and says so with the ceiling", async () => {
    await settings.setAutoRetrySettings(A, { maxAttemptsCeiling: 2 });
    const res = await bodyOf(await call("/api/tasks", { method: "POST", json: { title: "t", autoRetry: { maxAttempts: 3 } } }));
    expect((res.task.autoRetry as { maxAttempts: number }).maxAttempts).toBe(2);
    expect(res.autoRetryClamped).toEqual({ requested: 3, ceiling: 2 });
  });

  it("create takes fromTaskId: a child of an auto-retry attempt gets no autoRetry", async () => {
    const parent = await tasksService.createTask(A, { title: "p", autoRetry: { maxAttempts: 3 } });
    await testDb.pool.query(
      `update tasks set auto_retry = '{"maxAttempts":3,"retries":1,"inherited":0,"notBefore":null,"lastCause":null,"notice":null}' where id = $1`,
      [parent.id],
    );
    const res = await bodyOf(
      await call("/api/tasks", { method: "POST", json: { title: "resume", autoRetry: { maxAttempts: 3 }, fromTaskId: parent.id } }),
    );
    expect(res.task.autoRetry).toBeNull();
  });

  it("update sets, changes and clears autoRetry at any status; the list and the page carry it", async () => {
    const t = await tasksService.createTask(A, { title: "t" });
    const set = await bodyOf(await call(`/api/tasks/${t.id}`, { method: "PATCH", json: { autoRetry: { maxAttempts: 3 } } }));
    expect(set.task.autoRetry).toMatchObject({ maxAttempts: 3, retries: 0 });
    const list = (await (await call("/api/tasks")).json()) as { tasks: { autoRetry: unknown }[] };
    expect(list.tasks[0]!.autoRetry).toMatchObject({ maxAttempts: 3 });
    const page = (await (await call("/api/tasks?limit=10")).json()) as { tasks: { autoRetry: unknown }[] };
    expect(page.tasks[0]!.autoRetry).toMatchObject({ maxAttempts: 3 });
    const cleared = await bodyOf(await call(`/api/tasks/${t.id}`, { method: "PATCH", json: { autoRetry: null } }));
    expect(cleared.task.autoRetry).toBeNull();
  });

  it("update with only autoRetry is accepted; an empty body is still refused", async () => {
    const t = await tasksService.createTask(A, { title: "t" });
    expect((await call(`/api/tasks/${t.id}`, { method: "PATCH", json: {} })).status).toBe(400);
    expect((await call(`/api/tasks/${t.id}`, { method: "PATCH", json: { autoRetry: { maxAttempts: 9 } } })).status).toBe(400);
  });

  it("update clamps and says so", async () => {
    await settings.setAutoRetrySettings(A, { maxAttemptsCeiling: 1 });
    const t = await tasksService.createTask(A, { title: "t" });
    const res = await bodyOf(await call(`/api/tasks/${t.id}`, { method: "PATCH", json: { autoRetry: { maxAttempts: 3 } } }));
    expect(res.autoRetryClamped).toEqual({ requested: 3, ceiling: 1 });
  });

  it("assign applies autoRetry first, then the status; null clears", async () => {
    const t = await tasksService.createTask(A, { title: "t", coreId: "core-a", agent: "agent-a" });
    const res = await bodyOf(await call(`/api/tasks/${t.id}/status`, { method: "POST", json: { status: "assigned", autoRetry: { maxAttempts: 2 } } }));
    expect(res.task.status).toBe("assigned");
    expect(res.task.autoRetry).toMatchObject({ maxAttempts: 2 });
    const back = await bodyOf(await call(`/api/tasks/${t.id}/status`, { method: "POST", json: { status: "draft", autoRetry: null } }));
    expect(back.task).toMatchObject({ status: "draft", autoRetry: null });
  });

  it("a refused move leaves autoRetry alone: assigning a running Task is a 409 and changes nothing", async () => {
    const t = await tasksService.createTask(A, { title: "t", coreId: "core-a", agent: "agent-a" });
    await testDb.pool.query("update tasks set status = 'in_progress' where id = $1", [t.id]);
    const res = await call(`/api/tasks/${t.id}/status`, { method: "POST", json: { status: "assigned", autoRetry: { maxAttempts: 2 } } });
    expect(res.status).toBe(409);
    expect((await tasksService.getTask(A, t.id)).autoRetry).toBeNull();
    const v1 = await call(`/api/v1/tasks/${t.id}/status`, { method: "POST", bearer: await key(), session: false, json: { status: "assigned", autoRetry: { maxAttempts: 2 } } });
    expect(v1.status).toBe(409);
    expect((await tasksService.getTask(A, t.id)).autoRetry).toBeNull();
  });

  it("a move to the status the Task already has is refused and leaves autoRetry alone", async () => {
    const t = await tasksService.createTask(A, { title: "t", coreId: "core-a", agent: "agent-a", startNow: true });
    const res = await call(`/api/tasks/${t.id}/status`, { method: "POST", json: { status: "assigned", autoRetry: { maxAttempts: 2 } } });
    expect(res.status).toBe(409);
    expect((await tasksService.getTask(A, t.id)).autoRetry).toBeNull();
    const v1 = await call(`/api/v1/tasks/${t.id}/status`, { method: "POST", bearer: await key(), session: false, json: { status: "assigned", autoRetry: { maxAttempts: 2 } } });
    expect(v1.status).toBe(409);
    expect((await tasksService.getTask(A, t.id)).autoRetry).toBeNull();
    await testDb.pool.query("update tasks set status = 'done' where id = $1", [t.id]);
    const toDraft = await call(`/api/tasks/${t.id}/status`, { method: "POST", json: { status: "draft", autoRetry: { maxAttempts: 2 } } });
    expect(toDraft.status).toBe(409);
    expect((await tasksService.getTask(A, t.id)).autoRetry).toBeNull();
  });

  it("assign without autoRetry leaves it alone", async () => {
    const t = await tasksService.createTask(A, { title: "t", coreId: "core-a", agent: "agent-a", autoRetry: { maxAttempts: 2 } });
    const res = await bodyOf(await call(`/api/tasks/${t.id}/status`, { method: "POST", json: { status: "assigned" } }));
    expect(res.task.autoRetry).toMatchObject({ maxAttempts: 2 });
  });

  it("shows a pending retry and its notice in the view", async () => {
    const t = await tasksService.createTask(A, { title: "t", autoRetry: { maxAttempts: 3 } });
    await testDb.pool.query(
      `update tasks set auto_retry = '{"maxAttempts":3,"retries":1,"inherited":0,"notBefore":5000,"lastCause":"1|x","notice":{"id":1,"kind":"retry","text":"Auto-retry 2/3"}}' where id = $1`,
      [t.id],
    );
    const res = await bodyOf(await call(`/api/tasks/${t.id}`));
    expect(res.task.autoRetry).toEqual({ maxAttempts: 3, retries: 1, pendingAt: 5000, notice: { id: 1, kind: "retry", text: "Auto-retry 2/3" } });
  });
});

describe("v1 Task routes", () => {
  it("create, get and list carry autoRetry; a clamp is reported", async () => {
    const k = await key();
    await settings.setAutoRetrySettings(A, { maxAttemptsCeiling: 2 });
    const res = await call("/api/v1/tasks", { method: "POST", bearer: k, json: { title: "t", autoRetry: { maxAttempts: 3 } } });
    expect(res.status).toBe(201);
    const body = await bodyOf(res);
    expect(body.task.autoRetry).toMatchObject({ maxAttempts: 2 });
    expect(body.autoRetryClamped).toEqual({ requested: 3, ceiling: 2 });
    const got = await bodyOf(await call(`/api/v1/tasks/${body.task.id}`, { bearer: k }));
    expect(got.task.autoRetry).toMatchObject({ maxAttempts: 2 });
    const list = (await (await call("/api/v1/tasks", { bearer: k })).json()) as { tasks: { autoRetry: unknown }[] };
    expect(list.tasks[0]!.autoRetry).toMatchObject({ maxAttempts: 2 });
    const page = (await (await call("/api/v1/tasks?limit=5", { bearer: k })).json()) as { tasks: { autoRetry: unknown }[] };
    expect(page.tasks[0]!.autoRetry).toMatchObject({ maxAttempts: 2 });
  });

  it("create refuses a bad autoRetry and takes fromTaskId", async () => {
    const k = await key();
    expect((await call("/api/v1/tasks", { method: "POST", bearer: k, json: { title: "t", autoRetry: { maxAttempts: 4 } } })).status).toBe(400);
    const parent = await tasksService.createTask(A, { title: "p", autoRetry: { maxAttempts: 3 } });
    await testDb.pool.query(
      `update tasks set auto_retry = '{"maxAttempts":3,"retries":2,"inherited":0,"notBefore":null,"lastCause":null,"notice":null}' where id = $1`,
      [parent.id],
    );
    const child = await bodyOf(
      await call("/api/v1/tasks", { method: "POST", bearer: k, json: { title: "c", autoRetry: { maxAttempts: 2 }, fromTaskId: parent.id } }),
    );
    expect(child.task.autoRetry).toBeNull();
  });

  it("fromTaskId is held to the key's Core scope: a parent on another Core, or an unknown one, is refused alike and nothing is created", async () => {
    await testDb.pool.query("insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ('core-b', 1, 'Core B', 'https://b', 1, 1)");
    const scoped = (await createApiKey(A, { name: "scoped", coreIds: ["core-a"], permissions: ALL_API_KEY_PERMISSIONS })).key;
    const other = await tasksService.createTask(A, { title: "on b", coreId: "core-b", autoRetry: { maxAttempts: 3 } });
    const mine = await tasksService.createTask(A, { title: "on a", coreId: "core-a" });
    const before = (await tasksService.listTasks(A)).length;
    for (const fromTaskId of [other.id, "task_does_not_exist"]) {
      const res = await call("/api/v1/tasks", { method: "POST", bearer: scoped, json: { title: "c", coreId: "core-a", autoRetry: { maxAttempts: 2 }, fromTaskId } });
      expect(res.status).toBe(403);
    }
    expect((await tasksService.listTasks(A)).length).toBe(before);
    // A parent inside the scope is still taken.
    const ok = await call("/api/v1/tasks", { method: "POST", bearer: scoped, json: { title: "c", coreId: "core-a", fromTaskId: mine.id } });
    expect(ok.status).toBe(201);
  });

  it("PATCH and the status move take autoRetry", async () => {
    const k = await key();
    const t = await tasksService.createTask(A, { title: "t", coreId: "core-a", agent: "agent-a" });
    const patched = await bodyOf(await call(`/api/v1/tasks/${t.id}`, { method: "PATCH", bearer: k, json: { autoRetry: { maxAttempts: 2 } } }));
    expect(patched.task.autoRetry).toMatchObject({ maxAttempts: 2 });
    const moved = await bodyOf(await call(`/api/v1/tasks/${t.id}/status`, { method: "POST", bearer: k, json: { status: "assigned", autoRetry: { maxAttempts: 1 } } }));
    expect(moved.task).toMatchObject({ status: "assigned", autoRetry: { maxAttempts: 1 } });
    const cleared = await bodyOf(await call(`/api/v1/tasks/${t.id}/status`, { method: "POST", bearer: k, json: { status: "draft", autoRetry: null } }));
    expect(cleared.task.autoRetry).toBeNull();
  });
});

describe("MCP tools", () => {
  async function client(): Promise<McpTestClient> {
    const c = new McpTestClient(await key());
    await c.connect();
    return c;
  }

  it("create_task, assign_task and update_task list autoRetry and name it in the description", async () => {
    const tools = await (await client()).listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ["create_task", "assign_task", "update_task"]) {
      const prop = byName[name]!.inputSchema.properties.autoRetry;
      expect(prop, name).toBeDefined();
      expect(byName[name]!.description, name).toContain("autoRetry");
      expect(JSON.stringify(prop), name).toContain("maxAttempts");
    }
    expect(byName.create_task!.inputSchema.properties.fromTaskId).toBeDefined();
    expect(byName.create_task!.inputSchema.properties.fromTaskId.description).toContain("your own Task");
    expect(byName.update_task!.inputSchema.required).toEqual(["taskId"]);
  });

  it("create_task stores autoRetry and reports a clamp", async () => {
    await settings.setAutoRetrySettings(A, { maxAttemptsCeiling: 2 });
    const c = await client();
    const data = dataOf(await c.call("create_task", { title: "t", autoRetry: { maxAttempts: 3 } }));
    expect(data.task.autoRetry).toMatchObject({ maxAttempts: 2 });
    expect(data.autoRetryClamped).toEqual({ requested: 3, ceiling: 2 });
    expect(dataOf(await c.call("create_task", { title: "u" })).task.autoRetry).toBeNull();
  });

  it("create_task refuses autoRetry outside 1 to 3", async () => {
    const c = await client();
    const res = await c.call("create_task", { title: "t", autoRetry: { maxAttempts: 4 } });
    expect(res.isError).toBe(true);
  });

  it("create_task with fromTaskId of an auto-retry attempt gets no autoRetry", async () => {
    const parent = await tasksService.createTask(A, { title: "p", autoRetry: { maxAttempts: 3 } });
    await testDb.pool.query(
      `update tasks set auto_retry = '{"maxAttempts":3,"retries":1,"inherited":0,"notBefore":null,"lastCause":null,"notice":null}' where id = $1`,
      [parent.id],
    );
    const data = dataOf(await (await client()).call("create_task", { title: "r", autoRetry: { maxAttempts: 3 }, fromTaskId: parent.id }));
    expect(data.task.autoRetry).toBeNull();
  });

  it("update_task takes only autoRetry, and null clears it", async () => {
    const t = await tasksService.createTask(A, { title: "t" });
    const c = await client();
    expect(dataOf(await c.call("update_task", { taskId: t.id, autoRetry: { maxAttempts: 3 } })).task.autoRetry).toMatchObject({ maxAttempts: 3 });
    expect(dataOf(await c.call("update_task", { taskId: t.id, autoRetry: null })).task.autoRetry).toBeNull();
  });

  it("assign_task applies autoRetry with the status", async () => {
    const t = await tasksService.createTask(A, { title: "t", coreId: "core-a", agent: "agent-a" });
    const data = dataOf(await (await client()).call("assign_task", { taskId: t.id, autoRetry: { maxAttempts: 2 } }));
    expect(data.task).toMatchObject({ status: "assigned", autoRetry: { maxAttempts: 2 } });
  });
});

describe("instance settings route", () => {
  it("needs the Operator's session, not a key", async () => {
    expect((await call("/api/settings/auto-retry", { session: false })).status).toBe(401);
    expect((await call("/api/settings/auto-retry", { bearer: await key() })).status).toBeGreaterThanOrEqual(401);
    expect((await call("/api/settings/auto-retry", { method: "PATCH", bearer: await key(), json: { enabled: false } })).status).toBeGreaterThanOrEqual(401);
  });

  it("reads the defaults", async () => {
    const res = await call("/api/settings/auto-retry");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, maxAttemptsCeiling: 3, pausedCores: [] });
  });

  it("PATCH changes the kill switch and the ceiling", async () => {
    const res = await call("/api/settings/auto-retry", { method: "PATCH", json: { enabled: false, maxAttemptsCeiling: 2 } });
    expect(await res.json()).toMatchObject({ enabled: false, maxAttemptsCeiling: 2 });
    expect(await settings.getAutoRetrySettings(A)).toEqual({ enabled: false, maxAttemptsCeiling: 2 });
    const one = await call("/api/settings/auto-retry", { method: "PATCH", json: { enabled: true } });
    expect(await one.json()).toMatchObject({ enabled: true, maxAttemptsCeiling: 2 });
  });

  it("PATCH refuses a ceiling outside 1 to 3, a non-boolean and unknown keys", async () => {
    for (const json of [{ maxAttemptsCeiling: 0 }, { maxAttemptsCeiling: 4 }, { maxAttemptsCeiling: 1.5 }, { enabled: "no" }, { other: 1 }]) {
      expect((await call("/api/settings/auto-retry", { method: "PATCH", json })).status, JSON.stringify(json)).toBe(400);
    }
    expect(await settings.getAutoRetrySettings(A)).toEqual({ enabled: true, maxAttemptsCeiling: 3 });
  });

  it("lists the paused Cores with their label and resumes one", async () => {
    const now = 1_000_000;
    await settings.recordCoreRetry(A, "core-a", now);
    await settings.recordCoreRetry(A, "core-a", now + 1);
    expect((await settings.recordCoreRetry(A, "core-a", now + 2)).tripped).toBe(true);
    const listed = (await (await call("/api/settings/auto-retry")).json()) as { pausedCores: unknown };
    expect(listed.pausedCores).toEqual([{ coreId: "core-a", label: "Core A" }]);
    const resumed = await call("/api/settings/auto-retry/cores/core-a/resume", { method: "POST" });
    expect(resumed.status).toBe(200);
    expect(((await resumed.json()) as { pausedCores: unknown }).pausedCores).toEqual([]);
    expect(await settings.isCorePaused(A, "core-a")).toBe(false);
  });

  it("resuming a Core that is not paused is a harmless no-op", async () => {
    const res = await call("/api/settings/auto-retry/cores/core-a/resume", { method: "POST" });
    expect(res.status).toBe(200);
  });
});
