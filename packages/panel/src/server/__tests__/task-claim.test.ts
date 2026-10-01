import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb } from "./_panel-test-db";

/**
 * The dispatcher's claim (#570): one conditional update takes an `assigned` Task
 * to `in_progress`, so two dispatchers that read the same Task cannot both start
 * it. On the real-Postgres CI job the pool has several connections, so the race
 * below is a real one; on PGlite the one connection serialises the two calls and
 * the conditional `WHERE status = 'assigned'` is what is left to hold.
 */

const testDb = await openPanelTestDb();
const { claimTask, createTask, getTask, failTaskDispatch, listTaskHistory, changeTaskStatus } = await import(
  "../services/tasks"
);
const { NotFoundError } = await import("../errors");

const A = 1;
const B = 2;

beforeAll(async () => {
  await testDb.pool.query("alter table operator drop constraint operator_single_row");
  for (const id of [A, B]) {
    await testDb.pool.query(
      "insert into operator (id, name, password_hash, created_at, password_changed_at) values ($1, $2, 'h', 1, 1)",
      [id, `owner-${id}`],
    );
  }
});
beforeEach(async () => {
  await testDb.pool.query("truncate tasks cascade");
});
afterAll(async () => {
  await closePanelTestDb(testDb);
});

describe("claiming an assigned Task", () => {
  it("lets exactly one of two racing dispatchers claim it", async () => {
    const task = await createTask(A, { title: "race", startNow: true });
    const results = await Promise.all([claimTask(A, task.id, 1_000), claimTask(A, task.id, 1_001)]);

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const after = await getTask(A, task.id);
    expect(after.status).toBe("in_progress");
    expect(after.attemptCount).toBe(1);
    const history = await listTaskHistory(A, task.id);
    expect(history.map((h) => `${h.fromStatus}>${h.toStatus}`)).toEqual(["null>assigned", "assigned>in_progress"]);
  });

  it("lets exactly one of many racing dispatchers claim it", async () => {
    const task = await createTask(A, { title: "crowd", startNow: true });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => claimTask(A, task.id, 2_000 + i)));

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect((await getTask(A, task.id)).attemptCount).toBe(1);
  });

  it("sets the status, the attempt count, the dispatch time and clears the last error, in the one update", async () => {
    const task = await createTask(A, { title: "fields", startNow: true });
    const claimed = await claimTask(A, task.id, 5_000);

    expect(claimed).toMatchObject({ status: "in_progress", attemptCount: 1, dispatchedAt: 5_000, lastError: null });
  });

  it("counts a second attempt after a finished Task is assigned again", async () => {
    const task = await createTask(A, { title: "again", startNow: true });
    await claimTask(A, task.id, 1_000);
    await failTaskDispatch(A, task.id, "boom", 1_500);
    expect((await getTask(A, task.id)).lastError).toBe("boom");
    await changeTaskStatus(A, task.id, "assigned", 2_000);

    const second = await claimTask(A, task.id, 3_000);

    expect(second).toMatchObject({ attemptCount: 2, dispatchedAt: 3_000, lastError: null });
  });

  it.each(["draft", "in_progress", "done", "failed", "partial"] as const)("does not claim a %s Task", async (status) => {
    const task = await createTask(A, { title: status });
    const path: Record<string, ("assigned" | "in_progress" | "done" | "failed" | "partial")[]> = {
      draft: [],
      in_progress: ["assigned", "in_progress"],
      done: ["assigned", "in_progress", "done"],
      failed: ["assigned", "in_progress", "failed"],
      partial: ["assigned", "in_progress", "partial"],
    };
    for (const step of path[status]!) await changeTaskStatus(A, task.id, step);

    expect(await claimTask(A, task.id, 9_000)).toBeNull();
    const after = await getTask(A, task.id);
    expect(after.status).toBe(status);
    expect(after.attemptCount).toBe(0);
    expect(after.dispatchedAt).toBeNull();
  });

  it("does not claim another owner's Task, and changes nothing of it", async () => {
    const task = await createTask(A, { title: "mine", startNow: true });

    expect(await claimTask(B, task.id, 1_000)).toBeNull();
    const after = await getTask(A, task.id);
    expect(after.status).toBe("assigned");
    expect(after.attemptCount).toBe(0);
    await expect(getTask(B, task.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("a failed dispatch", () => {
  it("moves the Task to failed with the reason as its last error and one system comment", async () => {
    const task = await createTask(A, { title: "nope", startNow: true });
    await claimTask(A, task.id, 1_000);

    const failed = await failTaskDispatch(A, task.id, "no Agent on this Task", 1_100);

    expect(failed).toMatchObject({ status: "failed", lastError: "no Agent on this Task" });
    const { listTaskComments } = await import("../services/tasks");
    const comments = await listTaskComments(A, task.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ authorKind: "system", sourceFile: null });
    expect(comments[0]!.body).toContain("no Agent on this Task");
  });

  it("is refused for a Task that is not in progress, writing nothing", async () => {
    const task = await createTask(A, { title: "still assigned", startNow: true });

    await expect(failTaskDispatch(A, task.id, "x", 1_000)).rejects.toMatchObject({ code: "illegal_task_transition" });
    const { listTaskComments } = await import("../services/tasks");
    expect(await listTaskComments(A, task.id)).toEqual([]);
    expect((await getTask(A, task.id)).lastError).toBeNull();
  });
});
