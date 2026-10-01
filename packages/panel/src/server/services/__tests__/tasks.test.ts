import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TASK_STATUSES, TASK_TRANSITIONS, type TaskStatus } from "~/shared/tasks";
import { closePanelTestDb, openPanelTestDb } from "../../__tests__/_panel-test-db";

const testDb = await openPanelTestDb();
const tasksService = await import("../tasks");
const { NotFoundError, ValidationError } = await import("../../errors");
const {
  DuplicateTaskCommentSourceError,
  IllegalTaskTransitionError,
  addTaskComment,
  changeTaskStatus,
  commentAndReassign,
  createTask,
  getTask,
  listTaskComments,
  listTaskHistory,
  listTasks,
} = tasksService;

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

/** A Task in `status`, reached only by legal moves. */
const PATH: Record<TaskStatus, TaskStatus[]> = {
  draft: [],
  assigned: ["assigned"],
  in_progress: ["assigned", "in_progress"],
  done: ["assigned", "in_progress", "done"],
  failed: ["assigned", "in_progress", "failed"],
  partial: ["assigned", "in_progress", "partial"],
};
async function taskIn(status: TaskStatus, owner = A) {
  const t = await createTask(owner, { title: "t" });
  for (const step of PATH[status]) await changeTaskStatus(owner, t.id, step);
  return t.id;
}

const LEGAL: [TaskStatus, TaskStatus][] = [
  ["draft", "assigned"],
  ["assigned", "draft"],
  ["assigned", "in_progress"],
  ["in_progress", "done"],
  ["in_progress", "failed"],
  ["in_progress", "partial"],
  ["done", "assigned"],
  ["failed", "assigned"],
  ["partial", "assigned"],
];
const ALL_PAIRS = TASK_STATUSES.flatMap((from) => TASK_STATUSES.map((to) => [from, to] as [TaskStatus, TaskStatus]));
const ILLEGAL = ALL_PAIRS.filter(([f, t]) => !LEGAL.some(([lf, lt]) => lf === f && lt === t));

describe("the status rules", () => {
  it("are exactly the nine legal moves of issue 568", () => {
    expect(TASK_STATUSES).toEqual(["draft", "assigned", "in_progress", "done", "failed", "partial"]);
    expect(Object.entries(TASK_TRANSITIONS).flatMap(([f, ts]) => ts.map((t) => `${f}>${t}`)).sort()).toEqual(
      LEGAL.map(([f, t]) => `${f}>${t}`).sort(),
    );
    expect(LEGAL.length + ILLEGAL.length).toBe(36);
  });

  it.each(LEGAL)("allows %s -> %s and records it in the history", async (from, to) => {
    const id = await taskIn(from);
    const moved = await changeTaskStatus(A, id, to, 500);
    expect(moved.status).toBe(to);
    expect(moved.updatedAt).toBe(500);
    expect((await getTask(A, id)).status).toBe(to);
    const history = await listTaskHistory(A, id);
    expect(history.at(-1)).toMatchObject({ fromStatus: from, toStatus: to, changedAt: 500 });
  });

  it.each(ILLEGAL)("rejects %s -> %s with a typed error and leaves the Task alone", async (from, to) => {
    const id = await taskIn(from);
    const before = await listTaskHistory(A, id);
    const err = await changeTaskStatus(A, id, to).catch((e) => e);
    expect(err).toBeInstanceOf(IllegalTaskTransitionError);
    expect(err).toMatchObject({ code: "illegal_task_transition", from, to });
    expect((await getTask(A, id)).status).toBe(from);
    expect(await listTaskHistory(A, id)).toEqual(before);
  });

  it("rejects a status that does not exist", async () => {
    const id = await taskIn("draft");
    await expect(changeTaskStatus(A, id, "cancelled" as TaskStatus)).rejects.toBeInstanceOf(ValidationError);
  });

  it("lets only one of two racing callers make the same move", async () => {
    const id = await taskIn("in_progress");
    const results = await Promise.allSettled([changeTaskStatus(A, id, "done"), changeTaskStatus(A, id, "failed")]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await listTaskHistory(A, id)).toHaveLength(4);
  });
});

describe("createTask", () => {
  it("creates a draft with its first history row", async () => {
    const t = await createTask(A, { title: "  write docs ", description: "d" }, 100);
    expect(t).toMatchObject({ title: "write docs", description: "d", status: "draft", attemptCount: 0, dispatchedAt: null, lastError: null });
    expect(await listTaskHistory(A, t.id)).toMatchObject([{ fromStatus: null, toStatus: "draft", changedAt: 100 }]);
  });

  it("creates it assigned in one call with Start now", async () => {
    const t = await createTask(A, { title: "go", agent: "reviewer", startNow: true }, 100);
    expect(t.status).toBe("assigned");
    expect(t.agent).toBe("reviewer");
    expect(await listTaskHistory(A, t.id)).toMatchObject([{ fromStatus: null, toStatus: "assigned" }]);
  });

  it("refuses an empty title, and a Core the owner does not have", async () => {
    await expect(createTask(A, { title: "  " })).rejects.toBeInstanceOf(ValidationError);
    await expect(createTask(A, { title: "t", coreId: "core_nope" })).rejects.toBeInstanceOf(NotFoundError);
    expect(await listTasks(A)).toEqual([]);
  });

  it("filters the list by status", async () => {
    await createTask(A, { title: "d" });
    await createTask(A, { title: "a", startNow: true });
    expect((await listTasks(A, ["assigned"])).map((t) => t.title)).toEqual(["a"]);
    expect(await listTasks(A)).toHaveLength(2);
  });
});

