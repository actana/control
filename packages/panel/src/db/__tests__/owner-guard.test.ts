import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { PgDialect, integer, pgSchema, pgTable, text } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it } from "vitest";
import * as panelSchema from "../pg-schema";
import { ownedBy } from "../owner";
import { bundledPanelMigrations } from "../pg-migrations-bundle";
import { parseMigrations } from "../pg-migrate";
import { createTestDb, type TestDb } from "../test-db";
import {
  OWNERLESS_TABLES,
  checkDatabaseTables,
  checkSchemaTables,
  REPOSITORY_DIR,
  findUnscopedQueries,
  ownerScopedTables,
  pgSchemaImportsOutsideRepositories,
  repositoryFiles,
  scanRepositories,
} from "./owner-guard-checks";

/**
 * The ownership guard (#567, ADR 0041 D15): every Panel table is owner-scoped
 * (`owner_id`, not null, referencing `operator.id`) or on the short allowlist
 * in `owner-guard-checks.ts`, and no repository query on an owner-scoped table
 * skips the owner. The first two describe blocks run the guard on the real
 * schema; the rest plant a violation to show that the guard can fail.
 */

const operator = pgTable("operator", { id: integer("id").primaryKey() });
const owned = pgTable("tasks", {
  id: integer("id").primaryKey(),
  ownerId: integer("owner_id")
    .notNull()
    .references(() => operator.id),
});

describe("the Panel's schema", () => {
  it("has an owner_id on every table that is not allowlisted", () => {
    expect(checkSchemaTables(panelSchema)).toEqual([]);
  });

  it("gives every allowlisted table a reason", () => {
    for (const [table, reason] of Object.entries(OWNERLESS_TABLES)) {
      expect(reason.length, table).toBeGreaterThan(10);
    }
  });
});

describe("the migrated database", { timeout: 30_000 }, () => {
  const open: TestDb[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => db.close()));
  });
  // One statement per array item: a migration file separates them with a breakpoint.
  const migrate = async (...statements: string[]) => {
    const sql = statements.join("\n--> statement-breakpoint\n");
    const extra = sql
      ? parseMigrations({ entries: [{ tag: "0001_planted", when: 1790800767886 + 1000 }] }, { "0001_planted": sql })
      : [];
    const db = await createTestDb({ env: {}, migrations: [...bundledPanelMigrations(), ...extra] });
    open.push(db);
    return db.pool;
  };

  it("has an owner_id on every table that is not allowlisted", async () => {
    expect(await checkDatabaseTables(await migrate())).toEqual([]);
  });

  it("passes a table with a not-null owner_id that references operator.id", async () => {
    const pool = await migrate(
      "CREATE TABLE tasks (id integer PRIMARY KEY, owner_id integer NOT NULL REFERENCES operator (id))",
    );
    expect(await checkDatabaseTables(pool)).toEqual([]);
  });

  it("fails a planted table that has no owner_id", async () => {
    const pool = await migrate("CREATE TABLE planted (id integer PRIMARY KEY)");
    expect(await checkDatabaseTables(pool)).toEqual(["public.planted has no owner_id column"]);
  });

  it("fails a planted owner_id that is nullable, or that references nothing", async () => {
    const pool = await migrate(
      "CREATE TABLE nullable (id integer PRIMARY KEY, owner_id integer REFERENCES operator (id))",
      "CREATE TABLE dangling (id integer PRIMARY KEY, owner_id integer NOT NULL)",
    );
    expect(await checkDatabaseTables(pool)).toEqual([
      "public.dangling.owner_id does not reference operator.id",
      "public.nullable.owner_id is nullable",
    ]);
  });
});

