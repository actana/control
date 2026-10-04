import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";

vi.mock("../services/claude-cli", () => ({
  runCli: vi.fn().mockResolvedValue("TITLE: Generated title\nICON: palette"),
}));

const testDb = await openPanelTestDb();
const { runCli } = await import("../services/claude-cli");
const { handleApiRequest } = await import("../api-router");
const { operatorSessionCookie, resetOperatorSessionForTests } = await import("./_operator-session");
const { createOperator } = await import("../services/operator");
const { createSession, getSession, updateSession } = await import("../services/sessions");
const { generateTitleForSession } = await import("../services/title-generator");
const { TITLE_WAITING } = await import("~/lib/session-sentinels");

const LOOPBACK_HEADERS = { origin: "http://127.0.0.1:5173" };

async function authed(input: string, init: RequestInit = {}): Promise<Request> {
  return new Request(`http://127.0.0.1:5173${input}`, {
    ...init,
    headers: {
      ...LOOPBACK_HEADERS,
      cookie: await operatorSessionCookie(),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

async function createTitleSession() {
  return createSession({
    title: TITLE_WAITING,
    agent: "codex",
  });
}

beforeEach(async () => {
  await resetPanelState(testDb);
  resetOperatorSessionForTests();
  await createOperator({ name: "Test Operator", password: "test-password" });
  vi.mocked(runCli).mockClear();
});

afterAll(async () => {
  await closePanelTestDb(testDb);
});

describe("session title updates", () => {
  it("marks PATCH title updates as manually set", async () => {
    const session = await createTitleSession();

    const res = await handleApiRequest(
      (await authed(`/api/sessions/${session.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "  Manual session title  " }),
      })),
    );

    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.session.title).toBe("Manual session title");
    expect(body.session.titleManuallySet).toBe(true);
    expect((await getSession(session.id))?.titleManuallySet).toBe(true);
  });

  it("does not generate over a manually marked title, even when still sentinel", async () => {
    const session = await createTitleSession();
    await updateSession(session.id, { titleManuallySet: true });

    await generateTitleForSession(session.id, "add a dark mode toggle");

    expect(runCli).not.toHaveBeenCalled();
    expect(await getSession(session.id)).toMatchObject({
      title: TITLE_WAITING,
      titleManuallySet: true,
    });
  });
});
