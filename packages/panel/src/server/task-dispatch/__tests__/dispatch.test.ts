import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb } from "../../__tests__/_panel-test-db";
import { FakeClock, FakeCore, FakeShared, collectingLog } from "./fakes";

/**
 * The dispatcher and the result watcher end to end (#570): the real Tasks service on a real (PGlite or
 * Postgres) database, a fake Core that records the Sessions it is asked to start, and a fake CoreShared
 * with a clock the test moves by hand. No timer is involved unless a test says so.
 */

const testDb = await openPanelTestDb();
const { TaskDispatcher } = await import("../dispatcher");
const { ResultWatcher } = await import("../result-watcher");
const tasksService = await import("../../services/tasks");
const { NotFoundError } = await import("../../errors");
const { createTask, getTask, listTaskComments, listTaskHistory, commentAndReassign, claimTask, addTaskComment } =
  tasksService;

const A = 1;
const B = 2;
const TIMEOUT_MS = 120_000;
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
  await testDb.pool.query("alter table operator drop constraint operator_single_row");
  for (const id of [A, B]) {
    await testDb.pool.query(
      "insert into operator (id, name, password_hash, created_at, password_changed_at) values ($1, $2, 'h', 1, 1)",
      [id, `owner-${id}`],
    );
  }
});
beforeEach(async () => {
  await testDb.pool.query("truncate tasks cascade");
});
afterAll(async () => {
  await closePanelTestDb(testDb);
});

function rig(ownerId = A) {
  const clock = new FakeClock();
  const shared = new FakeShared(clock);
  const core = new FakeCore();
  const log = collectingLog();
  const agents = {
    get: async (_owner: number, id: string) => {
      if (id !== AGENT.id) throw new NotFoundError("agent not found");
      return AGENT;
    },
    resolve: async (_owner: number, id: string) => {
      if (id !== AGENT.id) throw new NotFoundError("agent not found");
      return { agentId: AGENT.id, coreId: AGENT.coreId, harness: AGENT.harness, model: AGENT.model, flags: [...AGENT.flags] };
    },
  };
  const watcher = new ResultWatcher({ ownerId, now: clock.now, timeoutMs: TIMEOUT_MS, exitGraceMs: GRACE_MS, log });
  const dispatcher = new TaskDispatcher({
    ownerId,
    startSession: core.startSession,
    sharedFor: async () => shared,
    watcher,
    agents,
    now: clock.now,
    log,
  });
  return { clock, shared, core, log, watcher, dispatcher, agents };
}

const assign = (clock: FakeClock, overrides: Partial<Parameters<typeof createTask>[1]> = {}, owner = A) =>
  createTask(owner, { title: "Fix the build", description: "The CI build is red on main.", agent: AGENT.id, startNow: true, ...overrides }, clock.now());

const result = (id: string, name: string) => `tasks/${id}/${name}`;
const report = (text: string) => `${text}\n\nACT-REPORT-END\n`;

