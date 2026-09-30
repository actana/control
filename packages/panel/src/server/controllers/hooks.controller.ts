import { z } from "zod";
import {
  handleHarnessHookEvent,
  hookResultResponse,
  type HarnessHookBody,
} from "@actana/shared/harness-hook-pipeline";
import type { HarnessQuestion } from "@actana/shared/harness-questions";
import { getSession, updateStatus, updateSession } from "../services/sessions";
import { setPendingQuestion } from "../services/pending-questions";
import { setTranscriptPath } from "../services/session-transcripts";
import { generateTitleForSession, isTitleGenerationPrompt } from "../services/title-generator";
import { rethrowUnlessDomain, json, jsonError, parseJsonBody } from "./_helpers";
import { HTTP_BAD_REQUEST, HTTP_NOT_FOUND } from "~/shared/http-status";

const hookPayload = z
  .object({
    hook_event_name: z.string(),
    prompt: z.string(),
    notification_type: z.string(),
    message: z.string(),
    title: z.string(),
    session_id: z.string(),
    conversation_id: z.string(),
    tool_name: z.string(),
    tool_use_id: z.string(),
    // SubagentStart/SubagentStop: unique id of the subagent instance, used to
    // pair a stop with its start when counting still-active subagents.
    agent_id: z.string(),
    tool_input: z.unknown(),
    // PostToolUse carries the tool's result.
    tool_response: z.unknown(),
    // SessionStart's trigger: "startup" | "resume" | "clear" | "compact".
    source: z.string(),
    // Absolute path to the session's JSONL transcript (Claude Code). Stashed per
    // session so auto-distill can read the full session, not just the prompts.
    transcript_path: z.string(),
    // Stop / SubagentStop carry the turn's final assistant text directly.
    last_assistant_message: z.string(),
    // Synthetic MissionControlSessionEnded (the Core's pty-manager): the PTY
    // process's exit code, used to pick finished vs terminated.
    exit_code: z.number(),
  })
  .partial();

/**
 * The Panel's hook endpoint, for the Panel's own session rows.
 *
 * The decisions all live in `@actana/shared/harness-hook-pipeline` — the same
 * state machine the Core runs for the Sessions it owns (issue 84) — so this is
 * an adapter: it reads the request, supplies the Panel's writes, and formats
 * the answer. A Core-owned Session never reaches here; its hooks post to its
 * own Core's receiver, which has the row.
 */
export async function receive(url: URL, request: Request): Promise<Response> {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return jsonError(HTTP_BAD_REQUEST, "sessionId required");

  const parsed = await parseJsonBody(request, hookPayload);
  if (!parsed.ok) return parsed.response;
  const payload: HarnessHookBody = parsed.data;

  try {
    const result = handleHarnessHookEvent(
      sessionId,
      payload,
      {
        getSession: (id) => {
          const session = getSession(id);
          if (!session) return null;
          return { status: session.status, claudeSessionId: session.claudeSessionId };
        },
        updateStatus: (id, status) => Boolean(updateStatus(id, { status })),
        setSessionId: (id, harnessSessionId) => {
          updateSession(id, { claudeSessionId: harnessSessionId });
        },
        onTranscriptPath: setTranscriptPath,
        onQuestion: (id, toolUseId, questions) => {
          const session = getSession(id);
          if (!session) return;
          setPendingQuestion({
            sessionId: id,
            projectId: session.projectId,
            questions: questions as HarnessQuestion[],
            id: toolUseId,
          });
        },
        onPrompt: (id, prompt) => {
          // Never treat our own headless title-generation helper as a user
          // prompt. If one ever fires these hooks (e.g. it inherited the
          // session hook env), re-running title generation is the feedback
          // loop that would loop forever — ignore it outright.
          if (isTitleGenerationPrompt(prompt)) return;
          void generateTitleForSession(id, prompt).catch(() => undefined);
        },
      },
      url.searchParams.get("hookEvent") ?? "",
    );

    // One mapping, shared with the Core's receiver, so the same event never
    // gets two different answers depending on which host owns the row.
    const answer = hookResultResponse(result);
    return answer.ok ? json(answer.body) : jsonError(HTTP_NOT_FOUND, "session not found");
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}
