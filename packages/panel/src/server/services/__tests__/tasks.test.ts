import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DELETABLE_TASK_STATUSES,
  EDITABLE_TASK_STATUSES,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  canDeleteTask,
  STOPPABLE_TASK_STATUSES,
  canEditTask,
  canStopTask,
  formatTaskStopComment,
  formatTaskDispatchComment,
  type TaskStatus,
} from "~/shared/tasks";
import { closePanelTestDb, openPanelTestDb } from "../../__tests__/_panel-test-db";

const testDb = await openPanelTestDb();
const tasksService = await import("../tasks");
const { ConflictError, NotFoundError, ValidationError } = await import("../../errors");
const {
  DuplicateTaskCommentSourceError,
  IllegalTaskTransitionError,
  TaskNotChangeableError,
  TaskNotRunningError,
  addTaskComment,
  changeTaskStatus,
  claimTask,
  commentAndReassign,
  createTask,
  deleteTask,
  findCurrentTaskSession,
  getTask,
  markTaskStopped,
  listTaskComments,
  listTaskHistory,
  listTasks,
  updateTask,
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
  await testDb.pool.query("truncate tasks, webhook_outbox cascade");
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

/** The webhook events written for one Task, oldest first. */
async function outboxFor(taskId: string): Promise<{ type: string; task: Record<string, unknown> }[]> {
  const rows = (
    await testDb.pool.query(
      "select event_type, payload from webhook_outbox where (payload::jsonb)->'data'->'task'->>'id' = $1 order by created_at, id",
      [taskId],
    )
  ).rows as { event_type: string; payload: string }[];
  return rows.map((r) => ({ type: r.event_type, task: JSON.parse(r.payload).data.task }));
}

const NOT_RUNNING = TASK_STATUSES.filter((s) => s !== "in_progress");

describe("the edit and delete rules (#722)", () => {
  it("allow every status but in_progress", () => {
    expect([...EDITABLE_TASK_STATUSES].sort()).toEqual([...NOT_RUNNING].sort());
    expect([...DELETABLE_TASK_STATUSES].sort()).toEqual([...NOT_RUNNING].sort());
    for (const s of TASK_STATUSES) {
      expect(canEditTask(s), s).toBe(s !== "in_progress");
      expect(canDeleteTask(s), s).toBe(s !== "in_progress");
    }
  });
});

describe("updateTask (#722)", () => {
  it.each(NOT_RUNNING)("edits a %s Task, keeps its status, and writes task.updated", async (status) => {
    const id = await taskIn(status);
    const updated = await updateTask(A, id, { title: "  New  ", description: "new body" }, 900);
    expect(updated).toMatchObject({ id, title: "New", description: "new body", status, updatedAt: 900 });
    expect(await getTask(A, id)).toMatchObject({ title: "New", description: "new body", status });
    const events = (await outboxFor(id)).filter((e) => e.type === "task.updated");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ task: { id, title: "New", description: "new body", status } });
  });

  it("changes only the fields given", async () => {
    const t = await createTask(A, { title: "t", description: "d" });
    expect(await updateTask(A, t.id, { description: "d2" })).toMatchObject({ title: "t", description: "d2" });
    expect(await updateTask(A, t.id, { title: "t2" })).toMatchObject({ title: "t2", description: "d2" });
  });

  it("refuses an in_progress Task with a typed 409 error and changes nothing", async () => {
    const id = await taskIn("in_progress");
    const err = await updateTask(A, id, { title: "late" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TaskNotChangeableError);
    expect(err).toMatchObject({ code: "illegal_task_transition", action: "edit", status: "in_progress" });
    expect((await getTask(A, id)).title).toBe("t");
    expect((await outboxFor(id)).map((e) => e.type)).not.toContain("task.updated");
  });

  it("refuses an empty title, and answers not found for a missing Task", async () => {
    const id = await taskIn("draft");
    await expect(updateTask(A, id, { title: "   " })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateTask(A, "task_missing", { title: "x" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("loses to a dispatcher that claims the Task first", async () => {
    const id = await taskIn("assigned");
    expect(await claimTask(A, id)).not.toBeNull();
    await expect(updateTask(A, id, { title: "late" })).rejects.toBeInstanceOf(TaskNotChangeableError);
  });
});

describe("deleteTask (#722)", () => {
  it.each(NOT_RUNNING)("deletes a %s Task with its comments and history, and writes task.deleted", async (status) => {
    const id = await taskIn(status);
    await addTaskComment(A, id, { authorKind: "user", authorName: "n", body: "hi" });
    const removed = await deleteTask(A, id, 900);
    expect(removed).toMatchObject({ id, status });
    await expect(getTask(A, id)).rejects.toBeInstanceOf(NotFoundError);
    for (const table of ["task_comments", "task_status_history"]) {
      expect((await testDb.pool.query(`select count(*)::int as n from ${table} where task_id = $1`, [id])).rows[0].n, table).toBe(0);
    }
    const events = (await outboxFor(id)).filter((e) => e.type === "task.deleted");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ task: { id, status } });
  });

  it("refuses an in_progress Task with a typed 409 error and keeps it", async () => {
    const id = await taskIn("in_progress");
    const err = await deleteTask(A, id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TaskNotChangeableError);
    expect(err).toMatchObject({ code: "illegal_task_transition", action: "delete", status: "in_progress" });
    expect((await getTask(A, id)).status).toBe("in_progress");
    expect((await outboxFor(id)).map((e) => e.type)).not.toContain("task.deleted");
  });

  it("answers not found for a missing Task", async () => {
    await expect(deleteTask(A, "task_missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("and a racing claim: exactly one of them wins", async () => {
    const id = await taskIn("assigned");
    const [claimed, deleted] = await Promise.allSettled([claimTask(A, id), deleteTask(A, id)]);
    const claimWon = claimed.status === "fulfilled" && claimed.value !== null;
    if (claimWon) {
      expect(deleted.status).toBe("rejected");
      expect((await getTask(A, id)).status).toBe("in_progress");
    } else {
      expect(deleted.status).toBe("fulfilled");
      await expect(getTask(A, id)).rejects.toBeInstanceOf(NotFoundError);
    }
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
    await expect(updateTask(B, id, { title: "theirs" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteTask(B, id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getTask(A, id)).status).toBe("done");
    expect((await getTask(A, id)).title).toBe("t");
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

describe("stopping a Task (#723)", () => {
  it("only an in_progress Task is stoppable", () => {
    expect(STOPPABLE_TASK_STATUSES).toEqual(["in_progress"]);
    for (const s of TASK_STATUSES) expect(canStopTask(s)).toBe(s === "in_progress");
  });

  it("formats the stop comment with and without a reason", () => {
    expect(formatTaskStopComment({ stoppedBy: "Core", reason: "hung" })).toBe("Stopped by Core: hung");
    expect(formatTaskStopComment({ stoppedBy: "Core", reason: "  " })).toBe("Stopped by Core.");
    expect(formatTaskStopComment({ stoppedBy: "Core" })).toBe("Stopped by Core.");
  });

  it("markTaskStopped fails the Task with a system comment, the last error, and one status_changed and one comment.created event", async () => {
    const id = await taskIn("in_progress");
    const stopped = await markTaskStopped(A, id, { stoppedBy: "Core", reason: "hung" }, 700);
    expect(stopped).toMatchObject({ status: "failed", lastError: "Stopped by Core: hung" });
    expect((await listTaskComments(A, id)).map((c) => [c.authorKind, c.authorName, c.body])).toEqual([["system", "Panel", "Stopped by Core: hung"]]);
    expect((await listTaskHistory(A, id)).at(-1)).toMatchObject({ fromStatus: "in_progress", toStatus: "failed", changedAt: 700 });
    const types = (await outboxFor(id)).map((e) => e.type);
    expect(types.filter((t) => t === "task.status_changed")).toHaveLength(3);
    expect(types.at(-1)).toBe("task.status_changed");
    expect(types).toContain("comment.created");
  });

  it.each(NOT_RUNNING)("markTaskStopped refuses a %s Task with TaskNotRunningError and writes nothing", async (status) => {
    const id = await taskIn(status);
    const before = await listTaskHistory(A, id);
    const err = await markTaskStopped(A, id, { stoppedBy: "Core" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TaskNotRunningError);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err).toMatchObject({ code: "illegal_task_transition" });
    expect((err as Error).message).toBe(`a Task that is ${status} is not running: only an in_progress Task can be stopped`);
    expect(await listTaskComments(A, id)).toEqual([]);
    expect(await listTaskHistory(A, id)).toEqual(before);
    expect((await getTask(A, id)).status).toBe(status);
  });

  it("markTaskStopped is not found for another owner", async () => {
    const id = await taskIn("in_progress");
    await expect(markTaskStopped(B, id, { stoppedBy: "x" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a second stop is refused: the first one failed the Task", async () => {
    const id = await taskIn("in_progress");
    await markTaskStopped(A, id, { stoppedBy: "Core" });
    await expect(markTaskStopped(A, id, { stoppedBy: "Core" })).rejects.toBeInstanceOf(TaskNotRunningError);
  });

  it("re-assigning an in_progress Task is a 409 that names the stop call", async () => {
    const id = await taskIn("in_progress");
    const viaComment = await commentAndReassign(A, id, { authorKind: "user", authorName: "n", body: "b" }).catch((e: unknown) => e);
    expect(viaComment).toBeInstanceOf(IllegalTaskTransitionError);
    expect((viaComment as Error).message).toMatch(/stop/);
    expect((viaComment as Error).message).toContain("/api/v1/tasks/:id/stop");
    const viaStatus = await changeTaskStatus(A, id, "assigned").catch((e: unknown) => e);
    expect((viaStatus as Error).message).toMatch(/stop/);
    expect((await getTask(A, id)).status).toBe("in_progress");
  });

  it("other illegal moves keep the plain message", async () => {
    const id = await taskIn("done");
    await expect(changeTaskStatus(A, id, "draft")).rejects.toThrow("a Task cannot move from done to draft");
  });

  it("findCurrentTaskSession picks the dispatch comment of the current attempt", async () => {
    const id = await taskIn("assigned");
    expect(await findCurrentTaskSession(A, id)).toBeNull();
    const note = (attempt: number, sessionId: string, coreId = "core_1") =>
      addTaskComment(A, id, { authorKind: "system", authorName: "Panel", body: formatTaskDispatchComment({ attempt, agentName: "Claude Code", harness: "claude-code", coreId, sessionId }) });
    await claimTask(A, id);
    await note(1, "session_1");
    expect(await findCurrentTaskSession(A, id)).toEqual({ coreId: "core_1", sessionId: "session_1", attempt: 1 });
    await markTaskStopped(A, id, { stoppedBy: "Core" });
    await commentAndReassign(A, id, { authorKind: "user", authorName: "n", body: "again" });
    await claimTask(A, id);
    // Attempt 2 is claimed but not noted yet: attempt 1's Session is not the current one.
    expect(await findCurrentTaskSession(A, id)).toBeNull();
    await note(2, "session_2", "core_2");
    expect(await findCurrentTaskSession(A, id)).toEqual({ coreId: "core_2", sessionId: "session_2", attempt: 2 });
    // A user comment that looks like a dispatch note is not trusted.
    await addTaskComment(A, id, { authorKind: "user", authorName: "n", body: formatTaskDispatchComment({ attempt: 2, agentName: "x", harness: "claude-code", coreId: "evil", sessionId: "s9" }) });
    expect((await findCurrentTaskSession(A, id))?.sessionId).toBe("session_2");
    // An explicit attempt is honoured, so a stop of attempt 1 never lands on attempt 2's Session.
    expect((await findCurrentTaskSession(A, id, 1))?.sessionId).toBe("session_1");
    expect((await findCurrentTaskSession(A, id, 2))?.sessionId).toBe("session_2");
    expect(await findCurrentTaskSession(A, id, 3)).toBeNull();
    await expect(findCurrentTaskSession(B, id)).rejects.toBeInstanceOf(NotFoundError);
  });
});
