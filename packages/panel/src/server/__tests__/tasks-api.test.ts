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

  it("need the operator's session to edit or delete (#722)", async () => {
    const t = await tasksService.createTask(A, { title: "locked" });
    expect((await call(`/api/tasks/${t.id}`, { anonymous: true, method: "PATCH", json: { title: "x" } })).status).toBe(401);
    expect((await call(`/api/tasks/${t.id}`, { anonymous: true, method: "DELETE" })).status).toBe(401);
  });
});
