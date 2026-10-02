import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";
import type { Harness } from "@actana/shared/domain";

const testDb = await openPanelTestDb();

const { handleApiRequest } = await import("../api-router");
const { getOrCreateApiToken } = await import("../services/settings");
const { createSession, getSession, updateStatus } = await import("../services/sessions");
const { createOperator } = await import("../services/operator");
const { TITLE_WAITING } = await import("~/lib/session-sentinels");

const LOOPBACK_HEADERS = { origin: "http://127.0.0.1:5173" };
const SESSION_ID = "00000000-0000-4000-8000-000000000000";

// Some cases pin or shift Date.now around the finish race window; always restore.
const realNow = Date.now;
afterEach(() => {
  Date.now = realNow;
});

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

async function postHook(
  slug: string,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<Response | null> {
  return handleApiRequest(
    await authed(`/api/hooks/${slug}?sessionId=${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function createHookSession(agent: Harness) {
  return createSession({
    title: TITLE_WAITING,
    agent,
    claudeSessionId: null,
  });
}

describe.each([
  { agent: "claude-code" as const, slug: "claude" },
  { agent: "codex" as const, slug: "codex" },
])("$agent hook API", ({ agent, slug }) => {
  let sessionId = "";

  beforeEach(async () => {
    await resetPanelState(testDb);
    await createOperator({ name: "Test Operator", password: "test-password" });
    sessionId = (await createHookSession(agent)).id;
  });

  it("marks sessions running on UserPromptSubmit", async () => {
    const res = await postHook(slug, sessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION_ID,
      prompt: "fix the login bug",
    });

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({ ok: true, status: "running" });
    expect((await getSession(sessionId))?.status).toBe("running");
  });

  it("captures session ids from UserPromptSubmit", async () => {
    const res = await postHook(slug, sessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION_ID,
      prompt: "wire hook tests",
    });

    expect(res?.status).toBe(200);
    expect(await getSession(sessionId)).toMatchObject({
      claudeSessionId: SESSION_ID,
      status: "running",
    });
  });

  it("marks sessions finished on Stop", async () => {
    const res = await postHook(slug, sessionId, {
      hook_event_name: "Stop",
      session_id: SESSION_ID,
    });

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({ ok: true, status: "finished" });
    expect((await getSession(sessionId))?.status).toBe("finished");
  });

  it("marks sessions needs-input on PermissionRequest", async () => {
    const res = await postHook(slug, sessionId, {
      hook_event_name: "PermissionRequest",
      session_id: SESSION_ID,
    });

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({ ok: true, status: "needs-input" });
    expect((await getSession(sessionId))?.status).toBe("needs-input");
  });

  it("walks the full hook lifecycle over HTTP", async () => {
    const running = await postHook(slug, sessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION_ID,
      prompt: "ship agent hook coverage",
    });
    expect(running?.status).toBe(200);

    const finished = await postHook(slug, sessionId, {
      hook_event_name: "Stop",
      session_id: SESSION_ID,
    });
    expect(finished?.status).toBe(200);

    expect(await getSession(sessionId)).toMatchObject({
      claudeSessionId: SESSION_ID,
      status: "finished",
    });
  });
});

describe("cursor-cli hook API", () => {
  let sessionId = "";

  beforeEach(async () => {
    await resetPanelState(testDb);
    await createOperator({ name: "Test Operator", password: "test-password" });
    sessionId = (await createHookSession("cursor-cli")).id;
  });

  it("marks sessions running on beforeSubmitPrompt", async () => {
    const res = await postHook("cursor", sessionId, {
      hook_event_name: "beforeSubmitPrompt",
      session_id: SESSION_ID,
      prompt: "fix the login bug",
    });

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({ ok: true, status: "running" });
    expect((await getSession(sessionId))?.status).toBe("running");
  });

  it("captures session ids from beforeSubmitPrompt", async () => {
    const res = await postHook("cursor", sessionId, {
      hook_event_name: "beforeSubmitPrompt",
      session_id: SESSION_ID,
      prompt: "wire hook tests",
    });

    expect(res?.status).toBe(200);
    expect(await getSession(sessionId)).toMatchObject({
      claudeSessionId: SESSION_ID,
      status: "running",
    });
  });

  it("captures conversation ids from beforeSubmitPrompt", async () => {
    const res = await postHook("cursor", sessionId, {
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: SESSION_ID,
      prompt: "wire hook tests",
    });

    expect(res?.status).toBe(200);
    expect(await getSession(sessionId)).toMatchObject({
      claudeSessionId: SESSION_ID,
      status: "running",
    });
  });

  it("captures conversation ids from sessionStart", async () => {
    const res = await postHook("cursor", sessionId, {
      hook_event_name: "sessionStart",
      conversation_id: SESSION_ID,
    });

    expect(res?.status).toBe(200);
    expect(await getSession(sessionId)).toMatchObject({
      claudeSessionId: SESSION_ID,
    });
  });

  it("marks sessions finished on stop", async () => {
    const res = await postHook("cursor", sessionId, {
      hook_event_name: "stop",
      session_id: SESSION_ID,
    });

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({ ok: true, status: "finished" });
    expect((await getSession(sessionId))?.status).toBe("finished");
  });

  it("marks sessions finished on afterAgentResponse", async () => {
    const res = await postHook("cursor", sessionId, {
      hook_event_name: "afterAgentResponse",
      session_id: SESSION_ID,
    });

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({ ok: true, status: "finished" });
    expect((await getSession(sessionId))?.status).toBe("finished");
  });

  it("walks the full hook lifecycle over HTTP", async () => {
    const running = await postHook("cursor", sessionId, {
      hook_event_name: "beforeSubmitPrompt",
      session_id: SESSION_ID,
      prompt: "ship agent hook coverage",
    });
    expect(running?.status).toBe(200);

    const finished = await postHook("cursor", sessionId, {
      hook_event_name: "afterAgentResponse",
      session_id: SESSION_ID,
    });
    expect(finished?.status).toBe(200);

    expect(await getSession(sessionId)).toMatchObject({
      claudeSessionId: SESSION_ID,
      status: "finished",
    });
  });
});

describe("background subagents over the claude hook API", () => {
  let sessionId = "";

  beforeEach(async () => {
    await resetPanelState(testDb);
    await createOperator({ name: "Test Operator", password: "test-password" });
    sessionId = (await createHookSession("claude-code")).id;
  });

  async function prompt(harnessSessionId = SESSION_ID) {
    const res = await postHook("claude", sessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: harnessSessionId,
      prompt: "run the sweep with background agents",
    });
    expect(res?.status).toBe(200);
  }

  async function subagent(event: "SubagentStart" | "SubagentStop", harnessId?: string) {
    const res = await postHook("claude", sessionId, {
      hook_event_name: event,
      session_id: SESSION_ID,
      ...(harnessId ? { agent_id: harnessId } : {}),
    });
    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({ ok: true, event });
    return res;
  }

  async function stop(harnessSessionId = SESSION_ID) {
    const res = await postHook("claude", sessionId, {
      hook_event_name: "Stop",
      session_id: harnessSessionId,
    });
    expect(res?.status).toBe(200);
    return (await res?.json()) as { status?: string };
  }

  it("holds the session on running while a background subagent is active", async () => {
    await prompt();
    await subagent("SubagentStart", "sub-1");

    // Foreground turn ends while the background subagent still runs.
    const held = await stop();
    expect(held.status).toBe("running");
    expect((await getSession(sessionId))?.status).toBe("running");

    // Subagent completes; the re-invoked main agent's own Stop is the real finish.
    await subagent("SubagentStop", "sub-1");
    const finished = await stop();
    expect(finished.status).toBe("finished");
    expect((await getSession(sessionId))?.status).toBe("finished");
  });

  it("finishes on Stop when subagents already completed within the turn", async () => {
    await prompt();
    await subagent("SubagentStart", "sub-1");
    await subagent("SubagentStart", "sub-2");
    await subagent("SubagentStop", "sub-1");
    await subagent("SubagentStop", "sub-2");

    const finished = await stop();
    expect(finished.status).toBe("finished");
    expect((await getSession(sessionId))?.status).toBe("finished");
  });

  it("holds until the LAST of several background subagents reports in", async () => {
    await prompt();
    await subagent("SubagentStart", "sub-1");
    await subagent("SubagentStart", "sub-2");
    await subagent("SubagentStop", "sub-1");

    const held = await stop();
    expect(held.status).toBe("running");

    await subagent("SubagentStop", "sub-2");
    const finished = await stop();
    expect(finished.status).toBe("finished");
  });

  it("counts subagents without agent_id via the anonymous fallback", async () => {
    await prompt();
    await subagent("SubagentStart");
    expect((await stop()).status).toBe("running");

    await subagent("SubagentStop");
    expect((await stop()).status).toBe("finished");
  });

  it("does not change session status on subagent lifecycle events themselves", async () => {
    await prompt();
    expect((await getSession(sessionId))?.status).toBe("running");
    await subagent("SubagentStart", "sub-1");
    expect((await getSession(sessionId))?.status).toBe("running");
    await subagent("SubagentStop", "sub-1");
    expect((await getSession(sessionId))?.status).toBe("running");
  });

  it("drops tracked subagents when a new session id is captured", async () => {
    await prompt();
    await subagent("SubagentStart", "sub-1");

    // A new Claude process (fresh session id) means the old session's
    // subagents are gone — its Stop must finish normally.
    const nextSession = "11111111-1111-4111-8111-111111111111";
    await prompt(nextSession);
    const finished = await stop(nextSession);
    expect(finished.status).toBe("finished");
  });

  it("ignores subagent events from a foreign session", async () => {
    await prompt();
    const foreign = "22222222-2222-4222-8222-222222222222";
    const res = await postHook("claude", sessionId, {
      hook_event_name: "SubagentStart",
      session_id: foreign,
      agent_id: "foreign-sub",
    });
    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({ ok: true, ignored: "foreign-session" });

    const finished = await stop();
    expect(finished.status).toBe("finished");
  });

  it("heals a finished session when a late subagent event loses the race to Stop", async () => {
    await prompt();
    // Stop wins the race against the just-launched subagent's SubagentStart.
    // Both POSTs leave the same harness process microseconds apart, so the
    // clock is pinned: the heal window is that race, not the round trip.
    const raceInstant = realNow();
    Date.now = () => raceInstant;
    expect((await stop()).status).toBe("finished");

    await subagent("SubagentStart", "late-sub");
    expect((await getSession(sessionId))?.status).toBe("running");
    Date.now = realNow;

    await subagent("SubagentStop", "late-sub");
    expect((await stop()).status).toBe("finished");
  });

  it("drops tracked subagents on /clear (same session id, background work killed)", async () => {
    await prompt();
    await subagent("SubagentStart", "sub-1");

    const cleared = await postHook("claude", sessionId, {
      hook_event_name: "SessionStart",
      session_id: SESSION_ID,
      source: "clear",
    });
    expect(cleared?.status).toBe(200);

    const finished = await stop();
    expect(finished.status).toBe("finished");
  });

  it("drops tracked subagents when the terminal is terminated", async () => {
    await prompt();
    await subagent("SubagentStart", "sub-1");
    await updateStatus(sessionId, { status: "terminated" });

    // A later session of the same session must not be held by the dead
    // session's never-stopped subagent.
    await prompt();
    const finished = await stop();
    expect(finished.status).toBe("finished");
  });

  it("ignores post-turn helper subagent events on a long-finished session", async () => {
    await prompt();
    expect((await stop()).status).toBe("finished");

    // Seconds later the user refocuses the pane, or clicks the just-finished
    // pin, and Claude Code's internal away-summary helper fires
    // SubagentStart/Stop — with no Stop to follow. The finished status must
    // hold. Five seconds was INSIDE the old 30s heal window (issue 385): the
    // card flipped back to running and stayed there until the drain backstop.
    Date.now = () => realNow() + 5_000;
    await subagent("SubagentStart", "away-helper");
    expect((await getSession(sessionId))?.status).toBe("finished");
    await subagent("SubagentStop", "away-helper");
    expect((await getSession(sessionId))?.status).toBe("finished");
    Date.now = realNow;

    // The helper's start must not count as active work either — a lost helper
    // stop would otherwise hold the next turn's Stop on running.
    await prompt();
    expect((await stop()).status).toBe("finished");
  });
});

describe("synthetic session-process-exit over the claude hook API", () => {
  let sessionId = "";

  beforeEach(async () => {
    await resetPanelState(testDb);
    await createOperator({ name: "Test Operator", password: "test-password" });
    sessionId = (await createHookSession("claude-code")).id;
  });

  async function processExited(exitCode: number) {
    const res = await postHook("claude", sessionId, {
      hook_event_name: "MissionControlSessionEnded",
      exit_code: exitCode,
    });
    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({
      ok: true,
      event: "MissionControlSessionEnded",
    });
  }

  it("terminates a running session whose process died", async () => {
    await updateStatus(sessionId, { status: "running" });
    await processExited(137);
    expect((await getSession(sessionId))?.status).toBe("terminated");
  });

  it("finishes a running session whose process exited cleanly", async () => {
    await updateStatus(sessionId, { status: "running" });
    await processExited(0);
    expect((await getSession(sessionId))?.status).toBe("finished");
  });

  it("terminates a needs-input session whose process died", async () => {
    await updateStatus(sessionId, { status: "needs-input" });
    await processExited(1);
    expect((await getSession(sessionId))?.status).toBe("terminated");
  });

  it("leaves settled sessions alone", async () => {
    await updateStatus(sessionId, { status: "finished" });
    await processExited(1);
    expect((await getSession(sessionId))?.status).toBe("finished");

    await updateStatus(sessionId, { status: "interrupted" });
    await processExited(0);
    expect((await getSession(sessionId))?.status).toBe("interrupted");
  });

  it("never heals on laggard subagent events after the process died", async () => {
    await updateStatus(sessionId, { status: "running" });
    // A real Stop lands the finish moments before the process exits…
    const stopped = await postHook("claude", sessionId, {
      hook_event_name: "Stop",
      session_id: SESSION_ID,
    });
    expect(stopped?.status).toBe(200);
    await processExited(0);

    // …then an in-flight SubagentStart from the dying session arrives inside
    // what would be the heal window. A dead process can't be re-invoked, so
    // healing here would wedge the session on "running" for the whole TTL.
    const laggard = await postHook("claude", sessionId, {
      hook_event_name: "SubagentStart",
      session_id: SESSION_ID,
      agent_id: "laggard",
    });
    expect(laggard?.status).toBe(200);
    expect((await getSession(sessionId))?.status).toBe("finished");
  });

  it("drops tracked subagents with the dead process", async () => {
    await updateStatus(sessionId, { status: "running" });
    const started = await postHook("claude", sessionId, {
      hook_event_name: "SubagentStart",
      session_id: SESSION_ID,
      agent_id: "orphan",
    });
    expect(started?.status).toBe(200);
    await processExited(1);

    // A later session of the same session must not be held by the dead
    // session's never-stopped subagent.
    const prompted = await postHook("claude", sessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION_ID,
      prompt: "start again",
    });
    expect(prompted?.status).toBe(200);
    const res = await postHook("claude", sessionId, {
      hook_event_name: "Stop",
      session_id: SESSION_ID,
    });
    await expect(res?.json()).resolves.toMatchObject({ status: "finished" });
  });
});


afterAll(async () => {
  await closePanelTestDb(testDb);
});
