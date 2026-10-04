import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb } from "./_panel-test-db";

/**
 * Two owners, one table (#569, ADR 0041 D15). `operator` keeps `CHECK (id = 1)`,
 * so the test lifts it on its own throw-away database to put a second owner in.
 */

const testDb = await openPanelTestDb();
const { deleteAgent, findAgentById, findAgents, findDefaultAgent, insertAgent } = await import(
  "../repositories/agents.repo"
);

const A = 1;
const B = 2;

const agent = (ownerId: number, id: string, over: Record<string, unknown> = {}) => ({
  id,
  ownerId,
  coreId: `core-${ownerId}`,
  name: `agent ${id}`,
  harness: "claude-code",
  model: null,
  flags: [] as string[],
  isDefault: false,
  createdAt: 10,
  updatedAt: 10,
  ...over,
});

beforeAll(async () => {
  await testDb.pool.query("alter table operator drop constraint operator_single_row");
  for (const id of [A, B]) {
    await testDb.pool.query(
      "insert into operator (id, name, password_hash, created_at, password_changed_at) values ($1, $2, 'h', 1, 1)",
      [id, `owner-${id}`],
    );
    await testDb.pool.query(
      "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ($1, $2, 'c', $3, 1, 1)",
      [`core-${id}`, id, `https://core-${id}`],
    );
  }
  expect((await insertAgent(agent(A, "a-1", { isDefault: true }))).kind).toBe("ok");
  expect((await insertAgent(agent(B, "b-1", { isDefault: true }))).kind).toBe("ok");
});

afterAll(async () => {
  await closePanelTestDb(testDb);
});

describe("Agent repository across owners", () => {
  it("lists and finds only the owner's Agents", async () => {
    expect((await findAgents(A)).map((a) => a.id)).toEqual(["a-1"]);
    expect((await findAgents(B)).map((a) => a.id)).toEqual(["b-1"]);
    expect(await findAgentById(B, "a-1")).toBeNull();
    expect((await findAgentById(A, "a-1"))?.id).toBe("a-1");
  });

  it("narrows a list to one Core, and gives owner B nothing for owner A's Core", async () => {
    expect((await findAgents(A, "core-1")).map((a) => a.id)).toEqual(["a-1"]);
    expect(await findAgents(B, "core-1")).toEqual([]);
  });

  it("finds a default Agent only for its owner", async () => {
    expect((await findDefaultAgent(A, "core-1", "claude-code"))?.id).toBe("a-1");
    expect(await findDefaultAgent(B, "core-1", "claude-code")).toBeNull();
  });

  it("refuses an Agent that names another owner's Core, writing nothing", async () => {
    expect(await insertAgent(agent(B, "b-evil", { coreId: "core-1", name: "evil" }))).toEqual({ kind: "no-core" });
    expect(await findAgentById(A, "b-evil")).toBeNull();
    expect(await findAgentById(B, "b-evil")).toBeNull();
  });

  it("does not let owner B delete owner A's Agent", async () => {
    expect(await deleteAgent(B, "a-1")).toBe(false);
    expect((await findAgentById(A, "a-1"))?.id).toBe("a-1");
  });

  it("lets owner A delete their own Agent", async () => {
    expect((await insertAgent(agent(A, "a-2", { name: "second" }))).kind).toBe("ok");
    expect(await deleteAgent(A, "a-2")).toBe(true);
    expect(await findAgentById(A, "a-2")).toBeNull();
  });

  it("reports a taken name or a second default as a conflict, not an error", async () => {
    expect(await insertAgent(agent(A, "a-3", { name: "agent a-1" }))).toEqual({ kind: "conflict" });
    expect(await insertAgent(agent(A, "a-4", { name: "other", isDefault: true }))).toEqual({ kind: "conflict" });
  });
});
