import type { SessionStatus } from "@actana/shared/domain";
import { ASK_USER_QUESTION_TOOL } from "./harness-questions";

export const HARNESS_HOOK_EVENTS = {
  userPromptSubmit: "UserPromptSubmit",
  stop: "Stop",
  subagentStart: "SubagentStart",
  subagentStop: "SubagentStop",
  userInterrupt: "UserInterrupt",
  // Synthetic (posted by the Core's pty-manager, not the agent): the session's
  // PTY process exited. Named to never collide with Claude Code's real
  // SessionEnd hook, which also fires on /clear while the process lives on.
  sessionProcessExited: "MissionControlSessionEnded",
  permissionRequest: "PermissionRequest",
  // The operator answered a permission prompt and the turn carries on.
  // OpenCode reports this from `permission.replied`; Pi reports it from
  // `ui_prompt_end`. Claude Code fires nothing at all when a permission is
  // GRANTED and has to be healed by the next `PostToolUse` instead.
  permissionReplied: "PermissionReplied",
  questionRequest: "QuestionRequest",
  notification: "Notification",
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  permissionPrompt: "permission_prompt",
  sessionStart: "SessionStart",
  cursorSessionStart: "sessionStart",
  cursorBeforeSubmitPrompt: "beforeSubmitPrompt",
  cursorStop: "stop",
  cursorAfterAgentResponse: "afterAgentResponse",
} as const;

/** The `status` Cursor's `stop` hook carries when the operator cancelled the turn. */
export const CURSOR_STOP_ABORTED = "aborted";

export type HarnessHookPayload = {
  hook_event_name?: string;
  notification_type?: string;
  message?: string;
  title?: string;
  tool_name?: string;
  /**
   * Cursor's `stop` hook: how the turn ended — `"completed"`, `"aborted"` (the
   * operator pressed Esc) or `"error"`. cursor-agent 2026.10.01-e373342 builds
   * the payload in its turn runner (`dist-package/7000.index.js`) and the
   * abort callback is the only place that writes `"aborted"` (issue 392).
   */
  status?: string;
};

export function mapHookEventToStatus(payload: HarnessHookPayload): SessionStatus | null {
  switch (payload.hook_event_name || "") {
    // `permissionReplied` is here because an answered permission is the turn
    // resuming. If the answer was a denial the harness ends the turn instead,
    // and the settle that follows is what moves the card — this event never
    // has the last word.
    case HARNESS_HOOK_EVENTS.userPromptSubmit:
    case HARNESS_HOOK_EVENTS.cursorBeforeSubmitPrompt:
    case HARNESS_HOOK_EVENTS.permissionReplied:
      return "running";
    case HARNESS_HOOK_EVENTS.stop:
    case HARNESS_HOOK_EVENTS.cursorAfterAgentResponse:
      return "finished";
    // Cursor's `stop` fires on a cancelled turn too, and says so: the operator's
    // Esc posts `status: "aborted"`. That is the harness reporting the abort
    // itself, so it maps to `interrupted` rather than to a finish that would
    // raise `session:finished` for work the operator cancelled (issue 392).
    // Any other status — `completed`, `error`, or none from an older build —
    // keeps the finish. The pipeline holds the abort against the rest of the
    // same generation's turn tail (`harness-hook-pipeline.ts`).
    case HARNESS_HOOK_EVENTS.cursorStop:
      return payload.status === CURSOR_STOP_ABORTED ? "interrupted" : "finished";
    case HARNESS_HOOK_EVENTS.userInterrupt:
      return "interrupted";
    case HARNESS_HOOK_EVENTS.permissionRequest:
    case HARNESS_HOOK_EVENTS.questionRequest:
      return "needs-input";
    case HARNESS_HOOK_EVENTS.notification:
      return isPermissionNotification(payload) ? "needs-input" : null;
    // `PreToolUse` is installed with an `AskUserQuestion` matcher, so the
    // guard here is belt-and-braces for an operator's own broader hook.
    // `PostToolUse` is installed UNMATCHED on purpose (see CLAUDE_HOOK_EVENTS
    // in the Core's harness-hooks.ts): every tool call arrives, and the ones
    // that are not AskUserQuestion are what heal a stale `needs-input` —
    // handled in the pipeline, which is why they map to no status here.
    case HARNESS_HOOK_EVENTS.preToolUse:
      return payload.tool_name === ASK_USER_QUESTION_TOOL ? "needs-input" : null;
    case HARNESS_HOOK_EVENTS.postToolUse:
      return payload.tool_name === ASK_USER_QUESTION_TOOL ? "running" : null;
    // Subagent lifecycle events carry no status of their own — the hooks
    // controller counts them to decide whether a Stop really ends the session
    // (background subagents outlive the foreground turn's Stop).
    case HARNESS_HOOK_EVENTS.subagentStart:
    case HARNESS_HOOK_EVENTS.subagentStop:
      return null;
    // Synthetic PTY-exit event: the hooks controller maps it conditionally
    // (only sessions still in an active status move to terminated/finished).
    case HARNESS_HOOK_EVENTS.sessionProcessExited:
      return null;
    default:
      return null;
  }
}

function isPermissionNotification(payload: HarnessHookPayload): boolean {
  if (payload.notification_type) {
    return payload.notification_type === HARNESS_HOOK_EVENTS.permissionPrompt;
  }
  const text = `${payload.title ?? ""} ${payload.message ?? ""}`.toLowerCase();
  return text.includes("permission");
}
