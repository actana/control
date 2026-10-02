/**
 * The migration that moves `missioncontrol.db` to Postgres (#567 PR 5): the
 * seven tables plus the token-usage rollup, with owner_id, bigint epoch ms,
 * boolean columns, and identity event ids.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../test-db";

const open: TestDb[] = [];
async function make() {
  const db = await createTestDb();
  open.push(db);
  return db;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

const NOW = 1_790_800_767_886;

async function seedOperator(db: TestDb, id = 1) {
  await db.pool.query(
    "insert into operator (id, name, password_hash, created_at, password_changed_at) values ($1, 'op', 'h', $2, $2)",
    [id, NOW],
  );
}

describe("the missioncontrol.db tables on Postgres", { timeout: 30_000 }, () => {
  it("keeps epoch milliseconds in bigint and booleans as boolean", async () => {
    const db = await make();
    await seedOperator(db);
    await db.pool.query(
      `insert into sessions (
         id, owner_id, title, title_manually_set, agent, status, branch, preview,
         lines, archived, pinned, claude_skip_permissions, claude_bare_session,
         created_at, updated_at
       ) values ('s1', 1, 't', false, 'claude-code', 'ready', 'main', '', 0, false, false, false, false, $1, $1)`,
      [NOW],
    );
    const read = await db.pool.query(
      "select created_at, archived, title_manually_set from sessions where id = 's1'",
    );
    expect(Number(read.rows[0].created_at)).toBe(NOW);
    expect(read.rows[0].archived).toBe(false);
    expect(read.rows[0].title_manually_set).toBe(false);
  });

  it("gives event_log an identity primary key and owner_id", async () => {
    const db = await make();
    await seedOperator(db);
    const a = await db.pool.query(
      "insert into event_log (owner_id, ts, kind, payload) values (1, $1, 'session:created', '{}') returning event_id",
      [NOW],
    );
    const b = await db.pool.query(
      "insert into event_log (owner_id, ts, kind, payload) values (1, $1, 'session:updated', '{}') returning event_id",
      [NOW],
    );
    expect(Number(b.rows[0].event_id)).toBe(Number(a.rows[0].event_id) + 1);
  });

  it("scopes app_settings by (owner_id, key)", async () => {
    const db = await make();
    await db.pool.query("alter table operator drop constraint operator_single_row");
    await seedOperator(db, 1);
    await seedOperator(db, 2);
    await db.pool.query(
      "insert into app_settings (owner_id, key, value) values (1, 'k', 'a'), (2, 'k', 'b')",
    );
    const alice = await db.pool.query("select value from app_settings where owner_id = 1 and key = 'k'");
    const bob = await db.pool.query("select value from app_settings where owner_id = 2 and key = 'k'");
    expect(alice.rows[0].value).toBe("a");
    expect(bob.rows[0].value).toBe("b");
  });

  it("holds rollup counters and byte_offset past 2^31 (SQLite INTEGER width)", async () => {
    const db = await make();
    await seedOperator(db);
    await db.pool.query(
      `insert into sessions (
         id, owner_id, title, title_manually_set, agent, status, branch, preview,
         lines, archived, pinned, claude_skip_permissions, claude_bare_session,
         created_at, updated_at
       ) values ('s1', 1, 't', false, 'claude-code', 'ready', 'main', '', 0, false, false, false, false, $1, $1)`,
      [NOW],
    );
    // One past int4 max: an integer column would reject this with "out of range".
    const pastInt4 = 2_147_483_648;
    await db.pool.query(
      `insert into token_usage_rollup (
         owner_id, session_id, day, input_tokens, output_tokens,
         cache_creation_tokens, cache_read_tokens, last_ts
       ) values (1, 's1', '2026-05-10', $1, $1, $1, $1, $2)`,
      [pastInt4, NOW],
    );
    await db.pool.query(
      `insert into token_usage_session_offsets (
         owner_id, claude_session_id, session_id, byte_offset, updated_at
       ) values (1, 'claude-1', 's1', $1, $2)`,
      [pastInt4, NOW],
    );
    const types = await db.pool.query(
      `select column_name, data_type from information_schema.columns
       where table_schema = 'public' and (
         (table_name = 'token_usage_rollup' and column_name in (
           'input_tokens','output_tokens','cache_creation_tokens','cache_read_tokens'
         ))
         or (table_name = 'token_usage_session_offsets' and column_name = 'byte_offset')
       )
       order by table_name, column_name`,
    );
    for (const r of types.rows) {
      expect(r.data_type, String(r.column_name)).toBe("bigint");
    }
    const rollup = await db.pool.query(
      "select input_tokens::text as i, cache_read_tokens::text as c from token_usage_rollup where session_id = 's1'",
    );
    expect(Number(rollup.rows[0].i)).toBe(pastInt4);
    expect(Number(rollup.rows[0].c)).toBe(pastInt4);
    const offset = await db.pool.query(
      "select byte_offset::text as b from token_usage_session_offsets where claude_session_id = 'claude-1'",
    );
    expect(Number(offset.rows[0].b)).toBe(pastInt4);
  });
});
