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
function livePtyCore(): {
  core: unknown;
  writes: string[];
  killed: string[];
  resolutions: string[];
  /** The same lookup, uncounted — for the query ports, which are not a verb. */
  ptyFor: (taskId: string) => string | null;
} {
  const writes: string[] = [];
  const killed: string[] = [];
  // Every `findByTask` this Core is asked, so a verb that resolves the PTY
  // twice — and opens a window between the two — is visible rather than
  // arguable (#289: one resolution for the write and the wait).
  const resolutions: string[] = [];
  const ptys = new Map<string, string>([["task_live", "pty_live"]]);
  const core = {
    setEmitTarget: () => {},
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
    spawn: () => {
      throw new Error("this suite does not spawn — see the header");
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
    eventLog?: false;
    /** Archive a row while its harness keeps running. */
    archived?: string[];
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
}> {
  const pty = livePtyCore();
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
  core = await startInProcessCore({
    ptyCore: pty.core,
    queryPort,
    mutationPort,
    // The live-event push, at test speed. A wait resolves when the status event
    // reaches the client, and the Core's default poll is 500 ms — which is fine
    // for a person and is most of the wall clock of a suite that waits twice,
    // on a machine already running five other packages' tests.
    liveEventPollMs: 25,
    ...(opts.eventLog === false ? {} : { eventLog }),
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
    expect(JSON.parse(settled.out.join("\n"))).toMatchObject({
      taskId: "task_live",
      status: "finished",
      promptDelivered: true,
    });
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
    expect(JSON.parse(settled.out.join("\n"))).toMatchObject({
      taskId: "task_live",
      status: "finished",
      promptDelivered: true,
    });
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