describe("dispatching an assigned Task", () => {
  it("starts a Session on the Agent's Core with the Task, its comments and the result instructions", async () => {
    const { clock, core, dispatcher } = rig();
    const task = await assign(clock);
    await addTaskComment(A, task.id, { authorKind: "user", authorName: "Operator", body: "Use pnpm, not npm." }, clock.now());
    await addTaskComment(A, task.id, { authorKind: "agent", authorName: "Claude Code", body: "Earlier I found the lockfile is stale." }, clock.now());
    await addTaskComment(A, task.id, { authorKind: "system", authorName: "Panel", body: "internal panel bookkeeping" }, clock.now());

    expect(await dispatcher.dispatchOnce()).toBe(1);

    expect(core.starts).toHaveLength(1);
    const start = core.starts[0]!;
    expect(start).toMatchObject({ coreId: "core_1", harness: "claude-code", model: "claude-sonnet-5-5", flags: ["skip-permissions"] });
    expect(start.title).toBe("Task: Fix the build");
    expect(start.prompt).toContain("Fix the build");
    expect(start.prompt).toContain("The CI build is red on main.");
    expect(start.prompt).toContain("Use pnpm, not npm.");
    expect(start.prompt).toContain("Earlier I found the lockfile is stale.");
    expect(start.prompt).not.toContain("internal panel bookkeeping");
    expect(start.prompt).toContain(`~/shared/tasks/${task.id}/success.md`);
    expect(start.prompt).toContain(`~/shared/tasks/${task.id}/fail.md`);
    expect(start.prompt).toContain(`~/shared/tasks/${task.id}/partial-<n>.md`);
    expect(start.prompt).toContain("ACT-REPORT-END");
  });

  it("leaves the Core's standard block to the Core: the prompt carries none", async () => {
    const { clock, core, dispatcher } = rig();
    await assign(clock);
    await dispatcher.dispatchOnce();

    // A prompt that already holds a block is left alone by the Core, so the Session would be told no report path of its own.
    expect(core.starts[0]!.prompt).not.toMatch(/\[\/?Actana standard block/);
  });

  it("claims the Task: in progress, attempt 1, dispatched at the clock", async () => {
    const { clock, dispatcher } = rig();
    const task = await assign(clock);
    clock.advance(500);
    await dispatcher.dispatchOnce();

    expect(await getTask(A, task.id)).toMatchObject({ status: "in_progress", attemptCount: 1, dispatchedAt: clock.now(), lastError: null });
  });

  it("adds one system comment that names the Session, and watches the Task", async () => {
    const { clock, core, dispatcher, watcher } = rig();
    const task = await assign(clock);
    await dispatcher.dispatchOnce();

    const comments = await listTaskComments(A, task.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ authorKind: "system", authorName: "Panel" });
    expect(comments[0]!.body).toContain(core.sessions[0]!.id);
    expect(comments[0]!.body).toContain("core_1");
    expect(watcher.isTracking(task.id)).toBe(true);
  });

  it("does not dispatch a draft Task, nor one that is already running", async () => {
    const { clock, core, dispatcher } = rig();
    await assign(clock, { startNow: false });
    const running = await assign(clock, { title: "running" });
    await claimTask(A, running.id, clock.now());

    expect(await dispatcher.dispatchOnce()).toBe(0);
    expect(core.starts).toHaveLength(0);
  });

  it("dispatches each assigned Task once, oldest first", async () => {
    const { clock, core, dispatcher } = rig();
    await assign(clock, { title: "first" });
    clock.advance(10);
    await assign(clock, { title: "second" });

    await dispatcher.dispatchOnce();
    await dispatcher.dispatchOnce();

    expect(core.starts.map((s) => s.title)).toEqual(["Task: first", "Task: second"]);
  });

  it("starts one Session when two dispatchers race for the same Task", async () => {
    const one = rig();
    const task = await assign(one.clock);
    // A second dispatcher over the same database, with its own Core and watcher: a second Panel process.
    const two = rig();
    two.clock.t = one.clock.t;

    const claimed = await Promise.all([one.dispatcher.dispatchOnce(), two.dispatcher.dispatchOnce()]);

    expect(claimed.reduce((a, b) => a + b, 0)).toBe(1);
    expect(one.core.starts.length + two.core.starts.length).toBe(1);
    expect((await getTask(A, task.id)).attemptCount).toBe(1);
    expect(await listTaskComments(A, task.id)).toHaveLength(1);
  });

  it("never touches another owner's Task", async () => {
    const { clock, core, dispatcher } = rig(A);
    const theirs = await assign(clock, {}, B);

    expect(await dispatcher.dispatchOnce()).toBe(0);

    expect(core.starts).toHaveLength(0);
    expect(await getTask(B, theirs.id)).toMatchObject({ status: "assigned", attemptCount: 0 });
  });
});

