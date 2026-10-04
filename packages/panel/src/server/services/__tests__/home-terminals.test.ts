import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "../../__tests__/_panel-test-db";

const testDb = await openPanelTestDb();
const { createOperator } = await import("../operator");
const {
  listHomeTerminals,
  createHomeTerminal,
  renameHomeTerminal,
  deleteHomeTerminal,
} = await import("../home-terminals");

beforeEach(async () => {
  await resetPanelState(testDb);
  await createOperator({ name: "Test Operator", password: "test-password" });
});

afterAll(async () => {
  await closePanelTestDb(testDb);
});

describe("home-terminals service", () => {
  it("stores no cwd: a terminal is a login shell in the Core's home, whatever the caller sends", async () => {
    // A POST body can still carry the field a 0.4.x client sent.
    const { create } = await import("../../controllers/home-terminals.controller");
    const response = await create(
      new Request("http://localhost/api/home/user-terminals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "shell", cwd: "/home/core/web" }),
      }),
    );
    const { terminal } = (await response.json()) as { terminal: { cwd: string | null } };
    expect(terminal.cwd).toBeNull();
  });

  it("creates with default name and lists in insertion order", async () => {
    const a = await createHomeTerminal({});
    const b = await createHomeTerminal({});
    expect(a.name).toBe("Terminal 1");
    expect(b.name).toBe("Terminal 2");
    expect((await listHomeTerminals()).map((t) => t.id)).toEqual([a.id, b.id]);
  });

  it("renames and trims", async () => {
    const t = await createHomeTerminal({});
    const renamed = await renameHomeTerminal(t.id, "  dev box  ");
    expect(renamed?.name).toBe("dev box");
    expect((await listHomeTerminals())[0]!.name).toBe("dev box");
  });

  it("rejects empty rename", async () => {
    const t = await createHomeTerminal({});
    await expect(renameHomeTerminal(t.id, "   ")).rejects.toThrow();
  });

  it("returns null when renaming a missing terminal", async () => {
    expect(await renameHomeTerminal("ht-missing-000000", "x")).toBeNull();
  });

  it("deletes only the targeted row", async () => {
    const a = await createHomeTerminal({});
    const b = await createHomeTerminal({});
    expect(await deleteHomeTerminal(a.id)).toBe(true);
    expect((await listHomeTerminals()).map((t) => t.id)).toEqual([b.id]);
  });

  it("reports false when deleting a missing terminal", async () => {
    expect(await deleteHomeTerminal("ht-missing-000000")).toBe(false);
  });

  it("reuses the lowest free Terminal N after a gap", async () => {
    const first = await createHomeTerminal({});
    await createHomeTerminal({});
    await deleteHomeTerminal(first.id);
    expect((await createHomeTerminal({})).name).toBe("Terminal 1");
  });

  it("accepts a client-provided domain id", async () => {
    const clientId = "ht-mabc123-abcdef";
    const t = await createHomeTerminal({ id: clientId });
    expect(t.id).toBe(clientId);
  });

  it("rejects an invalid client id", async () => {
    await expect(createHomeTerminal({ id: "not a domain id" })).rejects.toThrow();
  });

  it("orders by position before createdAt", async () => {
    const a = await createHomeTerminal({});
    const b = await createHomeTerminal({});
    const c = await createHomeTerminal({});
    await testDb.pool.query("update home_terminals set position = 2 where id = $1", [a.id]);
    await testDb.pool.query("update home_terminals set position = 1 where id = $1", [b.id]);
    await testDb.pool.query("update home_terminals set position = 0 where id = $1", [c.id]);
    expect((await listHomeTerminals()).map((t) => t.id)).toEqual([c.id, b.id, a.id]);
  });
});
