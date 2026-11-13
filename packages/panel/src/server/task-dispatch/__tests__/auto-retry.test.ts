import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb } from "../../__tests__/_panel-test-db";
import { taskAutoRetryView } from "~/shared/auto-retry";
import { FakeClock, FakeCore, FakeShared, collectingLog } from "./fakes";

/**
 * Opt-in auto-retry of a Task whose Session dies without a result (#958), end to end: the real Tasks service on a real
 * database, the dispatcher and the result watcher on a fake Core, fake Shared folder and a clock the test moves by hand.
 */

const testDb = await openPanelTestDb();
const { TaskDispatcher } = await import("../dispatcher");
const { ResultWatcher } = await import("../result-watcher");
const { stopTaskRun } = await import("../stop-task");
const { NotFoundError } = await import("../../errors");
const { createTask, getTask, listTaskComments, addTaskComment } = await import("../../services/tasks");
const { setAutoRetrySettings, listPausedCores, resumeAutoRetryOnCore } = await import("../../services/auto-retry-settings");

const A = 1;
const MIN = 60_000;
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
  await testDb.pool.query("insert into operator (id, name, password_hash, created_at, password_changed_at) values ($1, 'owner', 'h', 1, 1)", [A]);
});
beforeEach(async () => {
  await testDb.pool.query("truncate tasks cascade");
  await testDb.pool.query("delete from app_settings where key like 'tasks.autoRetry.%'");
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
    get: async (_owner: number, id: string) => {
      if (id !== AGENT.id) throw new NotFoundError("agent not found");
      return AGENT;
    },
    resolve: async (_owner: number, id: string) => {
      if (id !== AGENT.id) throw new NotFoundError("agent not found");
      return { agentId: AGENT.id, coreId: AGENT.coreId, harness: AGENT.harness, model: AGENT.model, flags: [...AGENT.flags] };
    },
  };
  const watcher = new ResultWatcher({ ownerId: A, now: clock.now, exitGraceMs: GRACE_MS, log, stopSession: core.stopSession, liveSessions: core.liveSessions });
  const dispatcher = new TaskDispatcher({ ownerId: A, startSession: core.startSession, sharedFor: async () => shared, watcher, stopSession: core.stopSession, agents, now: clock.now, log });
  const stop = (id: string) => stopTaskRun(A, id, { stoppedBy: "Operator" }, { watcher, stopSession: core.stopSession, now: clock.now, log });
  return { clock, shared, core, log, watcher, dispatcher, stop };
}
type Rig = ReturnType<typeof rig>;

const assign = (r: Rig, overrides: Partial<Parameters<typeof createTask>[1]> = {}) =>
  createTask(A, { title: "Orchestrate", description: "Run the long job.", agent: AGENT.id, startNow: true, timeoutMinutes: null, autoRetry: { maxAttempts: 3 }, ...overrides }, r.clock.now());

const prompt = (id: string, attempt: number) => `tasks/${id}/prompt-attempt-${attempt}.md`;
const RETRY_LINE = (code: number | string) => `The previous attempt's Session exited with code ${code} without a result. Read your state file or the comments before repeating any step.`;

/**
 * The newest Session dies: it ran `runMs`, optionally left progress (a comment by the agent, a file in the Task's folder),
 * then exited with `code`; the watcher looks once the grace is over.
 */
async function die(r: Rig, taskId: string, opts: { code?: number; runMs?: number; comment?: string; file?: string } = {}) {
  r.clock.advance(opts.runMs ?? 3 * MIN);
  if (opts.comment) await addTaskComment(A, taskId, { authorKind: "agent", authorName: "Claude Code", body: opts.comment }, r.clock.now());
  if (opts.file) r.shared.write(`tasks/${taskId}/${opts.file}`, "state");
  r.core.sessions.at(-1)!.exit(opts.code ?? 143);
  r.clock.advance(GRACE_MS);
  await r.watcher.tick();
}

const autoRetryComments = async (id: string) => (await listTaskComments(A, id)).filter((c) => c.body.startsWith("Auto-retry"));