describe("a Task that cannot be dispatched", () => {
  it("fails with the reason when the Core refuses to start the Session, and is not claimed again", async () => {
    const { clock, core, dispatcher, watcher, log } = rig();
    core.failWith = "the Core refused to start a claude-code Session: harness missing";
    const task = await assign(clock);

    await dispatcher.dispatchOnce();
    await dispatcher.dispatchOnce();

    const after = await getTask(A, task.id);
    expect(after.status).toBe("failed");
    expect(after.lastError).toContain("harness missing");
    expect(after.attemptCount).toBe(1);
    expect(core.starts).toHaveLength(1);
    expect(watcher.isTracking(task.id)).toBe(false);
    const comments = await listTaskComments(A, task.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ authorKind: "system" });
    expect(comments[0]!.body).toContain("harness missing");
    expect(log.errors.join("\n")).toContain("harness missing");
  });

  it("fails a Task with no Agent, without starting anything", async () => {
    const { clock, core, dispatcher } = rig();
    const task = await assign(clock, { agent: null });

    await dispatcher.dispatchOnce();

    expect(core.starts).toHaveLength(0);
    expect(await getTask(A, task.id)).toMatchObject({ status: "failed", lastError: "this Task has no Agent to run it" });
  });

  it("fails a Task whose Agent cannot be found or resolved", async () => {
    const { clock, core, dispatcher } = rig();
    const task = await assign(clock, { agent: "agent_gone" });

    await dispatcher.dispatchOnce();

    expect(core.starts).toHaveLength(0);
    const after = await getTask(A, task.id);
    expect(after.status).toBe("failed");
    expect(after.lastError).toContain("its Agent cannot run it");
  });

  it("fails a Task whose Core's Shared folder cannot be reached, before any Session starts", async () => {
    const { clock, core, shared, dispatcher } = rig();
    const task = await assign(clock);
    // A re-run needs the Shared folder to archive the older results; the first attempt is made one by hand.
    await claimTask(A, task.id, clock.now());
    await tasksService.failTaskDispatch(A, task.id, "x", clock.now());
    await tasksService.changeTaskStatus(A, task.id, "assigned", clock.now());
    shared.failing.list = "the Core is paused";

    await dispatcher.dispatchOnce();

    expect(core.starts).toHaveLength(0);
    const after = await getTask(A, task.id);
    expect(after.status).toBe("failed");
    expect(after.lastError).toContain("Shared folder of Core core_1 is not reachable");
    expect(after.lastError).toContain("the Core is paused");
  });
});

