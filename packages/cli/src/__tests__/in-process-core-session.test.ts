// The `session` noun against a Core that is actually running (#160).
//
// `session-command.test.ts` injects the gateway, which is what makes the flags,
// the tables, the `--json` shapes and the exit codes testable without a Core —
// and is exactly why it cannot say whether the frames this noun sends are the
// ones a Core answers. This suite closes that gap the way
// `in-process-core.test.ts` closed it for `core status`: the real
// `PtyCoreLinkServer` on a real `wss://` port, the real `openSessionGateway`,
// and nothing faked between them except the machine they would otherwise be on.
//
// The Core here holds **Sessions this CLI did not start** — a task list, a
// project list, and a PTY that was already running when the command was typed.
// That is not scene-setting: it is the ticket's criterion. Nothing about having
// started a Session is remembered locally, so `ls`, `logs`, `send` and `kill`
// have nothing to recognise and work on any Session on the Core.
//
// Starting a Session is deliberately not exercised here. A spawn needs a real
// harness binary on this machine's PATH and a real PTY, which is
// `packages/sdk`'s `live-session.test.ts` — an opt-in suite against an
// operator's own Core. What is provable without one is proved here.
//
// **With one exception, added by #395 and narrow on purpose.** That ticket is
// about what a `start`/`resume` *returns*, and its report is read off a row the
// Core appends **during the spawn round trip** — the window #483's review
// called the deaf one. No fake gateway can stage that: the whole question is
// whether a real frame arriving before the client has a Task id to bind it to
// is held and then judged. So `livePtyCore` grows an opt-in `spawn` that
// registers a PTY id and nothing else — no binary, no process, no bytes — and
// the two tests at the bottom use `resume`, which spawns against a Task the
// Core already holds. Everything a real harness would do is still out of scope.
//
// The Core comes from `in-process-core.ts`, which #160 and #161 each extracted
// a version of and the review of #205 merged into one. `ptyCore` is this
// suite's contribution to it: the manager below is the live PTY that `logs`,
// `send` and `kill` reach, and every other suite takes the default that throws.

import { describe, it, expect, afterEach } from "vitest";
import type {
  CoreLinkProjectSnapshot,
  CoreLinkSessionSnapshot,
  CoreLinkTaskSnapshot,
} from "@actana/sdk/core-link-frames.ts";
import {
  SESSION_DELIVERED_EVENT_KIND,
  SESSION_PROMPT_ABANDONED_EVENT_KIND,
  SESSION_PROMPT_DELIVERED_EVENT_KIND,
} from "@actana/sdk/core-link-frames.ts";

import { openSessionGateway } from "../session-gateway.ts";
import { EXIT_FAILURE, EXIT_OK } from "../exit-codes.ts";
import {
  makeCliFixture,
  registerCore,
  type CliFixture,
} from "./cli-harness.ts";
import {
  arrayEventLog,
  unavailableEventLog,
  startInProcessCore,
  waitFor,
  type ArrayEventLog,
  type InProcessCore,
} from "./in-process-core.ts";

const PROJECT: CoreLinkProjectSnapshot = {
  projectId: "proj_web",
  name: "web",
  path: "/home/core/projects/web",
  icon: "WE",
  iconColor: "#123456",
  pinned: false,
  rememberHarnessSettings: false,
  savedHarness: null,
  savedSkipPermissions: false,
  savedBareSession: false,
  defaultGridView: false,
  updatedAt: 1_700_000_000_000,
};

