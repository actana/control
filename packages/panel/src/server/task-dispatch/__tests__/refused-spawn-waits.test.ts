import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { taskWaitingReason } from "~/shared/tasks";
import { closePanelTestDb, openPanelTestDb } from "../../__tests__/_panel-test-db";
import { FakeClock, FakeCore, FakeShared, collectingLog } from "./fakes";

/**
 * A dispatch that fails before a Session started is not an attempt (#962, part p2): a Core that is full, a Core that is
 * not connected and a Harness that is not ready leave `attemptCount` as it was. A full or unconnected Core keeps the
 * Task `assigned` with a waiting reason, and it dispatches by itself when the condition clears. The real Tasks service
 * on a real (PGlite or Postgres) database, a fake Core with the real cap on live harness PTYs, a clock moved by hand.
 */

const testDb = await openPanelTestDb();
const { TaskDispatcher, FULL_CORE_RETRY_MIN_MS, FULL_CORE_RETRY_MAX_MS } = await import("../dispatcher");
const { ResultWatcher } = await import("../result-watcher");
const { createTask, getTask, listTaskComments, listTaskHistory } = await import("../../services/tasks");
const { NotFoundError } = await import("../../errors");
const { startTaskDispatch, stopTaskDispatch, queuedAnswer, stopTask } = await import("../index");

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

const report = (text: string) => `${text}\n\nACT-REPORT-END\n`;
const assign = (r: ReturnType<typeof rig>, title = "Fix the build") =>
  createTask(A, { title, description: "Red on main.", agent: AGENT.id, startNow: true, timeoutMinutes: null }, r.clock.now());
const systemComments = async (id: string) => (await listTaskComments(A, id)).filter((c) => c.authorKind === "system");

/** Fill the Core: CAP Tasks dispatched, their Sessions open. */
async function fill(r: ReturnType<typeof rig>) {
  const running = [];
  for (let i = 0; i < CAP; i += 1) {
    running.push(await assign(r, `running ${i + 1}`));
    await r.dispatcher.dispatchOnce();
  }
  expect(r.core.live?.size).toBe(CAP);
  return running;
}

