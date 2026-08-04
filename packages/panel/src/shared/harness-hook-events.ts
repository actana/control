import type { TaskStatus } from "@actana/shared/domain";
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

export type HarnessHookPayload = {
  hook_event_name?: string;
  notification_type?: string;
  message?: string;
  title?: string;
  tool_name?: string;
};

export function mapHookEventToStatus(payload: HarnessHookPayload): TaskStatus | null {
  switch (payload.hook_event_name || "") {
    case HARNESS_HOOK_EVENTS.userPromptSubmit:
    case HARNESS_HOOK_EVENTS.cursorBeforeSubmitPrompt:
      return "running";
    case HARNESS_HOOK_EVENTS.stop:
    case HARNESS_HOOK_EVENTS.cursorStop:
    case HARNESS_HOOK_EVENTS.cursorAfterAgentResponse:
      return "finished";
    case HARNESS_HOOK_EVENTS.userInterrupt:
      return "interrupted";
    case HARNESS_HOOK_EVENTS.permissionRequest:
    case HARNESS_HOOK_EVENTS.questionRequest:
      return "needs-input";
    case HARNESS_HOOK_EVENTS.notification:
      return isPermissionNotification(payload) ? "needs-input" : null;
    // Matchers restrict these hooks to AskUserQuestion already; the tool_name
    // guard keeps the mapping precise if a user points their own broader
    // PreToolUse/PostToolUse hooks at Mission Control.
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
    // (only tasks still in an active status move to terminated/finished).
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