describe("turning a result file into a comment and a status", () => {
  it("moves the Task from assigned to done with the report as one agent comment", async () => {
    const { clock, shared, dispatcher, watcher, core } = rig();
    const task = await assign(clock);
    await dispatcher.dispatchOnce();
    clock.advance(5_000);
    shared.write(result(task.id, "success.md"), report("# Fixed\n\nThe lockfile was stale; regenerated it."));

    await watcher.tick();

    expect(await getTask(A, task.id)).toMatchObject({ status: "done", attemptCount: 1 });
    const comments = await listTaskComments(A, task.id);
    const agent = comments.filter((c) => c.authorKind === "agent");
    expect(agent).toHaveLength(1);
    expect(agent[0]).toMatchObject({ authorName: "Claude Code", sourceFile: "attempt-1-success.md" });
    expect(agent[0]!.body).toBe("# Fixed\n\nThe lockfile was stale; regenerated it.");
    const history = await listTaskHistory(A, task.id);
    expect(history.map((h) => `${h.fromStatus}>${h.toStatus}`)).toEqual(["null>assigned", "assigned>in_progress", "in_progress>done"]);
    expect(watcher.isTracking(task.id)).toBe(false);
    expect(core.sessions[0]!.disposed).toBe(true);
  });

  it.each([
    ["fail.md", "failed"],
    ["partial-1.md", "partial"],
    ["partial-3.md", "partial"],
  ])("%s moves the Task to %s", async (name, status) => {
    const { clock, shared, dispatcher, watcher } = rig();
    const task = await assign(clock);
    await dispatcher.dispatchOnce();
    clock.advance(1_000);
    shared.write(result(task.id, name), report(`result in ${name}`));

    await watcher.tick();

    expect((await getTask(A, task.id)).status).toBe(status);
    const agent = (await listTaskComments(A, task.id)).filter((c) => c.authorKind === "agent");
    expect(agent.map((c) => [c.sourceFile, c.body])).toEqual([[`attempt-1-${name}`, `result in ${name}`]]);
  });

  it("ignores a file that is not newer than the dispatch time", async () => {
    const { clock, shared, dispatcher, watcher } = rig();
    const task = await assign(clock);
    // Left by an earlier run: written before this dispatch.
    shared.write(result(task.id, "success.md"), report("old news"), clock.now() - 60_000);
    clock.advance(1_000);
    await dispatcher.dispatchOnce();
    // Written at the very instant of the dispatch is not newer either.
    shared.write(result(task.id, "fail.md"), report("same instant"), clock.now());

    await watcher.tick();

    expect((await getTask(A, task.id)).status).toBe("in_progress");
    expect((await listTaskComments(A, task.id)).filter((c) => c.authorKind === "agent")).toEqual([]);

    // The same name written again, now newer, is the real result.
    clock.advance(2_000);
    shared.write(result(task.id, "success.md"), report("fresh"));
    await watcher.tick();
    expect((await getTask(A, task.id)).status).toBe("done");
    expect((await listTaskComments(A, task.id)).filter((c) => c.authorKind === "agent").map((c) => c.body)).toEqual(["fresh"]);
  });

  it("waits for a report that is not finished, and takes it when its last line is the end marker", async () => {
    const { clock, shared, dispatcher, watcher } = rig();
    const task = await assign(clock);
    await dispatcher.dispatchOnce();
    clock.advance(1_000);
    shared.write(result(task.id, "success.md"), "# Half written\n\nStill working on");

    await watcher.tick();
    expect((await getTask(A, task.id)).status).toBe("in_progress");

    clock.advance(1_000);
    shared.write(result(task.id, "success.md"), report("# Whole report"));
    await watcher.tick();
    expect((await getTask(A, task.id)).status).toBe("done");
  });

  it("does not take the end marker in the middle of a file for a finished report", async () => {
    const { clock, shared, dispatcher, watcher } = rig();
    const task = await assign(clock);
    await dispatcher.dispatchOnce();
    clock.advance(1_000);
    shared.write(result(task.id, "success.md"), "ACT-REPORT-END\n\nand then it carried on");

    await watcher.tick();

    expect((await getTask(A, task.id)).status).toBe("in_progress");
  });

  it("makes exactly one comment for a file however often it is read", async () => {
    const { clock, shared, dispatcher, watcher, log } = rig();
    const task = await assign(clock);
    await dispatcher.dispatchOnce();
    clock.advance(1_000);
    shared.write(result(task.id, "success.md"), report("once"));
    await watcher.tick();

    // A Panel that restarted and watches the same Task again reads the same file from the start.
    const again = new ResultWatcher({ ownerId: A, now: clock.now, timeoutMs: TIMEOUT_MS, exitGraceMs: GRACE_MS, log });
    again.track({ taskId: task.id, attempt: 1, dispatchedAt: (await getTask(A, task.id)).dispatchedAt!, coreId: "core_1", shared, authorName: "Claude Code" });
    await again.tick();

    expect((await listTaskComments(A, task.id)).filter((c) => c.authorKind === "agent")).toHaveLength(1);
    expect(log.errors).toEqual([]);
  });

  it("keeps a second result file of the same attempt as a comment without a second status move", async () => {
    const { clock, shared, dispatcher, watcher } = rig();
    const task = await assign(clock);
    await dispatcher.dispatchOnce();
    clock.advance(1_000);
    shared.write(result(task.id, "partial-1.md"), report("part one"));
    clock.advance(1_000);
    shared.write(result(task.id, "success.md"), report("all of it"));

    await watcher.tick();

    // The earlier file moved the Task; `partial -> done` is not a legal move, so the later one is a comment only.
    expect((await getTask(A, task.id)).status).toBe("partial");
    const agent = (await listTaskComments(A, task.id)).filter((c) => c.authorKind === "agent");
    expect(agent.map((c) => c.sourceFile)).toEqual(["attempt-1-partial-1.md", "attempt-1-success.md"]);
    expect((await listTaskHistory(A, task.id)).map((h) => h.toStatus)).toEqual(["assigned", "in_progress", "partial"]);
  });

  it("runs the Task again after a result: the older results are renamed and the new attempt's file counts", async () => {
    const { clock, shared, dispatcher, watcher, core } = rig();
    const task = await assign(clock);
    await dispatcher.dispatchOnce();
    clock.advance(1_000);
    shared.write(result(task.id, "fail.md"), report("first try failed"));
    shared.write(result(task.id, "attempt-1.log"), "log of attempt one");
    await watcher.tick();
    clock.advance(1_000);
    await commentAndReassign(A, task.id, { authorKind: "user", authorName: "Operator", body: "Try the other approach." }, clock.now());

    await dispatcher.dispatchOnce();

    expect(core.starts).toHaveLength(2);
    expect(core.starts[1]!.prompt).toContain("Try the other approach.");
    expect(core.starts[1]!.prompt).toContain("first try failed");
    expect(shared.text(result(task.id, "fail.md"))).toBeNull();
    expect(shared.text(result(task.id, "attempt-1-fail.md"))).toContain("first try failed");
    expect(shared.text(result(task.id, "attempt-1.log"))).toBe("log of attempt one");
    expect((await getTask(A, task.id)).attemptCount).toBe(2);

    clock.advance(1_000);
    shared.write(result(task.id, "success.md"), report("second try worked"));
    await watcher.tick();

    expect((await getTask(A, task.id)).status).toBe("done");
    const agent = (await listTaskComments(A, task.id)).filter((c) => c.authorKind === "agent");
    expect(agent.map((c) => c.sourceFile)).toEqual(["attempt-1-fail.md", "attempt-2-success.md"]);
  });

  it("does not record a result onto another owner's Task", async () => {
    const mine = rig(A);
    const theirs = await assign(mine.clock, {}, B);
    await claimTask(B, theirs.id, mine.clock.now());
    mine.watcher.track({ taskId: theirs.id, attempt: 1, dispatchedAt: mine.clock.now(), coreId: "core_1", shared: mine.shared, authorName: "x" });
    mine.clock.advance(1_000);
    mine.shared.write(result(theirs.id, "success.md"), report("not yours"));

    await mine.watcher.tick();

    expect(await getTask(B, theirs.id)).toMatchObject({ status: "in_progress" });
    expect(await listTaskComments(B, theirs.id)).toEqual([]);
    expect(mine.log.errors.join("\n")).toContain("gone while its result was being recorded");
  });
});

