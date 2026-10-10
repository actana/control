import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALL_API_KEY_PERMISSIONS, type ApiKeyPermission } from "~/shared/api-key-permissions";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";
import { McpTestClient, textOf } from "./_mcp-client";

/**
 * Per-key permissions (#688), through the real router and the real MCP
 * server. The acceptance lines live here: a read-only key gets 200 on every
 * GET and 403 on every POST and DELETE; a key without `agents:write` cannot
 * create or delete Agents; the same holds for the `/mcp` tools; and a key's
 * permissions are chosen at creation, never defaulted.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-api-key-permissions-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const testDb = await openPanelTestDb();
const { operatorSessionCookie, resetOperatorSessionForTests } = await import("./_operator-session");
const { API_KEY_ROUTES } = await import("../api-key-auth");
const { MCP_TOOLS } = await import("../mcp-tools");
const { createApiKey } = await import("../services/api-keys");
const tasksService = await import("../services/tasks");

const ORIGIN = "http://panel.example.test";
const A = 1;

async function call(
  pathname: string,
  init: { method?: string; json?: unknown; cookie?: boolean; bearer?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = await operatorSessionCookie();
  if (init.bearer !== undefined) headers.authorization = `Bearer ${init.bearer}`;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const response = await handleApiRequest(
    new Request(`${ORIGIN}${pathname}`, {
      method: init.method ?? "GET",
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    }),
  );
  if (!response) throw new Error(`no API response for ${pathname}`);
  return response;
}

type Created = { key: string; apiKey: { id: string; permissions: ApiKeyPermission[] } };

async function createKey(body: Record<string, unknown>): Promise<Created> {
  const res = await call("/api/api-keys", { method: "POST", json: { name: "k", ...body }, cookie: true });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as Created;
}

const keyWith = (permissions: readonly ApiKeyPermission[]) => createKey({ permissions });

const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

let taskId: string;

beforeAll(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
});
beforeEach(async () => {
  await resetPanelState(testDb);
  resetOperatorSessionForTests();
  await operatorSessionCookie();
  await testDb.pool.query(
    "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ('core-a', 1, 'a', 'https://a', 1, 1)",
  );
  await testDb.pool.query(
    "insert into agents (id, owner_id, core_id, name, harness, flags, is_default, created_at, updated_at) values ('agent-a', 1, 'core-a', 'A', 'claude-code', '{}', false, 1, 1), ('agent-b', 1, 'core-a', 'B', 'claude-code', '{}', false, 1, 1)",
  );
  taskId = (await tasksService.createTask(A, { title: "t", coreId: "core-a" })).id;
});
afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** One concrete request per key route, so a loop over `API_KEY_ROUTES` proves each one. */
function sampleFor(method: string, pattern: RegExp): { path: string; json?: unknown } {
  const path = pattern.source
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\\\//g, "/")
    .replace(/\(\?!pairing\$\)\[\^\/\]\+/g, "core-a")
    .replace(/\[\^\/\]\+/g, (_, offset: number, whole: string) => {
      const before = whole.slice(0, offset);
      if (before.endsWith("/agents/")) return "agent-b";
      if (before.endsWith("/tasks/")) return taskId;
      return "core-a";
    });
  if (method === "GET" || method === "DELETE") return { path };
  if (path === "/api/v1/agents") return { path, json: { coreId: "core-a", name: "new", harness: "claude-code" } };
  if (path === "/api/v1/tasks") return { path, json: { title: "new task" } };
  if (path.endsWith("/status")) return { path, json: { status: "draft" } };
  if (path.endsWith("/comments")) return { path, json: { body: "hello" } };
  throw new Error(`no sample for ${method} ${path}`);
}

