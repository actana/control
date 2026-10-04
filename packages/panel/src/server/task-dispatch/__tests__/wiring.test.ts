import { afterEach, describe, expect, it, vi } from "vitest";
import { DATABASE_URL_ENV, closePanelDatabase, type PanelPoolLike } from "~/db/pg";
import { installPanelDb } from "~/db/panel-db-handle";
import { createTestDb, type TestDb } from "~/db/test-db";
import { CoreLinkManager } from "../../services/core-link-manager";

/**
 * The dispatcher starts with the Panel and stops with it (#570): `bootPanel` starts it once the database is
 * up, `closePanel` stops it before the database goes, and a Panel that cannot start its database starts none.
 */

const order: string[] = [];
vi.mock("../index", () => ({
  startTaskDispatch: vi.fn(() => void order.push("start")),
  stopTaskDispatch: vi.fn(async () => {
    order.push("stop");
  }),
}));
const { bootPanel, closePanel } = await import("../../panel-boot");

const env = { [DATABASE_URL_ENV]: "postgres://panel:pw@db.internal:5432/panel" };
const open: TestDb[] = [];

async function poolOver(): Promise<PanelPoolLike> {
  const db = await createTestDb({ env: {} });
  open.push(db);
  installPanelDb(db.db);
  const pool: PanelPoolLike = {
    query: ((text: string, params?: unknown[]) => db.pool.query(text, params)) as PanelPoolLike["query"],
    connect: () => db.pool.connect(),
    end: async () => {
      order.push("database closed");
    },
    on: () => pool,
  };
  return pool;
}

afterEach(async () => {
  await closePanelDatabase();
  installPanelDb(null);
  vi.restoreAllMocks();
  order.length = 0;
  await Promise.all(open.splice(0).map((db) => db.close()));
});

describe("Task dispatch and the Panel's life", { timeout: 30_000 }, () => {
  it("starts once the database is up, and stops before the database closes", async () => {
    vi.spyOn(CoreLinkManager.prototype, "start").mockResolvedValue();
    const pool = await poolOver();

    await bootPanel(env, () => pool);
    expect(order).toEqual(["start"]);

    await closePanel();
    expect(order).toEqual(["start", "stop", "database closed"]);
  });

  it("starts nothing when the database cannot be reached", async () => {
    vi.spyOn(CoreLinkManager.prototype, "start").mockResolvedValue();
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

    expect(order).toEqual([]);
  });

  it("can be stopped when it never started", async () => {
    await expect(closePanel()).resolves.toBeUndefined();
    expect(order).toEqual(["stop"]);
  });
});
