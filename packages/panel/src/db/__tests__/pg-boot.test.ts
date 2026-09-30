import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DATABASE_URL_ENV, PanelDatabaseError, closePanelDatabase, getPanelPool, type PanelPoolLike } from "../pg";
import { bootPanelDatabase } from "../pg-boot";
import { parseMigrations } from "../pg-migrate";
import { bundledPanelMigrations } from "../pg-migrations-bundle";
import { createTestDb, type TestDb } from "../test-db";

const env = { [DATABASE_URL_ENV]: "postgres://panel:pw@db.internal:5432/panel" };
const open: TestDb[] = [];

/** A pool over a PGlite test database, shaped like the Panel's own. */
async function poolOver(): Promise<{ db: TestDb; pool: PanelPoolLike & { ended: number } }> {
  const db = await createTestDb({ env: {}, migrations: [] });
  open.push(db);
  const pool = {
    ended: 0,
    query: (text: string) => db.pool.query(text),
    connect: () => db.pool.connect(),
    end: async () => {
      pool.ended += 1;
    },
    on: () => pool,
  };
  return { db, pool };
}

afterEach(async () => {
  await closePanelDatabase();
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((db) => db.close()));
});

describe("bootPanelDatabase", () => {
  it("migrates after the pool check, and a second boot changes nothing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { db, pool } = await poolOver();
    await bootPanelDatabase(env, () => pool);
    const count = () => db.pool.query('select count(*)::int as n from "drizzle"."__drizzle_migrations"');
    expect((await count()).rows[0].n).toBe(1);
    expect(log).toHaveBeenCalledWith("[panel] database migrations applied: 0000_baseline");

    await closePanelDatabase();
    log.mockClear();
    await bootPanelDatabase(env, () => pool);
    expect((await count()).rows[0].n).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(getPanelPool()).toBe(pool);
  });

  it("does not migrate when the pool check fails", async () => {
    const connect = vi.fn();
    const pool: PanelPoolLike = {
      query: async () => {
        throw new Error("connection refused");
      },
      connect,
      end: async () => {},
      on: () => pool,
    };
    await expect(bootPanelDatabase(env, () => pool)).rejects.toThrow(/cannot reach Postgres/);
    expect(connect).not.toHaveBeenCalled();
  });

  it("refuses to start with the reason, and leaves no pool open, when a migration fails", async () => {
    const { pool } = await poolOver();
    const bad = parseMigrations({ entries: [{ tag: "0000_bad", when: 1 }] }, { "0000_bad": "select * from no_such_table;" });
    const error = await bootPanelDatabase(env, () => pool, bad).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PanelDatabaseError);
    expect((error as Error).message).toMatch(/failed while applying 0000_bad: .*no_such_table.*The Panel will not start\.$/);
    expect(pool.ended).toBe(1);
    expect(() => getPanelPool()).toThrow(PanelDatabaseError);
  });

  it("is what the server entry hands bin/panel.mjs as connectPanelDatabase", () => {
    const entry = readFileSync(path.resolve(import.meta.dirname, "..", "..", "server.ts"), "utf8");
    expect(entry).toContain('export { bootPanelDatabase as connectPanelDatabase } from "~/db/pg-boot";');
    expect(bundledPanelMigrations()).not.toHaveLength(0);
  });
});