describe("a Task that opted in and whose Session dies without a result", () => {
  it("is dispatched again with the retry lines after each kill, and ends failed at the cap", async () => {
    const r = rig();
    const task = await assign(r);
    expect(await r.dispatcher.dispatchOnce()).toBe(1);

    await die(r, task.id, { comment: "step 1 done" });
    let t = await getTask(A, task.id);
    expect(t).toMatchObject({ status: "assigned", attemptCount: 1, lastError: "waiting: auto-retry in 1 min" });
    expect(t.autoRetry).toMatchObject({ retries: 1, notBefore: r.clock.now() + MIN });
    expect((await autoRetryComments(task.id)).map((c) => [c.authorKind, c.body])).toEqual([["system", "Auto-retry 2/3: previous Session exited (code 143) without a result"]]);
    expect(r.shared.text(`tasks/${task.id}/fail.md`)).toBeNull();
    expect(r.watcher.isTracking(task.id)).toBe(false);

    // Back-off 1 minute: not claimed before, no comment per poll.
    const before = (await listTaskComments(A, task.id)).length;
    r.clock.advance(MIN - 1);
    expect(await r.dispatcher.dispatchOnce()).toBe(0);
    expect(await r.dispatcher.dispatchOnce()).toBe(0);
    expect((await listTaskComments(A, task.id)).length).toBe(before);
    expect(r.core.starts).toHaveLength(1);
    r.clock.advance(1);
    expect(await r.dispatcher.dispatchOnce()).toBe(1);
    expect(r.core.starts).toHaveLength(2);
    t = await getTask(A, task.id);
    expect(t).toMatchObject({ status: "in_progress", attemptCount: 2 });
    expect(t.autoRetry).toMatchObject({ retries: 1, notBefore: null });
    const second = r.shared.text(prompt(task.id, 2))!;
    expect(second).toContain("This is attempt 2.");
    expect(second).toContain(RETRY_LINE(143));
    expect(second.indexOf("This is attempt 2.")).toBeLessThan(second.indexOf(RETRY_LINE(143)));
    expect(r.shared.text(prompt(task.id, 1))).not.toBeNull();
    expect(r.shared.text(prompt(task.id, 1))).not.toContain("exited with code");

    // The second kill: back-off 5 minutes.
    await die(r, task.id, { comment: "step 2 done", code: 137 });
    expect(await getTask(A, task.id)).toMatchObject({ status: "assigned" });
    expect((await autoRetryComments(task.id)).at(-1)!.body).toBe("Auto-retry 3/3: previous Session exited (code 137) without a result");
    r.clock.advance(5 * MIN - 1);
    expect(await r.dispatcher.dispatchOnce()).toBe(0);
    r.clock.advance(1);
    expect(await r.dispatcher.dispatchOnce()).toBe(1);
    expect(r.shared.text(prompt(task.id, 3))).toContain(RETRY_LINE(137));

    // The third dies as well: no attempt left.
    await die(r, task.id, { comment: "step 3 done", code: 1 });
    t = await getTask(A, task.id);
    expect(t.status).toBe("failed");
    expect(t.attemptCount).toBe(3);
    expect(r.shared.text(`tasks/${task.id}/fail.md`)).toContain("Auto-retry stopped: 3 of 3 attempts used");
    expect(r.shared.text(`tasks/${task.id}/fail.md`)).toContain("The agent exited (code 1) without writing a result file");
    expect(t.autoRetry?.notice).toMatchObject({ kind: "gave-up", text: expect.stringContaining("3 of 3 attempts used") });
    expect(r.core.starts).toHaveLength(3);
  });

  it("waits the back-off of 1 minute for the first retry and 5 for the second", async () => {
    const r = rig();
    const task = await assign(r);
    await r.dispatcher.dispatchOnce();
    await die(r, task.id, { comment: "a" });
    const first = (await getTask(A, task.id)).autoRetry!.notBefore!;
    expect(first - r.clock.now()).toBe(MIN);
    r.clock.advance(MIN);
    await r.dispatcher.dispatchOnce();
    await die(r, task.id, { comment: "b", code: 2 });
    expect((await getTask(A, task.id)).autoRetry!.notBefore! - r.clock.now()).toBe(5 * MIN);
  });
});

