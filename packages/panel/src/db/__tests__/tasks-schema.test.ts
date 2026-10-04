import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../test-db";

/** The tasks, task_comments and task_status_history tables a migration creates (#568, ADR 0041 D15, D18, D23). */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb({ env: {} });
  await db.pool.query(
    "insert into operator (id, name, password_hash, created_at, password_changed_at) values (1, 'o', 'h', 1, 1)",
  );
}, 30_000);
afterAll(async () => {
  await db.close();
});

const insertTask = (id: string, status = "draft") =>
  db.pool.query(
    "insert into tasks (id, owner_id, title, status, created_at, updated_at) values ($1, 1, 't', $2, 1, 1)",
    [id, status],
  );
const insertComment = (id: string, taskId: string, kind: string, sourceFile: string | null) =>
  db.pool.query(
    "insert into task_comments (id, task_id, owner_id, author_kind, author_name, source_file, body, created_at) values ($1, $2, 1, $3, 'n', $4, 'b', 1)",
    [id, taskId, kind, sourceFile],
  );

describe("the task tables", () => {
  it("keep every time column as bigint and the owner as a not-null foreign key", async () => {
    const { rows } = await db.pool.query(
      `select table_name, column_name, data_type, is_nullable from information_schema.columns
       where table_name in ('tasks', 'task_comments', 'task_status_history')
         and (column_name like '%\\_at' or column_name = 'owner_id')
       order by table_name, column_name`,
    );
    for (const r of rows) {
      if (r.column_name === "owner_id") expect([r.table_name, r.is_nullable]).toEqual([r.table_name, "NO"]);
      else expect([r.table_name, r.column_name, r.data_type]).toEqual([r.table_name, r.column_name, "bigint"]);
    }
    expect(rows.filter((r) => r.column_name === "owner_id")).toHaveLength(3);
  });

  it("have no foreign key from tasks.agent to anything (Agents are #569)", async () => {
    const { rows } = await db.pool.query(
      `select a.attname from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
       where c.contype = 'f' and c.conrelid = 'tasks'::regclass`,
    );
    expect(rows.map((r) => r.attname).sort()).toEqual(["core_id", "owner_id"]);
  });

  it("accept each of the six statuses and refuse any other", async () => {
    for (const s of ["draft", "assigned", "in_progress", "done", "failed", "partial"]) {
      await insertTask(`ok-${s}`, s);
    }
    await expect(insertTask("bad", "cancelled")).rejects.toThrow(/tasks_status_check/);
  });

  it("refuse a Task with an owner that is not the Operator", async () => {
    await expect(
      db.pool.query("insert into tasks (id, owner_id, title, created_at, updated_at) values ('x', 2, 't', 1, 1)"),
    ).rejects.toThrow(/tasks_owner_id_operator_id_fk/);
  });

  it("refuse an author kind other than user, agent and system, and a source file on a non-agent", async () => {
    await insertTask("c1");
    await insertComment("k1", "c1", "user", null);
    await insertComment("k2", "c1", "system", null);
    await insertComment("k3", "c1", "agent", "a.md");
    await expect(insertComment("k4", "c1", "bot", null)).rejects.toThrow(/task_comments_author_kind_check/);
    await expect(insertComment("k5", "c1", "user", "a.md")).rejects.toThrow(/task_comments_source_file_check/);
  });

  it("keep an agent's source file unique per Task, and free on another Task", async () => {
    await insertTask("u1");
    await insertTask("u2");
    await insertComment("u-a", "u1", "agent", "out.md");
    await expect(insertComment("u-b", "u1", "agent", "out.md")).rejects.toThrow(/task_comments_task_source_file_unique/);
    await insertComment("u-c", "u2", "agent", "out.md");
  });

  it("delete a Task's comments and history with it", async () => {
    await insertTask("d1");
    await insertComment("d-k", "d1", "user", null);
    await db.pool.query(
      "insert into task_status_history (id, task_id, owner_id, from_status, to_status, changed_at) values ('d-h', 'd1', 1, null, 'draft', 1)",
    );
    await db.pool.query("delete from tasks where id = 'd1'");
    const { rows } = await db.pool.query(
      "select (select count(*) from task_comments where task_id = 'd1')::int as c, (select count(*) from task_status_history where task_id = 'd1')::int as h",
    );
    expect(rows[0]).toEqual({ c: 0, h: 0 });
  });
});
