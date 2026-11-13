import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb } from "../../__tests__/_panel-test-db";
import { FakeClock, FakeCore, FakeShared, collectingLog } from "./fakes";

/**
 * A finished Task's harness ends and its PTY slot is freed (#962, part p1): the result watcher asks the Core to stop
 * the Session's harness once the Task reports. The real Tasks service on a real (PGlite or Postgres) database, a fake
 * Core with the real cap on live harness PTYs, a fake Shared folder, a clock moved by hand.
 */

const testDb = await openPanelTestDb();
const { TaskDispatcher } = await import("../dispatcher");
const { ResultWatcher } = await import("../result-watcher");
const { stopSessionOnCore } = await import("../session-stopper");
const { createTask, getTask, listTaskComments } = await import("../../services/tasks");
const { NotFoundError } = await import("../../errors");

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

function rig() {
  const clock = new FakeClock();
  const shared = new FakeShared(clock);
  const core = new FakeCore();
  core.maxLivePtys = CAP;
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

const report = (text: string) => `${text}\n\nACT-REPORT-END\n`;
const resultPath = (id: string, name: string) => `tasks/${id}/${name}`;

async function assign(r: ReturnType<typeof rig>, title = "Fix the build") {
  return createTask(A, { title, description: "Red on main.", agent: AGENT.id, startNow: true, timeoutMinutes: null }, r.clock.now());
}

/** One Task, start to finish: dispatched, then it reports `name`. */
async function runToResult(r: ReturnType<typeof rig>, name: string, body = "Done.") {
  const task = await assign(r);
  await r.dispatcher.dispatchOnce();
  r.clock.advance(1_000);
  r.shared.write(resultPath(task.id, name), report(body), r.clock.now());
  await r.watcher.tick();
  return task;
}

describe("a finished Task's harness ends and frees its PTY slot (#962)", () => {
  it("runs 9 Tasks in a row on one Core, none refused for capacity", async () => {
    const r = rig();
    const tasks = [];
    for (let i = 0; i < CAP + 1; i += 1) tasks.push(await runToResult(r, "success.md", `Task ${i + 1} done.`));

    expect(r.core.starts).toHaveLength(CAP + 1);
    for (const task of tasks) expect((await getTask(A, task.id)).status).toBe("done");
    expect(r.core.live?.size).toBe(0);
    expect(r.log.errors).toEqual([]);
  });

  it("waits at the 9th Task without it: 8 Sessions that stay open fill the Core", async () => {
    const r = rig();
    for (let i = 0; i < CAP; i += 1) await assign(r);
    for (let i = 0; i < CAP; i += 1) await r.dispatcher.dispatchOnce();
    expect(r.core.live?.size).toBe(CAP);
    const ninth = await assign(r);
    await r.dispatcher.dispatchOnce();
    // Refused for capacity, which is not an attempt and not a failure (#962, p2): it waits.
    expect(await getTask(A, ninth.id)).toMatchObject({ status: "assigned", attemptCount: 0, lastError: "waiting: Core full (8/8)" });
  });

  it.each([
    ["success.md", "done"],
    ["partial-1.md", "partial"],
    ["fail.md", "failed"],
  ] as const)("ends the harness when the Task reports %s (%s)", async (name, status) => {
    const r = rig();
    const task = await runToResult(r, name);

    expect((await getTask(A, task.id)).status).toBe(status);
    expect(r.core.stops).toEqual([{ coreId: "core_1", sessionId: "session_1" }]);
    expect(r.core.live?.has("session_1")).toBe(false);
  });

  it("does not end the harness while the result file is still being written", async () => {
    const r = rig();
    const task = await assign(r);
    await r.dispatcher.dispatchOnce();
    r.clock.advance(1_000);
    r.shared.write(resultPath(task.id, "success.md"), "# Done\n\nstill writing", r.clock.now());
    await r.watcher.tick();

    expect((await getTask(A, task.id)).status).toBe("in_progress");
    expect(r.core.stops).toEqual([]);
  });

  it("does not end the harness of a Task that has no result yet", async () => {
    const r = rig();
    await assign(r);
    await r.dispatcher.dispatchOnce();
    r.clock.advance(1_000);
    await r.watcher.tick();

    expect(r.core.stops).toEqual([]);
    expect(r.core.live?.has("session_1")).toBe(true);
  });

  it("ends the harness once, however many more ticks follow", async () => {
    const r = rig();
    await runToResult(r, "success.md");
    r.clock.advance(60_000);
    await r.watcher.tick();
    await r.watcher.tick();

    expect(r.core.stops).toHaveLength(1);
  });

  it("ends the harness when the result is found by the last look before a timeout's fail.md", async () => {
    const r = rig();
    const task = await createTask(A, { title: "Slow", description: "d", agent: AGENT.id, startNow: true, timeoutMinutes: 2 }, r.clock.now());
    await r.dispatcher.dispatchOnce();
    r.shared.watchBlind = true;
    r.clock.advance(1_000);
    r.shared.write(resultPath(task.id, "success.md"), report("in time"), r.clock.now());
    r.clock.advance(2 * 60_000);
    await r.watcher.tick();

    expect((await getTask(A, task.id)).status).toBe("done");
    expect(r.core.stops).toEqual([{ coreId: "core_1", sessionId: "session_1" }]);
  });

  it("does not ask the Core to stop a harness that already exited", async () => {
    const r = rig();
    const task = await assign(r);
    await r.dispatcher.dispatchOnce();
    r.clock.advance(1_000);
    r.shared.write(resultPath(task.id, "success.md"), report("done"), r.clock.now());
    r.core.sessions[0]!.exit(0);
    r.core.live?.delete("session_1");
    await r.watcher.tick();

    expect((await getTask(A, task.id)).status).toBe("done");
    expect(r.core.stops).toEqual([]);
  });

  it("records the result and finishes the Task even when the Core cannot be reached to end the harness", async () => {
    const r = rig();
    r.core.stopOutcome = { outcome: "unreachable", detail: "there is no live link to this Core" };
    const task = await runToResult(r, "success.md", "All good.");

    expect((await getTask(A, task.id)).status).toBe("done");
    const comments = await listTaskComments(A, task.id);
    expect(comments.some((c) => c.authorKind === "agent" && c.body.includes("All good."))).toBe(true);
    expect(r.core.stops).toHaveLength(1);
    expect(r.log.infos.join("\n")).toContain("unreachable");
    expect(comments.some((c) => c.authorKind === "system" && c.body.includes("could not be ended after the Task reported"))).toBe(true);
  });

  it("finishes the Task when ending the harness throws", async () => {
    const r = rig();
    const throwing = new ResultWatcher({
      ownerId: A,
      now: r.clock.now,
      log: r.log,
      stopSession: async () => {
        throw new Error("link exploded");
      },
    });
    const dispatcher = new TaskDispatcher({ ownerId: A, startSession: r.core.startSession, sharedFor: async () => r.shared, watcher: throwing, agents: { get: async () => AGENT, resolve: async () => ({ agentId: AGENT.id, coreId: AGENT.coreId, harness: AGENT.harness, model: AGENT.model, flags: [...AGENT.flags] }) }, now: r.clock.now, log: r.log });
    const task = await assign(r);
    await dispatcher.dispatchOnce();
    r.clock.advance(1_000);
    r.shared.write(resultPath(task.id, "success.md"), report("done"), r.clock.now());
    await throwing.tick();

    expect((await getTask(A, task.id)).status).toBe("done");
    expect(throwing.isTracking(task.id)).toBe(false);
    expect(r.log.errors.join("\n")).toContain("link exploded");
  });

  it("leaves no Session state on the Task, and the harness's own exit changes nothing afterwards", async () => {
    const r = rig();
    const task = await runToResult(r, "success.md");
    // The harness's exit and its last status reach the Panel after the Task has finished.
    r.core.emitStatus("session_1", "terminated");
    r.core.sessions[0]!.exit(0);
    await r.watcher.tick();

    const after = await getTask(A, task.id);
    expect(after.status).toBe("done");
    expect(after.sessionState).toBeNull();
  });

  it("keeps the Session resumable: ending the harness is a kill of its PTY, and nothing is deleted or archived", async () => {
    const called: string[] = [];
    const sdk = {
      findBySession: async (sessionId: string) => {
        called.push(`findBySession ${sessionId}`);
        return { ptyId: "pty_1" };
      },
      kill: async (ptyId: string) => {
        called.push(`kill ${ptyId}`);
        return true;
      },
      forceTakeover: async () => {
        called.push("forceTakeover");
        return { supported: true, takenFrom: "other" };
      },
    };
    const outcome = await stopSessionOnCore({ coreId: "core_1", sessionId: "session_1" }, () => ({ sdk: sdk as never }));

    expect(outcome).toEqual({ outcome: "stopped", detail: null });
    expect(called).toEqual(["findBySession session_1", "kill pty_1"]);
  });
});