describe("an agent that exits without a result, and the timeout", () => {
  it("writes fail.md after the grace and fails the Task through the same path", async () => {
    const { clock, shared, core, dispatcher, watcher } = rig();
    const task = await assign(clock);
    await dispatcher.dispatchOnce();
    core.sessions[0]!.exit(1);

    clock.advance(GRACE_MS - 1);
    await watcher.tick();
    expect((await getTask(A, task.id)).status).toBe("in_progress");
    expect(shared.text(result(task.id, "fail.md"))).toBeNull();

    clock.advance(1);
    await watcher.tick();

    expect((await getTask(A, task.id)).status).toBe("failed");
    const written = shared.text(result(task.id, "fail.md"))!;
    expect(written).toContain("exited (code 1) without writing a result file");
    expect(written.trimEnd().endsWith("ACT-REPORT-END")).toBe(true);
    const agent = (await listTaskComments(A, task.id)).filter((c) => c.authorKind === "agent");
    expect(agent).toHaveLength(1);
    expect(agent[0]).toMatchObject({ sourceFile: "attempt-1-fail.md", authorName: "Claude Code" });
    expect(agent[0]!.body).toContain("exited (code 1)");
    expect(watcher.isTracking(task.id)).toBe(false);
  });

  it("takes a result that lands during the grace instead of writing fail.md", async () => {
    const { clock, shared, core, dispatcher, watcher } = rig();
    const task = await assign(clock);
    await dispatcher.dispatchOnce();
    core.sessions[0]!.exit(0);
    clock.advance(5_000);
    shared.write(result(task.id, "success.md"), report("synced late"));
    await watcher.tick();
    clock.advance(GRACE_MS);
    await watcher.tick();

    expect((await getTask(A, task.id)).status).toBe("done");
    expect(shared.text(result(task.id, "fail.md"))).toBeNull();
  });

  it("writes fail.md when the timeout runs out, on the fake clock", async () => {
    const { clock, shared, dispatcher, watcher } = rig();
    const task = await assign(clock);
    await dispatcher.dispatchOnce();

    clock.advance(TIMEOUT_MS - 1);
    await watcher.tick();
    expect((await getTask(A, task.id)).status).toBe("in_progress");
    expect(shared.text(result(task.id, "fail.md"))).toBeNull();

    clock.advance(1);
    await watcher.tick();

    expect((await getTask(A, task.id)).status).toBe("failed");
    expect(shared.text(result(task.id, "fail.md"))).toContain("no result within 2 minutes");
    const agent = (await listTaskComments(A, task.id)).filter((c) => c.authorKind === "agent");
    expect(agent.map((c) => c.sourceFile)).toEqual(["attempt-1-fail.md"]);
  });

  it("does not time out a Task that has a result, and counts the timeout from the dispatch time", async () => {
    const { clock, shared, dispatcher, watcher } = rig();
    const task = await assign(clock);
    clock.advance(30_000);
    await dispatcher.dispatchOnce();
    shared.write(result(task.id, "success.md"), report("fast"), clock.now() + 1);
    clock.advance(TIMEOUT_MS + 5_000);
    await watcher.tick();

    expect((await getTask(A, task.id)).status).toBe("done");
    expect(shared.text(result(task.id, "fail.md"))).toBeNull();
  });

  it("still fails the Task when fail.md cannot be written to the Shared folder, and says so in the log", async () => {
    const { clock, shared, dispatcher, watcher, log } = rig();
    const task = await assign(clock);
    await dispatcher.dispatchOnce();
    shared.failing.put = "read-only: the key expired";
    clock.advance(TIMEOUT_MS);

    await watcher.tick();

    expect((await getTask(A, task.id)).status).toBe("failed");
    expect(log.errors.join("\n")).toContain("could not write");
    expect(log.errors.join("\n")).toContain("the key expired");
  });

  it("times a Task out even while its Shared folder cannot be read", async () => {
    const { clock, shared, dispatcher, watcher, log } = rig();
    const task = await assign(clock);
    await dispatcher.dispatchOnce();
    shared.failing.watch = "the Core is paused";

    await watcher.tick();
    expect((await getTask(A, task.id)).status).toBe("in_progress");
    expect(log.errors.join("\n")).toContain("the Core is paused");

    clock.advance(TIMEOUT_MS);
    await watcher.tick();
    expect((await getTask(A, task.id)).status).toBe("failed");
  });

  it("reads a change again from the same cursor when the read of it failed", async () => {
    const { clock, shared, dispatcher, watcher } = rig();
    const task = await assign(clock);
    await dispatcher.dispatchOnce();
    await watcher.tick(); // the first look: nothing there yet
    clock.advance(1_000);
    shared.write(result(task.id, "success.md"), report("arrived"));
    shared.failing.get = "a blip";
    await watcher.tick();
    expect((await getTask(A, task.id)).status).toBe("in_progress");

    shared.failing.get = undefined;
    await watcher.tick();

    expect((await getTask(A, task.id)).status).toBe("done");
  });
});

