import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessHookBody } from "@actana/shared/harness-hook-pipeline";
import { clearSubagentActivity } from "@actana/shared/subagent-activity";
import { bootstrapCoreDb } from "../core-db-bootstrap";
import { CoreHarnessStatus } from "../core-harness-status";
import { configureCoreMutationStore, coreMutationStore, disposeCoreMutationStore } from "../core-mutation-store";
import { configureCoreQueryStore, coreQueryStore, disposeCoreQueryStore, listActiveSessions } from "../core-query-store";
import { CoreSessionBackstop } from "../core-session-backstop";
import { CoreSessionWriter } from "../core-session-writer";
import { DIALOG_SETTLE_MS, DialogScreenWatch } from "../core-dialog-watch";
import {
  appendEvent,
  configureEventLogStore,
  disposeEventLogStore,
  getLastEventId,
  readEventTail,
} from "../event-log-store";

// A dialog no hook announces sets `needs-input` (issue 963, Exact fix 3-5).

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const SECOND = 1000;

describe("DialogScreenWatch: when the screen is asked", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const watch = (harness: string, found: Array<{ ruleId: string; kind: string }>) =>
    new DialogScreenWatch({ harness, onDialog: (hit) => {
        found.push({ ruleId: hit.ruleId, kind: hit.kind });
      } });

  it("defaults to ten seconds", () => {
    expect(DIALOG_SETTLE_MS).toBe(10_000);
  });

  it("classifies a dialog once, after the screen has been silent for the settle time", () => {
    const found: Array<{ ruleId: string; kind: string }> = [];
    const w = watch("claude-code", found);
    w.push(fixture("claude-code-synthetic-bash-permission.txt"), "output");

    vi.advanceTimersByTime(DIALOG_SETTLE_MS - SECOND);
    expect(found).toEqual([]);
    vi.advanceTimersByTime(2 * SECOND);
    expect(found).toEqual([{ ruleId: "bash_permission_prompt", kind: "permission" }]);

    // Once: more silence says nothing new.
    vi.advanceTimersByTime(10 * DIALOG_SETTLE_MS);
    expect(found).toHaveLength(1);
    w.dispose();
  });

  it("treats a dialog that keeps repainting the same frame as static", () => {
    const found: Array<{ ruleId: string; kind: string }> = [];
    const w = watch("codex", found);
    w.push(fixture("codex-synthetic-allow-command.txt"), "output");
    for (let s = 0; s < 12; s += 1) {
      vi.advanceTimersByTime(SECOND);
      w.push("\u001b[?25h", s % 5 === 0 ? "static" : null);
    }
    expect(found).toEqual([{ ruleId: "live_strong_blocker", kind: "choice" }]);
    w.dispose();
  });

  it("does not ask while the screen is still moving", () => {
    const found: Array<{ ruleId: string; kind: string }> = [];
    const w = watch("claude-code", found);
    w.push(fixture("claude-code-synthetic-bash-permission.txt"), "output");
    for (let s = 0; s < 60; s += 1) {
      vi.advanceTimersByTime(5 * SECOND);
      w.push("\u001b[2K\u001b[Gworking", "redraw");
    }
    expect(found).toEqual([]);
    w.dispose();
  });

  it("finds nothing on a working spinner or an idle composer", () => {
    const found: Array<{ ruleId: string; kind: string }> = [];
    const spinner = watch("claude-code", found);
    spinner.push(fixture("claude-code-synthetic-working-spinner.txt"), "output");
    const composer = watch("codex", found);
    composer.push(fixture("codex-0.153.0-composer.txt"), "output");
    vi.advanceTimersByTime(5 * DIALOG_SETTLE_MS);
    expect(found).toEqual([]);
    spinner.dispose();
    composer.dispose();
  });

  it("forgets what a full-screen clear wiped", () => {
    const found: Array<{ ruleId: string; kind: string }> = [];
    const w = watch("claude-code", found);
    w.push(fixture("claude-code-synthetic-bash-permission.txt"), "output");
    w.push("\u001b[2J\u001b[H❯ ", "output");
    vi.advanceTimersByTime(2 * DIALOG_SETTLE_MS);
    expect(found).toEqual([]);
    w.dispose();
  });

  it("asks again after new output moved the screen and it settles on a dialog again", () => {
    const found: Array<{ ruleId: string; kind: string }> = [];
    const w = watch("generic", found);
    w.push(fixture("generic-synthetic-yes-no.txt"), "output");
    vi.advanceTimersByTime(2 * DIALOG_SETTLE_MS);
    w.push(fixture("generic-synthetic-numbered-choice.txt"), "output");
    vi.advanceTimersByTime(2 * DIALOG_SETTLE_MS);
    expect(found.map((f) => f.ruleId)).toEqual(["yes_no_prompt", "numbered_choice_footer"]);
    w.dispose();
  });

  it("asks again when the host refuses for a reason that may pass", () => {
    const calls: string[] = [];
    let refuse = true;
    const w = new DialogScreenWatch({
      harness: "claude-code",
      onDialog: (h) => {
        calls.push(h.ruleId);
        if (refuse) {
          refuse = false;
          return "retry";
        }
      },
    });
    w.push(fixture("claude-code-synthetic-bash-permission.txt"), "output");
    vi.advanceTimersByTime(DIALOG_SETTLE_MS + SECOND);
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(DIALOG_SETTLE_MS);
    expect(calls).toHaveLength(2);
    vi.advanceTimersByTime(10 * DIALOG_SETTLE_MS);
    expect(calls).toHaveLength(2);
    w.dispose();
  });

  it("stops asking once disposed", () => {
    const found: Array<{ ruleId: string; kind: string }> = [];
    const w = watch("claude-code", found);
    w.push(fixture("claude-code-synthetic-bash-permission.txt"), "output");
    w.dispose();
    vi.advanceTimersByTime(5 * DIALOG_SETTLE_MS);
    expect(found).toEqual([]);
  });

  it("never applies a harness's rules to another harness's screen", () => {
    const found: Array<{ ruleId: string; kind: string }> = [];
    const w = watch("codex", found);
    w.push(fixture("claude-code-synthetic-mcp-elicitation.txt"), "output");
    vi.advanceTimersByTime(2 * DIALOG_SETTLE_MS);
    expect(found.map((f) => f.ruleId)).not.toContain("mcp_elicitation_prompt");
    w.dispose();
  });
});

