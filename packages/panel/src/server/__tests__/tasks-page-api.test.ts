import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb } from "./_panel-test-db";

/**
 * `GET /api/tasks` with a column, a limit and a cursor, and `GET /api/tasks/counts` (#896),
 * as the browser calls them. With none of those parameters the list is the one it always was.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-tasks-page-api-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const testDb = await openPanelTestDb();
const { operatorSessionCookie } = await import("./_operator-session");

async function get(pathname: string, anonymous = false): Promise<Response> {
  const headers: Record<string, string> = {};
  if (!anonymous) headers.cookie = await operatorSessionCookie();
  const res = await handleApiRequest(new Request(`http://panel.example.test${pathname}`, { headers }));
  if (!res) throw new Error("no api response");
  return res;
}

async function seed(id: string, status: string, updatedAt: number, coreId: string | null = null, owner = 1) {
  await testDb.pool.query(
    "insert into tasks (id, owner_id, title, description, status, core_id, created_at, updated_at) values ($1, $2, $3, 'the long text', $4, $5, 1, $6)",
    [id, owner, `t ${id}`, status, coreId, updatedAt],
  );
}

type Page = { tasks: { id: string; description?: string }[]; nextCursor: string | null };

beforeAll(async () => {
  await operatorSessionCookie();
  await testDb.pool.query("alter table operator drop constraint operator_single_row");
  await testDb.pool.query(
    "insert into operator (id, name, password_hash, created_at, password_changed_at) values (2, 'owner-2', 'h', 1, 1)",
  );
  await testDb.pool.query(
    "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ('core-a', 1, 'a', 'https://a', 1, 1)",
  );
  for (let i = 1; i <= 12; i++) await seed(`d-${String(i).padStart(2, "0")}`, "draft", 100 + i);
  await seed("a-1", "assigned", 50, "core-a");
  await seed("f-done", "done", 10, "core-a");
  await seed("f-failed", "failed", 20);
  await seed("f-partial", "partial", 30);
  await seed("x-1", "draft", 999, null, 2);
});

afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("GET /api/tasks without paging parameters", () => {
  it("is the whole list with full rows and no nextCursor, as before", async () => {
    const body = (await (await get("/api/tasks")).json()) as { tasks: { id: string; description: string }[]; nextCursor?: unknown };
    expect(Object.keys(body)).toEqual(["tasks"]);
    expect(body.tasks).toHaveLength(16);
    expect(body.tasks.every((t) => t.description === "the long text")).toBe(true);
  });
});

describe("GET /api/tasks?column=", () => {
  it("returns 10 slim rows of a column with a nextCursor, then the rest", async () => {
    const first = (await (await get("/api/tasks?column=draft&limit=10")).json()) as Page;
    expect(first.tasks).toHaveLength(10);
    expect(first.tasks[0]!.id).toBe("d-12");
    expect("description" in first.tasks[0]!).toBe(false);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (await (await get(`/api/tasks?column=draft&limit=10&cursor=${encodeURIComponent(first.nextCursor!)}`)).json()) as Page;
    expect(second.tasks.map((t) => t.id)).toEqual(["d-02", "d-01"]);
    expect(second.nextCursor).toBeNull();
  });

  it("defaults the limit to 10", async () => {
    const page = (await (await get("/api/tasks?column=draft")).json()) as Page;
    expect(page.tasks).toHaveLength(10);
  });

  it("makes finished done, failed and partial together", async () => {
    const page = (await (await get("/api/tasks?column=finished")).json()) as Page;
    expect(page.tasks.map((t) => t.id)).toEqual(["f-partial", "f-failed", "f-done"]);
  });

  it("filters by Core", async () => {
    const page = (await (await get("/api/tasks?column=finished&coreId=core-a")).json()) as Page;
    expect(page.tasks.map((t) => t.id)).toEqual(["f-done"]);
  });

  it("refuses an unknown column, a bad limit and a cursor it did not issue with 400", async () => {
    expect((await get("/api/tasks?column=bogus")).status).toBe(400);
    expect((await get("/api/tasks?column=draft&limit=0")).status).toBe(400);
    expect((await get("/api/tasks?column=draft&limit=101")).status).toBe(400);
    expect((await get("/api/tasks?column=draft&limit=abc")).status).toBe(400);
    expect((await get("/api/tasks?column=draft&cursor=zzz")).status).toBe(400);
  });

  it("needs the operator's session", async () => {
    expect((await get("/api/tasks?column=draft", true)).status).toBe(401);
    expect((await get("/api/tasks/counts", true)).status).toBe(401);
  });
});

describe("GET /api/tasks/counts", () => {
  it("counts the owner's Tasks by status and by Core", async () => {
    const counts = await (await get("/api/tasks/counts")).json();
    expect(counts).toEqual({
      byStatus: { draft: 12, assigned: 1, done: 1, failed: 1, partial: 1 },
      byCore: { "core-a": { assigned: 1, done: 1 } },
    });
  });

  it("narrows to one Core with coreId", async () => {
    const counts = await (await get("/api/tasks/counts?coreId=core-a")).json();
    expect(counts.byStatus).toEqual({ assigned: 1, done: 1 });
  });
});