describe("comments", () => {
  it("records the author kind, name and, for an agent, the source file", async () => {
    const id = await taskIn("draft");
    await addTaskComment(A, id, { authorKind: "user", authorName: "Core", body: "hi" }, 1);
    await addTaskComment(A, id, { authorKind: "agent", authorName: "reviewer", body: "done", sourceFile: "out.md" }, 2);
    await addTaskComment(A, id, { authorKind: "system", authorName: "panel", body: "queued" }, 3);
    expect((await listTaskComments(A, id)).map((c) => [c.authorKind, c.authorName, c.sourceFile])).toEqual([
      ["user", "Core", null],
      ["agent", "reviewer", "out.md"],
      ["system", "panel", null],
    ]);
  });

  it("keeps an agent's source file unique per Task with a typed error", async () => {
    const id = await taskIn("draft");
    const input = { authorKind: "agent", authorName: "r", body: "b", sourceFile: "out.md" } as const;
    await addTaskComment(A, id, input);
    await expect(addTaskComment(A, id, input)).rejects.toBeInstanceOf(DuplicateTaskCommentSourceError);
    expect(await listTaskComments(A, id)).toHaveLength(1);
  });

  it("refuses a source file on a user comment, a blank body, an unknown kind", async () => {
    const id = await taskIn("draft");
    const base = { authorName: "n", body: "b" };
    await expect(addTaskComment(A, id, { ...base, authorKind: "user", sourceFile: "x.md" })).rejects.toBeInstanceOf(ValidationError);
    await expect(addTaskComment(A, id, { ...base, authorKind: "user", body: " " })).rejects.toBeInstanceOf(ValidationError);
    await expect(addTaskComment(A, id, { ...base, authorKind: "bot" as "user" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("answers not found for a Task that does not exist", async () => {
    await expect(addTaskComment(A, "nope", { authorKind: "user", authorName: "n", body: "b" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("commentAndReassign", () => {
  it.each(["done", "failed", "partial"] as const)("adds the comment and moves a %s Task to assigned in one call", async (status) => {
    const id = await taskIn(status);
    const moved = await commentAndReassign(A, id, { authorKind: "user", authorName: "Core", body: "again, with tests" }, 900);
    expect(moved.status).toBe("assigned");
    expect((await listTaskComments(A, id)).map((c) => c.body)).toEqual(["again, with tests"]);
    expect((await listTaskHistory(A, id)).at(-1)).toMatchObject({ fromStatus: status, toStatus: "assigned", changedAt: 900 });
  });

  it.each(["draft", "assigned", "in_progress"] as const)("refuses a %s Task and writes no comment", async (status) => {
    const id = await taskIn(status);
    await expect(commentAndReassign(A, id, { authorKind: "user", authorName: "n", body: "b" })).rejects.toBeInstanceOf(
      IllegalTaskTransitionError,
    );
    expect(await listTaskComments(A, id)).toEqual([]);
    expect((await getTask(A, id)).status).toBe(status);
  });

  it("rolls the status back when the comment is refused", async () => {
    const id = await taskIn("done");
    const input = { authorKind: "agent", authorName: "r", body: "b", sourceFile: "out.md" } as const;
    await addTaskComment(A, id, input);
    const before = await listTaskHistory(A, id);
    await expect(commentAndReassign(A, id, input)).rejects.toBeInstanceOf(DuplicateTaskCommentSourceError);
    expect((await getTask(A, id)).status).toBe("done");
    expect(await listTaskHistory(A, id)).toEqual(before);
    expect(await listTaskComments(A, id)).toHaveLength(1);
  });
});

describe("Tasks across owners", () => {
  it("shows owner B nothing of owner A's Task, and lets B change nothing", async () => {
    const id = await taskIn("done");
    await addTaskComment(A, id, { authorKind: "user", authorName: "n", body: "private" });
    expect(await listTasks(B)).toEqual([]);
    await expect(getTask(B, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listTaskComments(B, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listTaskHistory(B, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(changeTaskStatus(B, id, "assigned")).rejects.toBeInstanceOf(NotFoundError);
    await expect(addTaskComment(B, id, { authorKind: "user", authorName: "n", body: "x" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(commentAndReassign(B, id, { authorKind: "user", authorName: "n", body: "x" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await getTask(A, id)).status).toBe("done");
    expect(await listTaskComments(A, id)).toHaveLength(1);
  });

  it("does not let owner B attach owner A's Core to a Task", async () => {
    await testDb.pool.query(
      "insert into cores (id, owner_id, endpoint, label, created_at, updated_at) values ('core_a', $1, 'wss://a:1', 'a', 1, 1)",
      [A],
    );
    expect((await createTask(A, { title: "t", coreId: "core_a" })).coreId).toBe("core_a");
    await expect(createTask(B, { title: "t", coreId: "core_a" })).rejects.toBeInstanceOf(NotFoundError);
  });
});