function task(overrides: Partial<CoreLinkTaskSnapshot> = {}): CoreLinkTaskSnapshot {
  return {
    taskId: "task_live",
    projectId: PROJECT.projectId,
    title: "rebuild the flaky auth test",
    titleManuallySet: false,
    claudeSessionId: "00000000-0000-4000-8000-000000000000",
    agent: "claude-code",
    status: "running",
    pinned: false,
    archived: false,
    icon: null,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/**
 * The transcript a harness actually produces: a repainted line, not a log.
 *
 * `ESC[1G` walks the cursor back to column one and the next write lands on top
 * of what was there. Concatenated raw, this reads `Scanning…Scanning… 2
 * filesdone: 3 files changed`; rendered, it reads what a terminal would be
 * showing. That difference is the ticket's `logs` trap, and it is asserted in
 * both directions below.
 */
const REPAINTED =
  "\u001B[2J\u001B[H\u001B[1GScanning…\u001B[1GScanning… 2 files\u001B[1Gdone: 3 files changed\r\n";

/** A PTY manager holding one live PTY, and a record of what was done to it. */
function livePtyCore(
  opts: {
    /**
     * What this Core does the moment a spawn lands, before it answers (#395).
     *
     * Opt-in, and the shape is the point: the real Core appends its
     * `session:promptDelivered` row from inside the delivery it runs on the
     * PTY, which is after the client asked to spawn and before — often long
     * before — the client has done anything with the answer. A hook here
     * reproduces that ordering exactly, on a real socket, which is the only way
     * to prove the latch holds a row it cannot yet judge.
     */
    onSpawn?: (info: { taskId: string; ptyId: string; initialInput: string | undefined }) => void;
  } = {},
): {
  core: unknown;
  writes: string[];
  killed: string[];
  resolutions: string[];
  /** The same lookup, uncounted — for the query ports, which are not a verb. */
  ptyFor: (taskId: string) => string | null;
  exit: (ptyId: string) => void;
  spawns: () => number;
} {
  const writes: string[] = [];
  const killed: string[] = [];
  // Every `findByTask` this Core is asked, so a verb that resolves the PTY
  // twice — and opens a window between the two — is visible rather than
  // arguable (#289: one resolution for the write and the wait).
  const resolutions: string[] = [];
  const ptys = new Map<string, string>([["task_live", "pty_live"]]);
  let emit: ((event: { type: "exit"; ptyId: string; exitCode: number }) => void) | null = null;
  let spawns = 0;
  const core = {
    setEmitTarget: (target: typeof emit) => {
      emit = target;
    },
    findByTask: (taskId: string) => {
      resolutions.push(taskId);
      return { ptyId: ptys.get(taskId) ?? null };
    },
    taskIdForPty: (ptyId: string) =>
      [...ptys.entries()].find(([, id]) => id === ptyId)?.[0] ?? null,
    replay: (ptyId: string) =>
      ptyId === "pty_live"
        ? { data: REPAINTED, nextSeq: 1 }
        : { data: "", nextSeq: 0 },
    write: (ptyId: string, data: string) => {
      if (ptyId !== "pty_live") return false;
      writes.push(data);
      return true;
    },
    kill: (ptyId: string) => {
      if (ptyId !== "pty_live") return false;
      killed.push(ptyId);
      for (const [taskId, id] of ptys) if (id === ptyId) ptys.delete(taskId);
      return true;
    },
    resize: () => true,
    spawn: (spawnOpts: { taskId: string; initialInput?: string }) => {
      if (!opts.onSpawn) throw new Error("this suite does not spawn — see the header");
      const ptyId = `pty_${spawnOpts.taskId}`;
      ptys.set(spawnOpts.taskId, ptyId);
      spawns += 1;
      opts.onSpawn({ taskId: spawnOpts.taskId, ptyId, initialInput: spawnOpts.initialInput });
      return { ptyId, hooksReportTurnStart: true };
    },
    killAll: () => {},
    killLaunchProcesses: () => ({ ptyCount: 0, ports: [] }),
    killPtysUnderPath: () => {},
  };
  return {
    core,
    writes,
    killed,
    resolutions,
    ptyFor: (taskId: string) => ptys.get(taskId) ?? null,
    /** Push a PTY exit the way a dying process does — a frame, not a log row. */
    exit: (ptyId: string) => emit?.({ type: "exit", ptyId, exitCode: 0 }),
    spawns: () => spawns,
  };
}

/** Task and project reads, answered from memory. */
function ports(tasks: CoreLinkTaskSnapshot[], live: (taskId: string) => string | null) {
  /**
   * How many `sessionsList` frames this Core has answered.
   *
   * The suite's synchronisation point for "an attachment is established", and
   * it is that rather than `tailReads` because the two mean different things.
   * `tailReads` says a client subscribed — which now happens before the attach
   * has resolved a PTY, let alone read a status. `CoreSession.attach` ends with
   * `seedStatus()`, which is a `sessionsList`, so this counter moving is the
   * Core saying the attach got all the way to its last step. A test that
   * appends an event before that point is racing `settledNow()`: the seed would
   * read the status the test had already patched and resolve the wait from it,
   * with no event ever consumed.
   */
  let sessionListReads = 0;
  const sessions = (): CoreLinkSessionSnapshot[] => {
    sessionListReads += 1;
    return tasks
      .filter((row) => !row.archived)
      .map((row) => ({
        taskId: row.taskId,
        ptyId: live(row.taskId),
        status: row.status,
        updatedAt: row.updatedAt,
      }));
  };
  return {
    sessionListReads: () => sessionListReads,
    queryPort: {
      listProjects: () => [PROJECT],
      listTasks: () => tasks.filter((row) => !row.archived),
      listArchivedTasks: () => tasks.filter((row) => row.archived),
      countArchivedTasks: () => tasks.filter((row) => row.archived).length,
      getTask: (taskId: string) => tasks.find((row) => row.taskId === taskId) ?? null,
    },
    mutationPort: {
      mutateProject: () => null,
      mutateTask: () => null,
      listSessions: sessions,
    },
  };
}

let core: InProcessCore | null = null;
let fixture: CliFixture | null = null;

afterEach(() => {
  core?.close();
  core = null;
  fixture?.cleanup();
  fixture = null;
});

/** A Core holding one live Session and one that has already stopped. */
async function coreWithSessions(
  opts: {
    /**
     * Wire no event log, which is one of the two ways a Core on this protocol
     * version still answers a stamped write with no id — the other being an
     * `appendEvent` that failed. Both are what the gateway's refusal covers,
     * beyond the version gate that keeps an older Core off the wire entirely.
     */
    eventLog?: false | "unavailable";
    /** Archive a row while its harness keeps running. */
    archived?: string[];
    /**
     * Let this Core spawn, and say what it reports about the starting prompt
     * the moment it does (#395). `null` is a Core that spawns and reports
     * nothing, which is every Core before this change.
     *
     * `"blind"` is the third answer and the one the review of #494 found being
     * reported as success: a delivery the Core made on its quiet gap without
     * ever seeing a composer, which is what every harness with no
     * `HARNESS_READINESS` row gets — `codex` today.
     */
    onPromptDelivery?: "delivered" | "blind" | "abandoned" | null;
    /**
     * Rows to put in the log before anything else, to push it past the replay
     * cap (#494 review, blocker 1).
     *
     * `handleSubscribe` sends at most `EVENT_TAIL_LIMIT` — a thousand — rows and
     * marks the tail at the last one it sent, so a longer log is the ordinary
     * case in which the marker is nowhere near the end. Nothing prunes the log,
     * so a Core that has been up for days is always in this state.
     */
    filler?: number;
    /**
     * How long the Core waits between live-event pushes. The default of 25 ms
     * keeps the suite quick; an *ordering* test sets it far out so that nothing
     * but the Core deliberately putting a row on the socket can get it there
     * before the frame it has to precede (#495 gate review, addendum blocker 6).
     */
    liveEventPollMs?: number;
  } = {},
): Promise<{
  writes: string[];
  killed: string[];
  resolutions: string[];
  eventLog: ArrayEventLog;
  /** How many `sessionsList` frames the Core has answered — see {@link ports}. */
  sessionListReads: () => number;
  /** What the harness's own Stop hook does on the Core: patch the row, say so. */
  endTurn: (taskId: string, status: string) => void;
  /** Kill a PTY the way a process death does — an `exit` frame, no log row. */
  exitPty: (ptyId: string) => void;
  /** How many spawns this Core has served — the suite's "the harness is up". */
  spawns: () => number;
}> {
  // Forward-declared because the hook below runs inside the Core and the log is
  // built after it — the same knot the real Core ties by wiring `core-entry`'s
  // `appendEvent` into `PtyCoreDeps`.
  let appendPromptRow: ((taskId: string, ptyId: string) => void) | null = null;
  const pty = livePtyCore(
    opts.onPromptDelivery === undefined
      ? {}
      : {
          onSpawn: ({ taskId, ptyId }) => appendPromptRow?.(taskId, ptyId),
        },
  );
  const tasks = [
    task({ archived: opts.archived?.includes("task_live") ?? false }),
    task({ taskId: "task_done", title: "ship the changelog", status: "finished" }),
  ];
  // The uncounted lookup: `listSessions` resolves every row's PTY, and counting
  // those would drown the one thing `resolutions` is watching for — a *verb*
  // that resolves the same Session twice.
  const { queryPort, mutationPort, sessionListReads } = ports(tasks, pty.ptyFor);
  // The Core's event log, wired because #289's wait is a cursor into it: the
  // Core stamps a delivery there and the client counts settling statuses from
  // that id. Without one every write comes back unstamped, which is the
  // older-Core case and not the one these tests are about.
  const eventLog = arrayEventLog();
  for (let i = 0; i < (opts.filler ?? 0); i += 1) {
    eventLog.appendEvent("task:updated", JSON.stringify({ taskId: "task_filler" }), {
      taskId: "task_filler",
    });
  }
  if (opts.onPromptDelivery) {
    const outcome = opts.onPromptDelivery;
    appendPromptRow = (taskId, ptyId) => {
      if (outcome === "delivered" || outcome === "blind") {
        eventLog.appendEvent(
          SESSION_PROMPT_DELIVERED_EVENT_KIND,
          JSON.stringify({
            taskId,
            ptyId,
            characters: 2,
            waitedMs: 812,
            composerObserved: outcome === "delivered",
          }),
          { taskId, ptyId },
        );
        return;
      }
      eventLog.appendEvent(
        SESSION_PROMPT_ABANDONED_EVENT_KIND,
        JSON.stringify({
          taskId,
          ptyId,
          reason: "opencode composer never appeared within 90000 ms",
        }),
        { taskId, ptyId },
      );
    };
  }
  core = await startInProcessCore({
    ptyCore: pty.core,
    queryPort,
    mutationPort,
    // The live-event push, at test speed. A wait resolves when the status event
    // reaches the client, and the Core's default poll is 500 ms — which is fine
    // for a person and is most of the wall clock of a suite that waits twice,
    // on a machine already running five other packages' tests.
    liveEventPollMs: opts.liveEventPollMs ?? 25,
    ...(opts.eventLog === false
      ? {}
      : { eventLog: opts.eventLog === "unavailable" ? unavailableEventLog() : eventLog }),
  });
  fixture = makeCliFixture();
  registerCore(fixture.paths, "inproc", core.blobText);
  const endTurn = (taskId: string, status: string): void => {
    const row = tasks.find((t) => t.taskId === taskId);
    if (row) row.status = status;
    // The event the Core's task writer appends, with the status the mutation
    // patched on it — a report about a turn, and legible as one even when the
    // status it lands on is the status the row already had.
    eventLog.appendEvent(
      "task:updated",
      JSON.stringify({ taskId, projectId: PROJECT.projectId, status }),
      { taskId },
    );
  };
  return {
    writes: pty.writes,
    killed: pty.killed,
    resolutions: pty.resolutions,
    eventLog,
    sessionListReads,
    endTurn,
    exitPty: pty.exit,
    spawns: pty.spawns,
  };
}

/** Every session verb dials the Core for real in this suite. */
function withCore() {
  return { sessions: openSessionGateway };
}

describe("actana session, against a Core in this process", () => {
  it("lists the Sessions the Core holds, with the live one marked", async () => {
    await coreWithSessions();

    const run = await fixture!.run(["session", "ls", "--json"], withCore());
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);

    const rows = JSON.parse(run.out.join("\n")) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    const live = rows.find((row) => row.taskId === "task_live")!;
    expect(live.live).toBe(true);
    expect(live.ptyId).toBe("pty_live");
    // Joined off the Task rows: `sessionsList` carries neither, and a listing
    // that showed only ids would be unreadable.
    expect(live.title).toBe("rebuild the flaky auth test");
    expect(live.project).toBe("web");
    expect(live.harness).toBe("claude-code");
    expect(rows.find((row) => row.taskId === "task_done")!.live).toBe(false);
  }, 30_000);

  it("renders the transcript rather than concatenating the bytes", async () => {
    await coreWithSessions();

    const rendered = await fixture!.run(["session", "logs", "task_live"], withCore());
    expect(rendered.code, rendered.err.join("\n")).toBe(EXIT_OK);
    const screen = rendered.out.join("\n");
    expect(screen).toContain("done: 3 files changed");
    // The repaints are gone, which is the whole difference between a screen and
    // a byte log — and they are gone because the SDK's terminal drew them, not
    // because an escape stripper deleted them.
    expect(screen).not.toContain("Scanning…");
    expect(screen).not.toContain("\u001B");

    const raw = await fixture!.run(["session", "logs", "task_live", "--raw"], withCore());
    expect(raw.code).toBe(EXIT_OK);
    expect(raw.out.join("\n")).toContain("\u001B[1G");
  }, 30_000);

  it("sends exactly the bytes it was given, and the return as its own write (#404)", async () => {
    const { writes } = await coreWithSessions();

    // The default submits: the text, then the carriage return as a **second**
    // write to the same PTY — never `"2\r"` as one, because a harness that
    // treats a paste as one unit would swallow the return with the characters.
    // No timer between them: prompt delivery is still the Core's (ADR 0026).
    const sent = await fixture!.run(["session", "send", "task_live", "2"], withCore());
    expect(sent.code, sent.err.join("\n")).toBe(EXIT_OK);
    expect(writes).toEqual(["2", "\r"]);

    // `--enter` asks for what already happened, and a script that passes it
    // keeps working.
    const withEnter = await fixture!.run(["session", "send", "task_live", "2", "--enter"], withCore());
    expect(withEnter.code).toBe(EXIT_OK);
    expect(writes).toEqual(["2", "\r", "2", "\r"]);

    // And the opt-out reaches the wire as one write and nothing else.
    const typed = await fixture!.run(["session", "send", "task_live", "2", "--no-enter"], withCore());
    expect(typed.code, typed.err.join("\n")).toBe(EXIT_OK);
    expect(writes).toEqual(["2", "\r", "2", "\r", "2"]);
    expect(typed.err.join("\n")).toContain("started no turn");
  }, 30_000);

  it("kills a Session this CLI did not start", async () => {
    // The ticket's criterion, stated as a test: the PTY below was running
    // before this process existed, and the only thing naming it is a Task id.
    const { killed } = await coreWithSessions();

    const run = await fixture!.run(["session", "kill", "task_live", "--json"], withCore());
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(killed).toEqual(["pty_live"]);
    expect(JSON.parse(run.out.join("\n"))).toEqual({
      taskId: "task_live",
      ptyId: "pty_live",
      killed: true,
    });

    // And it is gone: the second kill finds no PTY and says so rather than
    // reporting a success the Core did not perform.
    const again = await fixture!.run(["session", "kill", "task_live", "--json"], withCore());
    expect(again.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(again.out.join("\n")).error).toContain("no harness running");
  }, 30_000);

  it("sends and awaits the turn in one PTY resolution, and prints the settled screen", async () => {
    // The whole of #289, against a Core that answers real frames: the write is
    // stamped in the event log, the wait counts from that id, and the turn that
    // ends afterwards is the one reported. The Session here is **already
    // settled** when the text lands — `task_live` is `running`, and the turn
    // below ends on `finished` — so nothing about this could be satisfied by
    // the status the Session was sitting at.
    const { writes, resolutions, eventLog, endTurn } = await coreWithSessions();

    const run = fixture!.run(
      ["session", "send", "task_live", "carry on", "--enter", "--wait", "--json"],
      withCore(),
    );
    // The turn ends once the delivery has been stamped — which is the ordering
    // a harness's Stop hook has: it cannot fire before the text arrives.
    await waitFor(
      () => eventLog.events.some((e) => e.kind === SESSION_DELIVERED_EVENT_KIND),
      "the write was stamped",
    );
    endTurn("task_live", "finished");

    const result = await run;
    expect(result.code, result.err.join("\n")).toBe(EXIT_OK);

    // Two writes, verbatim, with the return as its own byte (ADR 0026).
    expect(writes).toEqual(["carry on", "\r"]);
    // **One resolution for the write and the wait.** A second `findByTask`
    // between them is the window this design exists to close.
    expect(resolutions).toEqual(["task_live"]);

    const stamps = eventLog.events.filter((e) => e.kind === SESSION_DELIVERED_EVENT_KIND);
    expect(stamps).toHaveLength(2);
    expect(stamps[0]!.taskId).toBe("task_live");

    const payload = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(payload).toMatchObject({
      taskId: "task_live",
      ptyId: "pty_live",
      harness: "claude-code",
      waited: true,
      status: "finished",
      exited: false,
    });
    // The transcript rides along, rendered, read while the Session is alive —
    // and it is the Core's replay ring, so it holds what came before the wait.
    expect(String(payload.screen)).toContain("done: 3 files changed");
    // A minute, not thirty seconds: this one dials a real Core, runs a CLI
    // command end to end and waits on a live event push, and `pnpm test` runs it
    // beside five other packages' suites.
  }, 60_000);

  it("waits as a verb, and refuses to wait on a Session with no harness running", async () => {
    const { eventLog, endTurn } = await coreWithSessions();

    const waiting = fixture!.run(["session", "wait", "task_live", "--json"], withCore());
    // Nothing was delivered, so there is no cursor — the wait takes the next
    // settling status this attachment hears about.
    await waitFor(() => eventLog.tailReads > 0, "the wait subscribed to the event log");
    endTurn("task_live", "needs-input");

    const settled = await waiting;
    expect(settled.code, settled.err.join("\n")).toBe(EXIT_OK);
    expect(JSON.parse(settled.out.join("\n"))).toMatchObject({
      taskId: "task_live",
      status: "needs-input",
      waited: true,
      // An attach did not spawn, and says so rather than inventing an answer.
      command: null,
      reportsTurnStart: null,
    });

    const stopped = await fixture!.run(["session", "wait", "task_done", "--json"], withCore());
    expect(stopped.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(stopped.out.join("\n")).error).toContain("no harness running");
  }, 60_000);

  it("tells the caller the Core abandoned the starting prompt, off the event log (#483)", async () => {
    // The whole path, on a real socket: the Core appends the row, the client
    // reads it on the connection it already has, and the command turns it into
    // a sentence and a non-zero exit. `needs-input` on its own is a zero exit
    // by design — a harness that stopped to ask a question did not fail — and
    // that is exactly why the row has to exist: a prompt that never reached
    // the harness produces the same status and the opposite meaning.
    //
    // **Deterministic by ordering, not by luck.** The first version of this
    // test raced and failed four runs in five, for two reasons that are worth
    // keeping written down. The latch was installed after `CoreSession.attach`
    // had already round-tripped, so a fast abandon landed in a deaf window; and
    // it synchronised on `tailReads`, which says a client subscribed and *not*
    // that it is attached — append before `seedStatus()` runs and the seed reads
    // the status this test just patched, `settledNow()` short-circuits, and the
    // wait resolves having consumed no event at all.
    //
    // Both are fixed. The latch listens before the command asks the Core
    // anything, and this waits on the `sessionsList` that is `seedStatus`'s own
    // last step — so the rows below are appended after the attachment exists,
    // are live rather than replay, and arrive in the order they were written on
    // one ordered connection.
    const { eventLog, endTurn, sessionListReads } = await coreWithSessions();

    const waiting = fixture!.run(["session", "wait", "task_live", "--json"], withCore());
    await waitFor(() => sessionListReads() > 0, "the wait attached and seeded its status");
    const abandonedAt = eventLog.appendEvent(
      SESSION_PROMPT_ABANDONED_EVENT_KIND,
      JSON.stringify({
        taskId: "task_live",
        ptyId: "pty_live",
        reason: "opencode composer never appeared within 90000 ms",
      }),
      { taskId: "task_live" },
    );
    // The status the wait ends on is strictly behind the reason, which is the
    // discipline `pty-manager` now keeps on the Core: a client that hears the
    // status has already heard why.
    endTurn("task_live", "needs-input");
    expect(eventLog.getLastEventId()).toBeGreaterThan(abandonedAt);

    const settled = await waiting;
    expect(settled.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(settled.out.join("\n"))).toMatchObject({
      taskId: "task_live",
      status: "needs-input",
      promptDelivered: false,
      promptAbandonedReason: "opencode composer never appeared within 90000 ms",
    });
  }, 60_000);

  it("does not fail a healthy send on an abandon row from a previous start (#483)", async () => {
    // The inversion this feature could otherwise cause, on the very command its
    // own error message recommends. `session:promptAbandoned` is durable and
    // `subscribe` replays the log from the beginning, so a Session whose first
    // start lost its prompt carries that row forever. Reading it as a report
    // about *this* send would tell an operator the text did not land when it
    // landed perfectly — the same false report #483 exists to kill, pointed the
    // other way.
    //
    // The row is appended before the command runs, so it arrives in the replay
    // tail: below `eventsReplayed`, and below the delivery stamp this send is
    // cursored from. Either floor alone rejects it.
    const { eventLog, endTurn, writes } = await coreWithSessions();
    eventLog.appendEvent(
      SESSION_PROMPT_ABANDONED_EVENT_KIND,
      JSON.stringify({
        taskId: "task_live",
        ptyId: "pty_live",
        reason: "opencode composer never appeared within 90000 ms",
      }),
      { taskId: "task_live" },
    );

    const sending = fixture!.run(
      ["session", "send", "task_live", "carry", "on", "--wait", "--json"],
      withCore(),
    );
    // **Both** stamps, not the first. A send is two writes since #404 and the
    // wait counts from the *later* id; ending the turn between them would put
    // the status event below the cursor, where no wait can ever see it. That is
    // a 60 s hang rather than a wrong answer, and it is not what this test is
    // about — so it is closed out here rather than left to be rare.
    await waitFor(
      () => eventLog.events.filter((e) => e.kind === SESSION_DELIVERED_EVENT_KIND).length >= 2,
      "both halves of the send were stamped",
    );
    endTurn("task_live", "finished");

    const settled = await sending;
    expect(settled.code, settled.err.join("\n")).toBe(EXIT_OK);
    const payload = JSON.parse(settled.out.join("\n"));
    expect(payload).toMatchObject({ taskId: "task_live", status: "finished" });
    // **What this guards is that the stale row was not latched**, and that is
    // `not false` — a latched abandon would be `false`, would carry
    // `promptAbandonedReason`, and would exit non-zero.
    //
    // It is `null` rather than `true`, and the change is deliberate (#495 gate
    // review, addendum blocker 6). A send is a raw write by design (#404), so
    // no delivery of one goes through the Core's delivery machinery and no
    // `session:promptDelivered` row is ever appended for it. `true` here used
    // to come from the *absence* of an abandon row, which against a Core that
    // emits neither row means "nobody told me otherwise" — the class of claim
    // this train exists to remove. `null` is what nobody adjudicating actually
    // looks like.
    expect(payload.promptDelivered).toBeNull();
    expect(payload.promptAbandonedReason).toBeUndefined();
    expect(settled.err.join("\n")).not.toContain("did not deliver the starting prompt");
    expect(writes).toContain("carry on");
  }, 60_000);

  it("does not fail a bare wait on an abandon row that is already history (#483)", async () => {
    // The same staleness with no cursor to lean on: `session wait` delivers no
    // text, so there is no stamp, and the only thing separating "already in the
    // log" from "just happened" is the `eventsReplayed` marker. A Session that
    // was abandoned once and has since been answered by hand is a working
    // Session, and waiting on it must say so.
    const { eventLog, endTurn, sessionListReads } = await coreWithSessions();
    eventLog.appendEvent(
      SESSION_PROMPT_ABANDONED_EVENT_KIND,
      JSON.stringify({
        taskId: "task_live",
        ptyId: "pty_live",
        reason: "opencode composer never appeared within 90000 ms",
      }),
      { taskId: "task_live" },
    );

    const waiting = fixture!.run(["session", "wait", "task_live", "--json"], withCore());
    await waitFor(() => sessionListReads() > 0, "the wait attached and seeded its status");
    endTurn("task_live", "finished");

    const settled = await waiting;
    expect(settled.code, settled.err.join("\n")).toBe(EXIT_OK);
    const payload = JSON.parse(settled.out.join("\n"));
    expect(payload).toMatchObject({ taskId: "task_live", status: "finished" });
    // Same reading as the send above: `not false` is the guard, and `null` is
    // the honest value. A bare `session wait` hands over no prompt at all, so
    // there is nothing for the Core to have delivered and nothing it could
    // report — `true` was the absence of the stale row being read as a verdict.
    expect(payload.promptDelivered).toBeNull();
    expect(payload.promptAbandonedReason).toBeUndefined();
  }, 60_000);

  it("waits for the delivery row the Core appends inside the spawn round trip (#395)", async () => {
    // The whole of #395 on a real socket. `session resume … --await-prompt`
    // spawns, and the Core appends `session:promptDelivered` *while the spawn
    // frame is being handled* — before the answer goes back, and long before
    // `wrap()` has a Task id to bind the latch to. The row is therefore held,
    // judged against the `eventsReplayed` floor once the latch is armed, and
    // reported. Nothing here polls, sleeps or measures: the command ends
    // because the Core said something.
    //
    // A `resume` rather than a `start` only because the Core in this suite
    // holds Tasks and does not create them; the return path under test is the
    // same one, `reportStartedSession`, and both verbs reach it.
    await coreWithSessions({ onPromptDelivery: "delivered" });

    const run = await fixture!.run(
      ["session", "resume", "task_done", "carry", "on", "--await-prompt", "--json"],
      withCore(),
    );
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(JSON.parse(run.out.join("\n"))).toMatchObject({
      taskId: "task_done",
      awaitedPrompt: true,
      promptDelivered: true,
      // Not a turn wait, and the object says so rather than leaving a caller to
      // infer it from a missing `status`.
      waited: false,
    });
  }, 60_000);

  it("exits non-zero on a start whose prompt the Core gave up on (#395)", async () => {
    // The failure this gate exists for, end to end. Without `--await-prompt`
    // this command exits zero and says nothing, and the operator's next line —
    // a `session send` — types into a harness that never got the first message.
    // With it, the loss is the command's own exit code.
    await coreWithSessions({ onPromptDelivery: "abandoned" });

    const run = await fixture!.run(
      ["session", "resume", "task_done", "carry", "on", "--await-prompt"],
      withCore(),
    );
    expect(run.code).toBe(EXIT_FAILURE);
    const err = run.err.join("\n");
    expect(err).toContain("did not deliver the starting prompt");
    expect(err).toContain("opencode composer never appeared within 90000 ms");
    // And it names the recovery, which is the one thing `needs-input` alone
    // would have sent an operator the wrong way on.
    expect(err).toContain("session send task_done");
  }, 60_000);

  it("does not read a previous start's abandon row as this start's verdict (#395)", async () => {
    // #483's floor, now load-bearing for a *wait* rather than for a report read
    // after one. A Session resumed after a start that lost its prompt carries
    // that row for as long as the log does; latching it here would fail a
    // resume whose prompt landed perfectly, and — worse than #483's version of
    // this — would do it while a correct answer was sitting one event later.
    const { eventLog } = await coreWithSessions({ onPromptDelivery: "delivered" });
    eventLog.appendEvent(
      SESSION_PROMPT_ABANDONED_EVENT_KIND,
      JSON.stringify({
        taskId: "task_done",
        ptyId: "pty_task_done",
        reason: "a composer that never appeared, two starts ago",
      }),
      { taskId: "task_done" },
    );

    const run = await fixture!.run(
      ["session", "resume", "task_done", "carry", "on", "--await-prompt", "--json"],
      withCore(),
    );
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(JSON.parse(run.out.join("\n"))).toMatchObject({ promptDelivered: true });
    expect(run.err.join("\n")).not.toContain("two starts ago");
  }, 60_000);

  // ─── What the review of #494 found, each turned into a test ────────────
  //
  // All three failed on the code that review read, and each fails for a
  // different reason. They are here rather than beside the injected-gateway
  // suite because none of them can be staged with a fake gateway: the first is
  // about what a real `handleSubscribe` sends, the second about a frame that is
  // not a log row, the third about a payload field crossing a real socket.

  it("does not answer from a previous start's delivery row once the log passes the replay cap (#494 review, blocker 1)", async () => {
    // **Blocker 1, and it is ordinary use rather than an edge.**
    // `handleSubscribe` replays at most `EVENT_TAIL_LIMIT` — a thousand — rows
    // and marks the tail at the last one it *sent*; the rest of the history
    // then arrives behind that marker through `pushLiveEvents`, as ordinary
    // `event` frames. Nothing prunes the log. So with 1 200 rows in it, a
    // `session:promptDelivered` from a start last Tuesday sits above the old
    // floor and used to be judged as this command's verdict — exit 0 and "this
    // session can take a send now", before the Core had typed a character.
    //
    // The stale row is for this very Task, which is the case that matters: a
    // Session resumed after a start that delivered once carries that row for as
    // long as the log does.
    const { eventLog } = await coreWithSessions({ onPromptDelivery: "abandoned", filler: 1_200 });
    const staleAt = eventLog.appendEvent(
      SESSION_PROMPT_DELIVERED_EVENT_KIND,
      JSON.stringify({
        taskId: "task_done",
        ptyId: "pty_task_done",
        characters: 2,
        waitedMs: 400,
        composerObserved: true,
      }),
      { taskId: "task_done", ptyId: "pty_task_done" },
    );
    // Above the cap, and therefore above the marker the old floor used.
    expect(staleAt).toBeGreaterThan(1_000);

    const run = await fixture!.run(
      ["session", "resume", "task_done", "carry", "on", "--await-prompt", "--json"],
      withCore(),
    );
    // This start's own verdict, which is the one the Core gave for *this*
    // prompt — not the delivery from the life before it.
    expect(run.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(run.out.join("\n"))).toMatchObject({
      taskId: "task_done",
      promptDelivered: false,
      promptAbandonedReason: "opencode composer never appeared within 90000 ms",
    });
  }, 60_000);

  it("stops waiting when the harness exits, rather than for ever (#494 review, blocker 2)", async () => {
    // **Blocker 2's log-independent bound.** The Core here spawns and reports
    // nothing at all — the shape of a Core whose `appendEvent` is failing, and
    // of any other way the verdict never comes. `--await-prompt` refuses
    // `--wait-timeout` by design, so without a bound this blocks until the
    // operator kills it.
    //
    // An `exit` frame is the bound, and it is the right one because it is not a
    // log row: it comes off the PTY subscription, so it arrives from a Core
    // that cannot append anything, and a harness that is gone will never take
    // a prompt. Reported as "no verdict", never as a lost prompt — the text may
    // well have gone in before the process died.
    const { exitPty, spawns } = await coreWithSessions({ onPromptDelivery: null });

    const running = fixture!.run(
      ["session", "resume", "task_done", "carry", "on", "--await-prompt", "--json"],
      withCore(),
    );
    // After the spawn, so the exit is a live frame about a PTY that exists
    // rather than a frame nobody is subscribed to yet. The latch holds an exit
    // that beats `wrap()` all the same; this only keeps the test about the
    // bound rather than about that.
    await waitFor(() => spawns() > 0, "the Core spawned the harness");
    exitPty("pty_task_done");

    const run = await running;
    expect(run.code).toBe(EXIT_FAILURE);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.promptDelivered).toBeNull();
    expect(payload.promptUnknownReason).toContain("exited");
  }, 60_000);

  it("hears why the harness died before it hears that it died (#495 gate review, blocker 6)", async () => {
    // **The false success this closes.** `pty-manager` appends the
    // `session:promptAbandoned` reason row and *then* emits the exit. The exit
    // is fanned out synchronously; an appended row waits for the next live push.
    // So `wait()` resolved on the exit with the row still in flight, and
    // `--wait --json` printed `promptDelivered: true` beside `exited: true` —
    // with `EXIT_OK`, because a clean exit code is a clean settle — for a prompt
    // the Core had just said it never delivered.
    //
    // The poll is two seconds out on purpose. Nothing here can win that race by
    // being lucky: either the Core puts the row on the socket ahead of the exit
    // or this command finishes without it. That is what makes this an assertion
    // about the ordering rather than about the machine it runs on.
    const { eventLog, exitPty, spawns } = await coreWithSessions({
      onPromptDelivery: null,
      liveEventPollMs: 2_000,
    });

    const running = fixture!.run(
      ["session", "resume", "task_done", "carry", "on", "--wait", "--json"],
      withCore(),
    );
    await waitFor(() => spawns() > 0, "the Core spawned the harness");

    // `pty-manager`'s order, exactly: the row, then the death.
    eventLog.appendEvent(
      SESSION_PROMPT_ABANDONED_EVENT_KIND,
      JSON.stringify({
        taskId: "task_done",
        ptyId: "pty_task_done",
        reason: "the harness exited before the prompt was delivered",
      }),
      { taskId: "task_done", ptyId: "pty_task_done" },
    );
    exitPty("pty_task_done");

    const run = await running;
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.exited).toBe(true);
    expect(payload.promptDelivered).toBe(false);
    expect(payload.promptAbandonedReason).toBe(
      "the harness exited before the prompt was delivered",
    );
    expect(run.code).toBe(EXIT_FAILURE);
  }, 60_000);

  it("says it does not know rather than that the prompt landed, when no row ever comes", async () => {
    // The other half of blocker 6, and the reason the client stopped deriving
    // this field from the absence of an abandon row. Here the Core appends
    // nothing at all — an `appendEvent` that is failing, a store that cannot
    // open — so there is no row for the ordering above to carry, and the exit
    // is the only thing that arrives. `true` would be "nothing told me
    // otherwise" dressed as a report; `null` is what actually happened.
    const { exitPty, spawns } = await coreWithSessions({
      onPromptDelivery: null,
      liveEventPollMs: 2_000,
    });

    const running = fixture!.run(
      ["session", "resume", "task_done", "carry", "on", "--wait", "--json"],
      withCore(),
    );
    await waitFor(() => spawns() > 0, "the Core spawned the harness");
    exitPty("pty_task_done");

    const run = await running;
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.exited).toBe(true);
    expect(payload.promptDelivered).toBeNull();
    expect(payload.promptAbandonedReason).toBeUndefined();
  }, 60_000);

  it("refuses rather than waits when the Core cannot say where its log ends (#494 review, blocker 2)", async () => {
    // The other half of blocker 2, and the one that covers a Core older than
    // `session:promptDelivered` as well as this one, which has no event-log
    // port wired at all. Neither will ever append the row this wait is for.
    //
    // The absence of `tipEventId` on the replay marker is the signal, and it
    // arrives one frame after the subscribe — so the answer comes at once
    // instead of never.
    await coreWithSessions({ eventLog: false, onPromptDelivery: null });

    const run = await fixture!.run(
      ["session", "resume", "task_done", "carry", "on", "--await-prompt", "--json"],
      withCore(),
    );
    expect(run.code).toBe(EXIT_FAILURE);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.promptDelivered).toBeNull();
    expect(payload.promptUnknownReason).toContain("event log");
  }, 60_000);

  it("refuses on a Core whose event log is wired but cannot be reached (#495 gate review, blocker 7)", async () => {
    // **The hang.** The test above covers `eventLog: false` — no port at all —
    // and that path already worked, because `tipEventId` was simply absent. The
    // Core an operator actually runs never takes it: `core-entry.ts` always
    // wires the log, so a store that cannot open is a *wired* port answering
    // every call and recording nothing.
    //
    // That Core used to advertise `tipEventId: 0`. Zero is a real floor, so the
    // latch armed and waited; `appendEvent` returned `0` without throwing, so
    // no row was ever appended; and `--await-prompt` refuses `--wait-timeout`,
    // which left the harness exiting or the socket dropping as the only bounds.
    // Nothing here does either, so on the old code this test does not fail — it
    // does not finish.
    await coreWithSessions({ eventLog: "unavailable", onPromptDelivery: null });

    const run = await fixture!.run(
      ["session", "resume", "task_done", "carry", "on", "--await-prompt", "--json"],
      withCore(),
    );
    expect(run.code).toBe(EXIT_FAILURE);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.promptDelivered).toBeNull();
    expect(payload.promptUnknownReason).toContain("event log");
  }, 60_000);

  it("does not call a prompt typed on the quiet gap a delivery (#494 review, blocker 3)", async () => {
    // **Blocker 3.** A harness with no `HARNESS_READINESS` row — `codex` today
    // — is typed into when the screen stops moving, because `composerOnScreen`
    // is `true` for it without looking at anything. That is #483's generic
    // backstop, deliberately preserved, and it is a fine way to deliver. It is
    // not evidence: roughly one codex boot in three settles with a trust dialog
    // on screen, which is the failure #395's criterion names by hand.
    //
    // So the Core carries `composerObserved` on the row and this exits non-zero
    // rather than printing "this session can take a send now" over a prompt
    // that may be sitting in a dialog.
    await coreWithSessions({ onPromptDelivery: "blind" });

    const run = await fixture!.run(
      ["session", "resume", "task_done", "carry", "on", "--await-prompt", "--json"],
      withCore(),
    );
    expect(run.code).toBe(EXIT_FAILURE);
    const payload = JSON.parse(run.out.join("\n"));
    // Not `false`: the Core did not give up, and telling an operator the prompt
    // was lost would send them to re-send text that may well be in the composer.
    expect(payload.promptDelivered).toBeNull();
    expect(payload.composerObserved).toBe(false);
    expect(payload.promptAbandonedReason).toBeUndefined();
  }, 60_000);

  it("refuses to wait after a delivery the Core did not stamp, rather than answering with the turn before", async () => {
    // The Core here is on this protocol version and still cannot stamp: no
    // event-log port is wired. Falling through to an uncursored wait would
    // resolve from the status the Session was already parked at — last turn's
    // answer, with a zero exit — which is the exact lie the cursor exists to
    // prevent. It refuses instead.
    const { writes } = await coreWithSessions({ eventLog: false });

    const run = await fixture!.run(
      ["session", "send", "task_live", "carry on", "--enter", "--wait", "--json"],
      withCore(),
    );

    expect(run.code).toBe(EXIT_FAILURE);
    const error = String(JSON.parse(run.out.join("\n")).error);
    expect(error).toContain("did not record the delivery");
    // And it says the text landed, because the next thing an operator does
    // with this failure must not be to send it a second time.
    expect(error).toContain("The text was delivered");
    expect(writes).toEqual(["carry on", "\r"]);
  }, 30_000);

  it("waits on a Session that was archived while its harness kept running", async () => {
    // `tasksList` is active rows only by design (ADR 0019), and every other
    // verb that names a live PTY works on an archived Session. Refusing here
    // would make `wait` the odd one out over a row it reads two display fields
    // off.
    const { endTurn, eventLog } = await coreWithSessions({ archived: ["task_live"] });

    const waiting = fixture!.run(["session", "wait", "task_live", "--json"], withCore());
    await waitFor(() => eventLog.tailReads > 0, "the wait subscribed to the event log");
    endTurn("task_live", "finished");

    const settled = await waiting;
    expect(settled.code, settled.err.join("\n")).toBe(EXIT_OK);
    expect(JSON.parse(settled.out.join("\n"))).toMatchObject({
      taskId: "task_live",
      status: "finished",
      // Read off the archived row rather than lost with it.
      harness: "claude-code",
    });
  }, 60_000);

  it("says a stopped Session has no transcript rather than printing an empty one", async () => {
    await coreWithSessions();

    const run = await fixture!.run(["session", "logs", "task_done", "--json"], withCore());
    expect(run.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(run.out.join("\n")).error).toContain("no harness running");
    expect(run.err.join("\n")).toContain("actana session logs");
  }, 30_000);

  it("puts nothing but JSON on stdout, on the failing path as well as the happy one", async () => {
    await coreWithSessions();

    for (const argv of [
      ["session", "ls", "--json", "--verbose"],
      ["session", "logs", "task_live", "--json", "--verbose"],
      ["session", "logs", "task_missing", "--json", "--verbose"],
      ["session", "kill", "task_missing", "--json", "--verbose"],
    ]) {
      const run = await fixture!.run(argv, withCore());
      // One document, parsed whole. A single stray progress line would throw.
      expect(() => JSON.parse(run.out.join("\n")), `${argv.join(" ")} put prose on stdout`).not.toThrow();
      expect(run.err.length, `${argv.join(" ")} sent nothing to stderr`).toBeGreaterThan(0);
    }
  }, 30_000);
});
