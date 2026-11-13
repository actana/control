import { describe, expect, it } from "vitest";
import { hookPromptOf } from "../harness-hook-prompt";

// #959 source 1: what the hook that set `needs-input` says about the dialog.
describe("hookPromptOf", () => {
  it("PermissionRequest is a permission, with the tool when it names one", () => {
    expect(hookPromptOf({ hook_event_name: "PermissionRequest", tool_name: "Bash" })).toEqual({ kind: "permission", tool: "Bash" });
    expect(hookPromptOf({ hook_event_name: "PermissionRequest" })).toEqual({ kind: "permission" });
  });

  it("a permission Notification is a permission", () => {
    expect(hookPromptOf({ hook_event_name: "Notification", notification_type: "permission_prompt" })).toEqual({ kind: "permission" });
  });

  it("AskUserQuestion is a choice with its parsed options (the first question: the dialog shows one at a time)", () => {
    const tool_input = {
      questions: [
        { question: "Which database?", header: "DB", multiSelect: false, options: [{ label: "Postgres", description: "pg" }, { label: "SQLite" }] },
        { question: "Which cache?", multiSelect: false, options: [{ label: "none" }, { label: "redis" }] },
      ],
    };
    expect(hookPromptOf({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input })).toEqual({
      kind: "choice",
      text: "Which database?",
      options: [{ label: "Postgres" }, { label: "SQLite" }],
    });
  });

  it("an AskUserQuestion with no question the parser keeps is a question, no text", () => {
    const tool_input = { questions: [{ question: "What name?", multiSelect: false, options: [] }] };
    expect(hookPromptOf({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input })).toEqual({ kind: "question" });
  });

  it("QuestionRequest (Pi's extension dialog) is a question; a malformed AskUserQuestion still gives the kind", () => {
    expect(hookPromptOf({ hook_event_name: "QuestionRequest" })).toEqual({ kind: "question" });
    expect(hookPromptOf({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: "garbage" })).toEqual({ kind: "question" });
  });

  it("a hook that does not set needs-input says nothing", () => {
    expect(hookPromptOf({ hook_event_name: "Stop" })).toBeNull();
    expect(hookPromptOf({ hook_event_name: "PreToolUse", tool_name: "Bash" })).toBeNull();
    expect(hookPromptOf({ hook_event_name: "Notification", notification_type: "idle_prompt" })).toBeNull();
  });
});
