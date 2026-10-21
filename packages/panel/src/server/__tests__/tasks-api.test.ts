import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closePanelTestDb, openPanelTestDb } from "./_panel-test-db";

/**
 * The Task routes (#571), driven the way the browser drives them, as owner 1,
 * with a second owner's Tasks, Core and Agents in the same tables. The status
 * rules are the service's; what is asserted here is that the routes ask the
 * service, as the right owner, and report its answer.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-tasks-api-test-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const testDb = await openPanelTestDb();
const { operatorSessionCookie } = await import("./_operator-session");
const tasksService = await import("../services/tasks");
const tasksController = await import("../controllers/tasks.controller");

const { formatTaskDispatchComment } = await import("~/shared/tasks");

const A = 1;
const B = 2;

async function call(pathname: string, init: { method?: string; json?: unknown; anonymous?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (!init.anonymous) headers.cookie = await operatorSessionCookie();
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const res = await handleApiRequest(
    new Request(`http://panel.example.test${pathname}`, {
      method: init.method ?? "GET",
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    }),
  );
  if (!res) throw new Error("no api response");
  return res;
}
const post = (p: string, json: unknown) => call(p, { method: "POST", json });

async function seedAgent(id: string, owner: number, coreId: string, name: string, isDefault = false) {
  await testDb.pool.query(
    "insert into agents (id, owner_id, core_id, name, harness, flags, is_default, created_at, updated_at) values ($1,$2,$3,$4,'claude-code','{}',$5,1,1)",
    [id, owner, coreId, name, isDefault],
  );
}

beforeAll(async () => {
  await operatorSessionCookie();
  await testDb.pool.query("alter table operator drop constraint operator_single_row");
  await testDb.pool.query(
    "insert into operator (id, name, password_hash, created_at, password_changed_at) values (2, 'owner-2', 'h', 1, 1)",
  );
  await testDb.pool.query(
    "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ('core-a', 1, 'a', 'https://a', 1, 1), ('core-a2', 1, 'a2', 'https://a2', 1, 1), ('core-b', 2, 'b', 'https://b', 1, 1)",
  );
  await seedAgent("agent-a", A, "core-a", "claude-code", true);
  await seedAgent("agent-a2", A, "core-a2", "other-core-agent");
  await seedAgent("agent-b", B, "core-b", "owner-b-agent", true);
});

afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("Task routes", () => {
  it("need the operator's session", async () => {
    expect((await call("/api/tasks", { anonymous: true })).status).toBe(401);
    expect((await call("/api/tasks", { anonymous: true, method: "POST", json: { title: "x" } })).status).toBe(401);
    expect((await call("/api/cores/core-a/agents", { anonymous: true })).status).toBe(401);
  });

  it("create a draft without Start now and an assigned Task with it", async () => {
    const draft = await post("/api/tasks", { title: " Draft one ", coreId: "core-a", agent: "agent-a" });
    expect(draft.status).toBe(201);
    expect((await draft.json()).task).toMatchObject({ title: "Draft one", status: "draft", agent: "agent-a" });
    const started = await post("/api/tasks", { title: "Go", coreId: "core-a", agent: "agent-a", startNow: true });
    expect((await started.json()).task.status).toBe("assigned");
  });

  it("refuse Start now with no Core or Agent, and an Agent that is on another Core", async () => {
    expect((await post("/api/tasks", { title: "t", startNow: true })).status).toBe(400);
    const wrongCore = await post("/api/tasks", { title: "t", coreId: "core-a", agent: "agent-a2" });
    expect(wrongCore.status).toBe(400);
    expect((await post("/api/tasks", { title: "   " })).status).toBe(400);
  });

  it("do not let owner 1 name owner 2's Core or Agent", async () => {
    expect((await post("/api/tasks", { title: "t", coreId: "core-b" })).status).toBe(404);
    expect((await post("/api/tasks", { title: "t", coreId: "core-a", agent: "agent-b" })).status).toBe(404);
  });

  it("list and read only the owner's Tasks, 404 for another owner's", async () => {
    const theirs = await tasksService.createTask(B, { title: "theirs", coreId: "core-b", agent: "agent-b" });
    const list = (await (await call("/api/tasks")).json()).tasks as { id: string }[];
    expect(list.length).toBeGreaterThan(0);
    expect(list.map((t) => t.id)).not.toContain(theirs.id);
    expect((await call(`/api/tasks/${theirs.id}`)).status).toBe(404);
    expect((await post(`/api/tasks/${theirs.id}/comments`, { body: "hi" })).status).toBe(404);
    expect((await post(`/api/tasks/${theirs.id}/status`, { status: "assigned" })).status).toBe(404);
    expect((await post(`/api/tasks/${theirs.id}/comments`, { body: "hi", reassign: true })).status).toBe(404);
    // Owner 2's own handlers see it, and nothing of it changed above.
    expect(((await (await tasksController.read(B, theirs.id)).json()) as any).comments).toEqual([]);
    expect((await tasksService.getTask(B, theirs.id)).status).toBe("draft");
    expect((await (await tasksController.list(B)).json()).tasks.map((t: { id: string }) => t.id)).toEqual([theirs.id]);
  });

  it("assign and send back to draft, with the service's rules answering 409", async () => {
    const t = (await (await post("/api/tasks", { title: "move", coreId: "core-a", agent: "agent-a" })).json()).task;
    expect((await (await post(`/api/tasks/${t.id}/status`, { status: "assigned" })).json()).task.status).toBe("assigned");
    expect((await (await post(`/api/tasks/${t.id}/status`, { status: "draft" })).json()).task.status).toBe("draft");
    const bad = await post(`/api/tasks/${t.id}/status`, { status: "draft" });
    expect(bad.status).toBe(409);
    expect((await call(`/api/tasks/${t.id}`).then((r) => r.json())).task.status).toBe("draft");
    expect((await post(`/api/tasks/${t.id}/status`, { status: "nonsense" })).status).toBe(400);
  });

  it("take only assigned and draft on the status route, and change nothing for any other status", async () => {
    const t = (await (await post("/api/tasks", { title: "dispatcher's", coreId: "core-a", agent: "agent-a", startNow: true })).json()).task;
    for (const status of ["in_progress", "done", "failed", "partial"]) {
      expect((await post(`/api/tasks/${t.id}/status`, { status })).status).toBe(400);
    }
    const after = (await (await call(`/api/tasks/${t.id}`)).json()).task;
    expect(after).toMatchObject({ status: "assigned", attemptCount: 0, dispatchedAt: null });
    expect((await tasksService.listTaskHistory(A, t.id)).map((h) => h.toStatus)).toEqual(["assigned"]);
    // A running Task cannot be made finished by hand either, so a re-assign cannot start a second attempt over it.
    await tasksService.claimTask(A, t.id);
    expect((await post(`/api/tasks/${t.id}/status`, { status: "failed" })).status).toBe(400);
    expect((await tasksService.getTask(A, t.id)).status).toBe("in_progress");
  });

  it("add a comment as the operator, and refuse an empty one", async () => {
    const t = (await (await post("/api/tasks", { title: "talk" })).json()).task;
    const res = await post(`/api/tasks/${t.id}/comments`, { body: "first" });
    expect(res.status).toBe(201);
    expect((await res.json()).comment).toMatchObject({ authorKind: "user", authorName: "Test Operator", body: "first" });
    expect((await post(`/api/tasks/${t.id}/comments`, { body: "  " })).status).toBe(400);
    const read = await (await call(`/api/tasks/${t.id}`)).json();
    expect(read.comments.map((c: { body: string }) => c.body)).toEqual(["first"]);
  });

  it("Comment & re-assign is one call: comment and assigned together, and nothing when the Task is not finished", async () => {
    const t = (await (await post("/api/tasks", { title: "again", coreId: "core-a", agent: "agent-a", startNow: true })).json()).task;
    const refused = await post(`/api/tasks/${t.id}/comments`, { body: "nope", reassign: true });
    expect(refused.status).toBe(409);
    expect((await (await call(`/api/tasks/${t.id}`)).json()).comments).toEqual([]);

    await tasksService.claimTask(A, t.id);
    await tasksService.applyTaskResult(A, t.id, { to: "failed", authorName: "claude-code", body: "broke", sourceFile: "fail.md" });
    const ok = await (await post(`/api/tasks/${t.id}/comments`, { body: "try again", reassign: true })).json();
    expect(ok.task.status).toBe("assigned");
    expect(ok.comments.map((c: { body: string }) => c.body)).toEqual(["broke", "try again"]);
  });

  it("list a Core's own Agents only, 404 for another owner's Core", async () => {
    const mine = (await (await call("/api/cores/core-a/agents")).json()).agents as { id: string }[];
    expect(mine.map((a) => a.id)).toEqual(["agent-a"]);
    expect((await call("/api/cores/core-b/agents")).status).toBe(404);
    expect((await (await tasksController.listCoreAgents(B, "core-b")).json()).agents.map((a: { id: string }) => a.id)).toEqual(["agent-b"]);
  });

  it("edit the title and description, and refuse it while the Task is in_progress (#722)", async () => {
    const t = (await (await post("/api/tasks", { title: "old", description: "old body", coreId: "core-a", agent: "agent-a" })).json()).task;
    const edited = await call(`/api/tasks/${t.id}`, { method: "PATCH", json: { title: "new", description: "new body" } });
    expect(edited.status).toBe(200);
    expect((await edited.json()).task).toMatchObject({ title: "new", description: "new body", status: "draft" });
    expect((await call(`/api/tasks/${t.id}`, { method: "PATCH", json: {} })).status).toBe(400);
    await tasksService.changeTaskStatus(A, t.id, "assigned");
    await tasksService.changeTaskStatus(A, t.id, "in_progress");
    expect((await call(`/api/tasks/${t.id}`, { method: "PATCH", json: { title: "late" } })).status).toBe(409);
    expect((await tasksService.getTask(A, t.id)).title).toBe("new");
  });

  it("take a time limit on create and on edit, at any status, with a system comment (#724)", async () => {
    const make = async (json: Record<string, unknown> = {}) => call("/api/tasks", { method: "POST", json: { title: "lim", coreId: "core-a", agent: "agent-a", ...json } });
    expect((await (await make()).json()).task.timeoutMinutes).toBe(60);
    expect((await (await make({ timeoutMinutes: null })).json()).task.timeoutMinutes).toBeNull();
    for (const bad of [0, 43201, 1.5, "60"]) expect((await make({ timeoutMinutes: bad })).status, String(bad)).toBe(400);
    const t = (await (await make({ timeoutMinutes: 120 })).json()).task;
    expect(t.timeoutMinutes).toBe(120);
    await tasksService.changeTaskStatus(A, t.id, "assigned");
    await tasksService.claimTask(A, t.id);
    const res = await call(`/api/tasks/${t.id}`, { method: "PATCH", json: { timeoutMinutes: 240 } });
    expect(res.status).toBe(200);
    expect((await res.json()).task).toMatchObject({ status: "in_progress", timeoutMinutes: 240 });
    const comments = (await (await call(`/api/tasks/${t.id}`)).json()).comments as { authorKind: string; body: string }[];
    expect(comments.find((c) => c.authorKind === "system")?.body).toMatch(/^Time limit changed from 2 hours to 4 hours by .+\.$/);
    expect((await call(`/api/tasks/${t.id}`, { method: "PATCH", json: { timeoutMinutes: 0 } })).status).toBe(400);
    expect((await call(`/api/tasks/${t.id}`, { method: "PATCH", json: { title: "x", timeoutMinutes: 5 } })).status).toBe(409);
    expect((await tasksService.getTask(A, t.id)).timeoutMinutes).toBe(240);
  });

  it("delete a Task, refuse it while in_progress, and 404 for another owner's (#722)", async () => {
    const t = (await (await post("/api/tasks", { title: "gone", coreId: "core-a", agent: "agent-a" })).json()).task;
    expect((await call(`/api/tasks/${t.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await call(`/api/tasks/${t.id}`)).status).toBe(404);
    const running = await tasksService.createTask(A, { title: "running", coreId: "core-a", agent: "agent-a", startNow: true });
    await tasksService.changeTaskStatus(A, running.id, "in_progress");
    expect((await call(`/api/tasks/${running.id}`, { method: "DELETE" })).status).toBe(409);
    const theirs = await tasksService.createTask(B, { title: "theirs", coreId: "core-b", agent: "agent-b" });
    expect((await call(`/api/tasks/${theirs.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await call(`/api/tasks/${theirs.id}`, { method: "PATCH", json: { title: "mine" } })).status).toBe(404);
    expect((await tasksService.getTask(B, theirs.id)).title).toBe("theirs");
  });

  it("stop a running Task, then re-assign it; the same routes refuse a Task that is not running (#723)", async () => {
    const t = (await (await post("/api/tasks", { title: "hung", coreId: "core-a", agent: "agent-a", startNow: true })).json()).task;
    // Not running yet: 409, and nothing changes.
    expect((await post(`/api/tasks/${t.id}/stop`, {})).status).toBe(409);
    await tasksService.claimTask(A, t.id);
    await tasksService.addTaskComment(A, t.id, {
      authorKind: "system",
      authorName: "Panel",
      body: formatTaskDispatchComment({ attempt: 1, agentName: "claude-code", harness: "claude-code", coreId: "core-a", sessionId: "session_1" }),
    });
    // Re-assigning while it runs is refused with a message that names the stop call.
    const refused = await post(`/api/tasks/${t.id}/comments`, { body: "again", reassign: true });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/\/stop/);
    const refusedStatus = await post(`/api/tasks/${t.id}/status`, { status: "assigned" });
    expect(refusedStatus.status).toBe(409);
    expect((await refusedStatus.json()).error).toMatch(/\/stop/);

    const stopped = await post(`/api/tasks/${t.id}/stop`, { reason: "hung" });
    expect(stopped.status).toBe(200);
    const body = await stopped.json();
    expect(body.task).toMatchObject({ id: t.id, status: "failed" });
    // No Core link in this test, so the Core counts as offline.
    expect(body.session).toMatchObject({ coreId: "core-a", sessionId: "session_1", outcome: "unreachable" });
    const read = await (await call(`/api/tasks/${t.id}`)).json();
    expect(read.comments.some((c: { body: string }) => c.body.startsWith("Stopped by ") && c.body.includes("hung"))).toBe(true);
    // A second stop is a 409: it is no longer running.
    expect((await post(`/api/tasks/${t.id}/stop`, {})).status).toBe(409);
    const again = await (await post(`/api/tasks/${t.id}/comments`, { body: "again", reassign: true })).json();
    expect(again.task.status).toBe("assigned");
  });

  it("stop takes an empty body, refuses a bad reason, 404s for another owner's Task and needs the session (#723)", async () => {
    const t = await tasksService.createTask(A, { title: "r", coreId: "core-a", agent: "agent-a", startNow: true });
    await tasksService.claimTask(A, t.id);
    expect((await post(`/api/tasks/${t.id}/stop`, { reason: 5 })).status).toBe(400);
    expect((await post(`/api/tasks/${t.id}/stop`, { reason: "x".repeat(2001) })).status).toBe(400);
    expect((await call(`/api/tasks/${t.id}/stop`, { anonymous: true, method: "POST" })).status).toBe(401);
    expect((await tasksService.getTask(A, t.id)).status).toBe("in_progress");
    const theirs = await tasksService.createTask(B, { title: "theirs", coreId: "core-b", agent: "agent-b", startNow: true });
    await tasksService.claimTask(B, theirs.id);
    expect((await post(`/api/tasks/${theirs.id}/stop`, {})).status).toBe(404);
    expect((await tasksService.getTask(B, theirs.id)).status).toBe("in_progress");
    expect((await call(`/api/tasks/${t.id}/stop`, { method: "POST" })).status).toBe(200);
  });

  it("need the operator's session to edit or delete (#722)", async () => {
    const t = await tasksService.createTask(A, { title: "locked" });
    expect((await call(`/api/tasks/${t.id}`, { anonymous: true, method: "PATCH", json: { title: "x" } })).status).toBe(401);
    expect((await call(`/api/tasks/${t.id}`, { anonymous: true, method: "DELETE" })).status).toBe(401);
  });
});

describe("a board move is the button's move (#827)", () => {
  /** The webhook events written for one Task, oldest first. */
  async function outboxFor(taskId: string): Promise<{ type: string; data: Record<string, any> }[]> {
    const rows = (
      await testDb.pool.query(
        "select event_type, payload from webhook_outbox where (payload::jsonb)->'data'->'task'->>'id' = $1 order by created_at, id",
        [taskId],
      )
    ).rows as { event_type: string; payload: string }[];
    return rows.map((r) => ({ type: r.event_type, data: JSON.parse(r.payload).data }));
  }
  const draftTask = async (title: string) =>
    (await (await post("/api/tasks", { title, coreId: "core-a", agent: "agent-a" })).json()).task as { id: string };
  const failedTask = async (title: string) => {
    const t = (await (await post("/api/tasks", { title, coreId: "core-a", agent: "agent-a", startNow: true })).json()).task as { id: string };
    await tasksService.claimTask(A, t.id);
    await tasksService.applyTaskResult(A, t.id, { to: "failed", authorName: "claude-code", body: "broke", sourceFile: `${title}.md` });
    return t;
  };
  /** A status_changed payload without what differs per Task: id, title and every timestamp. */
  const comparable = (data: Record<string, any>) => {
    const { id: _id, title: _title, ...task } = data.task;
    for (const k of Object.keys(task)) if (/At$/.test(k)) delete task[k];
    return { ...data, task };
  };

  it("assign writes one history row and one task.status_changed from draft to assigned", async () => {
    const t = await draftTask("drag assign");
    expect((await post(`/api/tasks/${t.id}/status`, { status: "assigned" })).status).toBe(200);
    const events = await outboxFor(t.id);
    expect(events.map((e) => e.type)).toEqual(["task.created", "task.status_changed"]);
    expect(events[1]!.data).toMatchObject({ from: "draft", to: "assigned", task: { id: t.id, status: "assigned" } });
    expect((await tasksService.listTaskHistory(A, t.id)).map((h) => [h.fromStatus, h.toStatus])).toEqual([[null, "draft"], ["draft", "assigned"]]);
  });

  it("back to draft writes task.status_changed from assigned to draft", async () => {
    const t = await draftTask("drag draft");
    await post(`/api/tasks/${t.id}/status`, { status: "assigned" });
    expect((await post(`/api/tasks/${t.id}/status`, { status: "draft" })).status).toBe(200);
    const last = (await outboxFor(t.id)).at(-1)!;
    expect(last.type).toBe("task.status_changed");
    expect(last.data).toMatchObject({ from: "assigned", to: "draft", task: { status: "draft" } });
  });

  it("re-assign without a comment is Comment & re-assign's move, minus the comment", async () => {
    const x = await failedTask("drag-x");
    const y = await failedTask("drag-y");
    const xBefore = (await outboxFor(x.id)).length;
    const yBefore = (await outboxFor(y.id)).length;
    expect((await post(`/api/tasks/${x.id}/status`, { status: "assigned" })).status).toBe(200);
    expect((await post(`/api/tasks/${y.id}/comments`, { body: "again", reassign: true })).status).toBe(200);

    const xNew = (await outboxFor(x.id)).slice(xBefore);
    const yNew = (await outboxFor(y.id)).slice(yBefore);
    expect(xNew.map((e) => e.type)).toEqual(["task.status_changed"]);
    // Both rows share one timestamp, so their order is the row id's: compare as a set.
    expect(yNew.map((e) => e.type).sort()).toEqual(["comment.created", "task.status_changed"]);
    expect(xNew[0]!.data).toMatchObject({ from: "failed", to: "assigned" });
    expect(comparable(xNew[0]!.data)).toEqual(comparable(yNew.find((e) => e.type === "task.status_changed")!.data));

    const lastRow = async (id: string) => (await tasksService.listTaskHistory(A, id)).at(-1);
    expect(await lastRow(x.id)).toMatchObject({ fromStatus: "failed", toStatus: "assigned" });
    expect(await lastRow(y.id)).toMatchObject({ fromStatus: "failed", toStatus: "assigned" });

    const attempts = (await tasksService.getTask(A, x.id)).attemptCount;
    expect((await tasksService.claimTask(A, x.id))?.attemptCount).toBe(attempts + 1);
  });

  it("an empty-body re-assign is refused with 400 and changes nothing, so the drag does not use it", async () => {
    const t = await failedTask("drag-empty");
    const events = (await outboxFor(t.id)).length;
    const history = await tasksService.listTaskHistory(A, t.id);
    expect((await post(`/api/tasks/${t.id}/comments`, { body: "", reassign: true })).status).toBe(400);
    expect((await tasksService.getTask(A, t.id)).status).toBe("failed");
    expect(await outboxFor(t.id)).toHaveLength(events);
    expect(await tasksService.listTaskHistory(A, t.id)).toEqual(history);
  });

  it("refuses a running Task's move to assigned with 409 and to in_progress with 400, writing no event", async () => {
    const t = await tasksService.createTask(A, { title: "drag-running", coreId: "core-a", agent: "agent-a", startNow: true });
    await tasksService.claimTask(A, t.id);
    const events = (await outboxFor(t.id)).length;
    expect((await post(`/api/tasks/${t.id}/status`, { status: "assigned" })).status).toBe(409);
    expect((await post(`/api/tasks/${t.id}/status`, { status: "in_progress" })).status).toBe(400);
    expect(await outboxFor(t.id)).toHaveLength(events);
    expect((await tasksService.getTask(A, t.id)).status).toBe("in_progress");
  });
});
