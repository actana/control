import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";

const testDb = await openPanelTestDb();

const { handleApiRequest } = await import("../api-router");
const { getOrCreateApiToken } = await import("../services/settings");
const { createSession, getSession } = await import("../services/sessions");
const { createOperator } = await import("../services/operator");

const LOOPBACK_HEADERS = { origin: "http://127.0.0.1:5173" };
/** Shape Pi's extension posts from ctx.sessionManager.getSessionId(). */
const PI_SESSION = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

async function authed(input: string, init: RequestInit = {}): Promise<Request> {
  return new Request(`http://127.0.0.1:5173${input}`, {
    ...init,
    headers: {
      ...LOOPBACK_HEADERS,
      authorization: `Bearer ${await getOrCreateApiToken()}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

describe("Pi hook API (ADO #4986)", () => {
  let sessionId = "";

  beforeEach(async () => {
    await resetPanelState(testDb);
    await createOperator({ name: "Test Operator", password: "test-password" });
    const session = await createSession({
      title: "Waiting for initial prompt...",
      agent: "pi",
      claudeSessionId: null,
    });
    sessionId = session.id;
  });

  async function postHook(body: Record<string, unknown>): Promise<Response | null> {
    return handleApiRequest(
      await authed(`/api/hooks/pi?sessionId=${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("captures Pi's session UUID from SessionStart without changing status", async () => {
    const res = await postHook({
      hook_event_name: "SessionStart",
      session_id: PI_SESSION,
      source: "startup",
    });

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({ ok: true, ignored: "SessionStart" });
    expect((await getSession(sessionId))?.claudeSessionId).toBe(PI_SESSION);
    expect((await getSession(sessionId))?.status).toBe("ready");
  });

  it("keeps the UUID after a full turn so relaunch can use pi --session", async () => {
    await postHook({
      hook_event_name: "SessionStart",
      session_id: PI_SESSION,
      source: "startup",
    });
    const running = await postHook({
      hook_event_name: "UserPromptSubmit",
      session_id: PI_SESSION,
      prompt: "say hello",
    });
    expect(running?.status).toBe(200);
    expect(await getSession(sessionId)).toMatchObject({
      claudeSessionId: PI_SESSION,
      status: "running",
    });

    const stop = await postHook({
      hook_event_name: "Stop",
      session_id: PI_SESSION,
    });
    expect(stop?.status).toBe(200);
    expect(await getSession(sessionId)).toMatchObject({
      claudeSessionId: PI_SESSION,
      status: "finished",
    });
  });
});

afterAll(async () => {
  await closePanelTestDb(testDb);
});
