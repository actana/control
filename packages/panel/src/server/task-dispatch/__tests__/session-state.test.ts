import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sessionStateForCoreStatus } from "~/shared/tasks";
import { closePanelTestDb, openPanelTestDb } from "../../__tests__/_panel-test-db";
import { FakeClock, FakeCore, FakeShared, collectingLog } from "./fakes";

/**
 * The Session state a Task carries (#949, part p1): `markSessionState` on the result watcher, the real Tasks
 * service on a real (PGlite or Postgres) database, a fake Core and a fake Shared folder, a clock moved by hand.
 */

const testDb = await openPanelTestDb();
const { TaskDispatcher } = await import("../dispatcher");
const { ResultWatcher } = await import("../result-watcher");
const { stopTaskRun } = await import("../stop-task");
const { createTask, getTask, listTaskComments, listTasksPage } = await import("../../services/tasks");
const { NotFoundError } = await import("../../errors");

const A = 1;
const GRACE_MS = 10_000;
const AGENT = {
  id: "agent_1",
  ownerId: A,
  coreId: "core_1",
  name: "Claude Code",
  harness: "claude-code" as const,
  model: "claude-sonnet-5-5",
  flags: ["skip-permissions"],
  isDefault: false,
  createdAt: 1,
  updatedAt: 1,
};

beforeAll(async () => {
  await testDb.pool.query(
    "insert into operator (id, name, password_hash, created_at, password_changed_at) values ($1, $2, 'h', 1, 1) on conflict do nothing",
    [A, `owner-${A}`],
  );
});
beforeEach(async () => {
  await testDb.pool.query("truncate tasks cascade");
});
afterAll(async () => {
  await closePanelTestDb(testDb);
});

function rig() {
  const clock = new FakeClock();
  const shared = new FakeShared(clock);
  const core = new FakeCore();
  const log = collectingLog();
  const agents = {
    get: async () => AGENT,
    resolve: async (_owner: number, id: string) => {
      if (id !== AGENT.id) throw new NotFoundError("agent not found");
      return { agentId: AGENT.id, coreId: AGENT.coreId, harness: AGENT.harness, model: AGENT.model, flags: [...AGENT.flags] };
    },
  };
  const watcher = new ResultWatcher({ ownerId: A, now: clock.now, exitGraceMs: GRACE_MS, log, stopSession: core.stopSession, liveSessions: core.liveSessions });
  const dispatcher = new TaskDispatcher({ ownerId: A, startSession: core.startSession, sharedFor: async () => shared, watcher, stopSession: core.stopSession, agents, now: clock.now, log });
  return { clock, shared, core, log, watcher, dispatcher };
}

/** A Task that is dispatched and running. */
async function running() {
  const r = rig();
  const task = await createTask(A, { title: "Fix the build", description: "Red on main.", agent: AGENT.id, startNow: true, timeoutMinutes: null }, r.clock.now());
  await r.dispatcher.dispatchOnce();
  r.clock.advance(1_000);
  return { ...r, task };
}

const report = (text: string) => `${text}\n\nACT-REPORT-END\n`;
const resultPath = (id: string, name: string) => `tasks/${id}/${name}`;
/** The system comments that are about the Session's state, not the dispatch. */
async function stateComments(id: string) {
  return (await listTaskComments(A, id)).filter((c) => c.authorKind === "system" && c.body.startsWith("The agent's Session"));
}

