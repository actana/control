import { HARNESS_HOOK_EVENTS } from "./harness-hook-events";
import type { HarnessHookBody } from "./harness-hook-pipeline";
import { ASK_USER_QUESTION_TOOL, parseAskUserQuestionInput } from "./harness-questions";

// What the hook that set `needs-input` says about the dialog (#959, source 1 of `kind` and `options`).
// `PermissionRequest` gives a permission and the tool's name when the harness names it. `AskUserQuestion` gives its parsed
// question and options (`parseAskUserQuestionInput`). OpenCode's `permission.asked` and Pi's `ui_prompt_start` post no
// detail, so they give the kind alone.

/** The Core appends this event, with this payload, just before a hook writes `needs-input`. */
export const SESSION_PROMPT_EVENT_KIND = "session:prompt";

export type HookPrompt = {
  kind: "question" | "choice" | "permission";
  /** The tool a permission is asked for. */
  tool?: string;
  /** The question, from `AskUserQuestion`. */
  text?: string;
  options?: { label: string }[];
};

export type SessionPromptPayload = HookPrompt & { sessionId: string };

/** The dialog a hook announces, or null for a hook that does not set `needs-input`. */
export function hookPromptOf(payload: HarnessHookBody): HookPrompt | null {
  const event = payload.hook_event_name ?? "";
  if (event === HARNESS_HOOK_EVENTS.permissionRequest) return { kind: "permission", ...(payload.tool_name ? { tool: payload.tool_name } : {}) };
  if (event === HARNESS_HOOK_EVENTS.notification) {
    return payload.notification_type === HARNESS_HOOK_EVENTS.permissionPrompt ? { kind: "permission" } : null;
  }
  if (event === HARNESS_HOOK_EVENTS.questionRequest) return { kind: "question" };
  if (event === HARNESS_HOOK_EVENTS.preToolUse && payload.tool_name === ASK_USER_QUESTION_TOOL) {
    const first = parseAskUserQuestionInput(payload.tool_input)?.[0];
    if (!first) return { kind: "question" };
    const options = first.options.map((o) => ({ label: o.label }));
    return options.length > 0 ? { kind: "choice", text: first.question, options } : { kind: "question", text: first.question };
  }
  return null;
}
