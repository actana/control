import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb } from "./_panel-test-db";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-ask-question-api-test-"));
process.env.AC_USER_DATA_DIR = tmpRoot;

const testDb = await openPanelTestDb();
const { handleApiRequest } = await import("../api-router");
const { operatorSessionCookie } = await import("./_operator-session");
const { getOrCreateApiToken } = await import("../services/settings");
const { createProject } = await import("../services/projects");
const { createSession, getSession } = await import("../services/sessions");
const { getPendingQuestion } = await import("../services/pending-questions");
const { getDb } = await import("~/db/client");
const { projects, sessions, groups, appSettings } = await import("~/db/schema");
const { TITLE_WAITING } = await import("~/lib/session-sentinels");

const LOOPBACK_HEADERS = { origin: "http://127.0.0.1:5173" };
const SESSION_ID = "00000000-0000-4000-8000-000000000000";
const TOOL_USE_ID = "toolu_test_ask_user_question";

const QUESTION_TOOL_INPUT = {
  questions: [
    {
      question: "What would you like to focus on right now?",
      header: "Next session",
      multiSelect: false,
      options: [
        { label: "Complete the current feature", description: "Finish the modified file" },
        { label: "Review and debug" },
        { label: "Start something new" },
      ],
    },
  ],
};

async function authed(input: string, init: RequestInit = {}): Promise<Request> {
  return new Request(`http://127.0.0.1:5173${input}`, {
    ...init,
    headers: {
      ...LOOPBACK_HEADERS,
      // This file drives both surfaces: the agent hook endpoints (machine
      // token) and the Operator's session API (session cookie).
      cookie: await operatorSessionCookie(),
      authorization: `Bearer ${getOrCreateApiToken()}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

async function postHook(
  sessionId: string,
  body: Record<string, unknown>,
): Promise<Response | null> {
  return handleApiRequest(
    (await authed(`/api/hooks/claude?sessionId=${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })),
  );
}

async function getQuestion(sessionId: string): Promise<Response | null> {
  return handleApiRequest((await authed(`/api/sessions/${encodeURIComponent(sessionId)}/question`)));
}

async function postAskUserQuestion(sessionId: string): Promise<Response | null> {
  return postHook(sessionId, {
    hook_event_name: "PreToolUse",
    session_id: SESSION_ID,
    tool_name: "AskUserQuestion",
    tool_use_id: TOOL_USE_ID,
    tool_input: QUESTION_TOOL_INPUT,
  });
}

function resetDb() {
  const db = getDb();
  db.delete(sessions).run();
  db.delete(projects).run();
  db.delete(groups).run();
  db.delete(appSettings).run();
}

function createHookSession() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-ask-question-proj-"));
  const project = createProject({ name: "ask-question", path: dir });
  return createSession({
    projectId: project.id,
    title: TITLE_WAITING,
    agent: "claude-code",
    claudeSessionId: SESSION_ID,
  });
}

describe("AskUserQuestion hook API", () => {
  let sessionId = "";

  beforeEach(() => {
    resetDb();
    sessionId = createHookSession().id;
  });

  it("stores the question and flips status on PreToolUse", async () => {
    const res = await postAskUserQuestion(sessionId);

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({ ok: true, status: "needs-input" });
    expect(getSession(sessionId)?.status).toBe("needs-input");

    const stored = getPendingQuestion(sessionId);
    expect(stored).toMatchObject({
      id: TOOL_USE_ID,
      sessionId,
      questions: [
        {
          question: "What would you like to focus on right now?",
          header: "Next session",
          multiSelect: false,
        },
      ],
    });
    expect(stored?.questions[0]?.options).toHaveLength(3);
  });

  it("serves the pending question over the read endpoint", async () => {
    await postAskUserQuestion(sessionId);

    const res = await getQuestion(sessionId);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { question: { id: string } | null };
    expect(body.question?.id).toBe(TOOL_USE_ID);

    const missing = await getQuestion("nope");
    expect(missing?.status).toBe(404);
  });

  it("clears the question and returns to running on PostToolUse", async () => {
    await postAskUserQuestion(sessionId);

    const res = await postHook(sessionId, {
      hook_event_name: "PostToolUse",
      session_id: SESSION_ID,
      tool_name: "AskUserQuestion",
      tool_use_id: TOOL_USE_ID,
    });

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({ ok: true, status: "running" });
    expect(getSession(sessionId)?.status).toBe("running");
    expect(getPendingQuestion(sessionId)).toBeNull();
  });

  it.each(["UserPromptSubmit", "Stop"])("clears the question on %s", async (event) => {
    await postAskUserQuestion(sessionId);
    expect(getPendingQuestion(sessionId)).not.toBeNull();

    const res = await postHook(sessionId, {
      hook_event_name: event,
      session_id: SESSION_ID,
    });

    expect(res?.status).toBe(200);
    expect(getPendingQuestion(sessionId)).toBeNull();
  });

  it("still flips status when tool_input is malformed, without storing a question", async () => {
    const res = await postHook(sessionId, {
      hook_event_name: "PreToolUse",
      session_id: SESSION_ID,
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "", options: [] }, "garbage"] },
    });

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({ ok: true, status: "needs-input" });
    expect(getPendingQuestion(sessionId)).toBeNull();
  });

  it("ignores PreToolUse for other tools", async () => {
    const res = await postHook(sessionId, {
      hook_event_name: "PreToolUse",
      session_id: SESSION_ID,
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({ ok: true, ignored: "PreToolUse" });
    expect(getPendingQuestion(sessionId)).toBeNull();
    expect(getSession(sessionId)?.status).not.toBe("needs-input");
  });

  it("ignores questions from foreign sessions", async () => {
    const res = await postHook(sessionId, {
      hook_event_name: "PreToolUse",
      session_id: "11111111-1111-4111-8111-111111111111",
      tool_name: "AskUserQuestion",
      tool_input: QUESTION_TOOL_INPUT,
    });

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({ ok: true, ignored: "foreign-session" });
    expect(getPendingQuestion(sessionId)).toBeNull();
  });
});

afterAll(async () => {
  await closePanelTestDb(testDb);
});
