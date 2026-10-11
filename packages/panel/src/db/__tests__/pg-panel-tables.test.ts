import { afterEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../test-db";

/**
 * The migration that moves `panel.db` to Postgres (#567, ADR 0041 D14, D18):
 * what the four tables look like once migrated, and the SQLite-isms that
 * changed (epoch milliseconds past 2^31, a sealed blob, the single-row check).
 */

const open: TestDb[] = [];
async function make() {
  const db = await createTestDb();
  open.push(db);
  return db;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

const NOW = 1_790_800_767_886; // epoch ms: well past the 2^31 an int4 holds

async function seedOperator(db: TestDb, id = 1) {
  await db.pool.query(
    "insert into operator (id, name, password_hash, created_at, password_changed_at) values ($1, 'op', 'h', $2, $2)",
    [id, NOW],
  );
}

describe("the panel.db tables on Postgres", { timeout: 30_000 }, () => {
  it("creates operator, panel_sessions, cores, core_secrets, the Shared folder tables, the Task tables, agents, webhooks, the API key tables and the missioncontrol.db tables", async () => {
    const db = await make();
    const { rows } = await db.pool.query(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "agents",
      "api_key_cores",
      "api_keys",
      "app_settings",
      "core_secrets",
      "core_shared_folders",
      "cores",
      "event_log",
      "home_terminals",
      "operator",
      "panel_sessions",
      "sessions",
      "storage_config",
      "task_comments",
      "task_status_history",
      "tasks",
      "terminal_logs",
      "token_usage",
      "token_usage_rollup",
      "token_usage_session_offsets",
      "webhook_cores",
      "webhook_deliveries",
      "webhook_outbox",
      "webhooks",
    ]);
  });

  it("keeps epoch milliseconds in bigint columns", async () => {
    const db = await make();
    const { rows } = await db.pool.query(
      `select table_name, column_name, data_type from information_schema.columns
       where table_schema = 'public' and column_name in (
         'created_at','updated_at','last_seen_at','expires_at','last_event_id','password_changed_at',
         'changed_at','dispatched_at','processed_at','next_attempt_at','claimed_until','delivered_at','key_expires_at'
       )`,
    );
    // 36 since #689 added api_keys.expires_at.
    expect(rows.length).toBe(36);
    for (const r of rows) expect(r.data_type, `${r.table_name}.${r.column_name}`).toBe("bigint");
    await seedOperator(db);
    // An int4 column would reject this outright.
    await db.pool.query(
      "insert into panel_sessions (id, owner_id, token_hash, created_at, last_seen_at, expires_at) values ('s', 1, 't', $1, $1, $1)",
      [NOW],
    );
    const read = await db.pool.query("select expires_at from panel_sessions");
    expect(Number(read.rows[0].expires_at)).toBe(NOW);
  });

  it("stores the sealed secret as bytea and gives the bytes back unchanged", async () => {
    const db = await make();
    await seedOperator(db);
    await db.pool.query(
      "insert into cores (id, owner_id, endpoint, label, created_at, updated_at) values ('c', 1, 'wss://a:1', 'a', $1, $1)",
      [NOW],
    );
    const bytes = Buffer.from([0, 1, 2, 253, 254, 255]);
    await db.pool.query("insert into core_secrets (core_id, owner_id, sealed, updated_at) values ('c', 1, $1, $2)", [
      bytes,
      NOW,
    ]);
    const { rows } = await db.pool.query(
      "select sealed, pg_typeof(sealed)::text as type from core_secrets where core_id = 'c'",
    );
    expect(rows[0].type).toBe("bytea");
    expect(Buffer.from(rows[0].sealed as Uint8Array).equals(bytes)).toBe(true);
  });

  it("keeps the operator single-row: only id 1 is accepted", async () => {
    const db = await make();
    await expect(seedOperator(db, 2)).rejects.toThrow(/operator_single_row/);
    await seedOperator(db, 1);
    await expect(seedOperator(db, 1)).rejects.toThrow(/duplicate key|unique/i);
  });

  it("refuses an owner_id that is not an operator, on every owner-scoped table", async () => {
    const db = await make();
    await expect(
      db.pool.query(
        "insert into panel_sessions (id, owner_id, token_hash, created_at, last_seen_at, expires_at) values ('s', 9, 't', 1, 1, 1)",
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      db.pool.query(
        "insert into cores (id, owner_id, endpoint, label, created_at, updated_at) values ('c', 9, 'wss://a:1', 'a', 1, 1)",
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("cascades: removing a Core takes its secrets, and removing the Operator takes everything", async () => {
    const db = await make();
    await seedOperator(db);
    await db.pool.query(
      "insert into cores (id, owner_id, endpoint, label, created_at, updated_at) values ('c', 1, 'wss://a:1', 'a', 1, 1)",
    );
    await db.pool.query("insert into core_secrets (core_id, owner_id, sealed, updated_at) values ('c', 1, $1, 1)", [
      Buffer.from("x"),
    ]);
    await db.pool.query("delete from cores where id = 'c'");
    expect((await db.pool.query("select 1 from core_secrets")).rows).toHaveLength(0);
    await db.pool.query(
      "insert into panel_sessions (id, owner_id, token_hash, created_at, last_seen_at, expires_at) values ('s', 1, 't', 1, 1, 1)",
    );
    await db.pool.query("delete from operator");
    expect((await db.pool.query("select 1 from panel_sessions")).rows).toHaveLength(0);
  });

  it("allows one registration per endpoint for an owner, and a unique token hash", async () => {
    const db = await make();
    await seedOperator(db);
    const insert = (id: string) =>
      db.pool.query(
        "insert into cores (id, owner_id, endpoint, label, created_at, updated_at) values ($1, 1, 'wss://a:1', 'a', 1, 1)",
        [id],
      );
    await insert("c1");
    await expect(insert("c2")).rejects.toThrow(/cores_owner_endpoint_unique/);
    const session = (id: string) =>
      db.pool.query(
        "insert into panel_sessions (id, owner_id, token_hash, created_at, last_seen_at, expires_at) values ($1, 1, 'same', 1, 1, 1)",
        [id],
      );
    await session("s1");
    await expect(session("s2")).rejects.toThrow(/token_hash/);
  });
});
