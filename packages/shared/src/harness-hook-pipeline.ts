// One harness-hook state machine, two hosts.
//
// A hook fired by a harness says what just happened — a prompt was submitted, a
// turn ended, a permission was asked for, a subagent started. Turning that into
// the Session's status is not a table lookup: a `Stop` while background
// subagents are still working is not a finish, a subagent event moments after a
// finish is a raced POST rather than resumed work, and a `Notification` is only
// `needs-input` when it is a permission prompt. Those rules were tuned against
// real failure modes (see `docs/harness-status-detection.md`).
//
// Until issue 84 they lived in the Panel's hook controller, which is where a
// Core-owned Session's hooks never arrive — the Core spawns the harness, so the
// Core is what a hook on that machine can reach. Rather than grow a second copy
// of the tuned machine on the Core and watch the two drift, the decisions live
// here and each host supplies its own writes through {@link HookPipelinePorts}.
//
// The subagent bookkeeping this reads is module state in
// `subagent-activity.ts` — per process, so a Panel and a Core each track their
// own Sessions and neither can see the other's.

import { HARNESS_HOOK_EVENTS, mapHookEventToStatus } from "./harness-hook-events";
import { ASK_USER_QUESTION_TOOL, parseAskUserQuestionInput } from "./harness-questions";
import {
  armDeferredFinish,
  clearSubagentActivity,
  clearTaskFinished,
  disarmDeferredFinish,
  hasActiveSubagents,
  noteSubagentStart,
  noteSubagentStop,
  noteTaskFinished,
  taskFinishedWithinRaceWindow,
} from "./subagent-activity";
import type { TaskStatus } from "./domain";

/**
 * The hook body a harness pipes on stdin, as far as this pipeline reads it.
 * Every field is optional: the shape differs per harness and per event, and a
 * payload is agent-produced input arriving over an authenticated-yet-open local
 * endpoint, so nothing here may assume a field is present or well-typed.
 */
export type HarnessHookBody = {
  hook_event_name?: string;
  prompt?: string;
  notification_type?: string;
  message?: string;
  title?: string;
  session_id?: string;
  conversation_id?: string;
  tool_name?: string;
  tool_use_id?: string;
  /** SubagentStart/SubagentStop: the subagent instance, for pairing a stop with its start. */
  agent_id?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  /** SessionStart's trigger: "startup" | "resume" | "clear" | "compact". */
  source?: string;
  /** Absolute path to the session's JSONL transcript (Claude Code). */
  transcript_path?: string;
  last_assistant_message?: string;
  /** Synthetic session-exited event: the PTY process's exit code. */
  exit_code?: number;
};

/** What the pipeline needs to know about a task before it decides anything. */
export type HookTaskFacts = {
  status: string;
  /** The harness session id already captured for this task, or `null`. */
  claudeSessionId: string | null;
};

/**
 * The host's writes. `getTask` and `updateStatus` are required — without them
 * there is no row to move. The rest are the side effects one host has and the
 * other does not, so each is optional and skipped when absent.
 */
export type HookPipelinePorts = {
  getTask(taskId: string): HookTaskFacts | null;
  /** Write the task's status. `false` means the row went away mid-flight. */
  updateStatus(taskId: string, status: TaskStatus): boolean;
  /** Persist a newly observed harness session id for this task. */
  setSessionId(taskId: string, sessionId: string): void;
  /** Stash the session's transcript path (Panel-side auto-distill reads it). */
  onTranscriptPath?(taskId: string, transcriptPath: string): void;
  /** An AskUserQuestion menu is open; the host may raise its own overlay. */
  onQuestion?(taskId: string, toolUseId: string | undefined, questions: unknown): void;
  /** A user prompt was submitted — the trigger for naming an unnamed Session. */
  onPrompt?(taskId: string, prompt: string): void;
};

export type HookPipelineResult =
  | { outcome: "ok"; event: string; status?: TaskStatus }
  | { outcome: "ignored"; event: string }
  | { outcome: "foreign-session"; event: string }
  | { outcome: "task-not-found"; event: string };

function hookSessionId(payload: HarnessHookBody): string {
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
    event === HARNESS_HOOK_EVENTS.subagentStart || event === HARNESS_HOOK_EVENTS.subagentStop
  );
}

function reconcileSessionId(
  task: HookTaskFacts,
  taskId: string,
  incomingSessionId: string,
  event: string,
  ports: HookPipelinePorts,
): "ok" | "foreign-session" {
  if (!incomingSessionId) return "ok";
  if (!task.claudeSessionId) {
    if (isSessionCaptureEvent(event)) ports.setSessionId(taskId, incomingSessionId);
    return "ok";
  }
  if (incomingSessionId === task.claudeSessionId) return "ok";
  if (isSessionCaptureEvent(event)) {
    ports.setSessionId(taskId, incomingSessionId);
    return "ok";
  }
  return "foreign-session";
}

/**
 * Apply one hook event to one task. Every early return is a decision, not a
 * shortcut — see the comments at each. The caller turns the result into
 * whatever its transport answers with; nothing here formats a response.
 */
