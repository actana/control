import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionStatus } from "@actana/shared/domain";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-session-sweep-test-"));
process.env.AC_USER_DATA_DIR = tmpRoot;

const { handleApiRequest } = await import("../api-router");
const { operatorSessionCookie } = await import("./_operator-session");
const { createProject } = await import("../services/projects");
const { createSession, getSession, sweepOrphanedActiveSessions } = await import("../services/sessions");
const { getDb } = await import("~/db/client");
const { projects, sessions, groups, appSettings } = await import("~/db/schema");

function authed(input: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:5173${input}`, {
    ...init,
    headers: {
      origin: "http://127.0.0.1:5173",
      cookie: operatorSessionCookie(),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

function resetDb() {
  const db = getDb();
  db.delete(sessions).run();
  db.delete(projects).run();
  db.delete(groups).run();
  db.delete(appSettings).run();
}

describe("orphaned session status sweep", () => {
  let projectId = "";

  beforeEach(() => {
    resetDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-sweep-proj-"));
    projectId = createProject({ name: "sweep", path: dir }).id;
  });

  function makeSession(status: SessionStatus): string {
    const t = createSession({ projectId, title: "t", agent: "claude-code", status });
    return t.id;
  }

  it("disconnects local sessions stuck in active statuses, leaves settled ones", () => {
    const running = makeSession("running");
    const waiting = makeSession("needs-input");
    const finished = makeSession("finished");
    const ready = makeSession("ready");

    expect(sweepOrphanedActiveSessions()).toBe(2);

    expect(getSession(running)?.status).toBe("disconnected");
    expect(getSession(waiting)?.status).toBe("disconnected");
    expect(getSession(finished)?.status).toBe("finished");
    expect(getSession(ready)?.status).toBe("ready");
  });

  it("is exposed at POST /api/sessions/sweep-disconnected", async () => {
    const running = makeSession("running");
    const res = await handleApiRequest(
      authed("/api/sessions/sweep-disconnected", { method: "POST" }),
    );
    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({ swept: 1 });
    expect(getSession(running)?.status).toBe("disconnected");
  });
});