describe("a Panel that restarts while Tasks run", () => {
  it("takes over an in-progress Task, and its result file or timeout still ends it", async () => {
    const before = rig();
    const done = await assign(before.clock, { title: "will report" });
    const stuck = await assign(before.clock, { title: "will time out" });
    await before.dispatcher.dispatchOnce();
    await before.dispatcher.stop();

    // A new Panel process: a fresh dispatcher and watcher over the same database, the same Shared folder.
    const after = rig();
    after.clock.t = before.clock.t;
    const shared = before.shared;
    const dispatcher = new TaskDispatcher({
      ownerId: A,
      startSession: after.core.startSession,
      sharedFor: async () => shared,
      watcher: after.watcher,
      agents: after.agents,
      now: after.clock.now,
      log: after.log,
    });

    expect(await dispatcher.adoptInProgress()).toBe(2);
    expect(after.core.starts).toHaveLength(0);
    after.clock.advance(1_000);
    shared.write(result(done.id, "success.md"), report("reported after the restart"), after.clock.now());
    await after.watcher.tick();
    expect((await getTask(A, done.id)).status).toBe("done");
    expect((await getTask(A, stuck.id)).status).toBe("in_progress");

    after.clock.advance(TIMEOUT_MS);
    await after.watcher.tick();
    expect((await getTask(A, stuck.id)).status).toBe("failed");
  });

  it("fails an in-progress Task that has no Agent and no Core to look on, with the reason", async () => {
    const { clock, dispatcher, core } = rig();
    const task = await assign(clock, { agent: null });
    await claimTask(A, task.id, clock.now());

    expect(await dispatcher.adoptInProgress()).toBe(0);

    expect(await getTask(A, task.id)).toMatchObject({ status: "failed" });
    expect((await getTask(A, task.id)).lastError).toContain("has no Core to look for its result on");
    expect(core.starts).toHaveLength(0);
  });
});

