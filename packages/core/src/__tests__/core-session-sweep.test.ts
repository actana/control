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
  listBootSweepSessions,
} from "../core-query-store";
import {
  appendEvent,
  configureEventLogStore,
  disposeEventLogStore,
  getLastEventId,
  readEventTail,
} from "../event-log-store";
import { CoreSessionWriter } from "../core-session-writer";
import { sweepStrandedSessions } from "../core-session-sweep";

/**
 * The log's tip, insisting there is a log. `getLastEventId` answers `null` for
 * a store it cannot reach (#495 gate review, addendum blocker 7); in this file
 * the store is a real temp DB, so a `null` is a broken fixture and not a case
 * worth folding into `0` — folding it would make an assertion pass for the
 * wrong reason.
 */
function lastEventId(): number {
  const id = getLastEventId();
  if (id === null) throw new Error("this test's event-log store is unavailable");
  return id;
}

// The boot sweep (issue 243 part 3), against this Core's real SQLite and real
// event log — the two things a stranded row is wrong in.
//
// The scenario is a Core restart: rows left claiming `running` by PTYs that
// died with the previous process, which no `onSessionExit` will ever fire for.
// Everything here starts from rows written the way the Core writes them, and
// asserts on what a Panel would actually see.

describe("settling the Sessions a Core restart stranded", () => {
  let userDataDir: string;
  let writer: CoreSessionWriter;

  const insert = (sessionId: string, status: string, archived = false) => {
    coreMutationStore.mutateSession({
      op: "create",
      sessionId,
      projectId: "p1",
      title: sessionId,
      agent: "claude-code",
      status,
    });
    if (archived) {
      coreMutationStore.mutateSession({ op: "update", sessionId, archived: true });
    }
  };
  const statusOf = (sessionId: string) => coreQueryStore.getSession(sessionId)?.status;
  /**
   * The `pty:spawn` the Core appends when it starts a harness for a session, in
   * the shape `recordPtySpawn` writes — `shellSession` included, because the
   * sweep's evidence query reads it.
   */
  const spawnPty = (sessionId: string) => {
    const ptyId = `pty-${sessionId}`;
    return appendEvent(
      "pty:spawn",
      JSON.stringify({ ptyId, sessionId, shellSession: false }),
      { ptyId, sessionId },
    );
  };

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-session-sweep-"));
    bootstrapCoreDb(userDataDir);
    configureCoreMutationStore(userDataDir);
    configureCoreQueryStore(userDataDir);
    configureEventLogStore(userDataDir);
    writer = new CoreSessionWriter({
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

    const settled = sweepStrandedSessions({ listBootSweepSessions, writer });

    expect(settled.sort()).toEqual(["t-running", "t-waiting"]);
    expect(statusOf("t-running")).toBe("disconnected");
    expect(statusOf("t-waiting")).toBe("disconnected");
  });

  it("leaves a Session that already settled exactly as it settled", () => {
    // The whole point of `disconnected` over `finished`: the sweep makes no
    // claim about work whose end was actually reported.
    insert("t-finished", "finished");
    insert("t-interrupted", "interrupted");
    // A Session the operator created and has not started: `ready`, no PTY, no
    // `pty:spawn` behind it. Issue 387 widened the sweep to `ready`, and this
    // row is the reason that widening is evidence-gated rather than a status
    // filter — a queue of unstarted work must not read as a fleet of deaths.
    insert("t-ready", "ready");

    expect(sweepStrandedSessions({ listBootSweepSessions, writer })).toEqual([]);
    expect(statusOf("t-finished")).toBe("finished");
    expect(statusOf("t-interrupted")).toBe("interrupted");
    expect(statusOf("t-ready")).toBe("ready");
  });

  it("sweeps the bare Session a dead PTY left on ready (issue 387)", () => {
    // The live pairdemo zombie: spawned before a container recreate, never
    // prompted, so `running` / `needs-input` never described it and no Stop
    // was ever going to arrive. It outlived the recreate on the old filter.
    insert("t-zombie", "ready");
    spawnPty("t-zombie");
    insert("t-unstarted", "ready");

    expect(sweepStrandedSessions({ listBootSweepSessions, writer })).toEqual([
      "t-zombie",
    ]);
    expect(statusOf("t-zombie")).toBe("disconnected");
    expect(statusOf("t-unstarted")).toBe("ready");
  });

  it("sweeps a leftover ready row alongside the rows that claim to be working", () => {
    insert("t-running", "running");
    insert("t-zombie", "ready");
    spawnPty("t-zombie");

    const settled = sweepStrandedSessions({ listBootSweepSessions, writer });

    expect(settled.sort()).toEqual(["t-running", "t-zombie"]);
    expect(statusOf("t-running")).toBe("disconnected");
    expect(statusOf("t-zombie")).toBe("disconnected");
  });

  it("settles a swept ready row without claiming its work finished", () => {
    insert("t-zombie", "ready");
    spawnPty("t-zombie");
    const before = lastEventId();

    sweepStrandedSessions({ listBootSweepSessions, writer });

    const appended = readEventTail(before, 100);
    expect(appended.filter((e) => e.kind === "session:updated").map((e) => e.sessionId)).toEqual([
      "t-zombie",
    ]);
    // Nobody knows how that Session would have ended — no ding rides out.
    expect(appended.map((e) => e.kind)).not.toContain("session:finished");
  });

  it("sweeps an archived row too — it is the same stale row, one tab away", () => {
    insert("t-archived", "running", true);
    const settled = sweepStrandedSessions({ listBootSweepSessions, writer });
    expect(settled).toEqual(["t-archived"]);
    expect(statusOf("t-archived")).toBe("disconnected");
  });

  it("appends the event a connected Panel re-renders the card from", () => {
    insert("t-running", "running");
    const before = lastEventId();

    sweepStrandedSessions({ listBootSweepSessions, writer });

    const appended = readEventTail(before, 100);
    const updates = appended.filter((e) => e.kind === "session:updated");
    expect(updates).toHaveLength(1);
    expect(updates[0].sessionId).toBe("t-running");
    // `disconnected` is not a finish, so no notification may ride out with it.
    expect(appended.map((e) => e.kind)).not.toContain("session:finished");
  });

  it("is a no-op on the second boot, because the first one settled everything", () => {
    insert("t-running", "running");
    sweepStrandedSessions({ listBootSweepSessions, writer });
    const after = lastEventId();

    expect(sweepStrandedSessions({ listBootSweepSessions, writer })).toEqual([]);
    expect(lastEventId()).toBe(after);
  });

  it("keeps sweeping when one row cannot be written", () => {
    insert("t-a", "running");
    insert("t-b", "running");
    // A row that goes away between the read and the write — a Panel deleting
    // a Session while this Core boots. It must cost that row, not the sweep.
    const failing = new CoreSessionWriter({
      mutationPort: {
        mutateProject: coreMutationStore.mutateProject,
        mutateSession: (mutation) => {
          if (mutation.op === "update" && mutation.sessionId === "t-a") {
            throw new Error("row vanished");
          }
          return coreMutationStore.mutateSession(mutation);
        },
        listSessions: coreMutationStore.listSessions,
      },
      queryPort: coreQueryStore,
      eventLog: { appendEvent, getLastEventId, readEventTail },
    });

    expect(sweepStrandedSessions({ listBootSweepSessions, writer: failing })).toEqual(["t-b"]);
    expect(statusOf("t-b")).toBe("disconnected");
    expect(statusOf("t-a")).toBe("running");
  });

  it("sweeps nothing, and says nothing, on a Core with no stranded rows", () => {
    const before = lastEventId();
    expect(sweepStrandedSessions({ listBootSweepSessions, writer })).toEqual([]);
    expect(lastEventId()).toBe(before);
  });
});
