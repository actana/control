import { readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MIGRATION_LOCK_KEY,
  PanelMigrationError,
  parseMigrations,
  runMigrations,
  type MigrateClient,
  type MigrateSource,
  type Migration,
} from "../pg-migrate";
import { bundledPanelMigrations } from "../pg-migrations-bundle";
import { createTestDb, type TestDb } from "../test-db";

const open: TestDb[] = [];
async function make(migrations: Migration[] = []) {
  const db = await createTestDb({ env: {}, migrations });
  open.push(db);
  return db;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

const extra = (tag: string, when: number, sql: string) =>
  parseMigrations({ entries: [{ tag, when }] }, { [tag]: sql });

describe("parseMigrations", () => {
  it("splits on statement breakpoints, orders by when, and hashes the file text", () => {
    const migrations = parseMigrations(
      { entries: [{ tag: "0001_b", when: 20 }, { tag: "0000_a", when: 10 }] },
      { "0000_a": "create table a (id int);\n--> statement-breakpoint\ncreate table a2 (id int);", "0001_b": "select 1;" },
    );
    expect(migrations.map((m) => m.tag)).toEqual(["0000_a", "0001_b"]);
    expect(migrations[0].statements).toEqual(["create table a (id int);", "create table a2 (id int);"]);
    expect(migrations[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a journal entry whose SQL file is missing", () => {
    expect(() => parseMigrations({ entries: [{ tag: "0000_a", when: 1 }] }, {})).toThrow(
      /lists 0000_a but 0000_a\.sql is missing/,
    );
  });
});

describe("the bundled Postgres migrations", () => {
  it("are the baseline, the panel.db tables, the Task tables, the Agents table, the webhook tables, the API key tables, the Shared folder tables, the Storage settings columns and the missioncontrol.db tables, and every SQL file on disk is in the journal", () => {
    const dir = path.resolve(import.meta.dirname, "..", "pg-migrations");
    const onDisk = readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, ""));
    expect(bundledPanelMigrations().map((m) => m.tag)).toEqual(onDisk.sort());
    expect(onDisk).toEqual([
      "0000_baseline",
      "0001_panel_db_tables",
      "0002_panel_tasks",
      "0003_panel_agents",
      "0004_panel_webhooks",
      "0005_panel_api_keys",
      "0006_panel_shared_folders",
      "0007_panel_storage_settings",
      "0008_panel_missioncontrol_tables",
    ]);
  });
});

describe("runMigrations on PGlite", { timeout: 30_000 }, () => {
  it("applies the bundled migrations once and a second run is a no-op", async () => {
    const db = await make();
    const migrations = bundledPanelMigrations();
    expect(await runMigrations(db.pool, migrations)).toEqual([
      "0000_baseline",
      "0001_panel_db_tables",
      "0002_panel_tasks",
      "0003_panel_agents",
      "0004_panel_webhooks",
      "0005_panel_api_keys",
      "0006_panel_shared_folders",
      "0007_panel_storage_settings",
      "0008_panel_missioncontrol_tables",
    ]);
    expect(await runMigrations(db.pool, migrations)).toEqual([]);
    const { rows } = await db.pool.query('select hash, created_at from "drizzle"."__drizzle_migrations"');
    expect(rows).toHaveLength(migrations.length);
    expect(rows.map((r) => r.hash)).toEqual(migrations.map((m) => m.hash));
    expect(Number(rows[0].created_at)).toBe(migrations[0].folderMillis);
  });

  it("runs no migration statement on the second run", async () => {
    const db = await make();
    const migrations = bundledPanelMigrations();
    await runMigrations(db.pool, migrations);
    const seen: string[] = [];
    const spy: MigrateSource = {
      connect: async () => {
        const client = await db.pool.connect();
        return {
          query: (text, params) => {
            const words = text.trim().split(/\s+/).slice(0, 2).join(" ").toLowerCase();
            seen.push(words.startsWith("select pg_advisory") ? "select pg_advisory_xact_lock($1::bigint)" : words);
            return client.query(text, params);
          },
          release: () => client.release(),
        };
      },
    };
    await runMigrations(spy, migrations);
    expect(seen).toEqual([
      "begin",
      "set local",
      "select pg_advisory_xact_lock($1::bigint)",
      "create schema",
      "create table",
      "select hash,",
      "commit",
    ]);
  });

  it("applies only the migrations newer than the last one recorded", async () => {
    const db = await make();
    const base = bundledPanelMigrations()[0];
    const next = extra("9999_later", base.folderMillis + 1, "create table later (id int);");
    await runMigrations(db.pool, [base]);
    expect(await runMigrations(db.pool, [base, ...next])).toEqual(["9999_later"]);
    expect((await db.pool.query("select to_regclass('later') as t")).rows[0].t).toBe("later");
  });

  it("rolls everything back and names the step when a migration fails", async () => {
    const db = await make();
    const base = bundledPanelMigrations()[0];
    const bad = extra("0001_bad", base.folderMillis + 1, "create table half (id int);\n--> statement-breakpoint\nselect * from no_such_table;");
    const error = await runMigrations(db.pool, [base, ...bad]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PanelMigrationError);
    expect((error as Error).message).toMatch(/failed while applying 0001_bad: .*no_such_table/);
    expect((await db.pool.query("select to_regclass('half') as t")).rows[0].t).toBeNull();
    const recorded = await db.pool.query('select count(*)::int as n from "drizzle"."__drizzle_migrations"');
    expect(recorded.rows[0].n).toBe(0);
    // The failed attempt left nothing behind: the next run applies the baseline afresh.
    expect(await runMigrations(db.pool, [base])).toEqual(["0000_baseline"]);
  });
});

describe("refusing a database that does not match the Panel", { timeout: 30_000 }, () => {
  const base = () => bundledPanelMigrations()[0];

  it("refuses a database that holds a migration this Panel does not ship", async () => {
    const db = await make();
    const later = extra("0001_later", base().folderMillis + 10, "create table later (id int);");
    await runMigrations(db.pool, [base(), ...later]);
    // The same database, started by an older Panel that ships only the baseline.
    const error = await runMigrations(db.pool, [base()]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PanelMigrationError);
    expect((error as Error).message).toMatch(/while checking the applied migrations: the database holds a migration this Panel does not know/);
  });

  it("refuses a migration that sorts before one already applied, instead of skipping it", async () => {
    const db = await make();
    const newer = extra("0002_newer", base().folderMillis + 20, "create table newer (id int);");
    await runMigrations(db.pool, [base(), ...newer]);
    const older = extra("0001_older", base().folderMillis + 10, "create table older (id int);");
    const error = await runMigrations(db.pool, [base(), ...older, ...newer]).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/0001_older has not been applied but sorts before one that has/);
    expect((await db.pool.query("select to_regclass('older') as t")).rows[0].t).toBeNull();
  });

  it("refuses an applied migration whose file was edited", async () => {
    const db = await make();
    const original = extra("0001_t", base().folderMillis + 10, "create table t (id int);");
    await runMigrations(db.pool, [base(), ...original]);
    const edited = extra("0001_t", base().folderMillis + 10, "create table t (id int, extra int);");
    const error = await runMigrations(db.pool, [base(), ...edited]).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/applied migration 0001_t differs from the file this Panel ships/);
  });

  it("starts normally when the database matches exactly", async () => {
    const db = await make();
    await runMigrations(db.pool, [base()]);
    expect(await runMigrations(db.pool, [base()])).toEqual([]);
  });
});