describe("a spawn refused for capacity is not an attempt", () => {
  it("leaves attemptCount unchanged and the Task assigned, with the reason", async () => {
    const r = rig();
    await fill(r);
    const ninth = await assign(r, "ninth");

    expect(await r.dispatcher.dispatchOnce()).toBe(0);

    const after = await getTask(A, ninth.id);
    expect(after).toMatchObject({ status: "assigned", attemptCount: 0, lastError: "waiting: Core full (8/8)", dispatchedAt: null });
    expect(taskWaitingReason(after)).toBe("waiting: Core full (8/8)");
    expect(r.log.errors).toEqual([]);
  });

  it("writes one comment when it starts waiting, and none per retry", async () => {
    const r = rig();
    await fill(r);
    const ninth = await assign(r, "ninth");
    for (let i = 0; i < 5; i += 1) {
      await r.dispatcher.dispatchOnce();
      r.clock.advance(FULL_CORE_RETRY_MAX_MS + 1); // every probe is due
    }

    const comments = await systemComments(ninth.id);
    expect(comments.map((c) => c.body)).toEqual(["Waiting: Core full (8/8). It starts by itself when that clears."]);
    expect(await getTask(A, ninth.id)).toMatchObject({ status: "assigned", attemptCount: 0 });
  });

  it("does not try the Core on every poll: one probe, then backs off", async () => {
    const r = rig();
    await fill(r);
    const ninth = await assign(r, "ninth");
    const tenth = await assign(r, "tenth");
    const before = r.core.starts.length;

    await r.dispatcher.dispatchOnce(); // the ninth is refused; the tenth waits without trying
    expect(r.core.starts.length - before).toBe(1);
    const historyAfterFirst = (await listTaskHistory(A, ninth.id)).length;
    for (let i = 0; i < 20; i += 1) {
      r.clock.advance(500);
      await r.dispatcher.dispatchOnce();
    }

    expect(r.core.starts.length - before).toBe(1); // 10 s of polls: no new try
    expect((await listTaskHistory(A, ninth.id)).length).toBe(historyAfterFirst);
    expect(await getTask(A, tenth.id)).toMatchObject({ status: "assigned", attemptCount: 0, lastError: "waiting: Core full (8/8)" });
    expect(await systemComments(tenth.id)).toHaveLength(1);
    expect(await systemComments(ninth.id)).toHaveLength(1);
    // Only one of the two was claimed (whichever came first); the other waited without a claim.
    const claims = async (id: string) => (await listTaskHistory(A, id)).filter((h) => h.toStatus === "in_progress").length;
    expect((await claims(ninth.id)) + (await claims(tenth.id))).toBe(1);

    r.clock.advance(FULL_CORE_RETRY_MIN_MS); // a probe is due: one Task tries, is refused again
    await r.dispatcher.dispatchOnce();
    expect(r.core.starts.length - before).toBe(2);
    expect(await getTask(A, ninth.id)).toMatchObject({ status: "assigned", attemptCount: 0 });
  });

  it("dispatches when a slot frees: a Task that reports ends its harness, and the waiting Task starts", async () => {
    const r = rig();
    const running = await fill(r);
    const ninth = await assign(r, "ninth");
    await r.dispatcher.dispatchOnce();
    expect((await getTask(A, ninth.id)).status).toBe("assigned");

    // The first Task reports; the watcher stops its harness (#962 p1), which frees the slot and wakes the dispatcher.
    r.clock.advance(1_000);
    r.shared.write(`tasks/${running[0]!.id}/success.md`, report("Done."), r.clock.now());
    await r.watcher.tick();
    await r.dispatcher.dispatchOnce();

    expect(await getTask(A, running[0]!.id)).toMatchObject({ status: "done" });
    expect(await getTask(A, ninth.id)).toMatchObject({ status: "in_progress", attemptCount: 1, lastError: null });
    expect(r.core.live?.size).toBe(CAP);
  });

  it("queues a Task dispatched in the seconds between a result and the harness stop, and starts it once the stop frees the slot", async () => {
    const r = rig();
    const running = await fill(r);
    // The result is in, but the stop has not run yet: the Task is done, its harness still holds the slot.
    let release!: () => void;
    r.gate.hold = new Promise<void>((resolve) => (release = resolve));
    const ninth = await assign(r, "ninth");
    r.clock.advance(1_000);
    r.shared.write(`tasks/${running[0]!.id}/success.md`, report("Done."), r.clock.now());
    const ticking = r.watcher.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await r.dispatcher.dispatchOnce();
    expect(await getTask(A, ninth.id)).toMatchObject({ status: "assigned", attemptCount: 0, lastError: "waiting: Core full (8/8)" });

    release();
    await ticking;
    await r.dispatcher.dispatchOnce();

    expect(await getTask(A, ninth.id)).toMatchObject({ status: "in_progress", attemptCount: 1 });
  });

  it("starts the waiting Task at the next probe when no slot-freed signal came", async () => {
    const r = rig();
    await fill(r);
    const ninth = await assign(r, "ninth");
    await r.dispatcher.dispatchOnce();
    r.core.live?.delete([...r.core.live][0]!); // a Session closed by a person: no signal to the dispatcher

    await r.dispatcher.dispatchOnce();
    expect((await getTask(A, ninth.id)).status).toBe("assigned"); // the probe is not due yet
    r.clock.advance(FULL_CORE_RETRY_MIN_MS);
    await r.dispatcher.dispatchOnce();

    expect(await getTask(A, ninth.id)).toMatchObject({ status: "in_progress", attemptCount: 1 });
  });

  it("counts the attempt only when the Session started: a re-run after waiting is attempt 1, then 2", async () => {
    const r = rig();
    const running = await fill(r);
    const ninth = await assign(r, "ninth");
    await r.dispatcher.dispatchOnce();
    r.clock.advance(1_000);
    r.shared.write(`tasks/${running[0]!.id}/success.md`, report("Done."), r.clock.now());
    await r.watcher.tick();
    await r.dispatcher.dispatchOnce();
    expect((await getTask(A, ninth.id)).attemptCount).toBe(1);
    expect(r.core.starts.at(-1)!.prompt).toContain("prompt-attempt-1.md");
  });
});

