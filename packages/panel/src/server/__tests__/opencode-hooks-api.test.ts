import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-opencode-hooks-test-"));
process.env.AC_USER_DATA_DIR = tmpRoot;

const { handleApiRequest } = await import("../api-router");
const { getOrCreateApiToken } = await import("../services/settings");
const { createProject } = await import("../services/projects");
const { createSession, getSession } = await import("../services/sessions");
const { getDb } = await import("~/db/client");
const { projects, sessions, groups, appSettings } = await import("~/db/schema");

const LOOPBACK_HEADERS = { origin: "http://127.0.0.1:5173" };

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

describe("OpenCode hook API", () => {
  let sessionId = "";

  beforeEach(() => {
    const db = getDb();
    db.delete(sessions).run();
    db.delete(projects).run();
    db.delete(groups).run();
    db.delete(appSettings).run();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-opencode-hooks-proj-"));
    const project = createProject({ name: "opencode-hooks", path: dir });
    const session = createSession({
      projectId: project.id,
      title: "Waiting for initial prompt...",
      agent: "opencode",
      claudeSessionId: null,
    });
    sessionId = session.id;
  });

  function postHook(body: Record<string, unknown>): Promise<Response | null> {
    return handleApiRequest(
      authed(`/api/hooks/opencode?sessionId=${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  /** Capture a session id and put the Session on `running`, as a turn does. */
  async function start(harnessSessionId: string): Promise<void> {
    const running = await postHook({
      hook_event_name: "UserPromptSubmit",
      session_id: harnessSessionId,
      prompt: "ship opencode hooks",
    });
    expect(running?.status).toBe(200);
    expect(getSession(sessionId)).toMatchObject({ claudeSessionId: harnessSessionId, status: "running" });
  }

  it("captures ses_* session ids from SessionStart without changing status", async () => {
    const harnessSessionId = "ses_3cf7dd8d4ffeUPfENpVxfFojZ2";
    const res = await handleApiRequest(
      authed(`/api/hooks/opencode?sessionId=${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: harnessSessionId,
        }),
      }),
    );

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({ ok: true, ignored: "SessionStart" });
    expect(getSession(sessionId)?.claudeSessionId).toBe(harnessSessionId);
    expect(getSession(sessionId)?.status).toBe("ready");
  });

  it("marks sessions finished on Stop", async () => {
    const res = await handleApiRequest(
      authed(`/api/hooks/opencode?sessionId=${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hook_event_name: "Stop",
          session_id: "ses_3cf7dd8d4ffeUPfENpVxfFojZ2",
        }),
      }),
    );

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({ ok: true, status: "finished" });
    expect(getSession(sessionId)?.status).toBe("finished");
  });

  it("marks sessions running on UserPromptSubmit", async () => {
    const res = await handleApiRequest(
      authed(`/api/hooks/opencode?sessionId=${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "ses_3cf7dd8d4ffeUPfENpVxfFojZ2",
          prompt: "fix the login bug",
        }),
      }),
    );

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({ ok: true, status: "running" });
    expect(getSession(sessionId)?.status).toBe("running");
  });

  it("marks sessions needs-input on PermissionRequest", async () => {
    const res = await handleApiRequest(
      authed(`/api/hooks/opencode?sessionId=${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hook_event_name: "PermissionRequest",
          session_id: "ses_3cf7dd8d4ffeUPfENpVxfFojZ2",
        }),
      }),
    );

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({ ok: true, status: "needs-input" });
    expect(getSession(sessionId)?.status).toBe("needs-input");
  });

  it("marks sessions needs-input on QuestionRequest", async () => {
    const res = await handleApiRequest(
      authed(`/api/hooks/opencode?sessionId=${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hook_event_name: "QuestionRequest",
          session_id: "ses_question_test",
        }),
      }),
    );

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({ ok: true, status: "needs-input" });
    expect(getSession(sessionId)?.status).toBe("needs-input");
  });

  it("walks the full OpenCode hook lifecycle over HTTP", async () => {
    const harnessSessionId = "ses_lifecycle_integration";
    const token = getOrCreateApiToken();

    const sessionStart = await handleApiRequest(
      authed(`/api/hooks/opencode?sessionId=${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: harnessSessionId,
        }),
      }),
    );
    expect(sessionStart?.status).toBe(200);

    const running = await handleApiRequest(
      authed(`/api/hooks/opencode?sessionId=${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: harnessSessionId,
          prompt: "ship opencode hooks",
        }),
      }),
    );
    expect(running?.status).toBe(200);

    const finished = await handleApiRequest(
      authed(`/api/hooks/opencode?sessionId=${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hook_event_name: "Stop",
          session_id: harnessSessionId,
        }),
      }),
    );
    expect(finished?.status).toBe(200);

    expect(getSession(sessionId)).toMatchObject({
      claudeSessionId: harnessSessionId,
      status: "finished",
    });
    expect(token.length).toBeGreaterThan(0);
  });

  it("moves the card back to running when a permission is answered", async () => {
    // OpenCode fires `permission.replied`, so the plugin can report the turn
    // resuming outright. Claude Code fires nothing when a permission is
    // GRANTED, which is why that family has to be healed by the next
    // PostToolUse instead — the two harnesses genuinely differ here.
    const harnessSessionId = "ses_permission_flow";
    const hook = (body: Record<string, unknown>) =>
      handleApiRequest(
        authed(`/api/hooks/opencode?sessionId=${encodeURIComponent(sessionId)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, session_id: harnessSessionId }),
        }),
      );

    await hook({ hook_event_name: "UserPromptSubmit", prompt: "run the tests" });
    await hook({ hook_event_name: "PermissionRequest" });
    expect(getSession(sessionId)?.status).toBe("needs-input");

    const replied = await hook({ hook_event_name: "PermissionReplied" });
    expect(replied?.status).toBe(200);
    await expect(replied?.json()).resolves.toEqual({ ok: true, status: "running" });
    expect(getSession(sessionId)?.status).toBe("running");
  });

  it("walks the sequence the installed plugin actually produced", async () => {
    // Captured from opencode 1.18.18 running the Core's plugin: SessionStart
    // with the id, UserPromptSubmit with the text, three more from the session
    // going busy, then two Stops. The repeats matter — `session.status` idle
    // and `session.idle` both fire, and the card must settle once and stay
    // settled rather than flickering.
    const harnessSessionId = "ses_000c0422afferlN5ASgK5JDYj3";
    const post = (body: Record<string, unknown>) =>
      handleApiRequest(
        authed(`/api/hooks/opencode?sessionId=${encodeURIComponent(sessionId)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, session_id: harnessSessionId }),
        }),
      );

    await post({ hook_event_name: "SessionStart" });
    expect(getSession(sessionId)?.claudeSessionId).toBe(harnessSessionId);
    expect(getSession(sessionId)?.status).toBe("ready");

    await post({ hook_event_name: "UserPromptSubmit", prompt: "say hello" });
    expect(getSession(sessionId)?.status).toBe("running");
    for (let i = 0; i < 3; i += 1) await post({ hook_event_name: "UserPromptSubmit" });
    expect(getSession(sessionId)?.status).toBe("running");

    await post({ hook_event_name: "Stop" });
    await post({ hook_event_name: "Stop" });
    // The whole point of #230: a settle the Core can report, so `--wait` and
    // the SDK's wait-for-idle resolve instead of timing out "unreported".
    expect(getSession(sessionId)?.status).toBe("finished");
  });

  it("ignores claiming hooks from a different captured session", async () => {
    const capturedSessionId = "ses_captured_session";
    const foreignSessionId = "ses_foreign_session";

    await start(capturedSessionId);

    // A permission prompt from a session this session never captured would park
    // the card on `needs-input` for a question the operator cannot see. That
    // is what the foreign-session guard is for, and it still holds.
    const foreignAsk = await postHook({
      hook_event_name: "PermissionRequest",
      session_id: foreignSessionId,
    });

    expect(foreignAsk?.status).toBe(200);
    await expect(foreignAsk?.json()).resolves.toEqual({ ok: true, ignored: "foreign-session" });
    expect(getSession(sessionId)).toMatchObject({
      claudeSessionId: capturedSessionId,
      status: "running",
    });
  });

  it("does not settle a Session waiting on a permission prompt (issue 390)", async () => {
    // The parent raised the prompt and is blocked on it; a child session going
    // idle must not write `finished` over that, which would also clear the
    // pending question the operator still has to answer.
    const capturedSessionId = "ses_captured_session";

    await start(capturedSessionId);
    await postHook({ hook_event_name: "PermissionRequest", session_id: capturedSessionId });
    expect(getSession(sessionId)?.status).toBe("needs-input");

    const childStop = await postHook({
      hook_event_name: "Stop",
      session_id: "ses_leaked_child",
    });

    expect(childStop?.status).toBe(200);
    await expect(childStop?.json()).resolves.toEqual({ ok: true, event: "Stop" });
    expect(getSession(sessionId)).toMatchObject({
      claudeSessionId: capturedSessionId,
      status: "needs-input",
    });
  });

  it("still settles the Session on a Stop from a different session (issue 390)", async () => {
    // A resumed OpenCode process, or a child session whose `idle` slipped past
    // the plugin's parent/child filter. This used to be acked and dropped, so
    // the card sat on `running` with no `session:finished` ever coming — the
    // hook was addressed by session id out of this PTY's own environment, so the
    // turn that ended is this Session's whatever OpenCode calls the session.
    const capturedSessionId = "ses_captured_session";
    const foreignSessionId = "ses_foreign_session";

    await start(capturedSessionId);

    const foreignStop = await postHook({
      hook_event_name: "Stop",
      session_id: foreignSessionId,
    });

    expect(foreignStop?.status).toBe(200);
    await expect(foreignStop?.json()).resolves.toEqual({ ok: true, status: "finished" });
    expect(getSession(sessionId)).toMatchObject({
      // The stored id is untouched: a Stop is still not a capture event.
      claudeSessionId: capturedSessionId,
      status: "finished",
    });
  });
});
