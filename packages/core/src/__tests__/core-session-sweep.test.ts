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
import { sweepStrandedSessions } from "../core-session-sweep";

// The boot sweep (issue 243 part 3), against this Core's real SQLite and real
// event log — the two things a stranded row is wrong in.
//
// The scenario is a Core restart: rows left claiming `running` by PTYs that
// died with the previous process, which no `onSessionExit` will ever fire for.
// Everything here starts from rows written the way the Core writes them, and
// asserts on what a Panel would actually see.

describe("settling the Sessions a Core restart stranded", () => {
  let userDataDir: string;
  let writer: CoreTaskWriter;

  const insert = (taskId: string, status: string, archived = false) => {
    coreMutationStore.mutateTask({
      op: "create",
      taskId,
      projectId: "p1",
      title: taskId,
      agent: "claude-code",
      status,
    });
    if (archived) {
      coreMutationStore.mutateTask({ op: "update", taskId, archived: true });
    }
  };
  const statusOf = (taskId: string) => coreQueryStore.getTask(taskId)?.status;

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-session-sweep-"));
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
  });

  afterEach(() => {
    disposeCoreMutationStore();
    disposeCoreQueryStore();
    disposeEventLogStore();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it("marks every row still claiming a live process as disconnected", () => {
    insert("t-running", "running");
    insert("t-waiting", "needs-input");

    const settled = sweepStrandedSessions({ listActiveTasks, writer });

    expect(settled.sort()).toEqual(["t-running", "t-waiting"]);
    expect(statusOf("t-running")).toBe("disconnected");
    expect(statusOf("t-waiting")).toBe("disconnected");
  });

  it("leaves a Session that already settled exactly as it settled", () => {
    // The whole point of `disconnected` over `finished`: the sweep makes no
    // claim about work whose end was actually reported.
    insert("t-finished", "finished");
    insert("t-interrupted", "interrupted");
    insert("t-ready", "ready");

    expect(sweepStrandedSessions({ listActiveTasks, writer })).toEqual([]);
    expect(statusOf("t-finished")).toBe("finished");
    expect(statusOf("t-interrupted")).toBe("interrupted");
    expect(statusOf("t-ready")).toBe("ready");
  });

  it("sweeps an archived row too — it is the same stale row, one tab away", () => {
    insert("t-archived", "running", true);
    expect(sweepStrandedSessions({ listActiveTasks, writer })).toEqual(["t-archived"]);
    expect(statusOf("t-archived")).toBe("disconnected");
  });

  it("appends the event a connected Panel re-renders the card from", () => {
    insert("t-running", "running");
    const before = getLastEventId();

    sweepStrandedSessions({ listActiveTasks, writer });

    const appended = readEventTail(before, 100);
    const updates = appended.filter((e) => e.kind === "task:updated");
    expect(updates).toHaveLength(1);
    expect(updates[0].taskId).toBe("t-running");
    // `disconnected` is not a finish, so no notification may ride out with it.
    expect(appended.map((e) => e.kind)).not.toContain("session:finished");
  });

  it("is a no-op on the second boot, because the first one settled everything", () => {
    insert("t-running", "running");
    sweepStrandedSessions({ listActiveTasks, writer });
    const after = getLastEventId();

    expect(sweepStrandedSessions({ listActiveTasks, writer })).toEqual([]);
    expect(getLastEventId()).toBe(after);
  });

  it("keeps sweeping when one row cannot be written", () => {
    insert("t-a", "running");
    insert("t-b", "running");
    // A row that goes away between the read and the write — a Panel deleting
    // a Session while this Core boots. It must cost that row, not the sweep.
    const failing = new CoreTaskWriter({
      mutationPort: {
        mutateProject: coreMutationStore.mutateProject,
        mutateTask: (mutation) => {
          if (mutation.op === "update" && mutation.taskId === "t-a") {
            throw new Error("row vanished");
          }
          return coreMutationStore.mutateTask(mutation);
        },
        listSessions: coreMutationStore.listSessions,
      },
      queryPort: coreQueryStore,
      eventLog: { appendEvent, getLastEventId, readEventTail },
    });

    expect(sweepStrandedSessions({ listActiveTasks, writer: failing })).toEqual(["t-b"]);
    expect(statusOf("t-b")).toBe("disconnected");
    expect(statusOf("t-a")).toBe("running");
  });

  it("sweeps nothing, and says nothing, on a Core with no stranded rows", () => {
    const before = getLastEventId();
    expect(sweepStrandedSessions({ listActiveTasks, writer })).toEqual([]);
    expect(getLastEventId()).toBe(before);
  });
});
