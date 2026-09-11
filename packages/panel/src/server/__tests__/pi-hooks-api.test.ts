import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-pi-hooks-test-"));
process.env.AC_USER_DATA_DIR = tmpRoot;

const { handleApiRequest } = await import("../api-router");
const { getOrCreateApiToken } = await import("../services/settings");
const { createProject } = await import("../services/projects");
const { createTask, getTask } = await import("../services/tasks");
const { getDb } = await import("~/db/client");
const { projects, tasks, groups, appSettings } = await import("~/db/schema");

const LOOPBACK_HEADERS = { origin: "http://127.0.0.1:5173" };
/** Shape Pi's extension posts from ctx.sessionManager.getSessionId(). */
const PI_SESSION = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function authed(input: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:5173${input}`, {
    ...init,
    headers: {
      ...LOOPBACK_HEADERS,
      authorization: `Bearer ${getOrCreateApiToken()}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

describe("Pi hook API (ADO #4986)", () => {
  let taskId = "";

  beforeEach(() => {
    const db = getDb();
    db.delete(tasks).run();
    db.delete(projects).run();
    db.delete(groups).run();
    db.delete(appSettings).run();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-pi-hooks-proj-"));
    const project = createProject({ name: "pi-hooks", path: dir });
    const task = createTask({
      projectId: project.id,
      title: "Waiting for initial prompt...",
      agent: "pi",
      claudeSessionId: null,
    });
    taskId = task.id;
  });

  function postHook(body: Record<string, unknown>): Promise<Response | null> {
    return handleApiRequest(
      authed(`/api/hooks/pi?taskId=${encodeURIComponent(taskId)}`, {
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
    expect(getTask(taskId)?.claudeSessionId).toBe(PI_SESSION);
    expect(getTask(taskId)?.status).toBe("ready");
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
    expect(getTask(taskId)).toMatchObject({
      claudeSessionId: PI_SESSION,
      status: "running",
    });

    const stop = await postHook({
      hook_event_name: "Stop",
      session_id: PI_SESSION,
    });
    expect(stop?.status).toBe(200);
    expect(getTask(taskId)).toMatchObject({
      claudeSessionId: PI_SESSION,
      status: "finished",
    });
  });
});
