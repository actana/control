import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handleHarnessHookEvent,
  hookResultResponse,
  type HarnessHookBody,
  type HookPipelineResult,
  type HookPipelinePorts,
  type HookTaskFacts,
} from "../harness-hook-pipeline";
import {
  FINISH_RACE_WINDOW_MS,
  clearSubagentActivity,
  clearTaskFinished,
} from "../subagent-activity";
import type { TaskStatus } from "../domain";

// The subagent branch of the hook pipeline, driven event by event.
//
// The bug this pins (issue 385): a subagent event landing on a FINISHED task
// used to heal it back to "running" for a full 30 seconds afterwards, so the
// post-turn helpers Claude Code fires when the operator refocuses a pane or
// clicks the just-finished pin (away-summary generation, the title helper)
// resurrected a completed card. A heal is legitimate only when the turn can
// still plausibly be working — a tracked subagent is in flight, or the finish
// is younger than FINISH_RACE_WINDOW_MS (one second, inclusive).
//
// For the raced-POST case the clock is the whole gate: every hook-driven finish
// leaves the tracked set empty by construction, so the active-set disjunct only
// covers a "finished" written by another status writer. What that costs — a
// retry-delayed in-turn SubagentStart, dropped rather than healed — is filed as
// issue 440.

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const realNow = Date.now;
let taskIdSeq = 0;

type Harness = {
  taskId: string;
  task: HookTaskFacts;
  ports: HookPipelinePorts;
  /** Every status the pipeline wrote, oldest first. */
  writes: TaskStatus[];
  /** Every session id the pipeline captured, oldest first. */
  captured: string[];
  post(payload: HarnessHookBody): HookPipelineResult;
};

function makeHarness(): Harness {
  const taskId = `pipeline-task-${++taskIdSeq}`;
  const task: HookTaskFacts = { status: "ready", claudeSessionId: null };
  const writes: TaskStatus[] = [];
  const captured: string[] = [];
  const ports: HookPipelinePorts = {
    getTask: (id) => (id === taskId ? task : null),
    updateStatus: (id, status) => {
      if (id !== taskId) return false;
      task.status = status;
      writes.push(status);
      return true;
    },
    setSessionId: (id, sessionId) => {
      if (id !== taskId) return;
      task.claudeSessionId = sessionId;
      captured.push(sessionId);
    },
  };
  return {
    taskId,
    task,
    ports,
    writes,
    captured,
    post: (payload) =>
      handleHarnessHookEvent(taskId, { session_id: SESSION_ID, ...payload }, ports),
  };
}

const harnesses: Harness[] = [];

function harness(): Harness {
  const next = makeHarness();
  harnesses.push(next);
  return next;
}

beforeEach(() => {
  taskIdSeq = 0;
});

afterEach(() => {
  Date.now = realNow;
  // Module state in subagent-activity is per process, not per test.
  for (const used of harnesses.splice(0)) {
    clearSubagentActivity(used.taskId);
    clearTaskFinished(used.taskId);
  }
});

