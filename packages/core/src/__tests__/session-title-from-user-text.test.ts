import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapCoreDb } from "../core-db-bootstrap";
import { configureCoreMutationStore, coreMutationStore, disposeCoreMutationStore } from "../core-mutation-store";
import { configureCoreQueryStore, coreQueryStore, disposeCoreQueryStore } from "../core-query-store";
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
import { startHarnessHookReceiver, type HarnessHookReceiver } from "../harness-hook-receiver";
import { appendPromptBlock } from "../prompt-standard-block";
import { TITLE_WAITING } from "@actana/shared/session-sentinels";

// A harness reports the prompt it was given back on its own hook (UserPromptSubmit
// for Claude Code, Codex, opencode and Pi; beforeSubmitPrompt for Cursor), and
// after issue 563 that text is the user's prompt plus the Core's standard block.
// The Session is named from the user's text only, on every one of those paths.

const SESSION_ID = "t1";
const USER_TEXT = "fix the bug";
const WITH_BLOCK = appendPromptBlock(USER_TEXT, { sessionId: SESSION_ID, turn: 1 });

const HOOK_PATHS = [
  { agent: "claude-code", event: "UserPromptSubmit" },
  { agent: "codex", event: "UserPromptSubmit" },
  { agent: "opencode", event: "UserPromptSubmit" },
  { agent: "pi", event: "UserPromptSubmit" },
  { agent: "cursor-cli", event: "beforeSubmitPrompt" },
] as const;

describe("a Session is named from the user's text, not the standard block (issue 563)", () => {
  let userDataDir: string;
  let receiver: HarnessHookReceiver;
  let titleInputs: string[];
  let cliBehaviour: "title" | "fail";

  beforeEach(async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-title-block-"));
    bootstrapCoreDb(userDataDir);
    configureCoreMutationStore(userDataDir);
    configureCoreQueryStore(userDataDir);
    configureEventLogStore(userDataDir);
    const writer = new CoreSessionWriter({
      mutationPort: coreMutationStore,
      queryPort: coreQueryStore,
      eventLog: { appendEvent, getLastEventId, readEventTail },
    });
    titleInputs = [];
    cliBehaviour = "title";
    const generator = new CoreTitleGenerator({
      writer,
      runCli: async (_cmd, args) => {
        titleInputs.push(args.join(" "));
        if (cliBehaviour === "fail") throw new Error("cli down");
        return "TITLE: Fix the bug\nICON: bug";
      },
    });
    const status = new CoreHarnessStatus({
      writer,
      generateTitle: (id, prompt) => generator.schedule(id, prompt),
      spawned: () => null,
    });
    receiver = await startHarnessHookReceiver((id, payload, fallback) => status.receiveHook(id, payload, fallback));
  });

  afterEach(() => {
    receiver.close();
    disposeCoreMutationStore();
    disposeCoreQueryStore();
    disposeEventLogStore();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  function createSession(agent: string): void {
    coreMutationStore.mutateSession({ op: "create", sessionId: SESSION_ID, title: TITLE_WAITING, agent, status: "ready" });
  }

  async function post(event: string): Promise<void> {
    const query = new URLSearchParams({ sessionId: SESSION_ID });
    await fetch(`${receiver.url}/api/hooks/claude?${query}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${receiver.token}` },
      body: JSON.stringify({ hook_event_name: event, session_id: "h-1", prompt: WITH_BLOCK }),
    });
  }

  const rowTitle = () => coreQueryStore.getSession(SESSION_ID)?.title;

  it.each(HOOK_PATHS)("$agent on $event: the naming run is given the user's text, never the block", async ({ agent, event }) => {
    createSession(agent);
    await post(event);
    await vi.waitFor(() => expect(rowTitle()).not.toBe(TITLE_WAITING));
    for (const input of titleInputs) {
      expect(input).toContain(USER_TEXT);
      expect(input).not.toMatch(/Actana standard block|report-1\.md|ACT-REPORT-END|sudo/);
    }
  });

  it.each(HOOK_PATHS)("$agent on $event: the fallback title is the user's text", async ({ agent, event }) => {
    cliBehaviour = "fail";
    createSession(agent);
    await post(event);
    await vi.waitFor(() => expect(rowTitle()).toBe(USER_TEXT));
  });
});
