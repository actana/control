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
import { CoreTaskWriter } from "../core-task-writer";
import { CoreHarnessStatus } from "../core-harness-status";
import { CoreTitleGenerator } from "../core-title-generator";
import {
  startHarnessHookReceiver,
  type HarnessHookReceiver,
} from "../harness-hook-receiver";
import { clearSubagentActivity } from "@actana/shared/subagent-activity";
import { TITLE_WAITING } from "@actana/shared/task-sentinels";
import type { CoreLinkEvent } from "@actana/sdk/core-link-frames";

// Harness status detection on a Core, driven the way it really happens: a hook
// POSTs to the Core's own loopback receiver, that lands a row change in the
// Core's real SQLite, and that appends an event to the Core's real event log —
// which is what a Panel replays to re-render the card (issue 84).
//
// Nothing here hand-constructs a `task:updated` frame. Every assertion below
// starts at an HTTP request a `curl` in a hook file could have made.

const TASK_ID = "t1";

describe("harness status detection on the Core (issue 84)", () => {
  let userDataDir: string;
  let receiver: HarnessHookReceiver;
  let writer: CoreTaskWriter;
  let titleRuns: string[];
  let titleOutput: string;

  beforeEach(async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-harness-status-"));
    bootstrapCoreDb(userDataDir);
    configureCoreMutationStore(userDataDir);
    configureCoreQueryStore(userDataDir);
    configureEventLogStore(userDataDir);

    writer = new CoreTaskWriter({
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
      generateTitle: (taskId, prompt) => titleGenerator.schedule(taskId, prompt),
    });
    receiver = await startHarnessHookReceiver((taskId, payload, eventFallback) =>
      status.receiveHook(taskId, payload, eventFallback),
    );

    coreMutationStore.mutateProject({
      op: "create",
      projectId: "p1",
      name: "Warehouse",
      path: userDataDir,
    });
    coreMutationStore.mutateTask({
      op: "create",
      taskId: TASK_ID,
      projectId: "p1",
      title: TITLE_WAITING,
      agent: "claude-code",
      status: "ready",
    });
  });

  afterEach(() => {
    clearSubagentActivity(TASK_ID);
    receiver.close();
    disposeCoreMutationStore();
    disposeCoreQueryStore();
    disposeEventLogStore();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  /** POST a hook payload exactly as a managed hook's `curl` would. */
  async function postHook(
    body: Record<string, unknown>,
    opts?: { token?: string; taskId?: string; urlEvent?: string },
  ): Promise<{ status: number; json: unknown }> {
    const query = new URLSearchParams({ taskId: opts?.taskId ?? TASK_ID });
    if (opts?.urlEvent) query.set("hookEvent", opts.urlEvent);
    const res = await fetch(
      `${receiver.url}/api/hooks/claude?${query}`,
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

  const rowStatus = () => coreQueryStore.getTask(TASK_ID)?.status;
  const rowTitle = () => coreQueryStore.getTask(TASK_ID)?.title;
  const events = (): CoreLinkEvent[] => readEventTail(0, 100);
  const kinds = () => events().map((e) => e.kind);

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
    expect(kinds()).toContain("task:updated");
    expect(events().some((e) => e.taskId === TASK_ID)).toBe(true);
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
    // #20's notification consumer routes on this kind; a generic task update
    // would leave it with nothing to hear.
    expect(kinds()).toContain("session:finished");
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
    const status = new CoreHarnessStatus({ writer });
    await postHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-1" });

    status.sessionExited(TASK_ID, 1);
    expect(rowStatus()).toBe("terminated");

    // A second exit patch (a retry, a second tab) must not disturb the row.
    status.sessionExited(TASK_ID, 0);
    expect(rowStatus()).toBe("terminated");
  });

  it("settles a bare Session left on ready when its PTY dies (issue 387)", async () => {
    // The zombie found live on pairdemo: spawned, never prompted, so not one
    // hook ever arrived for it and no Stop was ever coming. The row is created
    // `ready` in beforeEach and nothing here posts a hook at all.
    const status = new CoreHarnessStatus({ writer });
    expect(rowStatus()).toBe("ready");

    status.sessionExited(TASK_ID, 1);

    expect(rowStatus()).toBe("disconnected");
    // `disconnected` is not a finish: no ding for a Session that never worked.
    expect(kinds()).not.toContain("session:finished");
    expect(kinds()).toContain("task:updated");
  });

  it("raises no completion ding for a bare Session whose PTY exited cleanly", async () => {
    // A clean exit of a Session that never ran a turn is still only a process
    // going away. `finished` here would append `session:finished` and ding the
    // operator for "Waiting for initial prompt…".
    const status = new CoreHarnessStatus({ writer });
    status.sessionExited(TASK_ID, 0);
    expect(rowStatus()).toBe("disconnected");
    expect(kinds()).not.toContain("session:finished");
  });

  it("reports a Session parked on a dialog nobody answered as needs-input", async () => {
    // Issue 177 finding 3. Prompt delivery abandons rather than guessing (ADR
    // 0026 D5), and until now that decision was a log line on the Core: the
    // row stayed where it was and every client saw a Session that looked hung.
    // It is not hung — it is waiting on a human, which `needs-input` is the
    // word for, and which is a settled status so an SDK `waitForIdle` stops.
    const status = new CoreHarnessStatus({ writer });
    await postHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-1" });
    expect(rowStatus()).toBe("running");

    status.outputSignal(TASK_ID, "dialog-unanswered");
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
    expect(coreQueryStore.getTask(TASK_ID)?.titleManuallySet).toBe(false);
  });

  it("never replaces an operator's rename, even when the generator finishes after it", async () => {
    let releaseCli: (value: string) => void = () => {};
    const slow = new Promise<string>((resolve) => {
      releaseCli = resolve;
    });
    const titleGenerator = new CoreTitleGenerator({ writer, runCli: () => slow });

    const pending = titleGenerator.generate(TASK_ID, "rebuild the picker");
    // The operator renames while the CLI is still thinking.
    writer.mutate({ op: "update", taskId: TASK_ID, title: "Picker rewrite" });
    releaseCli("TITLE: Rebuild the warehouse picker\nICON: package");
    await pending;

    expect(rowTitle()).toBe("Picker rewrite");
    // And the protection is on the row, so it survives a Panel reload rather
    // than living in Panel memory.
    expect(coreQueryStore.getTask(TASK_ID)?.titleManuallySet).toBe(true);
  });

  it("refuses a hook with the wrong bearer, and one for a task this Core does not have", async () => {
    const wrongToken = await postHook(
      { hook_event_name: "UserPromptSubmit" },
      { token: "not-the-token" },
    );
    expect(wrongToken.status).toBe(401);
    expect(rowStatus()).toBe("ready");

    const unknownTask = await postHook(
      { hook_event_name: "UserPromptSubmit" },
      { taskId: "nope" },
    );
    expect(unknownTask.status).toBe(404);
  });

  it("names a Session from a prompt the Panel captured off the terminal", async () => {
    // Cursor never fires `beforeSubmitPrompt`, so no hook carries the prompt.
    // The Panel reads it off the terminal and hands it over; without this hop
    // a Core-owned Cursor Session could never be named at all.
    const titleGenerator = new CoreTitleGenerator({
      writer,
      runCli: async () => "TITLE: Rebuild the warehouse picker\nICON: package",
    });
    titleGenerator.schedule(TASK_ID, "rebuild the picker");
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
    titleGenerator.schedule(TASK_ID, "You are naming a developer's coding session. Pick a title");
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
    const res = await fetch(`${receiver.url}/api/hooks/claude?taskId=${TASK_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${receiver.token}` },
      body: "x".repeat(1_000_001),
    });
    expect(res.status).toBe(413);
  });

  it("binds loopback only — a hook never leaves the Core's machine", () => {
    expect(receiver.url.startsWith("http://127.0.0.1:")).toBe(true);
    expect(receiver.port).toBeGreaterThan(0);
  });
});
