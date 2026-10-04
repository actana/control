import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";
import { McpTestClient, dataOf, textOf } from "./_mcp-client";

/**
 * The read tools over `/mcp` (#573): list_cores, list_agents, get_tasks,
 * get_task. Each runs as the key's owner and is limited to the key's Cores:
 * a key restricted to Core A cannot see, name or read anything on Core B.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-mcp-read-"));
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

let onA: { id: string };
let onB: { id: string };
let onX: { id: string };

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
  onA = await tasksService.createTask(A, { title: "on A", coreId: "core-a", agent: "agent-a" });
  onB = await tasksService.createTask(A, { title: "on B", coreId: "core-b", agent: "agent-b", startNow: true });
  onX = await tasksService.createTask(B, { title: "owner 2's", coreId: "core-x", agent: "agent-x" });
  await tasksService.addTaskComment(A, onB.id, { authorKind: "user", authorName: "op", body: "secret on B" });
}

async function client(owner: number, coreIds?: string[]): Promise<McpTestClient> {
  const { key } = await createApiKey(owner, { name: "k", ...(coreIds ? { coreIds } : {}) });
  const c = new McpTestClient(key);
  await c.connect();
  return c;
}

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
  it("describes the read tools with JSON Schemas and a read-only hint", async () => {
    const tools = await (await client(A)).listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ["list_cores", "list_agents", "get_tasks", "get_task"]) {
      expect(byName[name], name).toBeDefined();
      expect(byName[name]!.inputSchema.type).toBe("object");
      expect(byName[name]!.annotations.readOnlyHint).toBe(true);
    }
    expect(byName.get_task!.inputSchema.required).toEqual(["taskId"]);
  });
});

describe("an unrestricted key", () => {
  it("sees its owner's Cores, Agents and Tasks and nobody else's", async () => {
    const c = await client(A);
    expect(dataOf(await c.call("list_cores")).cores.map((x: { id: string }) => x.id).sort()).toEqual(["core-a", "core-b"]);
    expect(dataOf(await c.call("list_agents")).agents.map((x: { id: string }) => x.id).sort()).toEqual(["agent-a", "agent-b"]);
    const tasks = dataOf(await c.call("get_tasks")).tasks.map((t: { id: string }) => t.id);
    expect(tasks.sort()).toEqual([onA.id, onB.id].sort());
    expect(tasks).not.toContain(onX.id);
  });

  it("filters get_tasks by status and by Core", async () => {
    const c = await client(A);
    const assigned = dataOf(await c.call("get_tasks", { status: "assigned" })).tasks;
    expect(assigned.map((t: { id: string }) => t.id)).toEqual([onB.id]);
    const onCoreA = dataOf(await c.call("get_tasks", { coreId: "core-a" })).tasks;
    expect(onCoreA.map((t: { id: string }) => t.id)).toEqual([onA.id]);
    const rejected = await c.call("get_tasks", { status: "bogus" });
    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toContain("invalid arguments");
  });

  it("returns a Task with its comment thread", async () => {
    const c = await client(A);
    const got = dataOf(await c.call("get_task", { taskId: onB.id }));
    expect(got.task.title).toBe("on B");
    expect(got.comments.map((x: { body: string }) => x.body)).toContain("secret on B");
  });

  it("does not show another owner's Task, Core or Agents", async () => {
    const c = await client(A);
    const task = await c.call("get_task", { taskId: onX.id });
    expect(task.isError).toBe(true);
    expect(textOf(task)).toMatch(/^404/);
    const agents = await c.call("list_agents", { coreId: "core-x" });
    expect(agents.isError).toBe(true);
  });
});

describe("a key restricted to Core A", () => {
  it("lists only Core A, its Agents and its Tasks", async () => {
    const c = await client(A, ["core-a"]);
    expect(dataOf(await c.call("list_cores")).cores.map((x: { id: string }) => x.id)).toEqual(["core-a"]);
    expect(dataOf(await c.call("list_agents")).agents.map((x: { id: string }) => x.id)).toEqual(["agent-a"]);
    expect(dataOf(await c.call("get_tasks")).tasks.map((t: { id: string }) => t.id)).toEqual([onA.id]);
  });

  it("is refused 403 on Core B's Task, Agents and tasks filter, and learns nothing from the refusal", async () => {
    const c = await client(A, ["core-a"]);
    const task = await c.call("get_task", { taskId: onB.id });
    expect(task.isError).toBe(true);
    expect(textOf(task)).toMatch(/^403/);
    expect(textOf(task)).not.toContain("secret on B");
    expect(textOf(task)).not.toContain("on B");
    const agents = await c.call("list_agents", { coreId: "core-b" });
    expect(textOf(agents)).toMatch(/^403/);
    const filter = await c.call("get_tasks", { coreId: "core-b" });
    expect(textOf(filter)).toMatch(/^403/);
  });

  it("refuses a Task on Core B the same as a Task that does not exist on B: 403, not 404", async () => {
    const c = await client(A, ["core-a"]);
    expect(textOf(await c.call("get_task", { taskId: onB.id }))).toMatch(/^403/);
  });

});

describe("two owners", () => {
  it("runs as the key's owner: owner 2 sees only owner 2's data", async () => {
    const c = await client(B);
    expect(dataOf(await c.call("list_cores")).cores.map((x: { id: string }) => x.id)).toEqual(["core-x"]);
    expect(dataOf(await c.call("get_tasks")).tasks.map((t: { id: string }) => t.id)).toEqual([onX.id]);
    expect(textOf(await c.call("get_task", { taskId: onA.id }))).toMatch(/^404/);
  });
});