describe("a read-only key", () => {
  it("gets 200 on every GET route and 403 on every POST and DELETE route, naming the missing permission", async () => {
    const { key } = await keyWith(["read"]);
    const seen: string[] = [];
    for (const route of API_KEY_ROUTES) {
      const sample = sampleFor(route.method, route.pattern);
      const res = await call(sample.path, { method: route.method, bearer: key, ...(sample.json === undefined ? {} : { json: sample.json }) });
      seen.push(`${route.method} ${sample.path}`);
      if (route.method === "GET") {
        expect(res.status, `${route.method} ${sample.path}`).toBe(200);
      } else {
        expect(res.status, `${route.method} ${sample.path}`).toBe(403);
        expect(await errorOf(res)).toBe(`this API key lacks the ${route.permission} permission`);
      }
    }
    expect(seen.filter((s) => s.startsWith("POST ") || s.startsWith("DELETE ")).length).toBe(5);
    expect(seen.filter((s) => s.startsWith("GET ")).length).toBe(10);
    // Nothing was written: the 403 came from the gate, before any handler ran.
    expect((await testDb.pool.query("select count(*)::int as n from agents")).rows[0]).toEqual({ n: 2 });
    expect((await testDb.pool.query("select count(*)::int as n from tasks")).rows[0]).toEqual({ n: 1 });
    expect((await testDb.pool.query("select count(*)::int as n from task_comments")).rows[0]).toEqual({ n: 0 });
  });

  it("is still judged by the key alone: a non-key route is the same 403 as before, and revocation is a 401", async () => {
    const { key, apiKey } = await keyWith(["read"]);
    const settings = await call("/api/settings", { bearer: key });
    expect(settings.status).toBe(403);
    expect(await errorOf(settings)).toBe("this route does not accept an API key");
    expect((await call(`/api/api-keys/${apiKey.id}/revoke`, { method: "POST", cookie: true })).status).toBe(200);
    expect((await call("/api/v1/cores", { bearer: key })).status).toBe(401);
    expect((await call("/api/v1/tasks", { method: "POST", json: { title: "x" }, bearer: key })).status).toBe(401);
  });
});

describe("a key without agents:write", () => {
  it("cannot create or delete Agents, while the same key writes Tasks and reads Agents", async () => {
    const { key } = await keyWith(["read", "tasks:write"]);
    const created = await call("/api/v1/agents", {
      method: "POST",
      json: { coreId: "core-a", name: "new", harness: "claude-code" },
      bearer: key,
    });
    expect(created.status).toBe(403);
    expect(await errorOf(created)).toBe("this API key lacks the agents:write permission");
    const deleted = await call("/api/v1/agents/agent-b", { method: "DELETE", bearer: key });
    expect(deleted.status).toBe(403);
    expect(await errorOf(deleted)).toBe("this API key lacks the agents:write permission");
    expect((await testDb.pool.query("select count(*)::int as n from agents")).rows[0]).toEqual({ n: 2 });

    expect((await call("/api/v1/agents/agent-b", { bearer: key })).status).toBe(200);
    const task = await call("/api/v1/tasks", { method: "POST", json: { title: "mine" }, bearer: key });
    expect(task.status).toBe(201);
    const comment = await call(`/api/v1/tasks/${taskId}/comments`, { method: "POST", json: { body: "hi" }, bearer: key });
    expect(comment.status).toBe(201);
  });

  it("regression guard: a key with agents:write still deletes an Agent", async () => {
    const { key } = await keyWith(["agents:write"]);
    expect((await call("/api/v1/agents/agent-b", { method: "DELETE", bearer: key })).status).toBe(204);
    expect((await testDb.pool.query("select count(*)::int as n from agents")).rows[0]).toEqual({ n: 1 });
  });
});

describe("the permissions are independent", () => {
  it("a tasks:write-only key writes Tasks and reads nothing, not even the Task it made", async () => {
    const { key } = await keyWith(["tasks:write"]);
    const created = await call("/api/v1/tasks", { method: "POST", json: { title: "blind" }, bearer: key });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { task: { id: string } }).task.id;
    for (const p of ["/api/cores", "/api/v1/cores", "/api/v1/agents", "/api/v1/tasks", `/api/v1/tasks/${id}`]) {
      const res = await call(p, { bearer: key });
      expect(res.status, p).toBe(403);
      expect(await errorOf(res)).toBe("this API key lacks the read permission");
    }
  });

  it("the Core scope still applies on top: a read-only key outside its Cores gets the scope 403", async () => {
    await testDb.pool.query(
      "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ('core-b', 1, 'b', 'https://b', 1, 1)",
    );
    const { key } = await createKey({ permissions: ["read"], coreIds: ["core-b"] });
    expect((await call("/api/v1/cores/core-b", { bearer: key })).status).toBe(200);
    const other = await call("/api/v1/cores/core-a", { bearer: key });
    expect(other.status).toBe(403);
    expect(await errorOf(other)).toMatch(/does not reach/);
  });
});

