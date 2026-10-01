import { afterEach, describe, expect, it, vi } from "vitest";
import { DATABASE_URL_ENV, closePanelDatabase, type PanelPoolLike } from "~/db/pg";
import { bundledPanelMigrations } from "~/db/pg-migrations-bundle";
import { createTestDb, type TestDb } from "~/db/test-db";
import { bootPanel } from "../panel-boot";
import { CoreLinkManager } from "../services/core-link-manager";

/**
 * The Core registry is in Postgres, so the links to the registered Cores are
 * dialed only once the database is up, migrated and checked (#567). Before
 * this the manager started at import time, from a SQLite file.
 */

const env = { [DATABASE_URL_ENV]: "postgres://panel:pw@db.internal:5432/panel" };
const open: TestDb[] = [];

async function poolOver(): Promise<PanelPoolLike> {
  const db = await createTestDb({ env: {}, migrations: [] });
  open.push(db);
  const pool: PanelPoolLike = {
    query: (text: string) => db.pool.query(text),
    connect: () => db.pool.connect(),
    end: async () => {},
    on: () => pool,
  };
  return pool;
}

afterEach(async () => {
  await closePanelDatabase();
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((db) => db.close()));
});

describe("bootPanel", { timeout: 30_000 }, () => {
  it("dials the registered Cores after the database is migrated, not before", async () => {
    const order: string[] = [];
    const pool = await poolOver();
    const start = vi.spyOn(CoreLinkManager.prototype, "start").mockImplementation(async () => {
      const { rows } = await open[0]!.pool.query('select count(*)::int as n from "drizzle"."__drizzle_migrations"');
      order.push(`start (migrations applied: ${rows[0]?.n})`);
    });
    await bootPanel(env, () => pool);
    await vi.waitFor(() => expect(order).toHaveLength(1));
    expect(start).toHaveBeenCalledTimes(1);
    expect(order).toEqual([`start (migrations applied: ${bundledPanelMigrations().length})`]);
  });

  it("dials nothing and rejects when the database cannot be reached", async () => {
    const start = vi.spyOn(CoreLinkManager.prototype, "start").mockResolvedValue();
    const failing: PanelPoolLike = {
      query: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      connect: async () => {
        throw new Error("unreachable");
      },
      end: async () => {},
      on: () => failing,
    };
    await expect(bootPanel(env, () => failing)).rejects.toThrow(/cannot reach Postgres/);
    expect(start).not.toHaveBeenCalled();
  });

  it("logs a failure to read the registry and still returns the pool", async () => {
    const pool = await poolOver();
    vi.spyOn(CoreLinkManager.prototype, "start").mockRejectedValue(new Error("registry read failed"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(bootPanel(env, () => pool)).resolves.toBe(pool);
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith("[panel] could not dial the registered Cores: registry read failed"),
    );
  });
});
