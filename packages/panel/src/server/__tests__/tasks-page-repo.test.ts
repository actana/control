import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb } from "./_panel-test-db";

/**
 * Keyset paging and counts for the Tasks board (#896): `findTasksPage` and
 * `countTasks`, against the real migrations. Two owners and two Cores share the tables.
 */

const testDb = await openPanelTestDb();
const { countTasks, findTasksPage, insertTaskWithHistory } = await import("../repositories/tasks.repo");

const A = 1;
const B = 2;

const task = (
  ownerId: number,
  id: string,
  status: string,
  updatedAt: number,
  coreId: string | null = null,
) => ({
  id,
  ownerId,
  title: `task ${id}`,
  description: `long description of ${id}`,
  status,
  coreId,
  agent: null,
  attemptCount: 0,
  dispatchedAt: null,
  lastError: null,
  sessionState: null,
  sessionStateAt: null,
  autoRetry: null,
  timeoutMinutes: 60,
  createdAt: 1,
  updatedAt,
});

beforeAll(async () => {
  await testDb.pool.query("alter table operator drop constraint operator_single_row");
  for (const id of [A, B]) {
    await testDb.pool.query(
      "insert into operator (id, name, password_hash, created_at, password_changed_at) values ($1, $2, 'h', 1, 1)",
      [id, `owner-${id}`],
    );
  }
  for (const core of ["core-1", "core-2"]) {
    await testDb.pool.query(
      "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ($1, $2, $1, $3, 1, 1)",
      [core, A, `https://${core}`],
    );
  }
  const rows = [
    task(A, "d-1", "draft", 100, "core-1"),
    task(A, "d-2", "draft", 200, "core-2"),
    task(A, "d-3", "draft", 300),
    // Five Tasks with the same updatedAt: the id breaks the tie, descending.
    task(A, "e-1", "assigned", 500),
    task(A, "e-2", "assigned", 500),
    task(A, "e-3", "assigned", 500),
    task(A, "e-4", "assigned", 500),
    task(A, "e-5", "assigned", 500),
    task(A, "p-1", "in_progress", 600, "core-1"),
    task(A, "f-done", "done", 700, "core-1"),
    task(A, "f-failed", "failed", 800, "core-2"),
    task(A, "f-partial", "partial", 900, "core-1"),
    task(B, "b-1", "draft", 1000),
  ];
  for (const r of rows) await insertTaskWithHistory(r, `h-${r.id}`);
});

afterAll(async () => {
  await closePanelTestDb(testDb);
});

const ids = (page: { tasks: { id: string }[] }) => page.tasks.map((t) => t.id);

describe("findTasksPage", () => {
  it("returns at most `limit` rows, newest update first, with a nextCursor while more remain", async () => {
    const page = await findTasksPage(A, { statuses: ["draft"], limit: 2 });
    expect(ids(page)).toEqual(["d-3", "d-2"]);
    expect(page.nextCursor).toEqual(expect.any(String));
    const last = await findTasksPage(A, { statuses: ["draft"], limit: 2, cursor: page.nextCursor! });
    expect(ids(last)).toEqual(["d-1"]);
    expect(last.nextCursor).toBeNull();
  });

  it("has no nextCursor when the rows fit exactly in one page", async () => {
    const page = await findTasksPage(A, { statuses: ["draft"], limit: 3 });
    expect(ids(page)).toEqual(["d-3", "d-2", "d-1"]);
    expect(page.nextCursor).toBeNull();
  });

  it("leaves out description", async () => {
    const page = await findTasksPage(A, { statuses: ["draft"], limit: 1 });
    expect(page.tasks[0]).toBeDefined();
    expect("description" in page.tasks[0]!).toBe(false);
    expect(page.tasks[0]).toMatchObject({ id: "d-3", title: "task d-3", status: "draft", updatedAt: 300 });
  });

  it("continues across Tasks with an equal updatedAt without a gap or a repeat", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await findTasksPage(A, { statuses: ["assigned"], limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...ids(page));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(["e-5", "e-4", "e-3", "e-2", "e-1"]);
  });

  it("treats the finished column as done, failed and partial together", async () => {
    const page = await findTasksPage(A, { statuses: ["done", "failed", "partial"], limit: 10 });
    expect(ids(page)).toEqual(["f-partial", "f-failed", "f-done"]);
  });

  it("filters by Core", async () => {
    const page = await findTasksPage(A, { statuses: ["done", "failed", "partial"], coreId: "core-1", limit: 10 });
    expect(ids(page)).toEqual(["f-partial", "f-done"]);
  });

  it("limits to a set of Cores for a restricted key, leaving out Tasks with no Core", async () => {
    const page = await findTasksPage(A, { statuses: ["draft"], scopeCoreIds: ["core-2"], limit: 10 });
    expect(ids(page)).toEqual(["d-2"]);
    expect(ids(await findTasksPage(A, { statuses: ["draft"], scopeCoreIds: [], limit: 10 }))).toEqual([]);
  });

  it("without statuses pages across every status", async () => {
    const page = await findTasksPage(A, { limit: 100 });
    expect(page.tasks).toHaveLength(12);
    expect(page.tasks[0]!.id).toBe("f-partial");
  });

  it("never returns another owner's Task", async () => {
    expect(ids(await findTasksPage(B, { statuses: ["draft"], limit: 10 }))).toEqual(["b-1"]);
  });

  it("refuses a cursor it did not issue", async () => {
    await expect(findTasksPage(A, { limit: 2, cursor: "not-a-cursor" })).rejects.toThrow(/cursor/);
  });

  it("refuses a crafted cursor whose id Postgres would reject (NUL) as an invalid cursor, not a database error", async () => {
    const crafted = Buffer.from("5:\0").toString("base64url");
    await expect(findTasksPage(A, { limit: 2, cursor: crafted })).rejects.toThrow(/cursor/);
  });
});

describe("countTasks", () => {
  it("counts by status and by Core, for one owner", async () => {
    const counts = await countTasks(A);
    expect(counts.byStatus).toEqual({ draft: 3, assigned: 5, in_progress: 1, done: 1, failed: 1, partial: 1 });
    expect(counts.byCore).toEqual({
      "core-1": { draft: 1, in_progress: 1, done: 1, partial: 1 },
      "core-2": { draft: 1, failed: 1 },
    });
  });

  it("narrows to one Core", async () => {
    const counts = await countTasks(A, "core-1");
    expect(counts.byStatus).toEqual({ draft: 1, in_progress: 1, done: 1, partial: 1 });
  });
});