describe("a Task that cannot be taken over cleanly after a restart", () => {
  const dispatcherOf = (r: ReturnType<typeof rig>, overrides: Record<string, unknown>) =>
    new TaskDispatcher({
      ownerId: A,
      startSession: r.core.startSession,
      sharedFor: async () => r.shared,
      watcher: r.watcher,
      agents: r.agents,
      now: r.clock.now,
      log: r.log,
      ...overrides,
    });
  const runningTask = async (r: ReturnType<typeof rig>, overrides: Record<string, unknown> = {}) => {
    const task = await assign(r.clock, overrides as never);
    await claimTask(A, task.id, r.clock.now());
    return task;
  };

  it("watches by the Task's own Core when its Agent was deleted while it ran", async () => {
    const r = rig();
    await testDb.pool.query(
      "insert into cores (id, owner_id, endpoint, label, created_at, updated_at) values ('core_own', $1, 'wss://x', 'x', 1, 1) on conflict do nothing",
      [A],
    );
    const task = await runningTask(r, { agent: "agent_deleted", coreId: "core_own" });
    const seen: string[] = [];

    expect(await dispatcherOf(r, { sharedFor: async (id: string) => (seen.push(id), r.shared) }).adoptInProgress()).toBe(1);

    r.clock.advance(1_000);
    r.shared.write(result(task.id, "success.md"), report("agent gone, result still counts"));
    await r.watcher.tick();
    expect([...new Set(seen)]).toEqual(["core_own"]);
    expect((await getTask(A, task.id)).status).toBe("done");
  });

  it("fails it with the reason when the Agent is gone and the Task names no Core", async () => {
    const r = rig();
    const task = await runningTask(r, { agent: "agent_deleted" });

    await dispatcherOf(r, {}).adoptInProgress();

    const after = await getTask(A, task.id);
    expect(after.status).toBe("failed");
    expect(after.lastError).toContain("has no Core to look for its result on");
  });

  it("still watches it when the Core's Shared folder cannot be reached, so the timeout ends it", async () => {
    const r = rig();
    const task = await runningTask(r);
    const dispatcher = dispatcherOf(r, {
      sharedFor: async () => {
        throw new Error("this Core is not registered with this Panel");
      },
    });

    expect(await dispatcher.adoptInProgress()).toBe(1);
    expect(r.watcher.isTracking(task.id)).toBe(true);
    await r.watcher.tick();
    expect((await getTask(A, task.id)).status).toBe("in_progress");
    expect(r.log.errors.join("\n")).toContain("this Core is not registered with this Panel");

    r.clock.advance(TIMEOUT_MS);
    await r.watcher.tick();
    expect((await getTask(A, task.id)).status).toBe("failed");
  });

  it("tries the whole takeover again on the next cycle when it failed", async () => {
    const r = rig();
    const task = await runningTask(r);
    let calls = 0;
    const flaky = {
      get: async (owner: number, id: string) => {
        if ((calls += 1) === 1) throw new Error("database blip");
        return r.agents.get(owner, id);
      },
      resolve: r.agents.resolve,
    };
    const dispatcher = dispatcherOf(r, { agents: flaky });

    await dispatcher.dispatchOnce();
    expect(r.watcher.isTracking(task.id)).toBe(false);
    expect(r.log.errors.join("\n")).toContain("could not take over running Tasks yet");

    await dispatcher.dispatchOnce();
    expect(r.watcher.isTracking(task.id)).toBe(true);
    r.clock.advance(1_000);
    r.shared.write(result(task.id, "success.md"), report("found on the second try"));
    await r.watcher.tick();
    expect((await getTask(A, task.id)).status).toBe("done");
  });
});

