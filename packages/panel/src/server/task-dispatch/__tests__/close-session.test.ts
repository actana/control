import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb } from "../../__tests__/_panel-test-db";
import { FakeClock, FakeCore, FakeShared, collectingLog } from "./fakes";

/**
 * `close_session` (#962, part p3) frees a finished Task's PTY slot through the same `slotFreed` path as the watcher, so a
 * Task waiting on a full Core dispatches; a Session someone holds is left alone. The real Tasks service
 * on a real (PGlite or Postgres) database, a fake Core with the real cap on live harness PTYs, a clock moved by hand.
 */

const testDb = await openPanelTestDb();
const { TaskDispatcher } = await import("../dispatcher");
const { ResultWatcher } = await import("../result-watcher");
const { createTask, getTask } = await import("../../services/tasks");
const { ConflictError, NotFoundError } = await import("../../errors");
const { closeTaskSession } = await import("../close-session");

const A = 1;
const GRACE_MS = 10_000;
const CAP = 8;
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

function rig(cap: number | null = CAP) {
  const clock = new FakeClock();
  const shared = new FakeShared(clock);
  const core = new FakeCore();
  core.maxLivePtys = cap;
  const log = collectingLog();
  const agents = {
    get: async () => AGENT,
    resolve: async (_owner: number, id: string) => {
      if (id !== AGENT.id) throw new NotFoundError("agent not found");
      return { agentId: AGENT.id, coreId: AGENT.coreId, harness: AGENT.harness, model: AGENT.model, flags: [...AGENT.flags] };
    },
  };
  // The watcher tells the dispatcher a slot is free, as `startTaskDispatch` wires it.
  let dispatcher: InstanceType<typeof TaskDispatcher>;
  const gate: { hold: Promise<void> | null } = { hold: null };
  const stopSession: typeof core.stopSession = async (target) => {
    await gate.hold;
    return core.stopSession(target);
  };
  const watcher = new ResultWatcher({
    ownerId: A,
    now: clock.now,
    exitGraceMs: GRACE_MS,
    log,
    stopSession,
    liveSessions: core.liveSessions,
    onSlotFreed: (coreId) => dispatcher.slotFreed(coreId),
  });
  dispatcher = new TaskDispatcher({ ownerId: A, startSession: core.startSession, sharedFor: async () => shared, watcher, stopSession, agents, now: clock.now, log });
  return { clock, shared, core, log, watcher, dispatcher, gate };
}

async function setup() {
  const r = rig();
  const running = [];
  for (let i = 0; i < CAP; i += 1) {
    running.push(await createTask(A, { title: `t${i}`, description: "x", agent: AGENT.id, startNow: true, timeoutMinutes: null }, r.clock.now()));
    await r.dispatcher.dispatchOnce();
  }
  const ninth = await createTask(A, { title: "ninth", description: "x", agent: AGENT.id, startNow: true, timeoutMinutes: null }, r.clock.now());
  await r.dispatcher.dispatchOnce();
  expect(await getTask(A, ninth.id)).toMatchObject({ status: "assigned", lastError: "waiting: Core full (8/8)" });
  // The first Task has reported (done) but its harness was left running: the leak this card fixes, as an older Panel left it.
  await testDb.pool.query("update tasks set status = 'done' where id = $1", [running[0]!.id]);
  return { r, finished: running[0]!, ninth };
}

describe("close_session frees the slot", () => {
  it("ends the harness, keeps the Session's row, and the Task waiting on the full Core dispatches", async () => {
    const { r, finished, ninth } = await setup();
    const closed = await closeTaskSession(A, finished.id, { closedBy: "op" }, {
      stopSession: r.core.stopSession,
      slotFreed: (id) => r.dispatcher.slotFreed(id),
      isHeld: () => false,
      now: r.clock.now,
      log: r.log,
    });
    expect(closed.session.outcome).toBe("stopped");
    expect(r.core.live?.size).toBe(CAP - 1);
    expect(await getTask(A, finished.id)).toMatchObject({ status: "done" });
    await r.dispatcher.dispatchOnce();
    expect(await getTask(A, ninth.id)).toMatchObject({ status: "in_progress", attemptCount: 1, lastError: null });
  });

  it("leaves a Session someone holds alone: 409, the harness lives, the waiting Task keeps waiting", async () => {
    const { r, finished, ninth } = await setup();
    let slotFreed = 0;
    await expect(
      closeTaskSession(A, finished.id, { closedBy: "op" }, {
        stopSession: r.core.stopSession,
        slotFreed: () => void slotFreed++,
        isHeld: () => true,
        now: r.clock.now,
        log: r.log,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(slotFreed).toBe(0);
    expect(r.core.live?.size).toBe(CAP);
    await r.dispatcher.dispatchOnce();
    expect(await getTask(A, ninth.id)).toMatchObject({ status: "assigned", attemptCount: 0 });
  });
});
