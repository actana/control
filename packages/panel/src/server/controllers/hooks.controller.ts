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
import type { SessionStatus } from "@actana/shared/domain";

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
    agent_id: z.string(),
    tool_input: z.unknown(),
    tool_response: z.unknown(),
    source: z.string(),
    transcript_path: z.string(),
    last_assistant_message: z.string(),
    exit_code: z.number(),
  })
  .partial();

/**
 * The Panel's hook endpoint, for the Panel's own session rows.
 *
 * The shared pipeline is still synchronous (the Core's SQLite ports are);
 * this adapter keeps a per-request cache and flushes Postgres writes before
 * answering (#567 PR 5).
 */
export async function receive(url: URL, request: Request): Promise<Response> {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return jsonError(HTTP_BAD_REQUEST, "sessionId required");

  const parsed = await parseJsonBody(request, hookPayload);
  if (!parsed.ok) return parsed.response;
  const payload: HarnessHookBody = parsed.data;

  try {
    const initial = await getSession(sessionId);
    let cached = initial
      ? { status: initial.status, claudeSessionId: initial.claudeSessionId }
      : null;
    const pending: Promise<unknown>[] = [];

    const result = handleHarnessHookEvent(
      sessionId,
      payload,
      {
        getSession: (id) => (id === sessionId ? cached : null),
        updateStatus: (id, status: SessionStatus) => {
          if (id !== sessionId || !cached) return false;
          cached = { ...cached, status };
          pending.push(updateStatus(id, { status }));
          return true;
        },
        setSessionId: (id, harnessSessionId) => {
          if (cached && id === sessionId) {
            cached = { ...cached, claudeSessionId: harnessSessionId };
          }
          pending.push(updateSession(id, { claudeSessionId: harnessSessionId }));
        },
        onTranscriptPath: setTranscriptPath,
        onQuestion: (id, toolUseId, questions) => {
          if (!cached || id !== sessionId) return;
          setPendingQuestion({
            sessionId: id,
            questions: questions as HarnessQuestion[],
            id: toolUseId,
          });
        },
        onPrompt: (id, prompt) => {
          if (isTitleGenerationPrompt(prompt)) return;
          void generateTitleForSession(id, prompt).catch(() => undefined);
        },
      },
      url.searchParams.get("hookEvent") ?? "",
    );

    await Promise.all(pending);

    const answer = hookResultResponse(result);
    if (!answer.ok) return jsonError(HTTP_NOT_FOUND, "session not found");
    return json(answer.body);
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}
