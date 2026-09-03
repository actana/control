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
  taskProvenNeverWorked,
} from "../core-query-store";
import {
  appendEvent,
  configureEventLogStore,
  disposeEventLogStore,
  getLastEventId,
  readEventTail,
} from "../event-log-store";
import { CoreTaskWriter } from "../core-task-writer";
import { readySessionOnAgentSpawn } from "../core-session-relaunch";

// The other half of issue 387, against this Core's real SQLite and real event
// log. The sweep moves a bare Session OFF `ready`; this is what puts it back
// when a harness is spawned for it again — and what must not touch a Session
// that actually worked.

describe("putting a relaunched Session back on ready", () => {
  let userDataDir: string;
  let writer: CoreTaskWriter;

  const insert = (taskId: string, status: string) => {
    coreMutationStore.mutateTask({
      op: "create",
      taskId,
      projectId: "p1",
      title: taskId,
      agent: "claude-code",
      status: "ready",
    });
    // Written as a patch, not as the create's status, so the row's history in
    // the event log is the one a real Session leaves behind.
    if (status !== "ready") writer.mutate({ op: "update", taskId, status });
  };
  const statusOf = (taskId: string) => coreQueryStore.getTask(taskId)?.status;
  /**
   * A `task:updated` in the shape `CoreTaskWriter` wrote it BEFORE v0.4.0 —
   * `{taskId, projectId}` and no status (2dd34a8 added the status field). The
   * only way to reproduce the history a Core upgraded from 0.3.x still holds.
   */
  const legacyUpdate = (taskId: string) =>
    appendEvent("task:updated", JSON.stringify({ taskId, projectId: "p1" }), { taskId });
  const relaunch = (taskId: string) =>
    readySessionOnAgentSpawn({ writer, provenNeverWorked: taskProvenNeverWorked }, taskId);

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-session-relaunch-"));
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

  it("resets the bare Session the sweep settled", () => {
    // Exactly the row issue 387 strands: created `ready`, never prompted,
    // settled `disconnected` when its PTY died. A harness is up for it again.
    insert("t-bare", "disconnected");

    expect(relaunch("t-bare")).toBe(true);
    expect(statusOf("t-bare")).toBe("ready");
  });

  it("leaves a Session that actually worked exactly as it settled", () => {
    // `finished` is the operator's record of what that Session did, and
    // reopening it is a resume, not a fresh start.
    insert("t-worked", "running");
    writer.mutate({ op: "update", taskId: "t-worked", status: "finished" });

    expect(relaunch("t-worked")).toBe(false);
    expect(statusOf("t-worked")).toBe("finished");
  });

  it("leaves a Session that worked and was then swept", () => {
    // The sweep settles a `running` row to `disconnected` too. That row has a
    // turn behind it, so the same `disconnected` must not be reset.
    insert("t-swept", "running");
    writer.mutate({ op: "update", taskId: "t-swept", status: "disconnected" });

    expect(relaunch("t-swept")).toBe(false);
    expect(statusOf("t-swept")).toBe("disconnected");
  });

  it("does not reset a legacy finished row whose updates carry no status", () => {
    // A Core upgraded from 0.3.x. This Session ran for hours and finished; its
    // whole history predates the status field, so the event log holds no proof
    // either way. Read as "did any turn happen" the answer comes out backwards
    // and destroys the operator's record — so the reset must not fire, and the
    // status check must not offer `finished` as a candidate in the first place.
    coreMutationStore.mutateTask({
      op: "create",
      taskId: "t-legacy",
      projectId: "p1",
      title: "t-legacy",
      agent: "claude-code",
      status: "finished",
    });
    legacyUpdate("t-legacy");
    legacyUpdate("t-legacy");

    expect(relaunch("t-legacy")).toBe(false);
    expect(statusOf("t-legacy")).toBe("finished");
  });

  it("does not reset a legacy disconnected row either", () => {
    // The same old log, on the one status the reset does consider. Here the
    // narrowed status set gives no protection at all and the evidence check is
    // the only thing standing between a Session that worked and a wiped card.
    coreMutationStore.mutateTask({
      op: "create",
      taskId: "t-legacy-gone",
      projectId: "p1",
      title: "t-legacy-gone",
      agent: "claude-code",
      status: "disconnected",
    });
    legacyUpdate("t-legacy-gone");

    expect(relaunch("t-legacy-gone")).toBe(false);
    expect(statusOf("t-legacy-gone")).toBe("disconnected");
  });

  it("never considers a status a never-worked Session cannot be wearing", () => {
    // Before issue 387 `ready` was one-way, and the only status this Core's own
    // settles write for a never-worked row is `disconnected`. So these three
    // are unreachable by construction, and are not candidates — no log read
    // needed, and none trusted.
    for (const status of ["finished", "terminated", "interrupted"]) {
      const taskId = `t-${status}`;
      insert(taskId, status);
      expect(relaunch(taskId)).toBe(false);
      expect(statusOf(taskId)).toBe(status);
    }
  });

  it("does not disturb a live turn, or a Session already ready", () => {
    insert("t-running", "running");
    insert("t-waiting", "needs-input");
    insert("t-ready", "ready");

    expect(relaunch("t-running")).toBe(false);
    expect(relaunch("t-waiting")).toBe(false);
    expect(relaunch("t-ready")).toBe(false);
    expect(statusOf("t-running")).toBe("running");
    expect(statusOf("t-waiting")).toBe("needs-input");
    expect(statusOf("t-ready")).toBe("ready");
  });

  it("appends the event a connected Panel re-renders the card from", () => {
    insert("t-bare", "disconnected");
    const before = getLastEventId();

    relaunch("t-bare");

    const appended = readEventTail(before, 100);
    const updates = appended.filter((e) => e.kind === "task:updated");
    expect(updates).toHaveLength(1);
    expect(updates[0].taskId).toBe("t-bare");
    expect(appended.map((e) => e.kind)).not.toContain("session:finished");
  });

  it("is a no-op the second time, because the first one moved the row", () => {
    insert("t-bare", "disconnected");
    expect(relaunch("t-bare")).toBe(true);
    const after = getLastEventId();

    expect(relaunch("t-bare")).toBe(false);
    expect(getLastEventId()).toBe(after);
  });

  it("stays quiet about a Session this Core does not have", () => {
    expect(relaunch("t-missing")).toBe(false);
    expect(relaunch("")).toBe(false);
  });

  it("does not let a failed write take the spawn down", () => {
    insert("t-bare", "disconnected");
    const failing = new CoreTaskWriter({
      mutationPort: {
        mutateProject: coreMutationStore.mutateProject,
        mutateTask: (mutation) => {
          if (mutation.op === "update") throw new Error("row vanished");
          return coreMutationStore.mutateTask(mutation);
        },
        listSessions: coreMutationStore.listSessions,
      },
      queryPort: coreQueryStore,
      eventLog: { appendEvent, getLastEventId, readEventTail },
    });

    expect(
      readySessionOnAgentSpawn(
        { writer: failing, provenNeverWorked: taskProvenNeverWorked },
        "t-bare",
      ),
    ).toBe(false);
    expect(statusOf("t-bare")).toBe("disconnected");
  });
});