describe("choosing the permissions at creation", () => {
  it("is required: no permissions, an empty list or an unknown one is a 400, and nothing is minted", async () => {
    for (const body of [{ name: "k" }, { name: "k", permissions: [] }, { name: "k", permissions: ["admin"] }, { name: "k", permissions: "read" }]) {
      const res = await call("/api/api-keys", { method: "POST", json: body, cookie: true });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await testDb.pool.query("select count(*)::int as n from api_keys")).rows[0]).toEqual({ n: 0 });
  });

  it("stores the chosen set once each, in canonical order, and shows it in the list and on the principal", async () => {
    const { apiKey, key } = await createKey({ permissions: ["agents:write", "read", "read"] });
    expect(apiKey.permissions).toEqual(["read", "agents:write"]);
    const listed = (await (await call("/api/api-keys", { cookie: true })).json()) as { apiKeys: { id: string; permissions: string[] }[] };
    expect(listed.apiKeys.find((k) => k.id === apiKey.id)?.permissions).toEqual(["read", "agents:write"]);
    const { rows } = await testDb.pool.query("select permissions from api_keys where id = $1", [apiKey.id]);
    expect(rows[0]).toEqual({ permissions: ["read", "agents:write"] });
    const { authenticateApiKey } = await import("../services/api-keys");
    expect([...(await authenticateApiKey(key))!.permissions]).toEqual(["read", "agents:write"]);
  });

  it("is checked by the service too, for a caller that is not the route", async () => {
    const { ValidationError } = await import("../errors");
    await expect(createApiKey(A, { name: "k", permissions: [] })).rejects.toBeInstanceOf(ValidationError);
    await expect(createApiKey(A, { name: "k", permissions: ["read", "nope"] })).rejects.toBeInstanceOf(ValidationError);
    expect((await createApiKey(A, { name: "k", permissions: ALL_API_KEY_PERMISSIONS })).apiKey.permissions).toEqual([
      "read",
      "tasks:write",
      "agents:write",
    ]);
  });
});

describe("the /mcp tools apply the same permissions", () => {
  const names = (tools: { name: string }[]) => tools.map((t) => t.name).sort();
  const readTools = MCP_TOOLS.filter((t) => t.permission === "read").map((t) => t.name).sort();
  const taskTools = MCP_TOOLS.filter((t) => t.permission === "tasks:write").map((t) => t.name).sort();

  it("every tool names the permission its REST route needs: reads are read, the Task writes are tasks:write", () => {
    expect(readTools).toEqual(["get_shared", "get_task", "get_tasks", "list_agents", "list_cores", "list_shared"]);
    expect(taskTools).toEqual(["assign_task", "comment_task", "create_task"]);
    for (const t of MCP_TOOLS) expect(t.readOnly, t.name).toBe(t.permission === "read");
  });

  it("lists a read-only key the read tools only, and refuses a write tool with a 403 that names the permission", async () => {
    const { key } = await keyWith(["read"]);
    const client = new McpTestClient(key);
    await client.connect();
    expect(names(await client.listTools())).toEqual(readTools);
    const cores = await client.call("list_cores");
    expect(cores.isError).toBeUndefined();
    const task = await client.call("get_task", { taskId });
    expect(task.isError).toBeUndefined();
    for (const [name, args] of [
      ["create_task", { title: "x" }],
      ["assign_task", { taskId, status: "draft" }],
      ["comment_task", { taskId, body: "hi" }],
    ] as const) {
      const result = await client.call(name, args);
      expect(result.isError, name).toBe(true);
      expect(textOf(result)).toBe("403 this API key lacks the tasks:write permission");
    }
    expect((await testDb.pool.query("select count(*)::int as n from tasks")).rows[0]).toEqual({ n: 1 });
    expect((await testDb.pool.query("select count(*)::int as n from task_comments")).rows[0]).toEqual({ n: 0 });
  });

  it("lists a tasks:write-only key the write tools only, and refuses the reads", async () => {
    const { key } = await keyWith(["tasks:write"]);
    const client = new McpTestClient(key);
    await client.connect();
    expect(names(await client.listTools())).toEqual(taskTools);
    const created = await client.call("create_task", { title: "from mcp" });
    expect(created.isError).toBeUndefined();
    for (const name of ["list_cores", "get_tasks", "list_shared"]) {
      const result = await client.call(name, name === "list_shared" ? { coreId: "core-a" } : {});
      expect(result.isError, name).toBe(true);
      expect(textOf(result)).toBe("403 this API key lacks the read permission");
    }
  });

  it("regression guard: a key with every permission lists and calls every tool as before", async () => {
    const { key } = await keyWith(ALL_API_KEY_PERMISSIONS);
    const client = new McpTestClient(key);
    await client.connect();
    expect(names(await client.listTools())).toEqual(MCP_TOOLS.map((t) => t.name).sort());
    expect((await client.call("create_task", { title: "x" })).isError).toBeUndefined();
    expect((await client.call("get_tasks")).isError).toBeUndefined();
  });
});
