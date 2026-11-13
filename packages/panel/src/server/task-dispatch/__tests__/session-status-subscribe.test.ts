import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb } from "../../__tests__/_panel-test-db";
import { FakeClock, FakeCore, FakeShared, collectingLog } from "./fakes";

/**
 * The Session state of a Task follows the Core's status (#949, part p2): the dispatcher subscribes to the
 * Session's status, a Task adopted at Panel boot reads it once on adoption and again in the minute pass. The real
 * Tasks service on a real (PGlite or Postgres) database, a fake Core and a fake Shared folder.
 */

const testDb = await openPanelTestDb();
const { TaskDispatcher } = await import("../dispatcher");
const { ResultWatcher } = await import("../result-watcher");
const { createTask, getTask, listTaskComments } = await import("../../services/tasks");
const { NotFoundError } = await import("../../errors");

const A = 1;
const MINUTE_MS = 60_000;
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

function rig(clock = new FakeClock(), shared = new FakeShared(clock), core = new FakeCore()) {
  const log = collectingLog();
  const agents = {
    get: async () => AGENT,
    resolve: async (_owner: number, id: string) => {
      if (id !== AGENT.id) throw new NotFoundError("agent not found");
      return { agentId: AGENT.id, coreId: AGENT.coreId, harness: AGENT.harness, model: AGENT.model, flags: [...AGENT.flags] };
    },
  };
  const watcher = new ResultWatcher({
    ownerId: A,
    now: clock.now,
    exitGraceMs: 10_000,
    log,
    stopSession: core.stopSession,
    liveSessions: core.liveSessions,
    sessionStatuses: core.sessionStatuses,
    minutePassMs: MINUTE_MS,
  });
  const dispatcher = new TaskDispatcher({ ownerId: A, startSession: core.startSession, sharedFor: async () => shared, watcher, stopSession: core.stopSession, agents, now: clock.now, log });
  return { clock, shared, core, log, watcher, dispatcher };
}

async function dispatched() {
  const r = rig();
  const task = await createTask(A, { title: "Fix the build", description: "Red on main.", agent: AGENT.id, startNow: true, timeoutMinutes: null }, r.clock.now());
  await r.dispatcher.dispatchOnce();
  r.clock.advance(1_000);
  return { ...r, task };
}

const stateComments = async (id: string) =>
  (await listTaskComments(A, id)).filter((c) => c.authorKind === "system" && c.body.startsWith("The agent's Session")).map((c) => c.body);

describe("the dispatcher follows the Session's status (#949)", () => {
  it("records running → needs-input → running → finished from the Core's status events, with two comments", async () => {
    const { core, clock, task } = await dispatched();
    const seen: (string | null)[] = [];
    for (const status of ["running", "needs-input", "running", "finished"]) {
      clock.advance(1_000);
      core.emitStatus("session_1", status);
      await settle();
      seen.push((await getTask(A, task.id)).sessionState);
    }
    expect(seen).toEqual(["working", "needs-input", "working", "idle-no-result"]);
    expect(await stateComments(task.id)).toHaveLength(3); // needs-input, working again, idle-no-result
    expect((await getTask(A, task.id)).status).toBe("in_progress");
  });

  it("skips a status it does not know", async () => {
    const { core, task } = await dispatched();
    core.emitStatus("session_1", "needs-input");
    await settle();
    core.emitStatus("session_1", "some-future-status");
    await settle();
    expect((await getTask(A, task.id)).sessionState).toBe("needs-input");
  });

  it("lets go of the status subscription when the attempt ends (no leak)", async () => {
    const { core, clock, shared, watcher, task } = await dispatched();
    expect(core.listeners("session_1")).toBe(1);
    shared.write(`tasks/${task.id}/success.md`, "Done.\n\nACT-REPORT-END\n", clock.now());
    await watcher.tick();
    expect((await getTask(A, task.id)).status).toBe("done");
    expect(core.listeners("session_1")).toBe(0);
    // A late status from the Core finds nothing to write to.
    core.emitStatus("session_1", "needs-input");
    await settle();
    expect((await getTask(A, task.id)).sessionState).toBeNull();
  });
});

describe("a Task adopted at Panel boot reads its Session's status (#949)", () => {
  async function adopted(status: string | null) {
    const before = await dispatched();
    await before.dispatcher.stop();
    const core = new FakeCore();
    core.live!.add("session_1"); // the Session is alive on the Core, so the liveness check leaves it be
    if (status === null) core.statuses = null;
    else core.statuses!.set("session_1", status);
    const after = rig(before.clock, before.shared, core);
    expect(await after.dispatcher.adoptInProgress()).toBe(1);
    return { ...after, task: before.task };
  }

  it("reads the status once on adoption", async () => {
    const { task, core } = await adopted("needs-input");
    expect(core.statusCalls).toEqual([["core_1", ["session_1"]]]);
    expect(await getTask(A, task.id)).toMatchObject({ status: "in_progress", sessionState: "needs-input" });
    expect(await stateComments(task.id)).toHaveLength(1);
  });

  it("reads it again in the minute pass, and records the change", async () => {
    const { task, core, clock, watcher } = await adopted("running");
    expect((await getTask(A, task.id)).sessionState).toBe("working");
    core.statuses!.set("session_1", "interrupted");

    clock.advance(MINUTE_MS);
    await watcher.tick();

    expect(core.statusCalls).toEqual([
      ["core_1", ["session_1"]],
      ["core_1", ["session_1"]],
    ]); // adoption, then the minute pass
    expect(await getTask(A, task.id)).toMatchObject({ status: "in_progress", sessionState: "interrupted" });
    expect(await stateComments(task.id)).toHaveLength(1);
  });

  it("does not read it between minute passes", async () => {
    const { core, clock, watcher } = await adopted("running");
    clock.advance(MINUTE_MS);
    await watcher.tick(); // the minute pass
    expect(core.statusCalls).toHaveLength(2);
    clock.advance(MINUTE_MS / 2);
    await watcher.tick();
    expect(core.statusCalls).toHaveLength(2);
    clock.advance(MINUTE_MS / 2);
    await watcher.tick();
    expect(core.statusCalls).toHaveLength(3);
  });

  it("a Core that gives no answer changes nothing", async () => {
    const { task, core, clock, watcher, log } = await adopted(null);
    clock.advance(MINUTE_MS);
    await watcher.tick();
    expect(core.statusCalls).toHaveLength(2);
    expect((await getTask(A, task.id)).sessionState).toBeNull();
    expect(log.errors).toEqual([]);
  });

  it("a Session the Core does not list changes nothing", async () => {
    const { task, core, clock, watcher } = await adopted("running");
    core.statuses!.delete("session_1");
    clock.advance(MINUTE_MS);
    await watcher.tick();
    expect((await getTask(A, task.id)).sessionState).toBe("working");
  });
});

/** Let the handlers the Core's events started (a write to the database) finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
}
