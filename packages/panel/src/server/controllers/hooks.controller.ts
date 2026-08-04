import { z } from "zod";
import { HARNESS_HOOK_EVENTS, mapHookEventToStatus } from "~/shared/harness-hook-events";
import { ASK_USER_QUESTION_TOOL, parseAskUserQuestionInput } from "~/shared/harness-questions";
import { getTask, updateStatus, updateTask } from "../services/tasks";
import {
  armDeferredFinish,
  clearSubagentActivity,
  clearTaskFinished,
  disarmDeferredFinish,
  hasActiveSubagents,
  noteSubagentStart,
  noteSubagentStop,
  noteTaskFinished,
  taskFinishedRecently,
} from "../services/subagent-activity";
import { setPendingQuestion } from "../services/pending-questions";
import { setTranscriptPath } from "../services/session-transcripts";
import { getBooleanSetting } from "../services/settings";
import { events } from "../events";
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

function hookSessionId(payload: z.infer<typeof hookPayload>): string {
  if (typeof payload.session_id === "string" && payload.session_id.trim()) {
    return payload.session_id.trim();
  }
  if (typeof payload.conversation_id === "string" && payload.conversation_id.trim()) {
    return payload.conversation_id.trim();
  }
  return "";
}

function isSessionCaptureEvent(event: string): boolean {
  return (
    event === HARNESS_HOOK_EVENTS.userPromptSubmit ||
    event === HARNESS_HOOK_EVENTS.cursorBeforeSubmitPrompt ||
    event === HARNESS_HOOK_EVENTS.sessionStart ||
    event === HARNESS_HOOK_EVENTS.cursorSessionStart
  );
}

function isSubagentLifecycleEvent(event: string): boolean {
  return (
    event === HARNESS_HOOK_EVENTS.subagentStart ||
    event === HARNESS_HOOK_EVENTS.subagentStop
  );
}

// Deferred-finish backstop callback: fires when a held or healed "running"
// drained its subagents and no main-agent Stop landed within the grace.
// Guarded so it can't stomp a state the user or a later event moved the task
// into.
function finishQuietTask(taskId: string): void {
  const task = getTask(taskId);
  if (task?.status === "running") {
    updateStatus(taskId, { status: "finished" });
    noteTaskFinished(taskId);
  }
}

async function reconcileSessionId(
  task: { claudeSessionId: string | null },
  taskId: string,
  incomingSessionId: string,
  event: string,
  updateSessionId: (taskId: string, sessionId: string) => void | Promise<void>,
): Promise<"ok" | "foreign-session"> {
  if (!incomingSessionId) return "ok";

  if (!task.claudeSessionId) {
    if (isSessionCaptureEvent(event)) {
      await updateSessionId(taskId, incomingSessionId);
    }
    return "ok";
  }

  if (incomingSessionId === task.claudeSessionId) return "ok";

  if (isSessionCaptureEvent(event)) {
    await updateSessionId(taskId, incomingSessionId);
    return "ok";
  }

  return "foreign-session";
}

