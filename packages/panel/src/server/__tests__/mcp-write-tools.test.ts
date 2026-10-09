import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALL_API_KEY_PERMISSIONS } from "~/shared/api-key-permissions";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";
import { McpTestClient, dataOf, textOf } from "./_mcp-client";

/**
 * The write tools over `/mcp` (#573): create_task, assign_task, comment_task.
 * They go through the Tasks service as the key's owner, a key restricted to Core
 * A cannot write to Core B, and assign_task asks for the operator moves only
 * (assigned, draft), the line #630 and #632 settled.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-mcp-write-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const testDb = await openPanelTestDb();
const { operatorSessionCookie, resetOperatorSessionForTests } = await import("./_operator-session");
const tasksService = await import("../services/tasks");
const { createApiKey } = await import("../services/api-keys");

const A = 1;
const B = 2;

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
    ["core-a", A],
    ["core-b", A],
    ["core-x", B],
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

async function client(owner: number, coreIds?: string[]): Promise<McpTestClient> {
  const { key } = await createApiKey(owner, { name: "k", permissions: ALL_API_KEY_PERMISSIONS, ...(coreIds ? { coreIds } : {}) });
  const c = new McpTestClient(key);
  await c.connect();
  return c;
}

const taskCount = async () => (await testDb.pool.query("select count(*)::int as n from tasks")).rows[0].n as number;

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

describe("tools/list", () => {
  it("describes the write tools and offers assign_task only the operator moves", async () => {
    const tools = await (await client(A)).listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ["create_task", "assign_task", "comment_task"]) {
      expect(byName[name], name).toBeDefined();
      expect(byName[name]!.annotations.readOnlyHint).toBe(false);
    }
    expect(byName.assign_task!.inputSchema.properties.status.enum).toEqual(["assigned", "draft"]);
    expect(byName.assign_task!.inputSchema.required).toEqual(["taskId"]);
  });
});

describe("create_task", () => {
  it("creates a draft, owned by the key's owner, and an assigned Task with startNow", async () => {
    const c = await client(A);
    const draft = dataOf(await c.call("create_task", { title: " Fix it ", coreId: "core-a", agent: "agent-a" })).task;
    expect(draft).toMatchObject({ title: "Fix it", status: "draft", coreId: "core-a", agent: "agent-a" });
    const started = dataOf(await c.call("create_task", { title: "Go", coreId: "core-a", agent: "agent-a", startNow: true })).task;
    expect(started.status).toBe("assigned");
    expect((await tasksService.getTask(A, draft.id)).title).toBe("Fix it");
    await expect(tasksService.getTask(B, draft.id)).rejects.toThrow();
  });

  it("refuses an Agent that is not on the chosen Core, and startNow without one", async () => {
    const c = await client(A);
    expect(textOf(await c.call("create_task", { title: "x", coreId: "core-a", agent: "agent-b" }))).toMatch(/^400/);
    expect(textOf(await c.call("create_task", { title: "x", startNow: true }))).toMatch(/^400/);
    expect(await taskCount()).toBe(0);
  });

  it("is refused 403 on a Core outside the key, and writes nothing", async () => {
    const c = await client(A, ["core-a"]);
    const res = await c.call("create_task", { title: "x", coreId: "core-b", agent: "agent-b" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^403/);
    expect(await taskCount()).toBe(0);
  });

  it("keeps a Core-less Task from a Core-restricted key", async () => {
    const c = await client(A, ["core-a"]);
    expect(textOf(await c.call("create_task", { title: "floating" }))).toMatch(/^403/);
    expect(await taskCount()).toBe(0);
  });

  it("refuses another owner's Core as 404 (an unrestricted key is not a way across owners)", async () => {
    const c = await client(A);
    const res = await c.call("create_task", { title: "x", coreId: "core-x", agent: "agent-x" });
    expect(res.isError).toBe(true);
    expect(await taskCount()).toBe(0);
  });

  it("reports missing arguments as a tool error the model can read", async () => {
    const res = await (await client(A)).call("create_task", {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("title");
  });
});

describe("assign_task", () => {
  it("assigns a draft by default and moves it back to draft", async () => {
    const task = await tasksService.createTask(A, { title: "t", coreId: "core-a", agent: "agent-a" });
    const c = await client(A);
    expect(dataOf(await c.call("assign_task", { taskId: task.id })).task.status).toBe("assigned");
    expect(dataOf(await c.call("assign_task", { taskId: task.id, status: "draft" })).task.status).toBe("draft");
    expect((await tasksService.getTask(A, task.id)).status).toBe("draft");
  });

  it("refuses every move that is not the operator's, and the Task does not move", async () => {
    const task = await tasksService.createTask(A, { title: "t", coreId: "core-a", agent: "agent-a" });
    const c = await client(A);
    for (const status of ["in_progress", "done", "failed", "partial", "cancelled"]) {
      const res = await c.call("assign_task", { taskId: task.id, status });
      expect(res.isError, status).toBe(true);
      expect(textOf(res), status).toContain("invalid arguments");
    }
    expect((await tasksService.getTask(A, task.id)).status).toBe("draft");
  });

  it("reports an illegal move from the service as a conflict", async () => {
    const task = await tasksService.createTask(A, { title: "t", coreId: "core-a", agent: "agent-a", startNow: true });
    await tasksService.claimTask(A, task.id);
    const res = await (await client(A)).call("assign_task", { taskId: task.id, status: "draft" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^409/);
  });

  it("is refused 403 on a Task on a Core outside the key, which stays put", async () => {
    const onB = await tasksService.createTask(A, { title: "b", coreId: "core-b", agent: "agent-b" });
    const res = await (await client(A, ["core-a"])).call("assign_task", { taskId: onB.id });
    expect(textOf(res)).toMatch(/^403/);
    expect((await tasksService.getTask(A, onB.id)).status).toBe("draft");
  });

  it("does not find another owner's Task", async () => {
    const onX = await tasksService.createTask(B, { title: "x", coreId: "core-x", agent: "agent-x" });
    const res = await (await client(A)).call("assign_task", { taskId: onX.id });
    expect(textOf(res)).toMatch(/^404/);
    expect((await tasksService.getTask(B, onX.id)).status).toBe("draft");
  });
});

describe("comment_task", () => {
  it("adds a comment as the Operator's user, visible in the thread", async () => {
    const task = await tasksService.createTask(A, { title: "t", coreId: "core-a", agent: "agent-a" });
    const c = await client(A);
    const added = dataOf(await c.call("comment_task", { taskId: task.id, body: "please also add tests" })).comment;
    expect(added).toMatchObject({ taskId: task.id, authorKind: "user", body: "please also add tests" });
    const thread = dataOf(await c.call("get_task", { taskId: task.id })).comments;
    expect(thread.map((x: { body: string }) => x.body)).toEqual(["please also add tests"]);
  });

  it("reassigns a finished Task with the comment, in one call", async () => {
    const task = await tasksService.createTask(A, { title: "t", coreId: "core-a", agent: "agent-a", startNow: true });
    await tasksService.claimTask(A, task.id);
    await tasksService.applyTaskResult(A, task.id, { to: "done", body: "done", sourceFile: "r1.md", authorName: "agent" });
    const res = await (await client(A)).call("comment_task", { taskId: task.id, body: "again, but faster", reassign: true });
    expect(dataOf(res).task.status).toBe("assigned");
    expect(dataOf(res).comments.at(-1).body).toBe("again, but faster");
  });

  it("is refused 403 on a Core outside the key, and 404 on another owner's Task, and adds nothing", async () => {
    const onB = await tasksService.createTask(A, { title: "b", coreId: "core-b", agent: "agent-b" });
    const onX = await tasksService.createTask(B, { title: "x", coreId: "core-x", agent: "agent-x" });
    const restricted = await client(A, ["core-a"]);
    expect(textOf(await restricted.call("comment_task", { taskId: onB.id, body: "no" }))).toMatch(/^403/);
    expect(textOf(await (await client(A)).call("comment_task", { taskId: onX.id, body: "no" }))).toMatch(/^404/);
    expect(await tasksService.listTaskComments(A, onB.id)).toHaveLength(0);
    expect(await tasksService.listTaskComments(B, onX.id)).toHaveLength(0);
  });

  it("rejects an empty body", async () => {
    const task = await tasksService.createTask(A, { title: "t", coreId: "core-a", agent: "agent-a" });
    const res = await (await client(A)).call("comment_task", { taskId: task.id, body: "" });
    expect(res.isError).toBe(true);
  });
});
