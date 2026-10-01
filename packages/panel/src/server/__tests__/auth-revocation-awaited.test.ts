import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";

/**
 * A logout or a password change must not answer before the sessions are gone
 * (#567). On PGlite a statement that was never awaited still finishes before
 * the next one, so these tests slow the revoking statements down: a controller
 * that dropped its `await` would return while the session still resolved.
 */

const finished: string[] = [];
const slow = <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
  async (...args: A): Promise<R> => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    const result = await fn(...args);
    finished.push(name);
    return result;
  };

vi.mock("../repositories/panel-sessions.repo", async (importOriginal) => {
  const real = await importOriginal<typeof import("../repositories/panel-sessions.repo")>();
  return {
    ...real,
    deletePanelSessionByTokenHash: slow("deletePanelSessionByTokenHash", real.deletePanelSessionByTokenHash),
    deleteAllPanelSessions: slow("deleteAllPanelSessions", real.deleteAllPanelSessions),
  };
});

const testDb = await openPanelTestDb();
const { logout, changePassword } = await import("../controllers/auth.controller");
const { createOperator } = await import("../services/operator");
const { createPanelSession, resolvePanelSession } = await import("../services/panel-sessions");
const { PANEL_SESSION_COOKIE } = await import("../panel-auth");

const PASSWORD = "correct-horse-battery";

beforeEach(async () => {
  await resetPanelState(testDb);
  finished.length = 0;
  await createOperator({ name: "Ada", password: PASSWORD });
});

afterAll(async () => {
  await closePanelTestDb(testDb);
});

const withCookie = (token: string, body?: unknown) =>
  new Request("http://panel.example.test/api/auth/x", {
    method: "POST",
    headers: { cookie: `${PANEL_SESSION_COOKIE}=${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("revocation is finished before the answer", () => {
  it("logout has deleted the session by the time it returns", async () => {
    const { token } = await createPanelSession();
    await logout(withCookie(token));
    expect(finished).toContain("deletePanelSessionByTokenHash");
    expect(await resolvePanelSession(token)).toBeNull();
  });

  it("a password change has signed every other session out by the time it returns", async () => {
    const { token } = await createPanelSession();
    const other = await createPanelSession();
    const res = await changePassword(withCookie(token, { currentPassword: PASSWORD, newPassword: "a-brand-new-password" }));
    expect(res.status).toBe(200);
    expect(finished).toContain("deleteAllPanelSessions");
    expect(await resolvePanelSession(other.token)).toBeNull();
    expect(await resolvePanelSession(token)).toBeNull();
  });
});