export function handleHarnessHookEvent(
  taskId: string,
  payload: HarnessHookBody,
  ports: HookPipelinePorts,
  eventNameFallback = "",
): HookPipelineResult {
  const event = payload.hook_event_name || eventNameFallback || "";
  let status = mapHookEventToStatus({ ...payload, hook_event_name: event });
  const incomingSessionId = hookSessionId(payload);

  const task = ports.getTask(taskId);
  if (!task) return { outcome: "task-not-found", event };

  // Stash the transcript path (present on most Claude hooks incl. Stop) so a
  // host that reads whole sessions can. Latest wins; stable per session.
  // Subagent lifecycle hooks are excluded: they carry the SUBAGENT's own
  // transcript path, which would point the reader at a child transcript.
  if (
    !isSubagentLifecycleEvent(event) &&
    typeof payload.transcript_path === "string" &&
    payload.transcript_path.trim()
  ) {
    ports.onTranscriptPath?.(taskId, payload.transcript_path.trim());
  }

  if (event === HARNESS_HOOK_EVENTS.sessionStart && payload.source === "clear") {
    // /clear kills background subagents but keeps the session id, so the
    // session-id-change clear below never fires for it.
    clearSubagentActivity(taskId);
  }

  const sessionResult = reconcileSessionId(task, taskId, incomingSessionId, event, {
    ...ports,
    setSessionId: (id, sessionId) => {
      ports.setSessionId(id, sessionId);
      // A new session id means a new harness process; the old session's
      // subagents died with it, so they must not hold this task on "running".
      clearSubagentActivity(id);
    },
  });
  if (sessionResult === "foreign-session") return { outcome: "foreign-session", event };

  // Sub-agent lifecycle bookkeeping. Claude fires the top-level Stop when the
  // FOREGROUND turn ends — background subagents keep running, then their
  // completion re-invokes the main harness, whose own Stop follows. Track which
  // subagents are active so the Stop mapping below can hold the session on
  // "running" until the last one is done.
  //
  // On a task that is ALREADY finished these events carry no status of their
  // own, and un-finishing the card is only right when the turn can still
  // plausibly be working. Two things say so, and nothing else does:
  //
  //   - a tracked subagent from that turn is still in flight (the set is
  //     non-empty), so the finish landed over live work; or
  //   - the finish is younger than FINISH_RACE_WINDOW_MS (one second,
  //     inclusive), i.e. this event is the turn's own lifecycle POST that lost
  //     the race to the Stop.
  //
  // Which of those two actually decides the raced-POST case this exists for?
  // The clock, alone. Every HOOK-DRIVEN finish leaves the tracked set empty by
  // construction: the finished mapping below is downgraded to "running"
  // whenever hasActiveSubagents is true, so the finish write only happens with
  // an idle set; finishQuietTask runs only after the drain observed an idle
  // set; the sessionProcessExited branch calls clearSubagentActivity first;
  // and the Core's session backstop clears before it calls noteTaskFinished.
  // The active-set disjunct is therefore not the safety net for a raced POST —
  // it guards a "finished" written by one of the OTHER status writers (a
  // core-link task mutation through CoreTaskWriter, say, which clears
  // nothing). That is worth keeping; it is just not what protects in-turn work
  // here. The clock is, and its cost is documented on FINISH_RACE_WINDOW_MS
  // and filed as issue 440: a retry-delayed in-turn SubagentStart landing
  // after the Stop is dropped, not healed.
  //
  // Everything else on a finished task is one of Claude Code's post-turn
  // internal helpers — away-summary generation and the title helper fire
  // SubagentStart/Stop when the operator refocuses a finished session or
  // clicks the just-finished pin, with no Stop to follow. Those must not write
  // "running" (issue 385): the card would flip back to running seconds after
  // completing and stay there until the drain backstop noticed. Ignore them
  // for status, and don't record their starts either — a lost helper
  // SubagentStop would otherwise hold the NEXT turn's Stop for the whole TTL.
  if (isSubagentLifecycleEvent(event)) {
    // Read the tracked set BEFORE this event touches it: a helper's own
    // SubagentStart must not be the evidence that work is in flight.
    const inTurn =
      task.status !== "finished" ||
      hasActiveSubagents(taskId) ||
      taskFinishedWithinRaceWindow(taskId);
    if (event === HARNESS_HOOK_EVENTS.subagentStart) {
      if (inTurn) noteSubagentStart(taskId, payload.agent_id);
    } else {
      noteSubagentStop(taskId, payload.agent_id);
    }
    if (task.status === "finished" && inTurn) {
      ports.updateStatus(taskId, "running");
      armDeferredFinish(taskId, (id) => finishQuietTask(id, ports));
    }
    return { outcome: "ok", event };
  }

  // Synthetic PTY-exit event: the session process is gone, so a task still
  // showing active work is wrong — settle it by exit code. Tasks already in a
  // settled state (finished, interrupted, …) keep it: the exit of an idle
  // session isn't news. Dead process ⇒ its subagents died with it.
  //
  // `ready` is in scope too (issue 387), and it is the one status here that
  // does not describe work in progress. It describes a Session that has not
  // started one — a bare Session sitting on "Waiting for initial prompt…",
  // whose harness is up and whose first `UserPromptSubmit` has not arrived.
  // Nothing else settles it: no hook ever fired for that Session, so there is
  // no Stop to wait for, and the boot sweep's status filter did not see it
  // either. Left out, its row goes on claiming to be waiting for a prompt for
  // as long as the database exists — a zombie found alive on a Core hours
  // after its PTY died, and still there after the container was recreated.
  //
  // It settles on a scale of its own: `disconnected`, whatever the exit code.
  // Neither of the other two answers is true of a Session that never ran a
  // turn. `terminated` says a turn was killed. `finished` says work completed,
  // and it is not just a label — `CoreTaskWriter` appends `session:finished`
  // on exactly that transition, so an operator who opens a bare Session and
  // types `/exit` would get a completion ding for a Session still titled
  // "Waiting for initial prompt…". `disconnected` claims only that the process
  // went away, which is the whole of what is known. #387's acceptance allows
  // either ("disconnected or finished"); this is the one that agrees with the
  // boot sweep, which settles the same Session with the same reasoning and
  // deliberately raises no notification.
  if (event === HARNESS_HOOK_EVENTS.sessionProcessExited) {
    clearSubagentActivity(taskId);
    // No re-invocation can follow a dead process: laggard subagent POSTs still
    // in flight must be ignored as stale, never heal to "running".
    clearTaskFinished(taskId);
    if (task.status === "running" || task.status === "needs-input") {
      ports.updateStatus(taskId, payload.exit_code === 0 ? "finished" : "terminated");
    } else if (task.status === "ready") {
      ports.updateStatus(taskId, "disconnected");
    }
    // No `status` on the result: the settle is conditional, and a host that
    // echoed one would be claiming a transition that may not have happened.
    return { outcome: "ok", event };
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
    armDeferredFinish(taskId, (id) => finishQuietTask(id, ports));
  }

  // Hand the question over before the status write so a host's overlay data is
  // already in place when the status change triggers its refetches. Malformed
  // tool_input is fail-soft: status still flips, just no overlay.
  if (event === HARNESS_HOOK_EVENTS.preToolUse && payload.tool_name === ASK_USER_QUESTION_TOOL) {
    const questions = parseAskUserQuestionInput(payload.tool_input);
    if (questions) ports.onQuestion?.(taskId, payload.tool_use_id, questions);
  }

  // The AskUserQuestion-matched PostToolUse is the AskUserQuestion status
  // signal, handled below; every other PostToolUse only exists to heal a stale
  // needs-input state — a tool just ran, so the harness is provably working.
  if (event === HARNESS_HOOK_EVENTS.postToolUse && payload.tool_name !== ASK_USER_QUESTION_TOOL) {
    if (task.status === "needs-input") ports.updateStatus(taskId, "running");
    // Conditional like the exit settle above — the answer names the event, not
    // a status the heal may not have written.
    return { outcome: "ok", event };
  }

  if (!status) return { outcome: "ignored", event };

  if (!ports.updateStatus(taskId, status)) return { outcome: "task-not-found", event };
  // Timestamp real finishes so the subagent branch above can tell a raced
  // lifecycle POST (heal) from a post-turn helper event (ignore).
  if (status === "finished") noteTaskFinished(taskId);

  if (
    isSessionCaptureEvent(event) &&
    typeof payload.prompt === "string" &&
    payload.prompt.trim()
  ) {
    ports.onPrompt?.(taskId, payload.prompt);
  }

  return { outcome: "ok", event, status };
}

