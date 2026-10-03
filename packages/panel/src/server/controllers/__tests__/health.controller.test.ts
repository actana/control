import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installPanelDb, type PanelDb } from "~/db/panel-db-handle";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "../../__tests__/_panel-test-db";

const testDb = await openPanelTestDb();
const healthController = await import("../health.controller");

beforeAll(async () => {
  await resetPanelState(testDb);
});

afterEach(() => {
  installPanelDb(testDb.db);
  vi.useRealTimers();
});

afterAll(async () => {
  await closePanelTestDb(testDb);
});

describe("GET /api/healthz database check", () => {
  it("reports Postgres ok when the Panel database answers select 1", async () => {
    installPanelDb(testDb.db);
    const res = await healthController.read();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      status: string;
      checks: { api: string; database: string };
    };
    expect(body).toMatchObject({
      ok: true,
      status: "ok",
      checks: { api: "ok", database: "ok" },
    });
  });

  it("reports database error without leaking secrets when Postgres is unreachable", async () => {
    installPanelDb(null);
    const res = await healthController.read();
    expect(res.status).toBe(503);
    const text = await res.text();
    const body = JSON.parse(text) as {
      ok: boolean;
      status: string;
      checks: { api: string; database: string };
    };
    expect(body).toMatchObject({
      ok: false,
      status: "error",
      checks: { api: "ok", database: "error" },
    });
    // Unauthenticated: the body must never carry a connection URL or password.
    expect(text).not.toMatch(/postgres(ql)?:\/\//i);
    expect(text).not.toMatch(/password/i);
    expect(text).not.toMatch(/AC_PANEL_DATABASE_URL/);
    expect(Object.keys(body.checks)).toEqual(["api", "database"]);
  });

  it("reports database error within the probe bound when select 1 never settles", async () => {
    vi.useFakeTimers();
    installPanelDb({
      execute: () => new Promise(() => {}),
    } as unknown as PanelDb);

    const pending = healthController.read();
    await vi.advanceTimersByTimeAsync(healthController.DATABASE_PROBE_TIMEOUT_MS);
    const res = await pending;

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      ok: boolean;
      status: string;
      checks: { api: string; database: string };
    };
    expect(body).toMatchObject({
      ok: false,
      status: "error",
      checks: { api: "ok", database: "error" },
    });
  });
});
