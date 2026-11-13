import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSubagentActivity } from "@actana/shared/subagent-activity";
import { SESSION_PROMPT_EVENT_KIND } from "@actana/shared/harness-hook-prompt";
import { bootstrapCoreDb } from "../core-db-bootstrap";
import { CoreHarnessStatus } from "../core-harness-status";
import { configureCoreMutationStore, coreMutationStore, disposeCoreMutationStore } from "../core-mutation-store";
import { configureCoreQueryStore, coreQueryStore, disposeCoreQueryStore } from "../core-query-store";
import { CoreSessionWriter } from "../core-session-writer";
import { appendEvent, configureEventLogStore, disposeEventLogStore, getLastEventId, readEventTail } from "../event-log-store";

// #959, source 1: a hook that sets `needs-input` says what the dialog is (`session:prompt`), just before the status event.
describe("session:prompt, against the Core's real SQLite and event log", () => {
  let userDataDir: string;
  let status: CoreHarnessStatus;

  const insert = (sessionId: string, state: string) =>
    coreMutationStore.mutateSession({ op: "create", sessionId, title: sessionId, agent: "claude-code", status: state });
  const eventsSince = (id: number) => readEventTail(id, 100).map((e) => ({ kind: e.kind, payload: JSON.parse(e.payload) as Record<string, unknown> }));
  const last = (): number => getLastEventId() ?? 0;

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-hook-prompt-"));
    bootstrapCoreDb(userDataDir);
    configureCoreMutationStore(userDataDir);
    configureCoreQueryStore(userDataDir);
    configureEventLogStore(userDataDir);
    const writer = new CoreSessionWriter({
      mutationPort: coreMutationStore,
      queryPort: coreQueryStore,
      eventLog: { appendEvent, getLastEventId, readEventTail },
    });
    status = new CoreHarnessStatus({ writer, spawned: () => null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearSubagentActivity("t-1");
    disposeCoreMutationStore();
    disposeCoreQueryStore();
    disposeEventLogStore();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it("PermissionRequest appends session:prompt (permission, the tool) and then the needs-input status", () => {
    insert("t-1", "running");
    const before = last();
    status.receiveHook("t-1", { hook_event_name: "PermissionRequest", tool_name: "Bash" });
    const seen = eventsSince(before).filter((e) => e.kind === SESSION_PROMPT_EVENT_KIND || e.kind === "session:updated");
    expect(seen.map((e) => e.kind)).toEqual([SESSION_PROMPT_EVENT_KIND, "session:updated"]);
    expect(seen[0]!.payload).toEqual({ sessionId: "t-1", kind: "permission", tool: "Bash" });
    expect(seen[1]!.payload).toMatchObject({ sessionId: "t-1", status: "needs-input" });
  });

  it("AskUserQuestion appends session:prompt with the parsed question and options", () => {
    insert("t-1", "running");
    const before = last();
    status.receiveHook("t-1", {
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Which database?", multiSelect: false, options: [{ label: "Postgres" }, { label: "SQLite" }] }] },
    });
    const prompt = eventsSince(before).find((e) => e.kind === SESSION_PROMPT_EVENT_KIND);
    expect(prompt?.payload).toEqual({ sessionId: "t-1", kind: "choice", text: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] });
  });

  it("a hook that does not set needs-input appends no session:prompt", () => {
    insert("t-1", "running");
    const before = last();
    status.receiveHook("t-1", { hook_event_name: "Stop" });
    expect(eventsSince(before).some((e) => e.kind === SESSION_PROMPT_EVENT_KIND)).toBe(false);
  });
});
