import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";

/**
 * Public `/api/v1` REST API (#572 PR 2): a key restricted to Core A gets 403
 * on Core B across Cores, Agents, Tasks and comments, and a revoked key gets
 * 401 on every one of them. Built vertically first so the Done-when lines of
 * the issue are proven before the rest of the surface.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-public-api-test-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const testDb = await openPanelTestDb();
const { operatorSessionCookie, resetOperatorSessionForTests } = await import("./_operator-session");
const tasksService = await import("../services/tasks");

const ORIGIN = "http://panel.example.test";
const A = 1;
const B = 2;

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

const createKey = async (body: Record<string, unknown>) => {
  const res = await call("/api/api-keys", { method: "POST", json: body, cookie: true });
  expect(res.status).toBe(201);
  return (await res.json()) as { key: string; apiKey: { id: string } };
};

async function seedAgent(id: string, owner: number, coreId: string, name: string) {
  await testDb.pool.query(
    "insert into agents (id, owner_id, core_id, name, harness, flags, is_default, created_at, updated_at) values ($1,$2,$3,$4,'claude-code','{}',false,1,1)",
    [id, owner, coreId, name],
  );
}

async function seed() {
  await operatorSessionCookie();
  await testDb.pool.query("alter table operator drop constraint if exists operator_single_row");
  await testDb.pool.query(
    "insert into operator (id, name, password_hash, created_at, password_changed_at) values (2, 'B', 'h', 1, 1) on conflict do nothing",
  );
  for (const [id, owner] of [
    ["core-a", 1],
    ["core-b", 1],
    ["core-x", 2],
  ] as const) {
    await testDb.pool.query(
      "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ($1, $2, $1, $3, 1, 1)",
      [id, owner, `https://${id}`],
    );
  }
  await seedAgent("agent-a", A, "core-a", "Agent A");
  await seedAgent("agent-b", A, "core-b", "Agent B");
  await seedAgent("agent-x", B, "core-x", "Agent X");
}

beforeAll(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
});
beforeEach(async () => {
  await resetPanelState(testDb);
  resetOperatorSessionForTests();
  await seed();
});
afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("stub: the v1 path answers with a key", () => {
  it("lists Cores, Agents and Tasks end to end", async () => {
    const { key } = await createKey({ name: "all" });
    expect((await call("/api/v1/cores", { bearer: key })).status).toBe(200);
    expect((await call("/api/v1/agents", { bearer: key })).status).toBe(200);
    expect((await call("/api/v1/tasks", { bearer: key })).status).toBe(200);
  });
});

describe("a key restricted to Core A", () => {
  it("gets a 403 on Core B across Cores, Agents, Tasks and comments", async () => {
    const { key } = await createKey({ name: "a only", coreIds: ["core-a"] });
    const onB = await tasksService.createTask(A, {
      title: "on B",
      coreId: "core-b",
      agent: "agent-b",
    });
    await tasksService.addTaskComment(A, onB.id, {
      authorKind: "user",
      authorName: "op",
      body: "hi",
    });

    expect((await call("/api/v1/cores/core-b", { bearer: key })).status).toBe(403);
    expect((await call("/api/v1/cores/core-b/agents", { bearer: key })).status).toBe(403);
    expect((await call("/api/v1/agents/agent-b", { bearer: key })).status).toBe(403);
    expect((await call(`/api/v1/tasks/${onB.id}`, { bearer: key })).status).toBe(403);
    expect((await call(`/api/v1/tasks/${onB.id}/comments`, { bearer: key })).status).toBe(403);
    expect(
      (await call(`/api/v1/tasks/${onB.id}/comments`, { method: "POST", json: { body: "nope" }, bearer: key }))
        .status,
    ).toBe(403);
    expect(
      (await call(`/api/v1/tasks/${onB.id}/status`, { method: "POST", json: { status: "assigned" }, bearer: key }))
        .status,
    ).toBe(403);
    expect(
      (await call("/api/v1/tasks", { method: "POST", json: { title: "x", coreId: "core-b" }, bearer: key })).status,
    ).toBe(403);
    expect(
      (
        await call("/api/v1/agents", {
          method: "POST",
          json: { coreId: "core-b", name: "x", harness: "claude-code" },
          bearer: key,
        })
      ).status,
    ).toBe(403);
    expect((await call("/api/v1/agents/agent-b", { method: "DELETE", bearer: key })).status).toBe(403);

    // Same key reaches Core A.
    expect((await call("/api/v1/cores/core-a", { bearer: key })).status).toBe(200);
    expect((await call("/api/v1/agents/agent-a", { bearer: key })).status).toBe(200);
    const list = await call("/api/v1/cores", { bearer: key });
    expect(((await list.json()) as { cores: { id: string }[] }).cores.map((c) => c.id)).toEqual(["core-a"]);
    const agents = await call("/api/v1/agents", { bearer: key });
    expect(((await agents.json()) as { agents: { id: string }[] }).agents.map((a) => a.id)).toEqual(["agent-a"]);
  });

  it("lists only Core A's Tasks and never Core B's", async () => {
    const { key } = await createKey({ name: "a only", coreIds: ["core-a"] });
    const onA = await tasksService.createTask(A, { title: "on A", coreId: "core-a", agent: "agent-a" });
    const onB = await tasksService.createTask(A, { title: "on B", coreId: "core-b", agent: "agent-b" });
    const list = await call("/api/v1/tasks", { bearer: key });
    const ids = ((await list.json()) as { tasks: { id: string }[] }).tasks.map((t) => t.id);
    expect(ids).toContain(onA.id);
    expect(ids).not.toContain(onB.id);
  });
});

describe("a revoked key", () => {
  it("gets a 401 on every v1 resource", async () => {
    const { key, apiKey } = await createKey({ name: "all" });
    const task = await tasksService.createTask(A, { title: "t", coreId: "core-a", agent: "agent-a" });
    expect((await call("/api/v1/cores", { bearer: key })).status).toBe(200);
    expect((await call(`/api/api-keys/${apiKey.id}/revoke`, { method: "POST", cookie: true })).status).toBe(200);

    for (const [method, pathname, json] of [
      ["GET", "/api/v1/cores", undefined],
      ["GET", "/api/v1/cores/core-a", undefined],
      ["GET", "/api/v1/cores/core-a/agents", undefined],
      ["GET", "/api/v1/agents", undefined],
      ["GET", "/api/v1/agents/agent-a", undefined],
      ["DELETE", "/api/v1/agents/agent-a", undefined],
      ["GET", "/api/v1/tasks", undefined],
      ["POST", "/api/v1/tasks", { title: "x" }],
      ["GET", `/api/v1/tasks/${task.id}`, undefined],
      ["POST", `/api/v1/tasks/${task.id}/status`, { status: "assigned" }],
      ["GET", `/api/v1/tasks/${task.id}/comments`, undefined],
      ["POST", `/api/v1/tasks/${task.id}/comments`, { body: "x" }],
    ] as const) {
      const res = await call(pathname, { method, bearer: key, ...(json ? { json } : {}) });
      expect(res.status, `${method} ${pathname}`).toBe(401);
    }
  });
});

describe("two owners", () => {
  it("runs every call as the key's owner, never as the session beside it", async () => {
    const { createApiKey } = await import("../services/api-keys");
    const { key } = await createApiKey(B, { name: "owner-2" });
    const list = await call("/api/v1/cores", { bearer: key, cookie: true });
    expect(((await list.json()) as { cores: { id: string }[] }).cores.map((c) => c.id)).toEqual(["core-x"]);
    expect((await call("/api/v1/cores/core-a", { bearer: key, cookie: true })).status).toBe(404);
    expect((await call("/api/v1/agents/agent-a", { bearer: key, cookie: true })).status).toBe(404);
    const agents = await call("/api/v1/agents", { bearer: key, cookie: true });
    expect(((await agents.json()) as { agents: { id: string }[] }).agents.map((a) => a.id)).toEqual(["agent-x"]);
  });
});

describe("the session-cookie routes", () => {
  it("stay on their own path and do not accept a key for Tasks", async () => {
    const { key } = await createKey({ name: "k" });
    expect((await call("/api/tasks", { bearer: key })).status).toBe(403);
    expect((await call("/api/tasks", { cookie: true })).status).toBe(200);
    expect((await call("/api/v1/tasks", { cookie: true })).status).toBe(200);
  });
});