describe("no auto-retry", () => {
  it("after an operator stop", async () => {
    const r = rig();
    const task = await assign(r);
    await r.dispatcher.dispatchOnce();
    r.clock.advance(3 * MIN);
    await addTaskComment(A, task.id, { authorKind: "agent", authorName: "Claude Code", body: "progress" }, r.clock.now());
    await r.stop(task.id);
    r.core.sessions[0]!.exit(143);
    r.clock.advance(GRACE_MS);
    await r.watcher.tick();
    expect(await getTask(A, task.id)).toMatchObject({ status: "failed" });
    expect(await autoRetryComments(task.id)).toEqual([]);
    expect(r.shared.text(`tasks/${task.id}/fail.md`)).toBeNull();
  });

  it("after the timeout", async () => {
    const r = rig();
    const task = await assign(r, { timeoutMinutes: 5 });
    await r.dispatcher.dispatchOnce();
    r.clock.advance(5 * MIN);
    await addTaskComment(A, task.id, { authorKind: "agent", authorName: "Claude Code", body: "progress" }, r.clock.now());
    await r.watcher.tick();
    expect((await getTask(A, task.id)).status).toBe("failed");
    expect(r.shared.text(`tasks/${task.id}/fail.md`)).toContain("5-minute time limit");
    expect(await autoRetryComments(task.id)).toEqual([]);
    expect(r.core.starts).toHaveLength(1);
  });

  it("when the agent wrote its own fail.md", async () => {
    const r = rig();
    const task = await assign(r);
    await r.dispatcher.dispatchOnce();
    r.clock.advance(3 * MIN);
    r.shared.write(`tasks/${task.id}/fail.md`, "# Failed\n\nI could not do it.\n\nACT-REPORT-END\n");
    await die(r, task.id, { runMs: 1 });
    expect((await getTask(A, task.id)).status).toBe("failed");
    expect(await autoRetryComments(task.id)).toEqual([]);
    expect(r.shared.text(`tasks/${task.id}/fail.md`)).toContain("I could not do it.");
  });

  it("when the Session exits within 2 minutes of starting", async () => {
    const r = rig();
    const task = await assign(r);
    await r.dispatcher.dispatchOnce();
    await die(r, task.id, { runMs: 2 * MIN - GRACE_MS - 1, comment: "hello" });
    const t = await getTask(A, task.id);
    expect(t.status).toBe("failed");
    expect(r.shared.text(`tasks/${task.id}/fail.md`)).not.toContain("Auto-retry");
    expect(r.shared.text(`tasks/${task.id}/fail.md`)).toContain("exited (code 143) without writing a result file");
    expect(await autoRetryComments(task.id)).toEqual([]);
    expect(t.autoRetry).toMatchObject({ retries: 0, notice: { kind: "gave-up", text: "Auto-retry stopped: the Session exited within 2 minutes of starting" } });
  });

  it("when the Task did not opt in: the same fail.md as before", async () => {
    const r = rig();
    const task = await assign(r, { autoRetry: null });
    await r.dispatcher.dispatchOnce();
    await die(r, task.id, { comment: "progress" });
    const t = await getTask(A, task.id);
    expect(t).toMatchObject({ status: "failed", autoRetry: null });
    expect(r.shared.text(`tasks/${task.id}/fail.md`)).toBe(
      `# Failed\n\nThe agent exited (code 143) without writing a result file. (attempt 1; written by the Panel.)\n\nACT-REPORT-END\n`,
    );
    expect(await autoRetryComments(task.id)).toEqual([]);
  });
});

