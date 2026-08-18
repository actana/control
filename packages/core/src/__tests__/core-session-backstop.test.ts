import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapCoreDb } from "../core-db-bootstrap";
import {
  configureCoreMutationStore,
  coreMutationStore,
  disposeCoreMutationStore,
} from "../core-mutation-store";
import {
  configureCoreQueryStore,
  coreQueryStore,
  disposeCoreQueryStore,
  listActiveTasks,
} from "../core-query-store";
import {
  appendEvent,
  configureEventLogStore,
  disposeEventLogStore,
  getLastEventId,
  readEventTail,
} from "../event-log-store";
import { CoreTaskWriter } from "../core-task-writer";
import { CoreSessionBackstop } from "../core-session-backstop";
import { clearSubagentActivity } from "@actana/shared/subagent-activity";

// The backstop nobody has to arm (issue 243 part 2), against this Core's real
// SQLite and event log.
//
// The case that matters is the one the drain backstop cannot reach: a turn
// whose terminal `Stop` was the POST that dropped. Nothing was held, nothing
// was armed, no subagent was tracked — the row simply says `running` with no
// timer watching it. Every test below starts from exactly that row.

const QUIET_MS = 15 * 60 * 1000;
const MINUTE = 60 * 1000;

describe("settling a turn whose end nobody reported", () => {
  let userDataDir: string;
  let writer: CoreTaskWriter;
  let nowMs: number;
  let livePtys: Set<string>;

  const makeBackstop = () =>
    new CoreSessionBackstop({
      listActiveTasks,
      writer,
      hasLivePty: (taskId) => livePtys.has(taskId),
      now: () => nowMs,
      quietMs: QUIET_MS,
    });

  const insert = (taskId: string, status: string) => {
    coreMutationStore.mutateTask({
      op: "create",
      taskId,
      projectId: "p1",
      title: taskId,
      agent: "claude-code",
      status,
    });
    livePtys.add(taskId);
  };
  const statusOf = (taskId: string) => coreQueryStore.getTask(taskId)?.status;
  const kindsSince = (eventId: number) => readEventTail(eventId, 100).map((e) => e.kind);

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-session-backstop-"));
    bootstrapCoreDb(userDataDir);
    configureCoreMutationStore(userDataDir);
    configureCoreQueryStore(userDataDir);
    configureEventLogStore(userDataDir);
    writer = new CoreTaskWriter({
      mutationPort: coreMutationStore,
      queryPort: coreQueryStore,
      eventLog: { appendEvent, getLastEventId, readEventTail },
    });
    coreMutationStore.mutateProject({
      op: "create",
      projectId: "p1",
      name: "Warehouse",
      path: userDataDir,
    });
    nowMs = Date.now();
    livePtys = new Set();
  });

  afterEach(() => {
    clearSubagentActivity("t-1");
    disposeCoreMutationStore();
    disposeCoreQueryStore();
    disposeEventLogStore();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it("finishes a Session that has gone quiet, with nothing having armed it", () => {
    insert("t-1", "running");
    const backstop = makeBackstop();
    const before = getLastEventId();

    // No hook was ever seen for this row, so no timer exists for it anywhere —
    // which is precisely the state a lost `Stop` leaves behind.
    nowMs += QUIET_MS + MINUTE;
    expect(backstop.sweepOnce()).toEqual(["t-1"]);

    expect(statusOf("t-1")).toBe("finished");
    // The finish the operator never got: card, toast and notification all
    // route on this event (ADR 0008).
    expect(kindsSince(before)).toContain("session:finished");
  });

  it("leaves a turn alone while its harness is still talking", () => {
    insert("t-1", "running");
    const backstop = makeBackstop();

    // A long turn: hours of work, output all the way through. Every chunk of
    // PTY output and every hook lands here.
    for (let minute = 0; minute < 120; minute += 1) {
      nowMs += MINUTE;
      backstop.noteActivity("t-1");
      expect(backstop.sweepOnce()).toEqual([]);
    }
    expect(statusOf("t-1")).toBe("running");

    // Then the turn ends and its `Stop` drops. Nothing else is coming.
    nowMs += QUIET_MS + MINUTE;
    expect(backstop.sweepOnce()).toEqual(["t-1"]);
    expect(statusOf("t-1")).toBe("finished");
  });

  it("counts the row's own last write as the last thing heard from it", () => {
    // A Session this process has heard nothing about since boot — the restart
    // case — must not be settled for a silence that predates the Core.
    insert("t-1", "running");
    const backstop = makeBackstop();

    nowMs += QUIET_MS - MINUTE;
    expect(backstop.sweepOnce()).toEqual([]);
    nowMs += 2 * MINUTE;
    expect(backstop.sweepOnce()).toEqual(["t-1"]);
  });

  it("never settles a Session that is waiting on a human", () => {
    // `needs-input` may sit silent forever and still be true; a timer cannot
    // make it truer, and finishing it would hide a question.
    insert("t-1", "needs-input");
    const backstop = makeBackstop();

    nowMs += 10 * QUIET_MS;
    expect(backstop.sweepOnce()).toEqual([]);
    expect(statusOf("t-1")).toBe("needs-input");
  });

  it("calls a quiet Session with no PTY disconnected, not finished", () => {
    // No live PTY means the process went away without its exit being
    // recorded. That is not a finish, and it raises no finish notification.
    insert("t-1", "running");
    livePtys.delete("t-1");
    const backstop = makeBackstop();
    const before = getLastEventId();

    nowMs += QUIET_MS + MINUTE;
    expect(backstop.sweepOnce()).toEqual(["t-1"]);
    expect(statusOf("t-1")).toBe("disconnected");
    expect(kindsSince(before)).not.toContain("session:finished");
  });

  it("settles a row once, and the next sweep finds nothing to do", () => {
    insert("t-1", "running");
    const backstop = makeBackstop();

    nowMs += QUIET_MS + MINUTE;
    expect(backstop.sweepOnce()).toEqual(["t-1"]);
    const after = getLastEventId();

    nowMs += QUIET_MS;
    expect(backstop.sweepOnce()).toEqual([]);
    expect(getLastEventId()).toBe(after);
  });

  it("settles every quiet Session, not just the first", () => {
    insert("t-1", "running");
    insert("t-2", "running");
    insert("t-3", "running");
    const backstop = makeBackstop();

    nowMs += QUIET_MS + MINUTE;
    backstop.noteActivity("t-2");
    expect(backstop.sweepOnce().sort()).toEqual(["t-1", "t-3"]);
    expect(statusOf("t-2")).toBe("running");
  });

  it("stops watching a Session whose PTY exit already settled it", () => {
    insert("t-1", "running");
    const backstop = makeBackstop();
    backstop.noteActivity("t-1");
    backstop.forget("t-1");

    // The exit path settles the row; the backstop must not then re-settle it.
    coreMutationStore.mutateTask({ op: "update", taskId: "t-1", status: "terminated" });
    nowMs += QUIET_MS + MINUTE;
    expect(backstop.sweepOnce()).toEqual([]);
    expect(statusOf("t-1")).toBe("terminated");
  });

  it("runs on a timer without holding the process open", () => {
    insert("t-1", "running");
    const backstop = makeBackstop();
    backstop.start();
    // Idempotent start, and a stop that can be called on a stopped instance —
    // the shutdown path calls it unconditionally.
    backstop.start();
    backstop.stop();
    backstop.stop();
    expect(statusOf("t-1")).toBe("running");
  });
});