describe("the Session state of a Task (#949)", () => {
  it("has none before anything is reported", async () => {
    const { task } = await running();
    expect(await getTask(A, task.id)).toMatchObject({ status: "in_progress", sessionState: null, sessionStateAt: null });
  });

  it("records running → needs-input → running → finished, comments exactly twice, and clears on the result file", async () => {
    const { clock, shared, watcher, task } = await running();
    const seen: (string | null)[] = [];
    for (const status of ["running", "needs-input", "running"]) {
      clock.advance(1_000);
      await watcher.markSessionState(task.id, sessionStateForCoreStatus(status)!);
      seen.push((await getTask(A, task.id)).sessionState);
    }
    expect(seen).toEqual(["working", "needs-input", "working"]);
    expect((await stateComments(task.id)).map((c) => c.body)).toEqual([
      "The agent's Session needs input (it is waiting at a prompt).",
      "The agent's Session is working again.",
    ]);

    // The Session finishes, with its result file: the Task ends and the state goes with it.
    shared.write(resultPath(task.id, "success.md"), report("Done."), clock.now());
    await watcher.tick();
    await watcher.markSessionState(task.id, sessionStateForCoreStatus("finished")!);

    expect(await getTask(A, task.id)).toMatchObject({ status: "done", sessionState: null, sessionStateAt: null });
    expect(await stateComments(task.id)).toHaveLength(2);
  });

  it("writes exactly two system comments for running → needs-input → running", async () => {
    const { clock, watcher, task } = await running();
    for (const status of ["running", "needs-input", "running"]) {
      clock.advance(1_000);
      await watcher.markSessionState(task.id, sessionStateForCoreStatus(status)!);
    }
    expect(await stateComments(task.id)).toHaveLength(2);
    expect(await getTask(A, task.id)).toMatchObject({ sessionState: "working", status: "in_progress" });
  });

  it("stamps the time of the change", async () => {
    const { clock, watcher, task } = await running();
    await watcher.markSessionState(task.id, "needs-input");
    expect((await getTask(A, task.id)).sessionStateAt).toBe(clock.now());
  });

  it("writes nothing for working → working, nor for a repeated state", async () => {
    const { clock, watcher, task } = await running();
    await watcher.markSessionState(task.id, "working");
    const first = await getTask(A, task.id);
    clock.advance(5_000);
    await watcher.markSessionState(task.id, "working");
    await watcher.markSessionState(task.id, "needs-input");
    const second = await getTask(A, task.id);
    clock.advance(5_000);
    await watcher.markSessionState(task.id, "needs-input");
    const third = await getTask(A, task.id);

    expect(first.sessionStateAt).toBe(clock.now() - 10_000);
    expect(second.sessionStateAt).toBe(clock.now() - 5_000);
    expect(third.sessionStateAt).toBe(second.sessionStateAt);
    expect(await stateComments(task.id)).toHaveLength(1);
  });

  it("does not comment on the first working, nor on exited", async () => {
    const { watcher, task } = await running();
    await watcher.markSessionState(task.id, "working");
    await watcher.markSessionState(task.id, "exited");
    expect(await stateComments(task.id)).toHaveLength(0);
    expect((await getTask(A, task.id)).sessionState).toBe("exited");
  });

  it("never moves the Task's status, not even for exited or idle-no-result", async () => {
    const { watcher, task } = await running();
    for (const state of ["working", "needs-input", "interrupted", "idle-no-result", "exited"] as const) {
      await watcher.markSessionState(task.id, state);
      expect((await getTask(A, task.id)).status).toBe("in_progress");
    }
  });

  it("does not touch the Task's updatedAt, so the board's order does not move", async () => {
    const { clock, watcher, task } = await running();
    const before = (await getTask(A, task.id)).updatedAt;
    clock.advance(5_000);
    await watcher.markSessionState(task.id, "needs-input");
    expect((await getTask(A, task.id)).updatedAt).toBe(before);
  });

  it("with no result file, finished is idle-no-result, and a later result file still finishes the Task", async () => {
    const { clock, shared, watcher, task } = await running();
    await watcher.markSessionState(task.id, sessionStateForCoreStatus("finished")!);
    await watcher.tick();
    expect(await getTask(A, task.id)).toMatchObject({ status: "in_progress", sessionState: "idle-no-result" });
    expect(await stateComments(task.id)).toHaveLength(1);

    clock.advance(30_000);
    shared.write(resultPath(task.id, "success.md"), report("All good."), clock.now());
    await watcher.tick();

    expect(await getTask(A, task.id)).toMatchObject({ status: "done", sessionState: null, sessionStateAt: null });
  });

  it("finished with a complete result file already there finishes the Task: no idle-no-result state, comment or webhook", async () => {
    const { shared, watcher, task, clock } = await running();
    shared.write(resultPath(task.id, "success.md"), report("Done."), clock.now());
    await watcher.markSessionState(task.id, sessionStateForCoreStatus("finished")!);

    expect(await getTask(A, task.id)).toMatchObject({ status: "done", sessionState: null, sessionStateAt: null });
    expect(await stateComments(task.id)).toHaveLength(0);
    const rows = await testDb.pool.query(
      "select 1 from webhook_outbox where event_type = 'task.session_state_changed' and payload like $1",
      [`%${task.id}%`],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("ignores a state for a Task the watcher is not watching", async () => {
    const { watcher, task } = await running();
    watcher.untrack(task.id);
    await watcher.markSessionState(task.id, "needs-input");
    expect((await getTask(A, task.id)).sessionState).toBeNull();
    await watcher.markSessionState("task_missing", "needs-input");
  });

  it("writes nothing once the Task has ended, and does not throw", async () => {
    const { clock, shared, watcher, task, log } = await running();
    shared.write(resultPath(task.id, "fail.md"), report("Nope."), clock.now());
    await watcher.tick();
    expect((await getTask(A, task.id)).status).toBe("failed");
    await watcher.markSessionState(task.id, "needs-input");
    expect(await getTask(A, task.id)).toMatchObject({ sessionState: null, sessionStateAt: null });
    expect(log.errors).toEqual([]);
  });

  it("clears on partial and fail result files", async () => {
    for (const name of ["partial-1.md", "fail.md"]) {
      const { clock, shared, watcher, task } = await running();
      await watcher.markSessionState(task.id, "interrupted");
      shared.write(resultPath(task.id, name), report("Some."), clock.now());
      await watcher.tick();
      expect(await getTask(A, task.id)).toMatchObject({ sessionState: null, sessionStateAt: null });
    }
  });

  it("records exited when the agent's process exits, and clears it with the synthesized fail.md", async () => {
    const { clock, core, watcher, task } = await running();
    await watcher.markSessionState(task.id, "needs-input");
    core.sessions[0]!.exit(1);
    watcher.markExited(task.id, 1);

    await watcher.tick();
    expect(await getTask(A, task.id)).toMatchObject({ status: "in_progress", sessionState: "exited" });
    // no second comment for exited
    expect(await stateComments(task.id)).toHaveLength(1);

    clock.advance(GRACE_MS);
    await watcher.tick();
    expect(await getTask(A, task.id)).toMatchObject({ status: "failed", sessionState: null, sessionStateAt: null });
  });

  it("clears on a stop", async () => {
    const { clock, core, watcher, task, log } = await running();
    await watcher.markSessionState(task.id, "needs-input");
    await stopTaskRun(A, task.id, { stoppedBy: "Operator" }, { watcher, stopSession: core.stopSession, now: clock.now, log });
    expect(await getTask(A, task.id)).toMatchObject({ status: "failed", sessionState: null, sessionStateAt: null });
  });

  it("clears on a timeout", async () => {
    const r = rig();
    const task = await createTask(A, { title: "t", description: "d", agent: AGENT.id, startNow: true, timeoutMinutes: 1 }, r.clock.now());
    await r.dispatcher.dispatchOnce();
    await r.watcher.markSessionState(task.id, "needs-input");
    r.clock.advance(60_000);
    await r.watcher.tick();
    expect(await getTask(A, task.id)).toMatchObject({ status: "failed", sessionState: null, sessionStateAt: null });
  });

  it("starts the next attempt with no state", async () => {
    const { clock, shared, watcher, dispatcher, task } = await (async () => {
      const r = await running();
      return r;
    })();
    await watcher.markSessionState(task.id, "needs-input");
    shared.write(resultPath(task.id, "fail.md"), report("Nope."), clock.now());
    await watcher.tick();
    const { commentAndReassign } = await import("../../services/tasks");
    await commentAndReassign(A, task.id, { authorKind: "user", authorName: "Operator", body: "Again." }, clock.now());
    clock.advance(1_000);
    await dispatcher.dispatchOnce();
    expect(await getTask(A, task.id)).toMatchObject({ status: "in_progress", attemptCount: 2, sessionState: null, sessionStateAt: null });
  });

  it("is on the Task's list rows too", async () => {
    const { watcher, task } = await running();
    await watcher.markSessionState(task.id, "needs-input");
    const page = await listTasksPage(A, { statuses: ["in_progress"], limit: 10 });
    expect(page.tasks.find((t) => t.id === task.id)).toMatchObject({ sessionState: "needs-input" });
  });
});