/**
 * A stand-in server for the one thing PGlite cannot show: two connections.
 * It implements real advisory-lock semantics (a lock is held until its
 * transaction ends; a second taker waits) and an in-memory migrations table,
 * and it yields to the event loop on every statement so two unlocked runs
 * interleave the way two Panels would. Real-server behaviour is covered by the
 * AC_TEST_DATABASE_URL test below.
 */
function fakeServer() {
  const held = new Map<string, Promise<void>>();
  const rows: { hash: string; created_at: number }[] = [];
  const executed: string[] = [];
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const source: MigrateSource = {
    async connect(): Promise<MigrateClient> {
      let release: (() => void) | null = null;
      let key: string | null = null;
      const end = () => {
        if (key !== null && release) {
          held.delete(key);
          release();
        }
        key = null;
        release = null;
      };
      return {
        async query(text, params = []) {
          await tick();
          const sql = text.trim().toLowerCase();
          if (sql.startsWith("select pg_advisory_xact_lock")) {
            const k = String(params[0]);
            while (held.has(k)) await held.get(k);
            let done!: () => void;
            held.set(k, new Promise<void>((resolve) => (done = resolve)));
            key = k;
            release = done;
          } else if (sql === "commit" || sql === "rollback") {
            end();
          } else if (sql.startsWith("set local")) {
            // lock_timeout on the migration transaction (D22(c)).
          } else if (sql.startsWith("select hash")) {
            return { rows: rows.map((r) => ({ ...r })) };
          } else if (sql.startsWith("insert into")) {
            rows.push({ hash: String(params[0]), created_at: Number(params[1]) });
          } else if (sql !== "begin" && !sql.startsWith("create schema") && !sql.startsWith("create table if not exists")) {
            executed.push(text);
          }
          return { rows: [] };
        },
        release: end,
      };
    },
  };
  return { source, rows, executed };
}