describe("loop guards", () => {
  it("an attempt with no progress ends the Task failed", async () => {
    const r = rig();
    const task = await assign(r);
    await r.dispatcher.dispatchOnce();
    await die(r, task.id);
    const t = await getTask(A, task.id);
    expect(t.status).toBe("failed");
    expect(t.autoRetry?.notice?.text).toBe("Auto-retry stopped: no progress in attempt 1");
    expect(r.shared.text(`tasks/${task.id}/fail.md`)).toContain("Auto-retry stopped: no progress in attempt 1");
    expect(t.autoRetry?.notice).toMatchObject({ kind: "gave-up", text: "Auto-retry stopped: no progress in attempt 1" });
    expect(await autoRetryComments(task.id)).toEqual([]);
  });

  it("a system comment, a prompt file or an older file is no progress; a new file, or 10 minutes of running, is", async () => {
    const r = rig();
    const old = await assign(r);
    r.shared.write(`tasks/${old.id}/notes.md`, "from before");
    await r.clock.advance(1);
    await r.dispatcher.dispatchOnce();
    r.clock.advance(MIN);
    await addTaskComment(A, old.id, { authorKind: "system", authorName: "Panel", body: "bookkeeping" }, r.clock.now());
    await die(r, old.id, { file: "prompt-attempt-7.md" });
    expect(await getTask(A, old.id)).toMatchObject({ status: "failed" });
    expect(r.shared.text(`tasks/${old.id}/fail.md`)).toContain("no progress in attempt 1");

    const withFile = await assign(r);
    await r.dispatcher.dispatchOnce();
    await die(r, withFile.id, { file: "state.md" });
    expect((await getTask(A, withFile.id)).status).toBe("assigned");

    const long = await assign(r);
    await r.dispatcher.dispatchOnce();
    await die(r, long.id, { runMs: 10 * MIN });
    expect((await getTask(A, long.id)).status).toBe("assigned");
  });

  it("the same exit twice in a row stops the retries", async () => {
    const r = rig();
    const task = await assign(r);
    await r.dispatcher.dispatchOnce();
    await die(r, task.id, { code: 137, file: "state-1.md" });
    expect((await getTask(A, task.id)).status).toBe("assigned");
    r.clock.advance(MIN);
    await r.dispatcher.dispatchOnce();
    await die(r, task.id, { code: 137, file: "state-2.md" });
    const t = await getTask(A, task.id);
    expect(t.status).toBe("failed");
    expect(r.shared.text(`tasks/${task.id}/fail.md`)).toContain("Auto-retry stopped: the same exit twice (code 137)");
    expect(r.core.starts).toHaveLength(2);
  });

  it("the same exit twice stops the retries even when the agent left a different comment each time", async () => {
    const r = rig();
    const task = await assign(r);
    await r.dispatcher.dispatchOnce();
    await die(r, task.id, { code: 137, comment: "first thing I did" });
    expect((await getTask(A, task.id)).status).toBe("assigned");
    r.clock.advance(MIN);
    await r.dispatcher.dispatchOnce();
    await die(r, task.id, { code: 137, comment: "a completely different note" });
    expect((await getTask(A, task.id)).status).toBe("failed");
    expect(r.shared.text(`tasks/${task.id}/fail.md`)).toContain("Auto-retry stopped: the same exit twice (code 137)");
    expect(r.core.starts).toHaveLength(2);
  });

  it("a hand-over chain cannot exceed the ceiling in total (retries inherited from the lineage count)", async () => {
    const r = rig();
    const task = await assign(r);
    await testDb.pool.query(`update tasks set auto_retry = jsonb_set(auto_retry, '{inherited}', '1') where id = $1`, [task.id]);
    await r.dispatcher.dispatchOnce();
    await die(r, task.id, { comment: "one" });
    expect((await getTask(A, task.id)).status).toBe("assigned");
    r.clock.advance(MIN);
    await r.dispatcher.dispatchOnce();
    await die(r, task.id, { comment: "two", code: 1 });
    const t = await getTask(A, task.id);
    expect(t.status).toBe("failed");
    expect(r.core.starts).toHaveLength(2); // 1 inherited + 1 own retry = the ceiling's 2 retries; attempt 3 is not started
  });

  it("the instance ceiling lowers a Task's own request", async () => {
    await setAutoRetrySettings(A, { maxAttemptsCeiling: 1 });
    const r = rig();
    const task = await assign(r);
    await r.dispatcher.dispatchOnce();
    await die(r, task.id, { comment: "progress" });
    expect((await getTask(A, task.id)).status).toBe("failed");
    expect(r.core.starts).toHaveLength(1);
  });

  it("the circuit breaker trips on the third auto-retry on a Core within an hour; the fourth is refused with a notice", async () => {
    const r = rig();
    const tasks = [];
    for (let i = 0; i < 4; i++) {
      tasks.push(await assign(r, { title: `Job ${i}` }));
      await r.clock.advance(1);
    }
    expect(await r.dispatcher.dispatchOnce()).toBe(4);
    r.clock.advance(3 * MIN);
    for (const t of tasks) await addTaskComment(A, t.id, { authorKind: "agent", authorName: "Claude Code", body: `progress of ${t.title}` }, r.clock.now());
    for (const s of r.core.sessions) s.exit(143);
    r.clock.advance(GRACE_MS);
    await r.watcher.tick();

    const after = await Promise.all(tasks.map((t) => getTask(A, t.id)));
    const retried = after.filter((t) => t.status === "assigned");
    const refused = after.filter((t) => t.status === "failed");
    expect(retried).toHaveLength(3);
    expect(refused).toHaveLength(1);
    expect(r.shared.text(`tasks/${refused[0]!.id}/fail.md`)).toContain("Auto-retry is paused on this Core");
    expect(refused[0]!.autoRetry?.notice).toMatchObject({ kind: "gave-up" });
    // The third retry is the one that tripped it: it is still scheduled, and its notice says the Core is paused.
    const tripped = retried.filter((t) => t.autoRetry?.notice?.kind === "paused");
    expect(tripped).toHaveLength(1);
    expect(tripped[0]!.autoRetry?.notice?.text).toContain("paused on Core core_1");
    expect(tripped[0]!.autoRetry?.notBefore).not.toBeNull();
    expect(await listPausedCores(A)).toEqual(["core_1"]);

    // An operator resumes the Core: auto-retry works there again.
    await resumeAutoRetryOnCore(A, "core_1");
    expect(await listPausedCores(A)).toEqual([]);
    const fresh = await assign(r, { title: "After resume" });
    await r.dispatcher.dispatchOnce();
    await die(r, fresh.id, { comment: "progress after resume" });
    expect((await getTask(A, fresh.id)).status).toBe("assigned");
  });

  it("the kill switch stops a pending retry: the Task is failed instead of started", async () => {
    const r = rig();
    const task = await assign(r);
    await r.dispatcher.dispatchOnce();
    await die(r, task.id, { comment: "progress" });
    expect((await getTask(A, task.id)).status).toBe("assigned");
    await setAutoRetrySettings(A, { enabled: false });
    r.clock.advance(MIN);
    await r.dispatcher.dispatchOnce();
    const t = await getTask(A, task.id);
    expect(t).toMatchObject({ status: "failed", attemptCount: 1, lastError: "Auto-retry is switched off" });
    expect(t.autoRetry?.notice).toMatchObject({ kind: "gave-up", text: "Auto-retry is switched off" });
    expect(r.core.starts).toHaveLength(1);
  });

  it("the kill switch also covers a Task that already carries autoRetry: its death is a plain failure", async () => {
    await setAutoRetrySettings(A, { enabled: false });
    const r = rig();
    const task = await assign(r);
    await r.dispatcher.dispatchOnce();
    await die(r, task.id, { comment: "progress" });
    const t = await getTask(A, task.id);
    expect(t.status).toBe("failed");
    expect(r.shared.text(`tasks/${task.id}/fail.md`)).not.toContain("Auto-retry stopped");
    expect(await autoRetryComments(task.id)).toEqual([]);
    expect(t.autoRetry?.notice).toMatchObject({ kind: "gave-up", text: "Auto-retry is switched off" });
  });

  it("the lineage's retries survive a child that has no autoRetry: its own child is refused the next retry", async () => {
    const r = rig();
    const a = await assign(r, { startNow: false });
    await testDb.pool.query(`update tasks set auto_retry = jsonb_set(auto_retry, '{retries}', '2') where id = $1`, [a.id]);
    const b = await assign(r, { startNow: false, fromTaskId: a.id });
    expect(taskAutoRetryView((await getTask(A, b.id)).autoRetry)).toBeNull();
    const c = await assign(r, { fromTaskId: b.id });
    expect((await getTask(A, c.id)).autoRetry).toMatchObject({ retries: 0 });
    await r.dispatcher.dispatchOnce();
    await die(r, c.id, { comment: "progress" });
    expect((await getTask(A, c.id)).status).toBe("failed");
    expect(r.core.starts).toHaveLength(1);
  });
});
