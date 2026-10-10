import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../pg-migrate";
import { bundledPanelMigrations } from "../pg-migrations-bundle";
import { createTestDb, type TestDb } from "../test-db";

/** The API key tables a migration creates (#572, ADR 0041 D15, D18, D23). */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb({ env: {} });
  await db.pool.query(
    "insert into operator (id, name, password_hash, created_at, password_changed_at) values (1, 'o', 'h', 1, 1)",
  );
  await db.pool.query(
    "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ('c1', 1, 'c', 'https://c1', 1, 1)",
  );
}, 30_000);
afterAll(async () => {
  await db.close();
});

const insertKey = (id: string, over: { hash?: string; revokedAt?: number | null; permissions?: string[] } = {}) =>
  db.pool.query(
    "insert into api_keys (id, owner_id, name, prefix, key_hash, permissions, created_at, revoked_at) values ($1, 1, $1, 'ak_1_abcdef', $2, $3, 1, $4)",
    [id, over.hash ?? `hash-${id}`, over.permissions ?? ["read", "tasks:write", "agents:write"], over.revokedAt ?? null],
  );

describe("the api_keys table", () => {
  it("has a not-null owner_id that references operator, bigint times, and all_cores true by default", async () => {
    const { rows } = await db.pool.query(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'api_keys'`,
    );
    const by = Object.fromEntries(rows.map((r) => [r.column_name, r]));
    expect(by.owner_id.is_nullable).toBe("NO");
    expect(by.created_at.data_type).toBe("bigint");
    expect(by.revoked_at.data_type).toBe("bigint");
    expect(by.all_cores.column_default).toBe("true");
    await expect(
      db.pool.query(
        "insert into api_keys (id, owner_id, name, prefix, key_hash, permissions, created_at) values ('x', 2, 'x', 'p', 'hx', '{read}', 1)",
      ),
    ).rejects.toThrow(/api_keys_owner_id_operator_id_fk/);
  });

  it("has no column that could hold the plaintext key", async () => {
    const { rows } = await db.pool.query(`select column_name from information_schema.columns where table_name = 'api_keys'`);
    expect(rows.map((r) => String(r.column_name)).sort()).toEqual(
      ["all_cores", "created_at", "id", "key_hash", "name", "owner_id", "permissions", "prefix", "revoked_at"].sort(),
    );
  });

  it("holds at least one known permission per key, with no column default (#688)", async () => {
    const { rows } = await db.pool.query(
      `select is_nullable, column_default, data_type from information_schema.columns where table_name = 'api_keys' and column_name = 'permissions'`,
    );
    expect(rows[0]).toEqual({ is_nullable: "NO", column_default: null, data_type: "ARRAY" });
    await expect(insertKey("p-empty", { permissions: [] })).rejects.toThrow(/api_keys_permissions_check/);
    await expect(insertKey("p-unknown", { permissions: ["read", "admin"] })).rejects.toThrow(/api_keys_permissions_check/);
    await expect(
      db.pool.query(
        "insert into api_keys (id, owner_id, name, prefix, key_hash, created_at) values ('p-none', 1, 'p', 'p', 'hp', 1)",
      ),
    ).rejects.toThrow(/permissions/);
    await insertKey("p-read", { permissions: ["read"] });
    await insertKey("p-write", { permissions: ["tasks:write", "agents:write"] });
    const { rows: stored } = await db.pool.query("select id, permissions from api_keys where id like 'p-%' order by id");
    expect(stored).toEqual([
      { id: "p-read", permissions: ["read"] },
      { id: "p-write", permissions: ["tasks:write", "agents:write"] },
    ]);
  });

  it("keeps a key hash unique", async () => {
    await insertKey("k1", { hash: "same" });
    await expect(insertKey("k2", { hash: "same" })).rejects.toThrow(/api_keys_key_hash_unique/);
  });

  it("sets revoked_at once, and then refuses to change or clear it", async () => {
    await insertKey("r1");
    await db.pool.query("update api_keys set revoked_at = 5 where id = 'r1'");
    await expect(db.pool.query("update api_keys set revoked_at = null where id = 'r1'")).rejects.toThrow(
      /api_keys_revocation_is_final/,
    );
    await expect(db.pool.query("update api_keys set revoked_at = 9 where id = 'r1'")).rejects.toThrow(
      /api_keys_revocation_is_final/,
    );
    await db.pool.query("update api_keys set name = 'renamed' where id = 'r1'");
    const { rows } = await db.pool.query("select revoked_at from api_keys where id = 'r1'");
    expect(Number(rows[0]!.revoked_at)).toBe(5);
  });
});

describe("the api_key_cores table", () => {
  it("references the key, the Core and the Operator, and goes with either the key or the Core", async () => {
    await insertKey("s1");
    await insertKey("s2");
    await db.pool.query("insert into api_key_cores (key_id, core_id, owner_id) values ('s1', 'c1', 1), ('s2', 'c1', 1)");
    await expect(db.pool.query("insert into api_key_cores (key_id, core_id, owner_id) values ('s1', 'c1', 1)")).rejects.toThrow(
      /api_key_cores_key_id_core_id_pk/,
    );
    await expect(
      db.pool.query("insert into api_key_cores (key_id, core_id, owner_id) values ('s1', 'nope', 1)"),
    ).rejects.toThrow(/api_key_cores_core_id_cores_id_fk/);
    await db.pool.query("delete from api_keys where id = 's1'");
    expect((await db.pool.query("select count(*)::int as n from api_key_cores where key_id = 's1'")).rows[0]).toEqual({ n: 0 });
    await db.pool.query("insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ('c2', 1, 'c', 'https://c2', 1, 1)");
    await db.pool.query("insert into api_key_cores (key_id, core_id, owner_id) values ('s2', 'c2', 1)");
    await db.pool.query("delete from cores where id = 'c2'");
    expect((await db.pool.query("select count(*)::int as n from api_key_cores where core_id = 'c2'")).rows[0]).toEqual({ n: 0 });
  });
});

describe("keys created before #688", () => {
  it("get the full permission set from the migration, and keep their access", { timeout: 30_000 }, async () => {
    const all = bundledPanelMigrations();
    const before = all.findIndex((m) => m.tag === "0010_panel_api_key_permissions");
    expect(before).toBeGreaterThan(0);
    const old = await createTestDb({ env: {}, migrations: all.slice(0, before) });
    try {
      await old.pool.query(
        "insert into operator (id, name, password_hash, created_at, password_changed_at) values (1, 'o', 'h', 1, 1)",
      );
      // The pre-#688 row shape: no permissions column at all.
      await old.pool.query(
        "insert into api_keys (id, owner_id, name, prefix, key_hash, all_cores, created_at) values ('legacy', 1, 'legacy', 'ak_1_abcdef', 'h-legacy', true, 1), ('legacy-revoked', 1, 'r', 'ak_1_abcdef', 'h-r', false, 1)",
      );
      await old.pool.query("update api_keys set revoked_at = 2 where id = 'legacy-revoked'");
      expect(await runMigrations(old.pool, all)).toEqual(["0010_panel_api_key_permissions"]);
      const { rows } = await old.pool.query(
        "select id, permissions, all_cores, revoked_at::int as revoked_at from api_keys order by id",
      );
      expect(rows).toEqual([
        { id: "legacy", permissions: ["read", "tasks:write", "agents:write"], all_cores: true, revoked_at: null },
        { id: "legacy-revoked", permissions: ["read", "tasks:write", "agents:write"], all_cores: false, revoked_at: 2 },
      ]);
      // The backfill default is gone: a new row must say its permissions.
      await expect(
        old.pool.query("insert into api_keys (id, owner_id, name, prefix, key_hash, created_at) values ('new', 1, 'n', 'p', 'h-n', 1)"),
      ).rejects.toThrow(/permissions/);
    } finally {
      await old.close();
    }
  });
});
