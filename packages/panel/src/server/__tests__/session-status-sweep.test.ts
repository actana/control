import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";
import type { SessionStatus } from "@actana/shared/domain";

const testDb = await openPanelTestDb();
const { handleApiRequest } = await import("../api-router");
const { operatorSessionCookie, resetOperatorSessionForTests } = await import("./_operator-session");
const { createOperator } = await import("../services/operator");
const { createSession, getSession, sweepOrphanedActiveSessions } = await import("../services/sessions");

async function authed(input: string, init: RequestInit = {}): Promise<Request> {
  return new Request(`http://127.0.0.1:5173${input}`, {
    ...init,
    headers: {
      origin: "http://127.0.0.1:5173",
      cookie: await operatorSessionCookie(),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

beforeEach(async () => {
  await resetPanelState(testDb);
  resetOperatorSessionForTests();
  await createOperator({ name: "Test Operator", password: "test-password" });
});

afterAll(async () => {
  await closePanelTestDb(testDb);
});

describe("orphaned session status sweep", () => {
  async function makeSession(status: SessionStatus): Promise<string> {
    const t = await createSession({ title: "t", agent: "claude-code", status });
    return t.id;
  }

  it("disconnects local sessions stuck in active statuses, leaves settled ones", async () => {
    const running = await makeSession("running");
    const waiting = await makeSession("needs-input");
    const finished = await makeSession("finished");
    const ready = await makeSession("ready");

    expect(await sweepOrphanedActiveSessions()).toBe(2);

    expect((await getSession(running))?.status).toBe("disconnected");
    expect((await getSession(waiting))?.status).toBe("disconnected");
    expect((await getSession(finished))?.status).toBe("finished");
    expect((await getSession(ready))?.status).toBe("ready");
  });

  it("is exposed at POST /api/sessions/sweep-disconnected", async () => {
    const running = await makeSession("running");
    const res = await handleApiRequest(
      (await authed("/api/sessions/sweep-disconnected", { method: "POST" })),
    );
    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({ swept: 1 });
    expect((await getSession(running))?.status).toBe("disconnected");
  });
});
