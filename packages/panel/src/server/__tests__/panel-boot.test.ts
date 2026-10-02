import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATABASE_URL_ENV, closePanelDatabase, type PanelPoolLike } from "~/db/pg";
import { installPanelDb } from "~/db/panel-db-handle";
import { bundledPanelMigrations } from "~/db/pg-migrations-bundle";
import { createTestDb, type TestDb } from "~/db/test-db";
import { bootPanel, closePanel } from "../panel-boot";
import { CoreLinkManager } from "../services/core-link-manager";
import { SharedFolders } from "../services/shared-folders";
import { stopWebhookDeliveryWorkerForTests } from "../services/webhook-delivery-worker";

/**
 * The Core registry is in Postgres, so the links to the registered Cores are
 * dialed only once the database is up, migrated and checked (#567). Before
 * this the manager started at import time, from a SQLite file.
 */

// `bootPanel` also starts the Task dispatcher (#570). These tests are about when the Cores are dialed, over a bare
// one-connection database, so the dispatcher is stubbed out here; `task-dispatch/__tests__/wiring.test.ts` covers it.
vi.mock("../task-dispatch", () => ({ startTaskDispatch: vi.fn(), stopTaskDispatch: vi.fn() }));

// `bootPanel` also starts the Shared folder key refresh (#564), which reads the database in the background; over this
// one-connection database that read would race the teardown, so it is stubbed here and proved on its own below.
const stopSharedFolders = vi.fn();
const startSharedFolders = () =>
  vi.spyOn(SharedFolders.prototype, "start").mockResolvedValue(stopSharedFolders as unknown as () => void);

const env = { [DATABASE_URL_ENV]: "postgres://panel:pw@db.internal:5432/panel" };
const open: TestDb[] = [];

async function poolOver(): Promise<PanelPoolLike> {
  const db = await createTestDb({ env: {}, migrations: [] });
  open.push(db);
  // Route repositories (the boot sweep) through the PGlite drizzle handle —
  // node-postgres drizzle over the stub pool cannot bind parameters on PGlite.
  installPanelDb(db.db);
  const pool: PanelPoolLike = {
    query: ((text: string, params?: unknown[]) => db.pool.query(text, params)) as PanelPoolLike["query"],
    connect: () => db.pool.connect(),
    end: async () => {},
    on: () => pool,
  };
  return pool;
}

beforeEach(() => {
  stopSharedFolders.mockClear();
  startSharedFolders();
});

afterEach(async () => {
  stopWebhookDeliveryWorkerForTests();
  await closePanelDatabase();
  installPanelDb(null);
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

  it("starts the Shared folder key refresh once the database is up, and stops it on close", async () => {
    const pool = await poolOver();
    vi.spyOn(CoreLinkManager.prototype, "start").mockResolvedValue();
    await bootPanel(env, () => pool);
    await vi.waitFor(() => expect(SharedFolders.prototype.start).toHaveBeenCalledTimes(1));
    expect(stopSharedFolders).not.toHaveBeenCalled();
    await closePanel();
    expect(stopSharedFolders).toHaveBeenCalledTimes(1);
  });

  it("starts no key refresh when the database cannot be reached", async () => {
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
    expect(SharedFolders.prototype.start).not.toHaveBeenCalled();
  });

  it("sweeps running and needs-input Sessions to disconnected after migrations", async () => {
    // What client.ts / reconcileStaleSessionsOnBoot did when opening missioncontrol.db.
    const db = await createTestDb({ env: {} });
    open.push(db);
    const NOW = 1_790_800_767_886;
    await db.pool.query(
      "insert into operator (id, name, password_hash, created_at, password_changed_at) values (1, 'op', 'h', $1, $1)",
      [NOW],
    );
    const seed = async (id: string, status: string) => {
      await db.pool.query(
        `insert into sessions (
           id, owner_id, title, title_manually_set, agent, status, branch, preview,
           lines, archived, pinned, claude_skip_permissions, claude_bare_session,
           created_at, updated_at
         ) values ($1, 1, 't', false, 'claude-code', $2, 'main', '', 0, false, false, false, false, $3, 0)`,
        [id, status, NOW],
      );
    };
    await seed("run", "running");
    await seed("blocked", "needs-input");
    await seed("ready", "ready");
    await seed("finished", "finished");
    await seed("terminated", "terminated");
    await seed("interrupted", "interrupted");
    await seed("disconnected", "disconnected");

    const pool: PanelPoolLike = {
      query: ((text: string, params?: unknown[]) => db.pool.query(text, params)) as PanelPoolLike["query"],
      connect: () => db.pool.connect(),
      end: async () => {},
      on: () => pool,
    };
    installPanelDb(db.db);
    vi.spyOn(CoreLinkManager.prototype, "start").mockResolvedValue();
    // Schema already applied by createTestDb; boot re-checks the journal (no-op)
    // and runs the stale-Session sweep that client.ts used to do at open.
    await bootPanel(env, () => pool);

    const { rows } = await db.pool.query(
      "select id, status, updated_at::text as updated_at from sessions order by id",
    );
    const byId = Object.fromEntries(rows.map((r) => [String(r.id), r]));
    expect(byId.run).toMatchObject({ status: "disconnected" });
    expect(Number(byId.run!.updated_at)).toBeGreaterThan(0);
    expect(byId.blocked).toMatchObject({ status: "disconnected" });
    expect(Number(byId.blocked!.updated_at)).toBeGreaterThan(0);
    expect(byId.ready).toMatchObject({ status: "ready" });
    expect(byId.finished).toMatchObject({ status: "finished" });
    expect(byId.terminated).toMatchObject({ status: "terminated" });
    expect(byId.interrupted).toMatchObject({ status: "interrupted" });
    expect(byId.disconnected).toMatchObject({ status: "disconnected" });
  });
});