describe("the advisory lock", () => {
  const migrations = extra("0000_t", 1, "create table t (id int);");

  it("takes the migration lock before it reads or changes anything", async () => {
    const seen: string[] = [];
    const source: MigrateSource = {
      connect: async () => ({
        query: async (text, params) => {
          seen.push(text.trim().split(/\s+/).slice(0, 2).join(" ").toLowerCase() + (params?.[0] !== undefined && text.includes("advisory") ? `:${params[0]}` : ""));
          return { rows: [] };
        },
        release: () => {},
      }),
    };
    await runMigrations(source, migrations);
    expect(seen.slice(0, 4)).toEqual([
      "begin",
      "set local",
      `select pg_advisory_xact_lock($1::bigint):${MIGRATION_LOCK_KEY}`,
      "create schema",
    ]);
    expect(seen.at(-1)).toBe("commit");
  });

  it("sets a lock_timeout and logs that it is waiting for the migration lock", async () => {
    const seen: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const source: MigrateSource = {
      connect: async () => ({
        query: async (text) => {
          seen.push(text.trim());
          return { rows: [] };
        },
        release: () => {},
      }),
    };
    try {
      await runMigrations(source, migrations);
      expect(seen[1]).toBe("SET LOCAL lock_timeout = '30s'");
      expect(log).toHaveBeenCalledWith("[panel] waiting for the migration lock");
      const lockAt = seen.findIndex((s) => s.toLowerCase().startsWith("select pg_advisory"));
      const logAt = log.mock.calls.findIndex(
        (call) => call[0] === "[panel] waiting for the migration lock",
      );
      expect(lockAt).toBeGreaterThan(1);
      expect(logAt).toBeGreaterThanOrEqual(0);
      // The log lands before the lock wait, not after it has already returned.
      expect(seen.indexOf("SET LOCAL lock_timeout = '30s'")).toBeLessThan(lockAt);
    } finally {
      log.mockRestore();
    }
  });

  it("lets two Panels starting at once migrate exactly once", async () => {
    const server = fakeServer();
    const [a, b] = await Promise.all([
      runMigrations(server.source, migrations),
      runMigrations(server.source, migrations),
    ]);
    expect([a.length, b.length].sort()).toEqual([0, 1]);
    expect(server.executed).toEqual(["create table t (id int);"]);
    expect(server.rows).toHaveLength(1);
  });
});

// Real connections, so the lock is the server's: only where a server is given.
describe.skipIf(!process.env.AC_TEST_DATABASE_URL)("the advisory lock on a real server", () => {
  it("lets two concurrent runs apply a migration exactly once", async () => {
    const db = await createTestDb({ migrations: [] });
    open.push(db);
    const later = extra("0001_t", Date.now(), "create table t (id int);");
    const runs = await Promise.all([runMigrations(db.pool, later), runMigrations(db.pool, later)]);
    expect(runs.map((r) => r.length).sort()).toEqual([0, 1]);
  });
});
