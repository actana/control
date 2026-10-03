import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installPanelDb } from "~/db/panel-db-handle";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "../../__tests__/_panel-test-db";

const testDb = await openPanelTestDb();
const healthController = await import("../health.controller");

beforeAll(async () => {
  await resetPanelState(testDb);
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
    installPanelDb(testDb.db);
  });
});