describe("checkSchemaTables on planted drizzle tables", () => {
  it("passes an owner-scoped table and the allowlisted operator", () => {
    expect(checkSchemaTables({ operator, owned })).toEqual([]);
  });

  it("fails a table with no owner_id", () => {
    const planted = pgTable("planted", { id: integer("id").primaryKey() });
    expect(checkSchemaTables({ operator, owned, planted })).toEqual(["public.planted has no owner_id column"]);
  });

  it("fails a nullable owner_id and one that references another table", () => {
    const nullable = pgTable("nullable", {
      ownerId: integer("owner_id").references(() => operator.id),
    });
    const other = pgTable("other", { id: integer("id").primaryKey(), name: text("name") });
    const wrongTarget = pgTable("wrong_target", {
      ownerId: integer("owner_id")
        .notNull()
        .references(() => other.id),
    });
    expect(checkSchemaTables({ operator, other: undefined, nullable, wrongTarget })).toEqual([
      "public.nullable.owner_id is nullable",
      "public.wrong_target.owner_id does not reference operator.id",
    ]);
  });
});

describe("checkSchemaTables on an operator table of another schema", () => {
  it("fails an owner_id that references other.operator.id, not public.operator", () => {
    const otherOperator = pgSchema("other").table("operator", { id: integer("id").primaryKey() });
    const lookalike = pgTable("lookalike", {
      ownerId: integer("owner_id")
        .notNull()
        .references(() => otherOperator.id),
    });
    expect(checkSchemaTables({ operator, lookalike })).toEqual([
      "public.lookalike.owner_id does not reference operator.id",
    ]);
  });
});

describe("findUnscopedQueries", () => {
  const tables = ownerScopedTables({ operator, tasks: owned });
  const scan = (source: string) => findUnscopedQueries(source, tables, "tasks-repo.ts");

  it("knows tasks is owner-scoped and the operator is not", () => {
    expect(tables).toEqual([{ exportName: "tasks", sqlName: "tasks" }]);
  });

  it("passes queries that carry the owner", () => {
    expect(
      scan(`
        const rows = await db.select().from(tasks).where(ownedBy(tasks, owner, eq(tasks.id, id)));
        await db.update(tasks).set({ title }).where(ownedBy(tasks, owner, eq(tasks.id, id)));
        await db.delete(tasks).where(ownedBy(tasks, owner));
        await db.insert(tasks).values({ ownerId: owner, title });
        await pool.query("SELECT * FROM tasks WHERE owner_id = $1", [owner]);
      `),
    ).toEqual([]);
  });

  it("fails a select, update and delete on tasks without the owner", () => {
    const faults = scan(`
      const a = await db.select().from(tasks).where(eq(tasks.id, id));
      await db.update(tasks).set({ title }).where(eq(tasks.id, id));
      await db.delete(tasks).where(eq(tasks.id, id));
    `);
    expect(faults).toEqual([
      "tasks-repo.ts:2 queries tasks without ownedBy()",
      "tasks-repo.ts:3 queries tasks without ownedBy()",
      "tasks-repo.ts:4 queries tasks without ownedBy()",
    ]);
  });

  it("fails an insert without ownerId, and raw SQL without owner_id", () => {
    expect(scan(`await db.insert(tasks).values({ title });`)).toEqual([
      "tasks-repo.ts:1 inserts into tasks without ownerId",
    ]);
    expect(scan('await pool.query("DELETE FROM tasks WHERE id = $1", [id]);')).toEqual([
      "tasks-repo.ts:1 raw SQL on tasks without owner_id",
    ]);
  });

  it("wants the owner for each owner-scoped table a join names", () => {
    expect(
      scan(`await db.select().from(tasks).innerJoin(tasks, eq(tasks.id, x)).where(ownedBy(tasks, owner));`),
    ).toEqual(["tasks-repo.ts:1 queries tasks, tasks without ownedBy()"]);
  });

  it("fails the relational API, a sql template and a count over the table without the owner", () => {
    expect(scan("await db.query.tasks.findMany({ where: eq(tasks.id, id) });")).toEqual([
      "tasks-repo.ts:1 queries tasks without ownedBy()",
    ]);
    expect(scan("await db.execute(sql`select * from ${tasks} where id = ${id}`);")).toEqual([
      "tasks-repo.ts:1 sql template over tasks without the owner",
    ]);
    expect(scan("const n = await db.$count(tasks);")).toEqual(["tasks-repo.ts:1 queries tasks without ownedBy()"]);
  });

  it("passes the same three forms once they carry the owner", () => {
    expect(
      scan(`
        await db.query.tasks.findMany({ where: ownedBy(tasks, owner, eq(tasks.id, id)) });
        await db.execute(sql\`select * from \${tasks} where \${tasks.ownerId} = \${owner}\`);
        const n = await db.$count(tasks, ownedBy(tasks, owner));
      `),
    ).toEqual([]);
  });

  it("does not take a comment's word for it", () => {
    expect(scan("await db.select().from(tasks)\n  // ownedBy(tasks, owner)\n  /* ownedBy( */;")).toEqual([
      "tasks-repo.ts:1 queries tasks without ownedBy()",
    ]);
  });
});

