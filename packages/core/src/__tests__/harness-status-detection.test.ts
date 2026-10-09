import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapCoreDb } from "../core-db-bootstrap";
import {
  configureCoreMutationStore,
  coreMutationStore,
  disposeCoreMutationStore,
} from "../core-mutation-store";
import {
  configureCoreQueryStore,
  coreQueryStore,
  disposeCoreQueryStore,
} from "../core-query-store";
import {
  appendEvent,
  configureEventLogStore,
  disposeEventLogStore,
  getLastEventId,
  readEventTail,
} from "../event-log-store";
import { CoreSessionWriter } from "../core-session-writer";
import { CoreHarnessStatus } from "../core-harness-status";
import { CoreTitleGenerator } from "../core-title-generator";
import {
  startHarnessHookReceiver,
  type HarnessHookReceiver,
} from "../harness-hook-receiver";
import { clearSubagentActivity } from "@actana/shared/subagent-activity";
import { TITLE_WAITING } from "@actana/shared/session-sentinels";
import type { CoreLinkEvent } from "@actana/sdk/core";

// Harness status detection on a Core, driven the way it really happens: a hook
// POSTs to the Core's own loopback receiver, that lands a row change in the
// Core's real SQLite, and that appends an event to the Core's real event log —
// which is what a Panel replays to re-render the card (issue 84).
//
// Nothing here hand-constructs a `session:updated` frame. Every assertion below
// starts at an HTTP request a `curl` in a hook file could have made.

const SESSION_ID = "t1";
/** The pid of the harness this Core "spawned" for the Session (issue 460). */
const SPAWNED_PID = 4242;
/** A `claude -p` started by the Session's own turn: a pid the Core never spawned. */
const NESTED_PID = 5151;
/**
 * The process table a hook's climb reads, as measured on a Debian `/bin/sh`
 * (dash forks the inner `sh -c`, so a hook's `$PPID` is one shell below the
 * harness) and on a nested run from inside a Bash tool call.
 */
const PROCESS_TABLE: Record<number, { comm: string; ppid: number }> = {
  [SPAWNED_PID]: { comm: "claude", ppid: 9 },
  4300: { comm: "sh", ppid: SPAWNED_PID },
  4301: { comm: "sh", ppid: 4300 },
  4400: { comm: "bash", ppid: SPAWNED_PID },
  [NESTED_PID]: { comm: "claude", ppid: 4400 },
  5200: { comm: "sh", ppid: NESTED_PID },
};