describe("subagent events on a finished task (issue 385)", () => {
  it("leaves the task finished when a helper SubagentStart follows the finish", () => {
    const h = harness();
    h.post({ hook_event_name: "UserPromptSubmit", prompt: "do the thing" });
    h.post({ hook_event_name: "Stop" });
    expect(h.task.status).toBe("finished");

    // The operator clicks the just-finished pin. Claude Code's away-summary
    // helper fires SubagentStart/Stop with no Stop to follow, and no subagent
    // from the finished turn is in flight.
    Date.now = () => realNow() + FINISH_RACE_WINDOW_MS + 1;
    h.post({ hook_event_name: "SubagentStart", agent_id: "away-helper" });
    expect(h.task.status).toBe("finished");
    h.post({ hook_event_name: "SubagentStop", agent_id: "away-helper" });
    expect(h.task.status).toBe("finished");
    expect(h.writes).toEqual(["running", "finished"]);
  });

  it("stays finished across the whole old 30s heal window", () => {
    // Every one of these used to write "running": the window was 30s, where
    // the race it models is the microseconds between two POSTs leaving the
    // same harness process.
    for (const afterMs of [2_000, 5_000, 15_000, 29_000]) {
      const h = harness();
      h.post({ hook_event_name: "UserPromptSubmit", prompt: "do the thing" });
      h.post({ hook_event_name: "Stop" });

      Date.now = () => realNow() + afterMs;
      h.post({ hook_event_name: "SubagentStart", agent_id: "title-helper" });
      expect(h.task.status).toBe("finished");
      Date.now = realNow;
    }
  });

  it("does not record a helper's start, so the next turn's Stop still finishes", () => {
    const h = harness();
    h.post({ hook_event_name: "UserPromptSubmit", prompt: "do the thing" });
    h.post({ hook_event_name: "Stop" });

    // A helper start that was counted as active work would hold the NEXT
    // turn's Stop on "running" until the 2h TTL if its stop went missing.
    Date.now = () => realNow() + FINISH_RACE_WINDOW_MS + 1;
    h.post({ hook_event_name: "SubagentStart", agent_id: "away-helper" });
    Date.now = realNow;

    h.post({ hook_event_name: "UserPromptSubmit", prompt: "next turn" });
    h.post({ hook_event_name: "Stop" });
    expect(h.task.status).toBe("finished");
  });

  it("still heals a lifecycle POST that genuinely lost the race to Stop", () => {
    const h = harness();
    h.post({ hook_event_name: "UserPromptSubmit", prompt: "do the thing" });
    h.post({ hook_event_name: "Stop" });
    expect(h.task.status).toBe("finished");

    // Same-millisecond arrival: the turn's own SubagentStart, reordered.
    h.post({ hook_event_name: "SubagentStart", agent_id: "raced-sub" });
    expect(h.task.status).toBe("running");

    h.post({ hook_event_name: "SubagentStop", agent_id: "raced-sub" });
    h.post({ hook_event_name: "Stop" });
    expect(h.task.status).toBe("finished");
  });

  it("heals past the race window while a tracked subagent is still in flight", () => {
    const h = harness();
    h.post({ hook_event_name: "UserPromptSubmit", prompt: "fan out" });
    h.post({ hook_event_name: "SubagentStart", agent_id: "sub-1" });

    // Reaching past the pipeline is the point, not a shortcut: no hook-driven
    // finish can leave the tracked set non-empty, so this branch is only ever
    // reachable from one of the OTHER status writers (structural note W1:
    // three of them, no arbiter) landing "finished" over live work — a
    // core-link task mutation through CoreTaskWriter, say, which clears
    // nothing.
    h.ports.updateStatus(h.taskId, "finished");

    // Long past any POST race, but the turn's own set says work is in flight,
    // so a second in-turn subagent is real work and does un-finish the card.
    Date.now = () => realNow() + 5 * 60_000;
    h.post({ hook_event_name: "SubagentStart", agent_id: "sub-2" });
    expect(h.task.status).toBe("running");
  });
});

describe("in-turn subagents hold the finish", () => {
  it("holds running until the last background subagent stops", () => {
    const h = harness();
    h.post({ hook_event_name: "UserPromptSubmit", prompt: "fan out" });
    h.post({ hook_event_name: "SubagentStart", agent_id: "sub-1" });
    h.post({ hook_event_name: "SubagentStart", agent_id: "sub-2" });

    // The FOREGROUND turn ends while both subagents are still working.
    h.post({ hook_event_name: "Stop" });
    expect(h.task.status).toBe("running");

    h.post({ hook_event_name: "SubagentStop", agent_id: "sub-1" });
    h.post({ hook_event_name: "Stop" });
    expect(h.task.status).toBe("running");

    // Only the Stop that arrives with nothing left active is the real finish.
    h.post({ hook_event_name: "SubagentStop", agent_id: "sub-2" });
    h.post({ hook_event_name: "Stop" });
    expect(h.task.status).toBe("finished");
  });

  it("finishes on Stop when the turn's subagents already reported in", () => {
    const h = harness();
    h.post({ hook_event_name: "UserPromptSubmit", prompt: "fan out" });
    h.post({ hook_event_name: "SubagentStart", agent_id: "sub-1" });
    h.post({ hook_event_name: "SubagentStop", agent_id: "sub-1" });
    h.post({ hook_event_name: "Stop" });
    expect(h.task.status).toBe("finished");
  });
});