describe("scanRepositories", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const repoDir = (files: Record<string, string>) => {
    const dir = mkdtempSync(path.join(tmpdir(), "actana-owner-guard-"));
    made.push(dir);
    for (const [name, source] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), source);
    }
    return dir;
  };
  const tables = ownerScopedTables({ operator, tasks: owned });

  it("finds nothing in the Panel's repositories today, and reads the folder they are really in", () => {
    expect(REPOSITORY_DIR.endsWith(path.join("packages", "panel", "src", "server", "repositories"))).toBe(true);
    expect(repositoryFiles().map((f) => path.basename(f))).toContain("tasks.repo.ts");
    expect(scanRepositories(ownerScopedTables(panelSchema))).toEqual([]);
  });

  it("fails when owner-scoped tables exist and the scan found no file, or no folder", () => {
    expect(scanRepositories(tables, repoDir({ "__tests__/only.test.ts": "" }))).toEqual([
      expect.stringContaining("no repository file found"),
    ]);
    expect(scanRepositories(tables, path.join(tmpdir(), "actana-owner-guard-missing"))).toEqual([
      expect.stringContaining("no repository file found"),
    ]);
    expect(scanRepositories([], repoDir({}))).toEqual([]);
  });

  it("finds no source file outside the repository folder that imports pg-schema", () => {
    expect(pgSchemaImportsOutsideRepositories()).toEqual([]);
  });

  it("fails a planted service that imports pg-schema, and allows the repository folder and tests", () => {
    const root = repoDir({
      "server/repositories/tasks.repo.ts": 'import { tasks } from "~/db/pg-schema";',
      "server/services/taskService.ts": 'import { tasks } from "~/db/pg-schema";',
      "server/routes/lazy.ts": 'const s = await import("../../db/pg-schema");',
      "server/services/__tests__/taskService.test.ts": 'import { tasks } from "~/db/pg-schema";',
      "server/services/ok.ts": 'import { x } from "~/db/schema";',
    });
    expect(
      pgSchemaImportsOutsideRepositories(root, path.join(root, "server", "repositories"), path.join(root, "db", "pg-schema.ts")).sort(),
    ).toEqual([
      path.join("server", "routes", "lazy.ts") + " imports pg-schema outside the repository folder",
      path.join("server", "services", "taskService.ts") + " imports pg-schema outside the repository folder",
    ]);
  });

  it("fails a planted repository file, in a nested folder, and skips its tests", () => {
    const dir = repoDir({
      "good.ts": `export const a = () => db.select().from(tasks).where(ownedBy(tasks, owner));`,
      "nested/planted.ts": `export const b = () => db.select().from(tasks);`,
      "__tests__/planted.test.ts": `db.select().from(tasks);`,
    });
    expect(scanRepositories(tables, dir)).toEqual([path.join("nested", "planted.ts") + ":1 queries tasks without ownedBy()"]);
  });
});

describe("ownedBy", () => {
  const dialect = new PgDialect();
  it("is the owner column equal to the owner, and more conditions after it", () => {
    expect(dialect.sqlToQuery(ownedBy(owned, 7))).toMatchObject({ sql: '"tasks"."owner_id" = $1', params: [7] });
    expect(dialect.sqlToQuery(ownedBy(owned, 7, eq(owned.id, 3), undefined))).toMatchObject({
      sql: '("tasks"."owner_id" = $1 and "tasks"."id" = $2)',
      params: [7, 3],
    });
  });
});
