import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_API_KEY_PERMISSIONS } from "~/shared/api-key-permissions";
import { closePanelTestDb, openPanelTestDb } from "./_panel-test-db";
import { McpTestClient, dataOf, textOf } from "./_mcp-client";

/**
 * `/api/v1/tasks` and MCP `get_tasks` with `limit` and `cursor` (#896). REST without a limit
 * gets the list it always got, with full rows; with a limit, slim rows and a `nextCursor`.
 * MCP `get_tasks` is lean by default (#957): no `description` with or without a limit, and
 * `withDescriptions` only together with a limit of at most 10. REST `?fields=lean` has the MCP row shape.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-tasks-page-public-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const testDb = await openPanelTestDb();
const { operatorSessionCookie } = await import("./_operator-session");
const { createApiKey } = await import("../services/api-keys");

async function seed(id: string, status: string, updatedAt: number, coreId: string | null = null) {
  await testDb.pool.query(
    "insert into tasks (id, owner_id, title, description, status, core_id, created_at, updated_at) values ($1, 1, $2, 'the long text', $3, $4, 1, $5)",
    [id, `t ${id}`, status, coreId, updatedAt],
  );
}

async function rest(key: string, query = ""): Promise<Response> {
  const res = await handleApiRequest(
    new Request(`http://panel.example.test/api/v1/tasks${query}`, { headers: { authorization: `Bearer ${key}` } }),
  );
  if (!res) throw new Error("no api response");
  return res;
}

async function mcp(coreIds?: string[]): Promise<McpTestClient> {
  const { key } = await createApiKey(1, { name: "k", permissions: ALL_API_KEY_PERMISSIONS, ...(coreIds ? { coreIds } : {}) });
  const c = new McpTestClient(key);
  await c.connect();
  return c;
}

type Row = { id: string; description?: string };
type Listed = { tasks: Row[]; nextCursor?: string | null };

let fullKey: string;
let coreAKey: string;

beforeAll(async () => {
  await operatorSessionCookie();
  await testDb.pool.query(
    "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ('core-a', 1, 'a', 'https://a', 1, 1), ('core-b', 1, 'b', 'https://b', 1, 1)",
  );
  await seed("t-1", "draft", 10, "core-a");
  await seed("t-2", "draft", 20, "core-b");
  await seed("t-3", "done", 30, "core-a");
  await seed("t-4", "draft", 40, "core-a");
  await seed("t-5", "failed", 50, null);
  fullKey = (await createApiKey(1, { name: "full", permissions: ALL_API_KEY_PERMISSIONS })).key;
  coreAKey = (await createApiKey(1, { name: "a", permissions: ALL_API_KEY_PERMISSIONS, coreIds: ["core-a"] })).key;
});

afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("GET /api/v1/tasks", () => {
  it("without limit or cursor is the old shape: every Task, full rows, no nextCursor", async () => {
    const body = (await (await rest(fullKey)).json()) as Listed;
    expect(Object.keys(body)).toEqual(["tasks"]);
    expect(body.tasks).toHaveLength(5);
    expect(body.tasks.every((t) => t.description === "the long text")).toBe(true);
  });

  it("?fields=lean without a limit: every Task, rows without description, no nextCursor", async () => {
    const body = (await (await rest(fullKey, "?fields=lean")).json()) as Listed;
    expect(Object.keys(body)).toEqual(["tasks"]);
    expect(body.tasks).toHaveLength(5);
    expect(body.tasks.some((t) => "description" in t)).toBe(false);
  });

  it("?fields=lean rows have the MCP get_tasks row shape, and the default rows only add description", async () => {
    const lean = (await (await rest(fullKey, "?fields=lean")).json()) as Listed;
    const viaMcp = dataOf(await (await mcp()).call("get_tasks")) as Listed;
    expect(lean.tasks).toEqual(viaMcp.tasks);
    const full = (await (await rest(fullKey)).json()) as Listed;
    expect(Object.keys(full.tasks[0]!).sort()).toEqual([...Object.keys(lean.tasks[0]!), "description"].sort());
  });

  it("?fields=lean keeps filtering by sessionState and the key's Cores", async () => {
    const body = (await (await rest(coreAKey, "?fields=lean")).json()) as Listed;
    expect(body.tasks.map((t) => t.id).sort()).toEqual(["t-1", "t-3", "t-4"]);
    expect(body.tasks.some((t) => "description" in t)).toBe(false);
  });

  it("refuses a fields value other than lean", async () => {
    expect((await rest(fullKey, "?fields=full")).status).toBe(400);
    expect((await rest(fullKey, "?fields=")).status).toBe(400);
  });

  it("with limit returns slim rows, newest update first, and a nextCursor to the rest", async () => {
    const first = (await (await rest(fullKey, "?limit=2")).json()) as Listed;
    expect(first.tasks.map((t) => t.id)).toEqual(["t-5", "t-4"]);
    expect(first.tasks.some((t) => "description" in t)).toBe(false);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (await (await rest(fullKey, `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`)).json()) as Listed;
    expect(second.tasks.map((t) => t.id)).toEqual(["t-3", "t-2"]);
    const third = (await (await rest(fullKey, `?limit=2&cursor=${encodeURIComponent(second.nextCursor!)}`)).json()) as Listed;
    expect(third.tasks.map((t) => t.id)).toEqual(["t-1"]);
    expect(third.nextCursor).toBeNull();
  });

  it("pages only inside a restricted key's Cores", async () => {
    const first = (await (await rest(coreAKey, "?limit=2")).json()) as Listed;
    expect(first.tasks.map((t) => t.id)).toEqual(["t-4", "t-3"]);
    const second = (await (await rest(coreAKey, `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`)).json()) as Listed;
    expect(second.tasks.map((t) => t.id)).toEqual(["t-1"]);
    expect(second.nextCursor).toBeNull();
  });

  it("refuses a limit over 100 or under 1, a cursor it did not issue, and a cursor with no limit", async () => {
    expect((await rest(fullKey, "?limit=101")).status).toBe(400);
    expect((await rest(fullKey, "?limit=0")).status).toBe(400);
    expect((await rest(fullKey, "?limit=2&cursor=zzz")).status).toBe(400);
    expect((await rest(fullKey, "?limit=2&cursor=NToA")).status).toBe(400);
    expect((await rest(fullKey, "?cursor=abc")).status).toBe(400);
  });
});

describe("MCP get_tasks", () => {
  it("without limit or cursor is lean: every Task, no description, no nextCursor", async () => {
    const result = await (await mcp()).call("get_tasks");
    const data = dataOf(result) as Listed;
    expect(Object.keys(data)).toEqual(["tasks"]);
    expect(data.tasks).toHaveLength(5);
    expect(data.tasks.some((t) => "description" in t)).toBe(false);
  });

  it("does not carry the rows twice: the JSON text is there, structuredContent is not", async () => {
    const result = await (await mcp()).call("get_tasks");
    expect(result.content).toHaveLength(1);
    expect(result.structuredContent).toBeUndefined();
  });

  it("with limit returns slim rows and a nextCursor, and the cursor gets the next page", async () => {
    const c = await mcp();
    const first = dataOf(await c.call("get_tasks", { limit: 3 })) as Listed;
    expect(first.tasks.map((t) => t.id)).toEqual(["t-5", "t-4", "t-3"]);
    expect(first.tasks.some((t) => "description" in t)).toBe(false);
    const second = dataOf(await c.call("get_tasks", { limit: 3, cursor: first.nextCursor })) as Listed;
    expect(second.tasks.map((t) => t.id)).toEqual(["t-2", "t-1"]);
    expect(second.nextCursor).toBeNull();
  });

  it("filters by status and by Core while paging", async () => {
    const c = await mcp();
    const drafts = dataOf(await c.call("get_tasks", { status: "draft", limit: 2 })) as Listed;
    expect(drafts.tasks.map((t) => t.id)).toEqual(["t-4", "t-2"]);
    expect(drafts.nextCursor).toEqual(expect.any(String));
    const onA = dataOf(await c.call("get_tasks", { coreId: "core-a", limit: 10 })) as Listed;
    expect(onA.tasks.map((t) => t.id)).toEqual(["t-4", "t-3", "t-1"]);
  });

  it("still filters by status without a limit, with lean rows", async () => {
    const data = dataOf(await (await mcp()).call("get_tasks", { status: "done" })) as Listed;
    expect(data.tasks.map((t) => t.id)).toEqual(["t-3"]);
    expect("description" in data.tasks[0]!).toBe(false);
  });

  it("withDescriptions with a limit of 10 or less returns the descriptions, one page", async () => {
    const c = await mcp();
    const data = dataOf(await c.call("get_tasks", { withDescriptions: true, limit: 2 })) as Listed;
    expect(data.tasks.map((t) => t.id)).toEqual(["t-5", "t-4"]);
    expect(data.tasks.every((t) => t.description === "the long text")).toBe(true);
    expect(data.nextCursor).toEqual(expect.any(String));
    const edge = dataOf(await c.call("get_tasks", { withDescriptions: true, limit: 10 })) as Listed;
    expect(edge.tasks).toHaveLength(5);
    expect(edge.tasks.every((t) => t.description === "the long text")).toBe(true);
  });

  it("withDescriptions: false is the lean default", async () => {
    const data = dataOf(await (await mcp()).call("get_tasks", { withDescriptions: false, limit: 2 })) as Listed;
    expect(data.tasks.some((t) => "description" in t)).toBe(false);
  });

  it("refuses withDescriptions without a limit or with a limit over 10, saying why", async () => {
    const c = await mcp();
    for (const args of [{ withDescriptions: true }, { withDescriptions: true, limit: 11 }, { withDescriptions: true, limit: 100 }]) {
      const r = await c.call("get_tasks", args);
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/^400/);
      expect(textOf(r)).toContain("withDescriptions needs a limit of 10 or less");
    }
  });

  it("a row is under 1 KB for a Task with a 20 KB description, with and without a limit", async () => {
    await testDb.pool.query(
      "insert into tasks (id, owner_id, title, description, status, core_id, created_at, updated_at) values ('t-big', 1, 'big', $1, 'in_progress', 'core-a', 1, 5)",
      ["x".repeat(20 * 1024)],
    );
    try {
      const c = await mcp();
      for (const args of [{}, { limit: 10 }, { status: "in_progress", coreId: "core-a" }]) {
        const result = await c.call("get_tasks", args);
        const data = dataOf(result) as Listed;
        const big = data.tasks.find((t) => t.id === "t-big")!;
        expect(big).toBeDefined();
        expect("description" in big).toBe(false);
        expect(JSON.stringify(big).length).toBeLessThan(1024);
        expect(textOf(result)).not.toContain("xxxxxxxxxx");
      }
    } finally {
      await testDb.pool.query("delete from tasks where id = 't-big'");
    }
  });

  it("pages inside a restricted key's Cores and refuses a Core outside them", async () => {
    const c = await mcp(["core-a"]);
    const page = dataOf(await c.call("get_tasks", { limit: 10 })) as Listed;
    expect(page.tasks.map((t) => t.id)).toEqual(["t-4", "t-3", "t-1"]);
    expect((await c.call("get_tasks", { coreId: "core-b", limit: 10 })).isError).toBe(true);
  });

  it("refuses a limit over 100, a limit under 1 and a cursor it did not issue", async () => {
    const c = await mcp();
    for (const args of [{ limit: 101 }, { limit: 0 }]) {
      const r = await c.call("get_tasks", args);
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("invalid arguments");
    }
    const bad = await c.call("get_tasks", { limit: 2, cursor: "zzz" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/^400/);
  });
});