describe("reading results that are awkward", () => {
  it("takes a result its change event missed, in the last look before writing fail.md", async () => {
    const { clock, shared, dispatcher, watcher } = rig();
    const task = await assign(clock);
    await dispatcher.dispatchOnce();
    await watcher.tick();
    shared.watchBlind = true;
    clock.advance(1_000);
    shared.write(result(task.id, "success.md"), report("the event never came"));
    clock.advance(TIMEOUT_MS);

    await watcher.tick();

    expect((await getTask(A, task.id)).status).toBe("done");
    expect(shared.text(result(task.id, "fail.md"))).toBeNull();
  });

  it("is not held up by a result-named file that is gone when it is read", async () => {
    const { clock, shared, dispatcher, watcher } = rig();
    const task = await assign(clock);
    await dispatcher.dispatchOnce();
    await watcher.tick();
    clock.advance(1_000);
    shared.ghosts.push(result(task.id, "partial-1.md"));
    shared.write(result(task.id, "success.md"), report("behind a ghost"));

    await watcher.tick();

    expect((await getTask(A, task.id)).status).toBe("done");
  });

  it("keeps a report over the size limit on the Shared folder and comments with a pointer", async () => {
    const { clock, shared, dispatcher, watcher } = rig();
    const task = await assign(clock);
    await dispatcher.dispatchOnce();
    clock.advance(1_000);
    shared.write(result(task.id, "success.md"), `${"x".repeat(1024 * 1024 + 1)}\n\nACT-REPORT-END\n`);
    const gets = () => shared.calls.filter((c) => c.startsWith("get "));

    await watcher.tick();

    expect(gets()).toEqual([]);
    expect((await getTask(A, task.id)).status).toBe("done");
    const [comment] = (await listTaskComments(A, task.id)).filter((c) => c.authorKind === "agent");
    expect(comment!.body).toContain(`tasks/${task.id}/success.md`);
    expect(comment!.body.length).toBeLessThan(500);
  });
});

describe("dispatch while the Panel is up", () => {
  it("claims a Task assigned after start without being called, and stops cleanly", async () => {
    const clock = new FakeClock();
    const shared = new FakeShared(clock);
    const core = new FakeCore();
    const log = collectingLog();
    const watcher = new ResultWatcher({ ownerId: A, now: clock.now, pollMs: 15, log });
    const { agents } = rig();
    const dispatcher = new TaskDispatcher({
      ownerId: A,
      startSession: core.startSession,
      sharedFor: async () => shared,
      watcher,
      agents,
      now: clock.now,
      pollMs: 15,
      log,
    });

    dispatcher.start();
    const first = await assign(clock, { title: "while up" });
    await waitUntil(() => core.starts.length === 1);
    expect((await getTask(A, first.id)).status).toBe("in_progress");

    // The loop also carries a result through, with no tick called by the test.
    clock.advance(1_000);
    shared.write(result(first.id, "success.md"), report("by the timer"));
    await waitUntil(async () => (await getTask(A, first.id)).status === "done");

    await dispatcher.stop();
    const later = await assign(clock, { title: "after stop" });
    await new Promise((r) => setTimeout(r, 80));

    expect(core.starts).toHaveLength(1);
    expect((await getTask(A, later.id)).status).toBe("assigned");
    expect(log.errors).toEqual([]);
  });

  it("leaves no timer behind after stop", async () => {
    const { vi } = await import("vitest");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const { dispatcher, core } = rig();
      dispatcher.start();
      await waitUntil(() => vi.getTimerCount() === 2); // the dispatcher's loop and the watcher's, once adoption is done
      await dispatcher.stop();

      expect(vi.getTimerCount()).toBe(0);
      expect(core.starts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets go of the Sessions on stop and leaves running Tasks in progress", async () => {
    const { clock, core, dispatcher, watcher } = rig();
    const task = await assign(clock);
    await dispatcher.dispatchOnce();

    await dispatcher.stop();

    expect(core.sessions[0]!.disposed).toBe(true);
    expect(watcher.size).toBe(0);
    expect((await getTask(A, task.id)).status).toBe("in_progress");
  });

  it("claims nothing once stopped", async () => {
    const { clock, core, dispatcher } = rig();
    await assign(clock);
    await dispatcher.stop();

    expect(await dispatcher.dispatchOnce()).toBe(0);
    expect(core.starts).toHaveLength(0);
  });
});

describe("the Panel's own wiring", () => {
  it("dispatches from startTaskDispatch with the real services, and stopTaskDispatch ends it", async () => {
    const { startTaskDispatch, stopTaskDispatch } = await import("../index");
    // The Agent does not exist, so the real Agents service refuses it: the Task failing with that reason shows the
    // loop ran the real claim, the real Agent lookup and the real failure path, with no test double in between.
    const task = await createTask(A, { title: "wired", agent: "agent_nobody", startNow: true });

    startTaskDispatch();
    startTaskDispatch(); // a second call starts nothing more
    await waitUntil(async () => (await getTask(A, task.id)).status === "failed");
    await stopTaskDispatch();
    await stopTaskDispatch(); // and stopping twice is safe

    expect((await getTask(A, task.id)).lastError).toContain("its Agent cannot run it: agent not found");
  });
});

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
}
