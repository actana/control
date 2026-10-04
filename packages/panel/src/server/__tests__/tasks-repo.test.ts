import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb } from "./_panel-test-db";

/**
 * Two owners, one table (#568, ADR 0041 D15). `operator` keeps `CHECK (id = 1)`,
 * so the test lifts it on its own throw-away database to put a second owner in.
 */

const testDb = await openPanelTestDb();
const { findCommentsForTask, insertComment } = await import("../repositories/task-comments.repo");
const { findTaskById, findTaskHistory, findTasks, insertTaskWithHistory, transitionTask } = await import(
  "../repositories/tasks.repo"
);

const A = 1;
const B = 2;

const task = (ownerId: number, id: string, status = "assigned") => ({
  id,
  ownerId,
  title: `task ${id}`,
  description: "",
  status,
  coreId: null,
  agent: null,
  attemptCount: 0,
  dispatchedAt: null,
  lastError: null,
  createdAt: 10,
  updatedAt: 10,
});
const comment = (ownerId: number, taskId: string, id: string, sourceFile: string | null = null) => ({
  id,
  taskId,
  ownerId,
  authorKind: sourceFile ? "agent" : "user",
  authorName: "n",
  sourceFile,
  body: "b",
  createdAt: 20,
});

beforeAll(async () => {
  await testDb.pool.query("alter table operator drop constraint operator_single_row");
  for (const id of [A, B]) {
    await testDb.pool.query(
      "insert into operator (id, name, password_hash, created_at, password_changed_at) values ($1, $2, 'h', 1, 1)",
      [id, `owner-${id}`],
    );
  }
  await insertTaskWithHistory(task(A, "a-1"), "h-a1");
  await insertTaskWithHistory(task(B, "b-1"), "h-b1");
  await insertComment(comment(A, "a-1", "k-a1"));
});

afterAll(async () => {
  await closePanelTestDb(testDb);
});

describe("Task repositories across owners", () => {
  it("lists and finds only the owner's Tasks", async () => {
    expect((await findTasks(A)).map((t) => t.id)).toEqual(["a-1"]);
    expect((await findTasks(B)).map((t) => t.id)).toEqual(["b-1"]);
    expect(await findTaskById(B, "a-1")).toBeNull();
    expect((await findTaskById(A, "a-1"))?.id).toBe("a-1");
  });

  it("shows owner B neither the comments nor the history of owner A's Task", async () => {
    expect((await findCommentsForTask(A, "a-1")).map((c) => c.id)).toEqual(["k-a1"]);
    expect(await findCommentsForTask(B, "a-1")).toEqual([]);
    expect((await findTaskHistory(A, "a-1")).length).toBe(1);
    expect(await findTaskHistory(B, "a-1")).toEqual([]);
  });

  it("refuses owner B's comment on owner A's Task, writing nothing", async () => {
    expect(await insertComment(comment(B, "a-1", "k-evil"))).toBeNull();
    expect((await findCommentsForTask(A, "a-1")).map((c) => c.id)).toEqual(["k-a1"]);
  });

  it("does not let owner B move owner A's Task, or comment through the move", async () => {
    const result = await transitionTask(B, "a-1", ["assigned"], "in_progress", 30, "h-evil", comment(B, "a-1", "k-evil2"));
    expect(result).toEqual({ kind: "missing" });
    expect((await findTaskById(A, "a-1"))?.status).toBe("assigned");
    expect(await findCommentsForTask(A, "a-1")).toHaveLength(1);
    expect(await findTaskHistory(A, "a-1")).toHaveLength(1);
  });

  it("lets owner A move their own Task", async () => {
    const result = await transitionTask(A, "a-1", ["assigned"], "in_progress", 30, "h-ok");
    expect(result.kind).toBe("ok");
    expect((await findTaskHistory(A, "a-1")).map((h) => [h.fromStatus, h.toStatus])).toEqual([
      [null, "assigned"],
      ["assigned", "in_progress"],
    ]);
  });
});
