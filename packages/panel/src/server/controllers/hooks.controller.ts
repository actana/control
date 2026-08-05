import { z } from "zod";
import {
  handleHarnessHookEvent,
  type HarnessHookBody,
} from "@actana/shared/harness-hook-pipeline";
import type { HarnessQuestion } from "@actana/shared/harness-questions";
import { getTask, updateStatus, updateTask } from "../services/tasks";
import { setPendingQuestion } from "../services/pending-questions";
import { setTranscriptPath } from "../services/session-transcripts";
import { generateTitleForTask, isTitleGenerationPrompt } from "../services/title-generator";
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
    // task so auto-distill can read the full session, not just the prompts.
    transcript_path: z.string(),
    // Stop / SubagentStop carry the turn's final assistant text directly.
    last_assistant_message: z.string(),
    // Synthetic MissionControlSessionEnded (the Core's pty-manager): the PTY
    // process's exit code, used to pick finished vs terminated.
    exit_code: z.number(),
  })
  .partial();

/**
 * The Panel's hook endpoint, for the Panel's own task rows.
 *
 * The decisions all live in `@actana/shared/harness-hook-pipeline` — the same
 * state machine the Core runs for the Sessions it owns (issue 84) — so this is
 * an adapter: it reads the request, supplies the Panel's writes, and formats
 * the answer. A Core-owned Session never reaches here; its hooks post to its
 * own Core's receiver, which has the row.
 */
export async function receive(url: URL, request: Request): Promise<Response> {
  const taskId = url.searchParams.get("taskId");
  if (!taskId) return jsonError(HTTP_BAD_REQUEST, "taskId required");

  const parsed = await parseJsonBody(request, hookPayload);
  if (!parsed.ok) return parsed.response;
  const payload: HarnessHookBody = parsed.data;

  try {
    const result = handleHarnessHookEvent(
      taskId,
      payload,
      {
        getTask: (id) => {
          const task = getTask(id);
          if (!task) return null;
          return { status: task.status, claudeSessionId: task.claudeSessionId };
        },
        updateStatus: (id, status) => Boolean(updateStatus(id, { status })),
        setSessionId: (id, sessionId) => {
          updateTask(id, { claudeSessionId: sessionId });
        },
        onTranscriptPath: setTranscriptPath,
        onQuestion: (id, toolUseId, questions) => {
          const task = getTask(id);
          if (!task) return;
          setPendingQuestion({
            taskId: id,
            projectId: task.projectId,
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
          void generateTitleForTask(id, prompt).catch(() => undefined);
        },
      },
      url.searchParams.get("hookEvent") ?? "",
    );

    switch (result.outcome) {
      case "task-not-found":
        return jsonError(HTTP_NOT_FOUND, "task not found");
      case "foreign-session":
        return json({ ok: true, ignored: "foreign-session" });
      case "ignored":
        return json({ ok: true, ignored: result.event });
      case "ok":
        return result.status
          ? json({ ok: true, status: result.status })
          : json({ ok: true, event: result.event });
    }
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}
