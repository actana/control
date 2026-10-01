import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../test-db";

/** The webhook, outbox and delivery tables a migration creates (#574, ADR 0041 D15, D18, D23). */

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

const sealed = Buffer.from([1, 2, 3]);

const insertWebhook = (id: string, over: { allCores?: boolean } = {}) =>
  db.pool.query(
    `insert into webhooks (id, owner_id, url, secret_sealed, events, all_cores, created_at, updated_at)
     values ($1, 1, 'https://example.test/hook', $2, '{task.created}', $3, 1, 1)`,
    [id, sealed, over.allCores ?? true],
  );

describe("the webhook tables", () => {
  it("keep every time column as bigint and the owner as a not-null foreign key", async () => {
    const { rows } = await db.pool.query(
      `select table_name, column_name, data_type, is_nullable from information_schema.columns
       where table_name in ('webhooks', 'webhook_cores', 'webhook_outbox', 'webhook_deliveries')
         and (column_name like '%\\_at' or column_name = 'owner_id' or column_name = 'claimed_until'
              or column_name = 'next_attempt_at')
       order by table_name, column_name`,
    );
    for (const r of rows) {
      if (r.column_name === "owner_id") expect([r.table_name, r.is_nullable]).toEqual([r.table_name, "NO"]);
      else expect([r.table_name, r.column_name, r.data_type]).toEqual([r.table_name, r.column_name, "bigint"]);
    }
    expect(rows.filter((r) => r.column_name === "owner_id")).toHaveLength(4);
  });

  it("refuse a webhook with an owner that is not the Operator", async () => {
    await expect(
      db.pool.query(
        `insert into webhooks (id, owner_id, url, secret_sealed, events, created_at, updated_at)
         values ('x', 2, 'https://example.test', $1, '{ping}', 1, 1)`,
        [sealed],
      ),
    ).rejects.toThrow(/webhooks_owner_id_operator_id_fk/);
  });

  it("accept each webhook event type and refuse any other", async () => {
    await db.pool.query(
      `insert into webhook_outbox (id, owner_id, event_type, payload, created_at)
       values ('o1', 1, 'task.created', '{}', 1),
              ('o2', 1, 'task.updated', '{}', 1),
              ('o3', 1, 'task.status_changed', '{}', 1),
              ('o4', 1, 'task.deleted', '{}', 1),
              ('o5', 1, 'comment.created', '{}', 1),
              ('o6', 1, 'ping', '{}', 1)`,
    );
    await expect(
      db.pool.query(
        `insert into webhook_outbox (id, owner_id, event_type, payload, created_at) values ('bad', 1, 'task.moved', '{}', 1)`,
      ),
    ).rejects.toThrow(/webhook_outbox_event_type_check/);
  });

  it("stores the sealed secret as bytea", async () => {
    await insertWebhook("w1");
    const { rows } = await db.pool.query(
      "select secret_sealed, pg_typeof(secret_sealed)::text as type from webhooks where id = 'w1'",
    );
    expect(rows[0].type).toBe("bytea");
    expect(Buffer.from(rows[0].secret_sealed as Uint8Array).equals(sealed)).toBe(true);
  });

  it("scopes a restricted webhook to Cores, and cascades with the webhook or the Core", async () => {
    await insertWebhook("s1", { allCores: false });
    await insertWebhook("s2", { allCores: false });
    await db.pool.query("insert into webhook_cores (webhook_id, core_id, owner_id) values ('s1', 'c1', 1), ('s2', 'c1', 1)");
    await expect(
      db.pool.query("insert into webhook_cores (webhook_id, core_id, owner_id) values ('s1', 'c1', 1)"),
    ).rejects.toThrow(/webhook_cores_webhook_id_core_id_pk/);
    await db.pool.query("delete from webhooks where id = 's1'");
    expect((await db.pool.query("select count(*)::int as n from webhook_cores where webhook_id = 's1'")).rows[0]).toEqual({
      n: 0,
    });
  });

  it("keeps delivery status in pending, delivered or failed", async () => {
    await insertWebhook("d1");
    await db.pool.query(
      `insert into webhook_outbox (id, owner_id, event_type, payload, created_at) values ('od1', 1, 'ping', '{}', 1)`,
    );
    await db.pool.query(
      `insert into webhook_deliveries
         (id, owner_id, webhook_id, outbox_id, event_type, payload, status, next_attempt_at, created_at, updated_at)
       values ('del1', 1, 'd1', 'od1', 'ping', '{}', 'pending', 1, 1, 1)`,
    );
    await expect(
      db.pool.query(`update webhook_deliveries set status = 'sending' where id = 'del1'`),
    ).rejects.toThrow(/webhook_deliveries_status_check/);
  });

  it("keeps one delivery per outbox and webhook", async () => {
    await insertWebhook("u1");
    await db.pool.query(
      `insert into webhook_outbox (id, owner_id, event_type, payload, created_at) values ('ou1', 1, 'ping', '{}', 1)`,
    );
    await db.pool.query(
      `insert into webhook_deliveries
         (id, owner_id, webhook_id, outbox_id, event_type, payload, status, next_attempt_at, created_at, updated_at)
       values ('du1', 1, 'u1', 'ou1', 'ping', '{}', 'pending', 1, 1, 1)`,
    );
    await expect(
      db.pool.query(
        `insert into webhook_deliveries
           (id, owner_id, webhook_id, outbox_id, event_type, payload, status, next_attempt_at, created_at, updated_at)
         values ('du2', 1, 'u1', 'ou1', 'ping', '{}', 'pending', 1, 1, 1)`,
      ),
    ).rejects.toThrow(/webhook_deliveries_outbox_webhook_unique/);
  });
});