describe("a screen-set needs-input, against the Core's real SQLite and event log", () => {
  let userDataDir: string;
  let writer: CoreSessionWriter;
  let nowMs: number;
  let status: CoreHarnessStatus;

  const insert = (sessionId: string, state: string, agent = "claude-code") =>
    coreMutationStore.mutateSession({ op: "create", sessionId, title: sessionId, agent, status: state });
  const statusOf = (sessionId: string) => coreQueryStore.getSession(sessionId)?.status;
  const payloadsSince = (eventId: number) =>
    readEventTail(eventId, 100)
      .filter((e) => e.kind === "session:updated")
      .map((e) => JSON.parse(e.payload) as Record<string, unknown>);
  const lastEventId = (): number => {
    const id = getLastEventId();
    if (id === null) throw new Error("event-log store unavailable");
    return id;
  };
  const hit = { ruleId: "bash_permission_prompt", kind: "permission" } as const;

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-dialog-screen-"));
    bootstrapCoreDb(userDataDir);
    configureCoreMutationStore(userDataDir);
    configureCoreQueryStore(userDataDir);
    configureEventLogStore(userDataDir);
    writer = new CoreSessionWriter({
      mutationPort: coreMutationStore,
      queryPort: coreQueryStore,
      eventLog: { appendEvent, getLastEventId, readEventTail },
    });
    nowMs = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    status = new CoreHarnessStatus({ writer, spawned: () => null, now: () => nowMs });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearSubagentActivity("t-1");
    disposeCoreMutationStore();
    disposeCoreQueryStore();
    disposeEventLogStore();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it("sets needs-input on a running Session and carries source screen:<ruleId> in the event", () => {
    insert("t-1", "running");
    const before = lastEventId();
    nowMs += DIALOG_SETTLE_MS;
    expect(status.dialogOnScreen("t-1", hit)).toBe("wrote");
    expect(statusOf("t-1")).toBe("needs-input");
    expect(payloadsSince(before)).toEqual([
      { sessionId: "t-1", status: "needs-input", source: "screen:bash_permission_prompt" },
    ]);
  });

  it("sets it once: a second ask while it is already needs-input writes nothing", () => {
    insert("t-1", "running");
    status.dialogOnScreen("t-1", hit);
    const before = lastEventId();
    expect(status.dialogOnScreen("t-1", hit)).not.toBe("wrote");
    expect(payloadsSince(before)).toEqual([]);
  });

  it("goes back to running on the next output burst, and says where that came from", () => {
    insert("t-1", "running");
    status.dialogOnScreen("t-1", hit);
    const before = lastEventId();
    status.screenActivity("t-1", "redraw");
    expect(statusOf("t-1")).toBe("needs-input");
    status.screenActivity("t-1", "output");
    expect(statusOf("t-1")).toBe("running");
    expect(payloadsSince(before)).toEqual([{ sessionId: "t-1", status: "running", source: "screen:output" }]);
  });

  it("does not touch a needs-input a hook wrote when output arrives", () => {
    insert("t-1", "running");
    status.receiveHook("t-1", { hook_event_name: "PermissionRequest" } as HarnessHookBody);
    expect(statusOf("t-1")).toBe("needs-input");
    status.screenActivity("t-1", "output");
    expect(statusOf("t-1")).toBe("needs-input");
  });

  it("does not overwrite a status a hook wrote: not when it is not running", () => {
    insert("t-1", "running");
    status.receiveHook("t-1", { hook_event_name: "PermissionRequest" } as HarnessHookBody);
    const before = lastEventId();
    expect(status.dialogOnScreen("t-1", hit)).not.toBe("wrote");
    expect(payloadsSince(before)).toEqual([]);
  });

  it("does not overwrite a status a hook wrote: not when a hook arrived within the settle time", () => {
    insert("t-1", "ready");
    status.receiveHook("t-1", { hook_event_name: "UserPromptSubmit", prompt: "go" } as HarnessHookBody);
    expect(statusOf("t-1")).toBe("running");
    nowMs += DIALOG_SETTLE_MS - SECOND;
    expect(status.dialogOnScreen("t-1", hit)).toBe("hook-recent");
    expect(statusOf("t-1")).toBe("running");
    nowMs += 2 * SECOND;
    expect(status.dialogOnScreen("t-1", hit)).toBe("wrote");
    expect(statusOf("t-1")).toBe("needs-input");
  });

  it("keeps a screen-set needs-input the screen's to undo when a hook writes no status", () => {
    insert("t-1", "running");
    status.dialogOnScreen("t-1", hit);
    const ignored = status.receiveHook("t-1", { hook_event_name: "Notification", message: "idle" } as HarnessHookBody);
    expect(ignored.body.ignored ?? ignored.body.outcome).toBeTruthy();
    expect(statusOf("t-1")).toBe("needs-input");
    status.screenActivity("t-1", "output");
    expect(statusOf("t-1")).toBe("running");
  });

  it("does not undo a hook-owned needs-input on output, even after a screen rule had set one", () => {
    insert("t-1", "running");
    status.dialogOnScreen("t-1", hit);
    status.receiveHook("t-1", { hook_event_name: "PermissionRequest" } as HarnessHookBody);
    status.screenActivity("t-1", "output");
    expect(statusOf("t-1")).toBe("needs-input");
  });

  it("lets a work hook put a screen-set needs-input back to running", () => {
    insert("t-1", "running");
    status.dialogOnScreen("t-1", hit);
    status.receiveHook("t-1", { hook_event_name: "PostToolUse", tool_name: "Bash" } as HarnessHookBody);
    expect(statusOf("t-1")).toBe("running");
  });

  it("finishes a screen-set needs-input on Stop, as for any needs-input", () => {
    insert("t-1", "running");
    status.dialogOnScreen("t-1", hit);
    status.receiveHook("t-1", { hook_event_name: "Stop" } as HarnessHookBody);
    expect(statusOf("t-1")).toBe("finished");
  });

  it("never classifies a Session that is ready, finished or gone", () => {
    for (const state of ["ready", "finished", "interrupted", "terminated"]) {
      insert(`s-${state}`, state);
      expect(status.dialogOnScreen(`s-${state}`, hit), state).toBe("not-running");
      expect(statusOf(`s-${state}`)).toBe(state);
    }
    expect(status.dialogOnScreen("no-such-session", hit)).toBe("not-running");
  });

  it("is not settled by the quiet rule or the idle rule", () => {
    insert("t-1", "running");
    status.dialogOnScreen("t-1", hit);
    const backstop = new CoreSessionBackstop({
      listActiveSessions,
      writer,
      hasLivePty: () => true,
      now: () => nowMs,
    });
    // A dialog repainting statically for hours: the idle rule's shape, then the quiet rule's.
    for (let minute = 0; minute < 30; minute += 1) {
      nowMs += 60 * SECOND;
      backstop.noteActivity("t-1", "static");
      expect(backstop.sweepOnce()).toEqual([]);
    }
    nowMs += 60 * 60 * SECOND;
    expect(backstop.sweepOnce()).toEqual([]);
    expect(statusOf("t-1")).toBe("needs-input");
  });

  it("end to end: a hook 3 s before the check does not use up the stall", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      insert("t-1", "running");
      const watch = new DialogScreenWatch({
        harness: "claude-code",
        now: () => nowMs,
        onDialog: (found) => {
          const v = status.dialogOnScreen("t-1", found);
          return v === "hook-recent" || v === "not-running" ? "retry" : undefined;
        },
      });
      const advance = (ms: number) => {
        nowMs += ms;
        vi.advanceTimersByTime(ms);
      };
      watch.push(fixture("claude-code-synthetic-bash-permission.txt"), "output");
      advance(DIALOG_SETTLE_MS - 3 * SECOND);
      status.receiveHook("t-1", { hook_event_name: "PreToolUse", tool_name: "Bash" } as HarnessHookBody);
      advance(4 * SECOND);
      expect(statusOf("t-1")).toBe("running");
      advance(DIALOG_SETTLE_MS);
      expect(statusOf("t-1")).toBe("needs-input");
      watch.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("end to end: a running Session whose screen turns static on a dialog is needs-input once, then running on output", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      insert("t-1", "running");
      const before = lastEventId();
      const watch = new DialogScreenWatch({
        harness: "claude-code",
        now: () => nowMs,
        onDialog: (found) => {
          status.dialogOnScreen("t-1", found);
        },
      });
      const advance = (ms: number) => {
        nowMs += ms;
        vi.advanceTimersByTime(ms);
      };
      watch.push(fixture("claude-code-synthetic-bash-permission.txt"), "output");
      advance(DIALOG_SETTLE_MS - SECOND);
      expect(statusOf("t-1")).toBe("running");
      advance(2 * SECOND);
      expect(statusOf("t-1")).toBe("needs-input");
      advance(10 * DIALOG_SETTLE_MS);

      status.screenActivity("t-1", "output");
      expect(statusOf("t-1")).toBe("running");
      expect(payloadsSince(before)).toEqual([
        { sessionId: "t-1", status: "needs-input", source: "screen:bash_permission_prompt" },
        { sessionId: "t-1", status: "running", source: "screen:output" },
      ]);
      watch.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