/**
 * The answer a hook gets back, as one shape both hosts encode.
 *
 * A harness ignores the body — its hook is fire-and-forget — but an operator
 * debugging with `curl -v` reads it, and `404` is how they learn the task is
 * gone rather than the hook being wrong. Keeping the mapping here means the
 * Panel's endpoint and the Core's receiver cannot answer the same event
 * differently.
 */
export function hookResultResponse(result: HookPipelineResult): {
  ok: boolean;
  body: Record<string, unknown>;
} {
  switch (result.outcome) {
    case "task-not-found":
      return { ok: false, body: { error: "task not found" } };
    case "foreign-session":
      return { ok: true, body: { ok: true, ignored: "foreign-session" } };
    case "ignored":
      return { ok: true, body: { ok: true, ignored: result.event } };
    case "ok":
      return {
        ok: true,
        body: result.status
          ? { ok: true, status: result.status }
          : { ok: true, event: result.event },
      };
  }
}

/**
 * Deferred-finish backstop: fires when a held or healed "running" drained its
 * subagents and no main-harness Stop landed within the grace. Guarded so it
 * cannot stomp a state the operator or a later event moved the task into.
 */
function finishQuietTask(taskId: string, ports: HookPipelinePorts): void {
  if (ports.getTask(taskId)?.status !== "running") return;
  ports.updateStatus(taskId, "finished");
  noteTaskFinished(taskId);
}
