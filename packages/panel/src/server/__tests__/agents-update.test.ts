import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";

/**
 * `updateAgent` (#893): change the name, model and flags of one Agent in place.
 * The id stays; the harness and the Core cannot change; a default Agent cannot
 * be changed. Same validation as `createAgent`.
 */

const testDb = await openPanelTestDb();
const { updateAgent, getAgent } = await import("../services/agents");
const { ConflictError, NotFoundError, ValidationError } = await import("../errors");

const A = 1;

beforeEach(async () => {
  await resetPanelState(testDb);
  await testDb.pool.query("alter table operator drop constraint if exists operator_single_row");
  await testDb.pool.query(
    "insert into operator (id, name, password_hash, created_at, password_changed_at) values (1, 'A', 'h', 1, 1), (2, 'B', 'h', 1, 1) on conflict do nothing",
  );
  await testDb.pool.query(
    "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ('core-a', 1, 'a', 'https://a', 1, 1), ('core-x', 2, 'x', 'https://x', 1, 1)",
  );
  await testDb.pool.query(
    `insert into agents (id, owner_id, core_id, name, harness, model, flags, is_default, created_at, updated_at) values
      ('agent-1', 1, 'core-a', 'Opus', 'claude-code', 'opus', '{skip-permissions}', false, 10, 10),
      ('agent-2', 1, 'core-a', 'Other', 'claude-code', null, '{}', false, 10, 10),
      ('agent-d', 1, 'core-a', 'Claude Code', 'claude-code', null, '{}', true, 10, 10),
      ('agent-x', 2, 'core-x', 'Theirs', 'claude-code', null, '{}', false, 10, 10)`,
  );
});
afterAll(async () => {
  await closePanelTestDb(testDb);
});

describe("updateAgent", () => {
  it("changes the model under the same id and stamps updatedAt", async () => {
    const updated = await updateAgent(A, "agent-1", { model: "sonnet" }, 99);
    expect(updated).toMatchObject({ id: "agent-1", coreId: "core-a", harness: "claude-code", name: "Opus", model: "sonnet", flags: ["skip-permissions"], isDefault: false, updatedAt: 99, createdAt: 10 });
    expect((await getAgent(A, "agent-1")).model).toBe("sonnet");
  });

  it("changes the name and the flags, and null clears the model", async () => {
    const updated = await updateAgent(A, "agent-1", { name: "  Reviewer ", model: null, flags: [] });
    expect(updated).toMatchObject({ name: "Reviewer", model: null, flags: [] });
  });

  it("leaves a field alone that the call does not give", async () => {
    const updated = await updateAgent(A, "agent-1", { name: "Renamed" });
    expect(updated).toMatchObject({ name: "Renamed", model: "opus", flags: ["skip-permissions"] });
  });

  it("refuses a call that changes nothing", async () => {
    await expect(updateAgent(A, "agent-1", {})).rejects.toBeInstanceOf(ValidationError);
  });

  it("validates like createAgent: name, model, flags and unknown flags", async () => {
    await expect(updateAgent(A, "agent-1", { name: "   " })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateAgent(A, "agent-1", { name: "a\nb" })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateAgent(A, "agent-1", { model: "bad model;rm" })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateAgent(A, "agent-1", { model: "sk-abcdefghijklmnop" })).rejects.toThrow(/platform key/);
    await expect(updateAgent(A, "agent-1", { flags: ["nope"] })).rejects.toThrow(/unknown flag/);
    expect(await getAgent(A, "agent-1")).toMatchObject({ name: "Opus", model: "opus" });
  });

  it("cannot change the harness, the Core, or carry a command, args or env", async () => {
    for (const field of ["harness", "coreId", "command", "args", "env", "id", "isDefault"]) {
      await expect(updateAgent(A, "agent-1", { [field]: "x" } as never), field).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await getAgent(A, "agent-1")).toMatchObject({ harness: "claude-code", coreId: "core-a" });
  });

  it("refuses a default Agent with 409, like delete", async () => {
    await expect(updateAgent(A, "agent-d", { model: "opus" })).rejects.toBeInstanceOf(ConflictError);
    await expect(updateAgent(A, "agent-d", { model: "opus" })).rejects.toThrow("a default Agent cannot be changed");
    expect((await getAgent(A, "agent-d")).model).toBeNull();
  });

  it("refuses a name another Agent on the Core already has, and allows keeping its own", async () => {
    await expect(updateAgent(A, "agent-1", { name: "Other" })).rejects.toBeInstanceOf(ConflictError);
    expect((await updateAgent(A, "agent-1", { name: "Opus", model: "haiku" })).model).toBe("haiku");
  });

  it("is not found for an unknown Agent or another owner's", async () => {
    await expect(updateAgent(A, "nope", { model: "opus" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateAgent(A, "agent-x", { model: "opus" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("two renames onto one name: one wins, the other is a 409, never a 500", async () => {
    const results = await Promise.allSettled([updateAgent(A, "agent-1", { name: "Z" }), updateAgent(A, "agent-2", { name: "Z" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(ConflictError);
  });

  it("maps a unique violation from the driver, bare or wrapped, to a conflict", async () => {
    const { isUniqueViolation } = await import("../repositories/agents.repo");
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
    expect(isUniqueViolation(new Error("x"))).toBe(false);
  });
});
