import { z } from "zod";
import {
  handleHarnessHookEvent,
  hookResultResponse,
  type HarnessHookBody,
} from "@actana/shared/harness-hook-pipeline";
import type { HarnessQuestion } from "@actana/shared/harness-questions";
import { getSession, updateStatus, updateSession } from "../services/sessions";
import { noteSessionFinished } from "../services/subagent-activity";
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
 *
 * The shared pipeline is still synchronous (the Core's SQLite ports are);
 * this adapter keeps a per-request cache and flushes Postgres writes before
 * answering (#567 PR 5). The deferred-finish backstop outlives the request, so
 * it uses {@link finishQuietlyFromDb} instead of the request snapshot.
 */
export async function receive(url: URL, request: Request): Promise<Response> {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return jsonError(HTTP_BAD_REQUEST, "sessionId required");

  const parsed = await parseJsonBody(request, hookPayload);
  if (!parsed.ok) return parsed.response;
  const payload: HarnessHookBody = parsed.data;

  const pending: Promise<unknown>[] = [];
  try {
    const initial = await getSession(sessionId);
    let cached = initial
      ? { status: initial.status, claudeSessionId: initial.claudeSessionId }
      : null;

    let result;
    try {
      result = handleHarnessHookEvent(
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
            // Never treat our own headless title-generation helper as a user
            // prompt. If one ever fires these hooks (e.g. it inherited the
            // session hook env), re-running title generation is the feedback
            // loop that would loop forever — ignore it outright.
            if (isTitleGenerationPrompt(prompt)) return;
            void generateTitleForSession(id, prompt).catch(() => undefined);
          },
          finishQuietly: finishQuietlyFromDb,
        },
        url.searchParams.get("hookEvent") ?? "",
      );
    } finally {
      // Flush every write the pipeline pushed, even when it threw mid-request.
      await Promise.all(pending);
    }

    const answer = hookResultResponse(result);
    if (!answer.ok) return jsonError(HTTP_NOT_FOUND, "session not found");
    return json(answer.body);
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

/**
 * Deferred-finish path for ports that outlive the HTTP request: re-read the
 * row from Postgres (not the request snapshot), await the write, and swallow
 * a rejection so a timer callback cannot become an unhandled rejection.
 */
function finishQuietlyFromDb(sessionId: string): void {
  void (async () => {
    const session = await getSession(sessionId);
    if (session?.status !== "running") return;
    await updateStatus(sessionId, { status: "finished" });
    noteSessionFinished(sessionId);
  })().catch(() => undefined);
}