describe("harness status detection on the Core (issue 84)", () => {
  let userDataDir: string;
  let receiver: HarnessHookReceiver;
  let writer: CoreSessionWriter;
  let titleRuns: string[];
  let titleOutput: string;

  beforeEach(async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-harness-status-"));
    bootstrapCoreDb(userDataDir);
    configureCoreMutationStore(userDataDir);
    configureCoreQueryStore(userDataDir);
    configureEventLogStore(userDataDir);

    writer = new CoreSessionWriter({
      mutationPort: coreMutationStore,
      queryPort: coreQueryStore,
      eventLog: { appendEvent, getLastEventId, readEventTail },
    });
    titleRuns = [];
    titleOutput = "TITLE: Rebuild the warehouse picker\nICON: package";
    const titleGenerator = new CoreTitleGenerator({
      writer,
      runCli: async (_cmd, args) => {
        titleRuns.push(args.join(" "));
        return titleOutput;
      },
    });
    const status = new CoreHarnessStatus({
      writer,
      generateTitle: (sessionId, prompt) => titleGenerator.schedule(sessionId, prompt),
      spawnedPid: (sessionId) => (sessionId === SESSION_ID ? SPAWNED_PID : null),
      readProcess: (pid) => PROCESS_TABLE[pid] ?? null,
    });
    receiver = await startHarnessHookReceiver((sessionId, payload, eventFallback, origin) =>
      status.receiveHook(sessionId, payload, eventFallback, origin),
    );

    coreMutationStore.mutateSession({
      op: "create",
      sessionId: SESSION_ID,
      title: TITLE_WAITING,
      agent: "claude-code",
      status: "ready",
    });
  });

  afterEach(() => {
    clearSubagentActivity(SESSION_ID);
    receiver.close();
    disposeCoreMutationStore();
    disposeCoreQueryStore();
    disposeEventLogStore();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  /**
   * POST a hook payload exactly as a managed hook's `curl` would — including
   * the pid of the process that ran it, which for the Session's own harness is
   * the one the Core spawned (issue 460). `pid: null` sends none.
   */
  async function postHook(
    body: Record<string, unknown>,
    opts?: { token?: string; sessionId?: string; urlEvent?: string; pid?: number | null; slug?: string },
  ): Promise<{ status: number; json: unknown }> {
    const query = new URLSearchParams({ sessionId: opts?.sessionId ?? SESSION_ID });
    if (opts?.urlEvent) query.set("hookEvent", opts.urlEvent);
    const pid = opts?.pid === undefined ? SPAWNED_PID : opts.pid;
    if (pid !== null) query.set("pid", String(pid));
    const res = await fetch(
      `${receiver.url}/api/hooks/${opts?.slug ?? "claude"}?${query}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts?.token ?? receiver.token}`,
        },
        body: JSON.stringify(body),
      },
    );
    return { status: res.status, json: await res.json() };
  }

  const rowStatus = () => coreQueryStore.getSession(SESSION_ID)?.status;
  const rowTitle = () => coreQueryStore.getSession(SESSION_ID)?.title;
  const rowSessionId = () => coreQueryStore.getSession(SESSION_ID)?.claudeSessionId;
  const events = (): CoreLinkEvent[] => readEventTail(0, 100);
  const kinds = () => events().map((e) => e.kind);

  it("captures Pi's session UUID from SessionStart onto the session row (ADO #4986)", async () => {
    // Pi's extension posts this exact shape; the Core must persist the UUID
    // so relaunch can spell `pi --session <uuid>`. The Panel never mints one.
    const piSession = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    expect(rowSessionId()).toBeNull();

    // The row must BE a Pi Session: the receiver holds the family in the URL to
    // the row's harness before any pid is looked at (issue 460), and `update`
    // never rewrites `agent`.
    coreMutationStore.mutateSession({ op: "delete", sessionId: SESSION_ID });
    coreMutationStore.mutateSession({
      op: "create",
      sessionId: SESSION_ID,
      title: TITLE_WAITING,
      agent: "pi",
      status: "ready",
    });
    const res = await fetch(
      `${receiver.url}/api/hooks/pi?sessionId=${SESSION_ID}&hookEvent=SessionStart&pid=${SPAWNED_PID}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${receiver.token}`,
        },
        body: JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: piSession,
          source: "startup",
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: "SessionStart" });
    expect(rowSessionId()).toBe(piSession);
    expect(rowStatus()).toBe("ready");

    await postHook(
      { hook_event_name: "UserPromptSubmit", session_id: piSession, prompt: "say hello" },
      { slug: "pi" },
    );
    await postHook({ hook_event_name: "Stop", session_id: piSession }, { slug: "pi" });
    expect(rowStatus()).toBe("finished");
    expect(rowSessionId()).toBe(piSession);
  });

  it("moves ready → running when the operator submits a prompt", async () => {
    const res = await postHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "sess-1",
      prompt: "rebuild the picker",
    });
    expect(res.status).toBe(200);
    expect(rowStatus()).toBe("running");
    // The Panel re-renders off this event, replayed from its cursor if the
    // link was down when it landed.
    expect(kinds()).toContain("session:updated");
    expect(events().some((e) => e.sessionId === SESSION_ID)).toBe(true);
  });

  it("moves running → needs-input on a permission request", async () => {
    await postHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-1" });
    await postHook({
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      session_id: "sess-1",
    });
    expect(rowStatus()).toBe("needs-input");
  });

  it("finishes the turn on Stop, and marks it distinguishably", async () => {
    await postHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-1" });
    await postHook({ hook_event_name: "Stop", session_id: "sess-1" });
    expect(rowStatus()).toBe("finished");
    // #20's notification consumer routes on this kind; a generic session update
    // would leave it with nothing to hear.
    expect(kinds()).toContain("session:finished");
  });

  it("finishes on a Stop whose session id is not the stored one (issue 390)", async () => {
    // The operator-visible miss: a resumed harness (or an OpenCode child whose
    // idle leaked past the plugin's filter) posts its Stop under a session id
    // this session never captured. It used to be acked as `foreign-session` and
    // dropped before any status write, so the card stayed on `running` and the
    // notification consumer never heard a thing.
    await postHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-1" });
    expect(rowStatus()).toBe("running");

    await postHook({ hook_event_name: "Stop", session_id: "sess-2-after-resume" });

    expect(rowStatus()).toBe("finished");
    expect(kinds()).toContain("session:finished");
  });

  it("finishes a fanned-out turn whose resume lost its SessionStart (issue 390)", async () => {
    // The pre-resume process's subagents can never report in — their harness is
    // gone, and the resumed session's own subagent events carry the new id, so
    // they are dropped as foreign. Holding on that stale set was two hours of a
    // card on `running` with its Stop acked: #390's symptom inside the fix.
    await postHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-1" });
    await postHook({
      hook_event_name: "SubagentStart",
      session_id: "sess-1",
      agent_id: "sub-1",
    });

    await postHook({ hook_event_name: "Stop", session_id: "sess-2-after-resume" });

    expect(rowStatus()).toBe("finished");
    expect(kinds()).toContain("session:finished");
  });

  it("leaves a Session waiting on a permission prompt alone (issue 390)", async () => {
    // `needs-input` is not settled by a foreign turn end: unlike the PTY-exit
    // settle, the process here is alive and may be blocked on that question.
    await postHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-1" });
    await postHook({ hook_event_name: "PermissionRequest", session_id: "sess-1" });
    expect(rowStatus()).toBe("needs-input");

    await postHook({ hook_event_name: "Stop", session_id: "sess-2-child" });

    expect(rowStatus()).toBe("needs-input");
    expect(kinds()).not.toContain("session:finished");
  });

  it("holds the finish while a background subagent is still working", async () => {
    await postHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-1" });
    await postHook({
      hook_event_name: "SubagentStart",
      session_id: "sess-1",
      agent_id: "sub-1",
    });
    await postHook({ hook_event_name: "Stop", session_id: "sess-1" });
    // The foreground turn ended; the work has not. Finishing here is the
    // mid-work ding the Stop-downgrade exists to prevent.
    expect(rowStatus()).toBe("running");
    expect(kinds()).not.toContain("session:finished");

    await postHook({
      hook_event_name: "SubagentStop",
      session_id: "sess-1",
      agent_id: "sub-1",
    });
    await postHook({ hook_event_name: "Stop", session_id: "sess-1" });
    expect(rowStatus()).toBe("finished");
    expect(kinds()).toContain("session:finished");
  });

  it("settles a Session whose PTY exited, and leaves a settled one alone", async () => {
    const status = new CoreHarnessStatus({ writer, spawnedPid: () => SPAWNED_PID });
    await postHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-1" });

    status.sessionExited(SESSION_ID, 1);
    expect(rowStatus()).toBe("terminated");

    // A second exit patch (a retry, a second tab) must not disturb the row.
    status.sessionExited(SESSION_ID, 0);
    expect(rowStatus()).toBe("terminated");
  });

  it("settles a bare Session left on ready when its PTY dies (issue 387)", async () => {
    // The zombie found live on pairdemo: spawned, never prompted, so not one
    // hook ever arrived for it and no Stop was ever coming. The row is created
    // `ready` in beforeEach and nothing here posts a hook at all.
    const status = new CoreHarnessStatus({ writer, spawnedPid: () => SPAWNED_PID });
    expect(rowStatus()).toBe("ready");

    status.sessionExited(SESSION_ID, 1);

    expect(rowStatus()).toBe("disconnected");
    // `disconnected` is not a finish: no ding for a Session that never worked.
    expect(kinds()).not.toContain("session:finished");
    expect(kinds()).toContain("session:updated");
  });

  it("raises no completion ding for a bare Session whose PTY exited cleanly", async () => {
    // A clean exit of a Session that never ran a turn is still only a process
    // going away. `finished` here would append `session:finished` and ding the
    // operator for "Waiting for initial prompt…".
    const status = new CoreHarnessStatus({ writer, spawnedPid: () => SPAWNED_PID });
    status.sessionExited(SESSION_ID, 0);
    expect(rowStatus()).toBe("disconnected");
    expect(kinds()).not.toContain("session:finished");
  });

  it("reports a Session parked on a dialog nobody answered as needs-input", async () => {
    // Issue 177 finding 3. Prompt delivery abandons rather than guessing (ADR
    // 0026 D5), and until now that decision was a log line on the Core: the
    // row stayed where it was and every client saw a Session that looked hung.
    // It is not hung — it is waiting on a human, which `needs-input` is the
    // word for, and which is a settled status so an SDK `waitForIdle` stops.
    const status = new CoreHarnessStatus({ writer, spawnedPid: () => SPAWNED_PID });
    await postHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-1" });
    expect(rowStatus()).toBe("running");

    status.outputSignal(SESSION_ID, "dialog-unanswered");
    expect(rowStatus()).toBe("needs-input");
  });

  it("names an unnamed Session on the Core's own row, unpinned for a later rename", async () => {
    await postHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "sess-1",
      prompt: "rebuild the picker",
    });
    await vi.waitFor(() => expect(rowTitle()).toBe("Rebuild the warehouse picker"));
    expect(titleRuns).toHaveLength(1);
    // Generated, not renamed — an operator can still rename it, and the next
    // generated title is not blocked by a flag the generator set itself.
    expect(coreQueryStore.getSession(SESSION_ID)?.titleManuallySet).toBe(false);
  });

  it("never replaces an operator's rename, even when the generator finishes after it", async () => {
    let releaseCli: (value: string) => void = () => {};
    const slow = new Promise<string>((resolve) => {
      releaseCli = resolve;
    });
    const titleGenerator = new CoreTitleGenerator({ writer, runCli: () => slow });

    const pending = titleGenerator.generate(SESSION_ID, "rebuild the picker");
    // The operator renames while the CLI is still thinking.
    writer.mutate({ op: "update", sessionId: SESSION_ID, title: "Picker rewrite" });
    releaseCli("TITLE: Rebuild the warehouse picker\nICON: package");
    await pending;

    expect(rowTitle()).toBe("Picker rewrite");
    // And the protection is on the row, so it survives a Panel reload rather
    // than living in Panel memory.
    expect(coreQueryStore.getSession(SESSION_ID)?.titleManuallySet).toBe(true);
  });

  it("refuses a hook with the wrong bearer, and one for a session this Core does not have", async () => {
    const wrongToken = await postHook(
      { hook_event_name: "UserPromptSubmit" },
      { token: "not-the-token" },
    );
    expect(wrongToken.status).toBe(401);
    expect(rowStatus()).toBe("ready");

    const unknownSession = await postHook(
      { hook_event_name: "UserPromptSubmit" },
      { sessionId: "nope" },
    );
    expect(unknownSession.status).toBe(404);
  });

  it("names a Session from a prompt the Panel captured off the terminal", async () => {
    // Cursor never fires `beforeSubmitPrompt`, so no hook carries the prompt.
    // The Panel reads it off the terminal and hands it over; without this hop
    // a Core-owned Cursor Session could never be named at all.
    const titleGenerator = new CoreTitleGenerator({
      writer,
      runCli: async () => "TITLE: Rebuild the warehouse picker\nICON: package",
    });
    titleGenerator.schedule(SESSION_ID, "rebuild the picker");
    await vi.waitFor(() => expect(rowTitle()).toBe("Rebuild the warehouse picker"));
  });

  it("refuses to name a Session from its own meta-prompt", async () => {
    let ran = false;
    const titleGenerator = new CoreTitleGenerator({
      writer,
      runCli: async () => {
        ran = true;
        return "TITLE: nope";
      },
    });
    // A headless helper inherits the session's hook env; generating a title
    // from the title-generation prompt is a loop with no end.
    titleGenerator.schedule(SESSION_ID, "You are naming a developer's coding session. Pick a title");
    await new Promise((r) => setTimeout(r, 10));
    expect(ran).toBe(false);
    expect(rowTitle()).toBe(TITLE_WAITING);
  });

  it("routes on the URL's event when the payload omits one", async () => {
    // The hook writer names the event in the URL, so a harness build that
    // leaves `hook_event_name` out of the body is still routable rather than
    // silently ignored — which is what the Panel's endpoint has always done.
    const res = await postHook({ session_id: "sess-1" }, { urlEvent: "UserPromptSubmit" });
    expect(res.status).toBe(200);
    expect(rowStatus()).toBe("running");
  });

  it("tells a dropped body apart from an oversized one", async () => {
    // An operator debugging with `curl -v` must not be told their kilobyte
    // payload was too large because the socket dropped.
    const res = await fetch(`${receiver.url}/api/hooks/claude?sessionId=${SESSION_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${receiver.token}` },
      body: "x".repeat(1_000_001),
    });
    expect(res.status).toBe(413);
  });

  // Issue 460: the hook env is inherited by everything the harness starts, so
  // a `claude` nested inside the Session — a `claude -p` the agent runs, one
  // the operator starts from the Session's shell — runs the same hook file
  // and POSTs under the Session's id. Its pid is the one thing it cannot
  // inherit, and every hook is held to the pid the Core spawned.
  describe("a harness nested inside the Session (issue 460)", () => {
    it("cannot take over the Session's claudeSessionId on a capture event", async () => {
      await postHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-1" });
      expect(rowSessionId()).toBe("sess-1");

      // The nested harness's own startup, under its own session id.
      const start = await postHook(
        { hook_event_name: "SessionStart", session_id: "nested-1", source: "startup" },
        { pid: 5200 },
      );
      expect(start.status).toBe(200);
      expect(start.json).toMatchObject({ ok: true, ignored: "foreign-process" });
      const prompt = await postHook(
        { hook_event_name: "UserPromptSubmit", session_id: "nested-1", prompt: "helper work" },
        { pid: 5200 },
      );
      expect(prompt.json).toMatchObject({ ok: true, ignored: "foreign-process" });

      expect(rowSessionId()).toBe("sess-1");
      expect(rowStatus()).toBe("running");
      // Nor does it name the Session from the helper's prompt.
      expect(titleRuns.every((run) => !run.includes("helper work"))).toBe(true);
    });

    it("cannot drive the Session's status", async () => {
      // No stored id yet: before this issue the nested SessionStart would have
      // been captured outright, and every event after it would have been "the
      // Session's".
      expect(rowSessionId()).toBeNull();
      await postHook(
        { hook_event_name: "SessionStart", session_id: "nested-1", source: "startup" },
        { pid: 5200 },
      );
      await postHook(
        { hook_event_name: "UserPromptSubmit", session_id: "nested-1", prompt: "x" },
        { pid: 5200 },
      );
      expect(rowSessionId()).toBeNull();
      expect(rowStatus()).toBe("ready");
      await postHook(
        { hook_event_name: "Notification", notification_type: "permission_prompt", session_id: "nested-1" },
        { pid: 5200 },
      );
      expect(rowStatus()).toBe("ready");
      expect(kinds()).not.toContain("session:updated");
    });

    it("cannot settle a live owned turn with its Stop — even when its capture POSTs were lost", async () => {
      // Consequence 2 of the issue: a foreign-session Stop settles `running`
      // (issue 390). With the nested harness's SessionStart/UserPromptSubmit
      // dropped by a busy Core, its Stop used to reach that settle and write
      // `finished` over the real turn, mid-work.
      await postHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-1" });
      expect(rowStatus()).toBe("running");

      const stop = await postHook(
        { hook_event_name: "Stop", session_id: "nested-1" },
        { pid: 5200 },
      );
      expect(stop.json).toMatchObject({ ok: true, ignored: "foreign-process" });

      expect(rowStatus()).toBe("running");
      expect(kinds()).not.toContain("session:finished");

      // The Session's own Stop still lands.
      await postHook({ hook_event_name: "Stop", session_id: "sess-1" });
      expect(rowStatus()).toBe("finished");
    });

    it("is dropped by pid alone — the nested harness's own pid is not the spawned one", async () => {
      await postHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-1" });
      const res = await postHook(
        { hook_event_name: "Stop", session_id: "nested-1" },
        { pid: NESTED_PID },
      );
      expect(res.json).toMatchObject({ ok: true, ignored: "foreign-process" });
      expect(rowStatus()).toBe("running");
    });

    it("drops a hook that reports no pid at all", async () => {
      // Every hook file this Core writes reports one; a request without it is
      // not from a file this Core wrote.
      const res = await postHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-1" }, { pid: null });
      expect(res.json).toMatchObject({ ok: true, ignored: "foreign-process" });
      expect(rowStatus()).toBe("ready");
      expect(rowSessionId()).toBeNull();
    });

    it("drops a hook from another harness family, before any pid is looked at", async () => {
      // A Codex started inside a Claude Code Session: the workspace may hold
      // both families' hook files, and the env is the Claude Session's.
      const res = await postHook(
        { hook_event_name: "UserPromptSubmit", session_id: "codex-1" },
        { slug: "codex" },
      );
      expect(res.json).toMatchObject({ ok: true, ignored: "foreign-process" });
      expect(rowStatus()).toBe("ready");
    });

    it("still answers 404 for a Session this Core does not have", async () => {
      const res = await postHook(
        { hook_event_name: "Stop", session_id: "nested-1" },
        { sessionId: "no-such-session", pid: 5200 },
      );
      expect(res.status).toBe(404);
    });
  });

  describe("the Session's own harness reports exactly as before (issue 460)", () => {
    it("is owned when the hook's shell is a direct child of the spawned process", async () => {
      // `/bin/sh` is bash: the outer shell execs the inner `sh -c`, whose
      // `$PPID` is the harness itself.
      await postHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-1" }, { pid: SPAWNED_PID });
      expect(rowStatus()).toBe("running");
      expect(rowSessionId()).toBe("sess-1");
    });

    it("is owned when the hook's shell sits one or two shells below the spawned process", async () => {
      // `/bin/sh` is dash: the outer shell forks, so `$PPID` is a shell whose
      // parent is the harness. The climb crosses shells and nothing else.
      await postHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-1" }, { pid: 4300 });
      expect(rowStatus()).toBe("running");
      await postHook({ hook_event_name: "Stop", session_id: "sess-1" }, { pid: 4301 });
      expect(rowStatus()).toBe("finished");
      expect(kinds()).toContain("session:finished");
    });

    it("still adopts a new session id from its own capture event (a resume in place)", async () => {
      await postHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-1" });
      await postHook({ hook_event_name: "Stop", session_id: "sess-1" });
      await postHook(
        { hook_event_name: "SessionStart", session_id: "sess-2", source: "resume" },
        { pid: 4300 },
      );
      expect(rowSessionId()).toBe("sess-2");
    });

    it("still settles a foreign-session Stop from its own process (issue 390 kept)", async () => {
      await postHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-1" });
      await postHook({ hook_event_name: "Stop", session_id: "sess-2-after-resume" }, { pid: 4300 });
      expect(rowStatus()).toBe("finished");
    });

    it("is dropped once the Core runs no harness for the Session", async () => {
      // Nothing this Core would own can be posting for a Session it has no
      // PTY for: a process of a previous spawn, or a stranger with the env.
      const status = new CoreHarnessStatus({ writer, spawnedPid: () => null });
      const res = status.receiveHook(
        SESSION_ID,
        { hook_event_name: "UserPromptSubmit", session_id: "sess-1" },
        "",
        { slug: "claude", pid: SPAWNED_PID },
      );
      expect(res.body).toMatchObject({ ignored: "foreign-process" });
      expect(rowStatus()).toBe("ready");
    });

    it("takes the hook, and says so, where the process table cannot be read", async () => {
      // A platform with neither /proc nor ps: refusing every hook there would
      // park every Session on `ready`; the exposure is logged instead.
      const status = new CoreHarnessStatus({
        writer,
        spawnedPid: () => SPAWNED_PID,
        readProcess: () => undefined,
      });
      const res = status.receiveHook(
        SESSION_ID,
        { hook_event_name: "UserPromptSubmit", session_id: "sess-1" },
        "",
        { slug: "claude", pid: 4300 },
      );
      expect(res.body).toMatchObject({ ok: true, status: "running" });
    });

    it("the Core's own synthetic events carry no origin and are never held to a pid", async () => {
      const status = new CoreHarnessStatus({ writer, spawnedPid: () => null });
      await postHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-1" });
      status.sessionExited(SESSION_ID, 0);
      expect(rowStatus()).toBe("finished");
    });
  });

  it("binds loopback only — a hook never leaves the Core's machine", () => {
    expect(receiver.url.startsWith("http://127.0.0.1:")).toBe(true);
    expect(receiver.port).toBeGreaterThan(0);
  });
});