describe("a PTY exit settles a Session that never started a turn (issue 387)", () => {
  // The live zombie this pins: a bare Session on `ready`, PTY spawned, no
  // prompt ever submitted — so no hook ever fired for it, and no Stop was
  // ever coming. Before this, the exit settle skipped `ready` and the row
  // went on saying "Waiting for initial prompt…" hours after its process died.
  const EXITED = "MissionControlSessionEnded";

  it("settles a ready Session to disconnected when its PTY dies badly", () => {
    const h = harness();
    expect(h.task.status).toBe("ready");

    h.post({ hook_event_name: EXITED, exit_code: 1 });

    // Not `terminated`: nothing was killed mid-turn, because there was no
    // turn. All that is known is that the process went away.
    expect(h.task.status).toBe("disconnected");
    expect(h.writes).toEqual(["disconnected"]);
  });

  it("settles a ready Session to disconnected on a clean exit too", () => {
    // Not `finished`. That transition is what `CoreTaskWriter` appends
    // `session:finished` on, and a Session that never ran a turn must not ring
    // a completion ding — the boot sweep settles the same Session silently.
    const h = harness();
    h.post({ hook_event_name: EXITED, exit_code: 0 });
    expect(h.task.status).toBe("disconnected");
    expect(h.writes).toEqual(["disconnected"]);
  });

  it("settles without a Stop hook ever arriving", () => {
    const h = harness();
    // The whole point: the Session is spawned and left alone. Nothing but the
    // exit is ever posted, and the row still moves off `ready`.
    h.post({ hook_event_name: "SessionStart", source: "startup" });
    expect(h.task.status).toBe("ready");

    h.post({ hook_event_name: EXITED, exit_code: 143 });
    expect(h.task.status).toBe("disconnected");
  });

  it("keeps the running/needs-input settle on its own scale", () => {
    // `terminated` still means a turn that was killed — widening `ready` must
    // not have widened this.
    const running = harness();
    running.post({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    running.post({ hook_event_name: EXITED, exit_code: 1 });
    expect(running.task.status).toBe("terminated");

    const waiting = harness();
    waiting.post({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    waiting.post({ hook_event_name: "Notification", notification_type: "permission_prompt" });
    expect(waiting.task.status).toBe("needs-input");
    waiting.post({ hook_event_name: EXITED, exit_code: 0 });
    expect(waiting.task.status).toBe("finished");
  });

  it("still leaves an already-settled Session exactly as it settled", () => {
    const h = harness();
    h.post({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    h.post({ hook_event_name: "Stop" });
    expect(h.task.status).toBe("finished");

    h.post({ hook_event_name: EXITED, exit_code: 1 });
    // The exit of an idle session is not news, and must not overwrite the
    // finish that was actually reported.
    expect(h.task.status).toBe("finished");
  });
});

describe("a turn end from a session this task never captured (issue 390)", () => {
  // The miss this pins (issue 390): a `Stop` is not a session-capture event, so
  // one arriving under a session id that is not the stored one used to return
  // `foreign-session` BEFORE any status write — acked with `{ ok: true }` and
  // dropped. The card stayed on `running` and no `session:finished` ever fired,
  // for a turn that had ended. The two ways to get there are a resumed harness
  // (new session id, stored one belongs to a dead process) and an OpenCode
  // child session whose `idle` leaked past the plugin's parent/child filter.
  //
  // The hook is addressed by task id out of the PTY's own environment, so the
  // PTY that posted it belongs to this task whatever the harness calls its
  // session — which is why a turn end is the one foreign event that settles.

  const FOREIGN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("finishes a running task on a Stop whose session_id does not match", () => {
    const h = harness();
    h.post({ hook_event_name: "UserPromptSubmit", prompt: "resume me" });
    expect(h.task.status).toBe("running");
    expect(h.task.claudeSessionId).toBe(SESSION_ID);

    const result = h.post({ hook_event_name: "Stop", session_id: FOREIGN });

    expect(h.task.status).toBe("finished");
    expect(result).toEqual({ outcome: "ok", event: "Stop", status: "finished" });
    expect(h.writes).toEqual(["running", "finished"]);
  });

  it("answers with the status rather than an ignored foreign-session ack", () => {
    // The ack was the operator-visible part of the miss: from the harness's
    // side a hook that changed nothing looked exactly like one that worked.
    const h = harness();
    h.post({ hook_event_name: "UserPromptSubmit", prompt: "resume me" });

    const body = hookResultResponse(h.post({ hook_event_name: "Stop", session_id: FOREIGN }));
    expect(body).toEqual({ ok: true, body: { ok: true, status: "finished" } });
  });

  it("settles a task parked on needs-input too", () => {
    const h = harness();
    h.post({ hook_event_name: "UserPromptSubmit", prompt: "ask me something" });
    h.post({ hook_event_name: "Notification", notification_type: "permission_prompt" });
    expect(h.task.status).toBe("needs-input");

    h.post({ hook_event_name: "Stop", session_id: FOREIGN });
    expect(h.task.status).toBe("finished");
  });

  it("settles Cursor's turn-end events on the same terms", () => {
    for (const event of ["stop", "afterAgentResponse"]) {
      const h = harness();
      h.post({ hook_event_name: "beforeSubmitPrompt", prompt: "go" });
      expect(h.task.status).toBe("running");

      h.post({ hook_event_name: event, session_id: FOREIGN });
      expect(h.task.status).toBe("finished");
    }
  });

  it("does not adopt the foreign session id", () => {
    // A `Stop` is still not a capture event. Adopting an OpenCode child's id
    // would hand the rest of that child's lifecycle the Session's card.
    const h = harness();
    h.post({ hook_event_name: "UserPromptSubmit", prompt: "resume me" });
    h.post({ hook_event_name: "Stop", session_id: FOREIGN });

    expect(h.task.claudeSessionId).toBe(SESSION_ID);
    expect(h.captured).toEqual([SESSION_ID]);
  });

  it("holds instead of finishing while a tracked subagent is in flight", () => {
    // The conservative half: an OpenCode child's leaked idle must not ding a
    // parent whose fan-out this pipeline can see is still working.
    const h = harness();
    h.post({ hook_event_name: "UserPromptSubmit", prompt: "fan out" });
    h.post({ hook_event_name: "SubagentStart", agent_id: "sub-1" });

    h.post({ hook_event_name: "Stop", session_id: FOREIGN });
    expect(h.task.status).toBe("running");

    // And the real finish still lands when the fan-out reports in.
    h.post({ hook_event_name: "SubagentStop", agent_id: "sub-1" });
    h.post({ hook_event_name: "Stop" });
    expect(h.task.status).toBe("finished");
  });

  it("leaves an already-settled task exactly as it settled", () => {
    const h = harness();
    h.post({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    h.post({ hook_event_name: "Stop" });
    expect(h.task.status).toBe("finished");

    const result = h.post({ hook_event_name: "Stop", session_id: FOREIGN });
    expect(h.task.status).toBe("finished");
    // No `status` echoed: the settle is conditional, like the PTY-exit one.
    expect(result).toEqual({ outcome: "ok", event: "Stop" });
    expect(h.writes).toEqual(["running", "finished"]);
  });

  it("leaves a ready Session alone rather than dinging a turn it never ran", () => {
    // `CoreTaskWriter` appends `session:finished` on that transition, and a
    // Session still titled "Waiting for initial prompt…" has no turn to end —
    // #387's reasoning, unchanged.
    const h = harness();
    h.post({ hook_event_name: "SessionStart", source: "startup" });
    expect(h.task.status).toBe("ready");

    h.post({ hook_event_name: "Stop", session_id: FOREIGN });
    expect(h.task.status).toBe("ready");
    expect(h.writes).toEqual([]);
  });

  it("still drops every other foreign event", () => {
    // The guard is narrowed to turn ends, not lifted. A foreign question, a
    // foreign subagent count, a foreign permission prompt and a foreign
    // interrupt all still claim the task for a session it does not own.
    // (The capture events are not in this list on purpose: adopting a new
    // session id is what they are for, and #390 did not touch that.)
    for (const payload of [
      { hook_event_name: "SubagentStart", agent_id: "foreign-sub" },
      { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" },
      { hook_event_name: "Notification", notification_type: "permission_prompt" },
      { hook_event_name: "UserInterrupt" },
    ] satisfies HarnessHookBody[]) {
      const h = harness();
      h.post({ hook_event_name: "UserPromptSubmit", prompt: "go" });
      const before = h.writes.length;

      const result = h.post({ ...payload, session_id: FOREIGN });
      expect(result.outcome).toBe("foreign-session");
      expect(h.task.status).toBe("running");
      expect(h.writes).toHaveLength(before);
    }
  });
});

describe("matching-session Stop behaviour is unchanged (issue 390)", () => {
  it("finishes on a Stop carrying the captured session id", () => {
    const h = harness();
    h.post({ hook_event_name: "UserPromptSubmit", prompt: "do the thing" });
    const result = h.post({ hook_event_name: "Stop" });

    expect(result).toEqual({ outcome: "ok", event: "Stop", status: "finished" });
    expect(h.task.status).toBe("finished");
    expect(h.writes).toEqual(["running", "finished"]);
    expect(h.task.claudeSessionId).toBe(SESSION_ID);
  });

  it("finishes on a Stop for a task that captured no session id at all", () => {
    // The guard never fires without a stored id, so this path did not change
    // and must not have: it is every Session before its first capture event.
    const h = harness();
    const result = handleHarnessHookEvent(h.taskId, { hook_event_name: "Stop" }, h.ports);

    expect(result).toEqual({ outcome: "ok", event: "Stop", status: "finished" });
    expect(h.task.status).toBe("finished");
  });

  it("still downgrades a matching Stop to running while subagents work", () => {
    const h = harness();
    h.post({ hook_event_name: "UserPromptSubmit", prompt: "fan out" });
    h.post({ hook_event_name: "SubagentStart", agent_id: "sub-1" });

    const held = h.post({ hook_event_name: "Stop" });
    expect(held).toEqual({ outcome: "ok", event: "Stop", status: "running" });
    expect(h.task.status).toBe("running");

    h.post({ hook_event_name: "SubagentStop", agent_id: "sub-1" });
    expect(h.post({ hook_event_name: "Stop" })).toEqual({
      outcome: "ok",
      event: "Stop",
      status: "finished",
    });
  });

  it("still finishes a matching Stop over an already-settled task", () => {
    // Unconditional, unlike the foreign settle: an owned Stop has the last
    // word on its own session, and narrowing that would be a behaviour change.
    const h = harness();
    h.post({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    h.post({ hook_event_name: "UserInterrupt" });
    expect(h.task.status).toBe("interrupted");

    expect(h.post({ hook_event_name: "Stop" })).toEqual({
      outcome: "ok",
      event: "Stop",
      status: "finished",
    });
    expect(h.task.status).toBe("finished");
  });
});