describe("a dispatch that fails before a Session started is not an attempt", () => {
  it("a Core with no live link at the start waits as not connected, and starts when the link is back", async () => {
    const r = rig(null);
    r.core.failWith = "there is no live link to this Core";
    const task = await assign(r);

    expect(await r.dispatcher.dispatchOnce()).toBe(0);
    expect(await getTask(A, task.id)).toMatchObject({ status: "assigned", attemptCount: 0, lastError: "waiting: Core not connected" });

    r.core.failWith = null;
    await r.dispatcher.dispatchOnce();
    expect(await getTask(A, task.id)).toMatchObject({ status: "in_progress", attemptCount: 1, lastError: null });
    expect((await systemComments(task.id)).filter((c) => c.body.startsWith("Waiting:"))).toHaveLength(1);
  });

  it("any other refusal to start fails the Task, and the attempt is given back", async () => {
    const r = rig(null);
    r.core.failWith = "the Core refused to start a claude-code Session: harness missing";
    const task = await assign(r);

    await r.dispatcher.dispatchOnce();

    expect(await getTask(A, task.id)).toMatchObject({ status: "failed", attemptCount: 0 });
  });

  it("a Task stopped while its start was being refused is left stopped", async () => {
    const r = rig();
    await fill(r);
    const ninth = await assign(r, "ninth");
    const { markTaskStopped } = await import("../../services/tasks");
    r.core.onStart = async () => {
      await markTaskStopped(A, ninth.id, { stoppedBy: "an operator" }, r.clock.now()).catch(() => undefined);
    };

    await r.dispatcher.dispatchOnce();

    expect((await getTask(A, ninth.id)).status).toBe("failed");
  });

  it("the retry interval doubles: refused at +15 s, the next probe is 30 s later, not 15", async () => {
    const r = rig();
    await fill(r);
    await assign(r, "ninth");
    const before = r.core.starts.length;
    await r.dispatcher.dispatchOnce(); // refused
    r.clock.advance(FULL_CORE_RETRY_MIN_MS);
    await r.dispatcher.dispatchOnce(); // probe 2, refused
    expect(r.core.starts.length - before).toBe(2);
    r.clock.advance(FULL_CORE_RETRY_MIN_MS + 1_000);
    await r.dispatcher.dispatchOnce();
    expect(r.core.starts.length - before).toBe(2); // 16 s later: not yet
    r.clock.advance(FULL_CORE_RETRY_MIN_MS);
    await r.dispatcher.dispatchOnce();
    expect(r.core.starts.length - before).toBe(3);
  });
});

describe("create_task with startNow on a full Core queues the Task and says so", () => {
  it("answers queued with the reason once the Core has refused a start, and nothing when it has not", async () => {
    const r = rig(1);
    const first = await assign(r, "first");
    const second = await assign(r, "second");
    await stopTaskDispatch();
    startTaskDispatch({
      startSession: r.core.startSession,
      throughCore: async () => r.shared,
      s3: async () => r.shared,
      stopSession: r.core.stopSession,
      agents: { get: async () => AGENT, resolve: async () => ({ agentId: AGENT.id, coreId: AGENT.coreId, harness: AGENT.harness, model: AGENT.model, flags: [] }) },
      now: r.clock.now,
      pollMs: 3_600_000,
      log: r.log,
    });
    try {
      const both = async () => [await getTask(A, first.id), await getTask(A, second.id)];
      for (let i = 0; i < 400 && !(await both()).some((t) => t.status === "assigned" && t.lastError !== null); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));

      // Same creation time: either may be dispatched first. One runs, the other waits, and neither has failed.
      const [one, two] = await both();
      const waiting = one!.status === "assigned" ? one! : two!;
      const running = one!.status === "assigned" ? two! : one!;
      expect(running).toMatchObject({ status: "in_progress", attemptCount: 1, lastError: null });
      expect(waiting).toMatchObject({ status: "assigned", attemptCount: 0, lastError: "waiting: Core full (1/1)" });
      expect(queuedAnswer(true, "core_1")).toMatchObject({ queued: true, waiting: "waiting: Core full (1/1)" });
      expect((queuedAnswer(true, "core_1") as { message: string }).message).toContain("starts by itself");
      expect(queuedAnswer(false, "core_1")).toEqual({});

      // An operator stops the running Task: its slot frees and the waiting one starts without waiting for a probe.
      await stopTask(A, running.id, { stoppedBy: "an operator" });
      for (let i = 0; i < 400 && (await getTask(A, waiting.id)).status === "assigned"; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await getTask(A, waiting.id)).toMatchObject({ status: "in_progress", attemptCount: 1 });
    } finally {
      await stopTaskDispatch();
    }
  });
});
