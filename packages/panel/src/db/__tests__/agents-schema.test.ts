import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../test-db";

/** The agents table a migration creates (#569, ADR 0041 D15, D18, D23). */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb({ env: {} });
  await db.pool.query(
    "insert into operator (id, name, password_hash, created_at, password_changed_at) values (1, 'o', 'h', 1, 1)",
  );
  await db.pool.query(
    "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ('c1', 1, 'c', 'https://c1', 1, 1), ('c2', 1, 'c', 'https://c2', 1, 1)",
  );
}, 30_000);
afterAll(async () => {
  await db.close();
});

const insertAgent = (id: string, over: { core?: string; name?: string; harness?: string; isDefault?: boolean } = {}) =>
  db.pool.query(
    "insert into agents (id, owner_id, core_id, name, harness, is_default, created_at, updated_at) values ($1, 1, $2, $3, $4, $5, 1, 1)",
    [id, over.core ?? "c1", over.name ?? id, over.harness ?? "claude-code", over.isDefault ?? false],
  );

describe("the agents table", () => {
  it("keeps every time column as bigint and the owner as a not-null foreign key to operator", async () => {
    const { rows } = await db.pool.query(
      `select column_name, data_type, is_nullable from information_schema.columns where table_name = 'agents'`,
    );
    const by = Object.fromEntries(rows.map((r) => [r.column_name, r]));
    expect(by.created_at.data_type).toBe("bigint");
    expect(by.updated_at.data_type).toBe("bigint");
    expect(by.owner_id.is_nullable).toBe("NO");
    const fks = await db.pool.query(
      `select a.attname, c.confrelid::regclass::text as target from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
       where c.contype = 'f' and c.conrelid = 'agents'::regclass order by a.attname`,
    );
    expect(fks.rows.map((r) => [r.attname, r.target])).toEqual([
      ["core_id", "cores"],
      ["owner_id", "operator"],
    ]);
  });

  it("has no column that could hold a shell command, a script, an environment or a key", async () => {
    const { rows } = await db.pool.query(`select column_name from information_schema.columns where table_name = 'agents'`);
    const names = rows.map((r) => String(r.column_name));
    expect(names.sort()).toEqual(
      ["core_id", "created_at", "flags", "harness", "id", "is_default", "model", "name", "owner_id", "updated_at"].sort(),
    );
    for (const n of names) expect(n).not.toMatch(/command|args|script|shell|env|key|secret|token|cmd|exec/);
  });

  it("accepts each harness and refuses any other", async () => {
    let i = 0;
    for (const h of ["claude-code", "codex", "cursor-cli", "opencode", "pi"]) await insertAgent(`h-${i++}`, { harness: h, name: h });
    await expect(insertAgent("h-bad", { harness: "bash" })).rejects.toThrow(/agents_harness_check/);
  });

  it("keeps a name unique per Core, and free on another Core", async () => {
    await insertAgent("n1", { name: "dup" });
    await expect(insertAgent("n2", { name: "dup" })).rejects.toThrow(/agents_core_name_unique/);
    await insertAgent("n3", { name: "dup", core: "c2" });
  });

  it("allows one default Agent per harness per Core", async () => {
    await insertAgent("d1", { core: "c2", harness: "codex", name: "d1", isDefault: true });
    await expect(insertAgent("d2", { core: "c2", harness: "codex", name: "d2", isDefault: true })).rejects.toThrow(
      /agents_default_per_harness/,
    );
    await insertAgent("d3", { core: "c2", harness: "codex", name: "d3" });
    await insertAgent("d4", { core: "c2", harness: "pi", name: "d4", isDefault: true });
  });

  it("refuses an owner that is not the Operator", async () => {
    await expect(
      db.pool.query(
        "insert into agents (id, owner_id, core_id, name, harness, created_at, updated_at) values ('x', 2, 'c1', 'x', 'codex', 1, 1)",
      ),
    ).rejects.toThrow(/agents_owner_id_operator_id_fk/);
  });

  it("deletes a Core's Agents with the Core", async () => {
    await insertAgent("z1", { core: "c1", name: "z1" });
    await db.pool.query("delete from cores where id = 'c1'");
    const { rows } = await db.pool.query("select count(*)::int as n from agents where core_id = 'c1'");
    expect(rows[0]).toEqual({ n: 0 });
  });
});