export async function receive(url: URL, request: Request): Promise<Response> {
  const taskId = url.searchParams.get("taskId");
  if (!taskId) return jsonError(HTTP_BAD_REQUEST, "taskId required");

  const parsed = await parseJsonBody(request, hookPayload);
  if (!parsed.ok) return parsed.response;
  const payload = parsed.data;

  const event = payload.hook_event_name || url.searchParams.get("hookEvent") || "";
  let status = mapHookEventToStatus({ ...payload, hook_event_name: event });
  const incomingSessionId = hookSessionId(payload);

  const task = getTask(taskId);
  if (!task) return jsonError(HTTP_NOT_FOUND, "task not found");

  // Stash the transcript path (present on most Claude hooks incl. Stop) so the
  // auto-distill pass can read the full session. Latest wins; stable per
  // session. Subagent lifecycle hooks are excluded: they carry the SUBAGENT's
  // own transcript path, which would point auto-distill at a child transcript.
  if (
    !isSubagentLifecycleEvent(event) &&
    typeof payload.transcript_path === "string" &&
    payload.transcript_path.trim()
  ) {
    setTranscriptPath(taskId, payload.transcript_path.trim());
  }

  if (event === HARNESS_HOOK_EVENTS.sessionStart) {
    // /clear kills background subagents but keeps the session id, so the
    // session-id-change clear below never fires for it.
    if (payload.source === "clear") {
      clearSubagentActivity(taskId);
    }
  }

  const sessionResult = await reconcileSessionId(
    task,
    taskId,
    incomingSessionId,
    event,
    (id, sessionId) => {
      updateTask(id, { claudeSessionId: sessionId });
      // A new session id means a new Claude process; the old session's
      // subagents died with it, so they must not hold this task on "running".
      clearSubagentActivity(id);
    },
  );
  if (sessionResult === "foreign-session") {
    return json({ ok: true, ignored: "foreign-session" });
  }

  // Sub-agent lifecycle bookkeeping. Claude fires the top-level Stop when the
  // FOREGROUND turn ends — background subagents keep running, then their
  // completion re-invokes the main agent, whose own Stop follows. Track which
  // subagents are active so the Stop mapping below can hold the session on
  // "running" until the last one is done. These events carry no status, but a
  // subagent event arriving MOMENTS after a task finished means the Stop won
  // the race against the turn's own subagent lifecycle POST — work is still
  // happening, so heal to running, and arm the drain backstop in case no
  // further Stop follows.
  //
  // Beyond that window, a subagent event on a finished task is one of Claude
  // Code's post-turn internal helpers (away-summary generation fires
  // SubagentStart/Stop when the user refocuses a finished session, with no
  // Stop after). Healing on those wedges tasks on "running" forever; ignore
  // them for status, and don't record their starts either — a lost helper
  // SubagentStop would otherwise hold the NEXT turn's Stop for the whole TTL.
  if (isSubagentLifecycleEvent(event)) {
    const staleFinished = task.status === "finished" && !taskFinishedRecently(taskId);
    if (event === HARNESS_HOOK_EVENTS.subagentStart) {
      if (!staleFinished) noteSubagentStart(taskId, payload.agent_id);
    } else {
      noteSubagentStop(taskId, payload.agent_id);
    }
    if (task.status === "finished" && !staleFinished) {
      updateStatus(taskId, { status: "running" });
      armDeferredFinish(taskId, finishQuietTask);
    }
    return json({ ok: true, event });
  }

  // Synthetic PTY-exit event (the Core's pty-manager): the session process is
  // gone, so a task still showing active work is wrong — settle it by exit
  // code. Tasks already in a settled state (finished, interrupted, ...) keep
  // it: the exit of an idle session isn't news. Dead process ⇒ its subagents
  // died with it.
  if (event === HARNESS_HOOK_EVENTS.sessionProcessExited) {
    clearSubagentActivity(taskId);
    // No re-invocation can follow a dead process: laggard subagent POSTs
    // still in flight must be ignored as stale, never heal to "running".
    clearTaskFinished(taskId);
    if (task.status === "running" || task.status === "needs-input") {
      updateStatus(taskId, {
        status: payload.exit_code === 0 ? "finished" : "terminated",
      });
    }
    return json({ ok: true, event });
  }
  if (event === HARNESS_HOOK_EVENTS.userPromptSubmit) {
    // A new user turn supersedes any held Stop; the next Stop re-evaluates.
    disarmDeferredFinish(taskId);
  }
  if (status === "finished" && hasActiveSubagents(taskId)) {
    // Only the foreground turn ended; subagents are still working. The real
    // finish — with the ding — lands on the next Stop that arrives with no
    // active subagents left. The armed backstop only fires if the remaining
    // subagents EXPIRE (their SubagentStop never arrived), so a lost POST
    // can't wedge the task on "running" forever.
    status = "running";
    armDeferredFinish(taskId, finishQuietTask);
  }

  // Store the question before updateStatus so the overlay data is already in
  // place when the task:updated event triggers renderer refetches. Malformed
  // tool_input is fail-soft: status still flips, just no native overlay.
  if (
    event === HARNESS_HOOK_EVENTS.preToolUse &&
    payload.tool_name === ASK_USER_QUESTION_TOOL
  ) {
    const questions = parseAskUserQuestionInput(payload.tool_input);
    if (questions) {
      setPendingQuestion({
        taskId,
        projectId: task.projectId,
        questions,
        id: payload.tool_use_id,
      });
    }
  }

  // The AskUserQuestion-matched PostToolUse is the AskUserQuestion status
  // signal, handled below; every other PostToolUse only exists to heal a
  // stale needs-input state — a tool just ran, so the agent is provably
  // working. updateStatus clears any stale pending question, so the native
  // overlay stands down.
  if (
    event === HARNESS_HOOK_EVENTS.postToolUse &&
    payload.tool_name !== ASK_USER_QUESTION_TOOL
  ) {
    if (task.status === "needs-input") {
      updateStatus(taskId, { status: "running" });
    }
    return json({ ok: true, event });
  }

  if (!status) {
    return json({ ok: true, ignored: event });
  }

  try {
    const t = updateStatus(taskId, { status });
    if (!t) return jsonError(HTTP_NOT_FOUND, "task not found");
    // Timestamp real finishes so the subagent branch above can tell a raced
    // lifecycle POST (heal) from a post-turn helper event (ignore).
    if (status === "finished") noteTaskFinished(taskId);
    if (
      isSessionCaptureEvent(event) &&
      typeof payload.prompt === "string" &&
      payload.prompt.trim() &&
      // Never treat our own headless title-generation helper as a user prompt.
      // If one ever fires these hooks (e.g. it inherited the session hook env),
      // re-running title generation is the feedback loop that would loop
      // forever — ignore it outright.
      !isTitleGenerationPrompt(payload.prompt)
    ) {
      void generateTitleForTask(taskId, payload.prompt).catch(() => undefined);
    }

    return json({ ok: true, status });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

