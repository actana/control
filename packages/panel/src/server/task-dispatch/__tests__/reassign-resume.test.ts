import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb } from "../../__tests__/_panel-test-db";
import { FakeClock, FakeCore, FakeShared, collectingLog } from "./fakes";

/**
 * A re-assigned Task resumes its own Session (#955, part p1): the comment is typed into that Session as its next
 * message, no new Session row, the attempt count goes up by one, and the same Session's result file finishes the Task.
 * A Session that is still running gets the message instead of a second harness. What cannot be resumed starts a new
 * Session, as before. The real Tasks service on a real database, a fake Core, a fake Shared folder, a clock by hand.
 */

const testDb = await openPanelTestDb();
const { TaskDispatcher } = await import("../dispatcher");
const { ResultWatcher } = await import("../result-watcher");
const { createTask, getTask, listTaskComments, commentAndReassign, findCurrentTaskSession } = await import("../../services/tasks");
const { NotFoundError } = await import("../../errors");

const A = 1;
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

function rig(opts: { withResume?: boolean } = {}) {
  const clock = new FakeClock();
  const shared = new FakeShared(clock);
  const core = new FakeCore();
  const log = collectingLog();
  const where = { coreId: AGENT.coreId };
  const agents = {
    get: async () => AGENT,
    resolve: async (_owner: number, id: string) => {
      if (id !== AGENT.id) throw new NotFoundError("agent not found");
      return { agentId: AGENT.id, coreId: where.coreId, harness: AGENT.harness, model: AGENT.model, flags: [...AGENT.flags] };
    },
  };
  const watcher = new ResultWatcher({ ownerId: A, now: clock.now, exitGraceMs: 10_000, log, stopSession: core.stopSession, liveSessions: core.liveSessions });
  const dispatcher = new TaskDispatcher({
    ownerId: A,
    startSession: core.startSession,
    ...(opts.withResume === false ? {} : { resumeSession: core.resumeSession }),
    sharedFor: async () => shared,
    watcher,
    stopSession: core.stopSession,
    agents,
    now: clock.now,
    log,
  });
  return { clock, shared, core, log, watcher, dispatcher, where };
}
type Rig = ReturnType<typeof rig>;

const report = (text: string) => `${text}\n\nACT-REPORT-END\n`;
const resultPath = (id: string, name: string) => `tasks/${id}/${name}`;
const bodies = async (id: string) => (await listTaskComments(A, id)).filter((c) => c.authorKind === "system").map((c) => c.body);

/** One Task through attempt 1: dispatched, then it reports success. */
async function finishedTask(r: Rig) {
  const task = await createTask(A, { title: "Fix the build", description: "Red on main.", agent: AGENT.id, startNow: true, timeoutMinutes: null }, r.clock.now());
  await r.dispatcher.dispatchOnce();
  r.clock.advance(1_000);
  r.shared.write(resultPath(task.id, "success.md"), report("Fixed it."), r.clock.now());
  await r.watcher.tick();
  expect((await getTask(A, task.id)).status).toBe("done");
  return task;
}

async function reassign(r: Rig, id: string, body = "Also handle Windows paths.") {
  r.clock.advance(1_000);
  await commentAndReassign(A, id, { authorKind: "user", authorName: "Operator", body }, r.clock.now());
  await r.dispatcher.dispatchOnce();
}

describe("a re-assigned Task resumes its own Session (#955)", () => {
  it("reopens the same Session on the same Core, types the message into it, and starts no new Session", async () => {
    const r = rig();
    const task = await finishedTask(r);
    expect(r.core.live?.has("session_1")).toBe(false); // #962 ended the harness

    await reassign(r, task.id);

    expect(r.core.resumes).toHaveLength(1);
    expect(r.core.resumes[0]).toMatchObject({ coreId: "core_1", sessionId: "session_1", harness: "claude-code", model: "claude-sonnet-5-5" });
    expect(r.core.typed).toEqual([{ sessionId: "session_1", text: expect.stringContaining(`tasks/${task.id}/prompt-attempt-2.md`), how: "resume" }]);
    expect(r.core.starts).toHaveLength(1);
    expect(r.core.sessions).toHaveLength(1);
    expect(r.core.live?.has("session_1")).toBe(true);
    expect(await getTask(A, task.id)).toMatchObject({ status: "in_progress", attemptCount: 2 });
  });

  it("says in the Task's comments that it resumed that Session, and which attempt", async () => {
    const r = rig();
    const task = await finishedTask(r);
    await reassign(r, task.id);

    const system = await bodies(task.id);
    expect(system.filter((b) => b.startsWith("Dispatched"))).toHaveLength(1);
    expect(system).toContain("Resumed Session session_1 (attempt 2)");
    expect(await findCurrentTaskSession(A, task.id)).toEqual({ coreId: "core_1", sessionId: "session_1", attempt: 2 });
  });

  it("puts the new comment into the attempt's prompt file, which the typed line points at, with where to report", async () => {
    const r = rig();
    const task = await finishedTask(r);
    await reassign(r, task.id, "Also handle Windows paths.");

    const file = r.shared.text(`tasks/${task.id}/prompt-attempt-2.md`)!;
    expect(file).toContain("Also handle Windows paths.");
    expect(file).toContain("attempt 2");
    expect(file).toContain(`~/shared/tasks/${task.id}/success.md`);
    expect(file).toContain("ACT-REPORT-END");
    // The Task itself is not sent again: that Session already has it.
    expect(file).not.toContain("Red on main.");
  });

  it("sends only what is new: the comments since the agent last reported, not the whole thread", async () => {
    const r = rig();
    const task = await finishedTask(r);
    await commentAndReassign(A, task.id, { authorKind: "user", authorName: "Operator", body: "First round of notes." }, r.clock.now());
    await r.dispatcher.dispatchOnce();
    r.clock.advance(1_000);
    r.shared.write(resultPath(task.id, "success.md"), report("Round two done."), r.clock.now());
    await r.watcher.tick();
    await reassign(r, task.id, "Now the second round.");

    const file = r.shared.text(`tasks/${task.id}/prompt-attempt-3.md`)!;
    expect(file).toContain("Now the second round.");
    expect(file).not.toContain("First round of notes.");
  });

  it("sends at most the last 20 new comments and says how many were left out", async () => {
    const r = rig();
    const task = await finishedTask(r);
    const { addTaskComment } = await import("../../services/tasks");
    for (let i = 1; i <= 24; i += 1) await addTaskComment(A, task.id, { authorKind: "user", authorName: "Operator", body: `note ${i}` }, r.clock.now());
    await reassign(r, task.id, "note 25");

    const file = r.shared.text(`tasks/${task.id}/prompt-attempt-2.md`)!;
    expect(file).toContain("note 25");
    expect(file).toContain("note 6");
    expect(file).not.toContain("note 5\n");
    expect(file).toContain(`5 older comments not included; read them with get_task ${task.id}`);
  });

  it("watches the same Session: the resumed attempt's result file finishes the Task", async () => {
    const r = rig();
    const task = await finishedTask(r);
    await reassign(r, task.id);
    r.clock.advance(1_000);
    r.shared.write(resultPath(task.id, "success.md"), report("Windows paths handled."), r.clock.now());
    await r.watcher.tick();

    expect(await getTask(A, task.id)).toMatchObject({ status: "done", attemptCount: 2 });
    const comments = await listTaskComments(A, task.id);
    expect(comments.some((c) => c.authorKind === "agent" && c.body.includes("Windows paths handled."))).toBe(true);
    // The first attempt's result was set aside, so it cannot finish attempt 2.
    expect(r.shared.text(`tasks/${task.id}/attempt-1-success.md`)).toContain("Fixed it.");
    // And the harness is ended again, as for any finished Task: it can be resumed once more.
    expect(r.core.stops).toEqual([
      { coreId: "core_1", sessionId: "session_1" },
      { coreId: "core_1", sessionId: "session_1" },
    ]);
  });

  it("does not finish on the first attempt's old result file", async () => {
    const r = rig();
    const task = await finishedTask(r);
    await reassign(r, task.id);
    r.clock.advance(1_000);
    await r.watcher.tick();

    expect((await getTask(A, task.id)).status).toBe("in_progress");
  });

  it("resumes again on the next re-assign, from the resumed attempt's comment", async () => {
    const r = rig();
    const task = await finishedTask(r);
    await reassign(r, task.id);
    r.clock.advance(1_000);
    r.shared.write(resultPath(task.id, "success.md"), report("Second."), r.clock.now());
    await r.watcher.tick();
    await reassign(r, task.id, "One more thing.");

    expect(r.core.resumes.map((x) => x.sessionId)).toEqual(["session_1", "session_1"]);
    expect(r.core.starts).toHaveLength(1);
    expect(await bodies(task.id)).toContain("Resumed Session session_1 (attempt 3)");
    expect(await getTask(A, task.id)).toMatchObject({ status: "in_progress", attemptCount: 3 });
  });

  it("a first dispatch never asks to resume", async () => {
    const r = rig();
    await finishedTask(r);
    expect(r.core.resumes).toEqual([]);
  });

  it("without a resumer (none wired) a re-assign starts a new Session, as before", async () => {
    const r = rig({ withResume: false });
    const task = await finishedTask(r);
    await reassign(r, task.id);

    expect(r.core.starts).toHaveLength(2);
    expect(await bodies(task.id)).toContain("Dispatched (attempt 2) to Claude Code (claude-code) on Core core_1: Session session_2.");
  });

  it("a stop of the resumed attempt finds the Session through the resume comment", async () => {
    const r = rig();
    const task = await finishedTask(r);
    await reassign(r, task.id);

    expect(await findCurrentTaskSession(A, task.id, 2)).toEqual({ coreId: "core_1", sessionId: "session_1", attempt: 2 });
  });
});

describe("one live harness per Task (#955)", () => {
  /** The harness did not end after the result (the Core could not be reached to stop it): the Session is still running. */
  async function finishedTaskStillRunning(r: Rig) {
    r.core.stopOutcome = { outcome: "failed", detail: "kill refused" };
    const task = await finishedTask(r);
    expect(r.core.live?.has("session_1")).toBe(true);
    return task;
  }

  it("types the message into the Session that is still running and starts nothing", async () => {
    const r = rig();
    const task = await finishedTaskStillRunning(r);
    await reassign(r, task.id);

    expect(r.core.typed).toEqual([{ sessionId: "session_1", text: expect.stringContaining(`tasks/${task.id}/prompt-attempt-2.md`), how: "send" }]);
    expect(r.core.starts).toHaveLength(1);
    expect(r.core.live?.size).toBe(1);
    expect(await bodies(task.id)).toContain("Resumed Session session_1 (attempt 2)");
    expect(await getTask(A, task.id)).toMatchObject({ status: "in_progress", attemptCount: 2 });
  });

  it("the result file of that attempt finishes the Task", async () => {
    const r = rig();
    const task = await finishedTaskStillRunning(r);
    await reassign(r, task.id);
    r.clock.advance(1_000);
    r.shared.write(resultPath(task.id, "partial-1.md"), report("Half."), r.clock.now());
    await r.watcher.tick();

    expect((await getTask(A, task.id)).status).toBe("partial");
  });

  it("when the running Session does not take the message, it is stopped and a new Session starts: never two live harnesses", async () => {
    const r = rig();
    const task = await finishedTaskStillRunning(r);
    r.core.acceptsSend = false;
    r.core.stopOutcome = { outcome: "stopped", detail: null };
    await reassign(r, task.id);

    expect(r.core.stops.at(-1)).toEqual({ coreId: "core_1", sessionId: "session_1" });
    expect(r.core.starts).toHaveLength(2);
    expect([...(r.core.live ?? [])]).toEqual(["session_2"]);
  });
});

describe("what cannot be resumed starts a new Session, as before (#955)", () => {
  async function newSessionInstead(r: Rig, reason: RegExp) {
    const task = await finishedTask(r);
    await reassign(r, task.id);

    expect(r.core.starts).toHaveLength(2);
    expect(r.core.typed).toEqual([]);
    expect(await bodies(task.id)).toContain("Dispatched (attempt 2) to Claude Code (claude-code) on Core core_1: Session session_2.");
    expect(await getTask(A, task.id)).toMatchObject({ status: "in_progress", attemptCount: 2 });
    // The reason is the seam p2 puts into its `New Session ...` comment: said here in the log.
    expect(r.log.infos.some((m) => m.includes(task.id) && reason.test(m))).toBe(true);
    // The new Session's prompt is the full one, as today.
    expect(r.shared.text(`tasks/${task.id}/prompt-attempt-2.md`)).toContain("Red on main.");
    return task;
  }

  it("the Session has no harness session id", async () => {
    const r = rig();
    r.core.capturesSessionId = false;
    await newSessionInstead(r, /no harness session id/);
  });

  it("the Core no longer has the Session", async () => {
    const r = rig();
    const task = await finishedTask(r);
    r.core.rows.delete("session_1");
    await reassign(r, task.id);

    expect(r.core.starts).toHaveLength(2);
    expect(r.log.infos.some((m) => /no longer has that Session/.test(m))).toBe(true);
  });

  it("the Agent now runs on another Core", async () => {
    const r = rig();
    const task = await finishedTask(r);
    r.where.coreId = "core_2";
    await reassign(r, task.id);

    expect(r.core.resumes).toEqual([]); // never asked: a Session cannot move
    expect(r.core.starts.map((s) => s.coreId)).toEqual(["core_1", "core_2"]);
    expect(r.log.infos.some((m) => /another Core/.test(m))).toBe(true);
  });

  it("the Core refuses the resume", async () => {
    const r = rig();
    const { RESUME_REFUSALS } = await import("../types");
    r.core.resumeRefusal = RESUME_REFUSALS.resumeRefused("session not found");
    await newSessionInstead(r, /refused the resume \(session not found\)/);
  });

  it("the harness exits at once", async () => {
    const r = rig();
    r.core.resumeExitsAtOnce = true;
    await newSessionInstead(r, /exited at once/);
  });

  it("the Task's earlier Session was cut short by an operator's stop: the new Session still stops the old one first", async () => {
    const r = rig();
    const task = await createTask(A, { title: "Fix the build", description: "Red.", agent: AGENT.id, startNow: true, timeoutMinutes: null }, r.clock.now());
    await r.dispatcher.dispatchOnce();
    r.core.capturesSessionId = false;
    const { markTaskStopped } = await import("../../services/tasks");
    await markTaskStopped(A, task.id, { stoppedBy: "Operator", reason: null }, r.clock.now());
    r.core.rows.get("session_1")!.claudeSessionId = null;
    await reassign(r, task.id);

    expect(r.core.starts).toHaveLength(2);
    expect(r.core.stops).toEqual([{ coreId: "core_1", sessionId: "session_1" }]);
  });
});

describe("a resume that cannot start waits like any start (#962)", () => {
  it("a full Core: the Task waits, no attempt is spent, and no new Session is tried in its place", async () => {
    const r = rig();
    const task = await finishedTask(r);
    r.core.resumeFailsWith = "pty:spawn refused: this Core already runs 8 live harness PTYs (the limit).";
    await reassign(r, task.id);

    expect(r.core.starts).toHaveLength(1);
    expect(await getTask(A, task.id)).toMatchObject({ status: "assigned", attemptCount: 1, lastError: "waiting: Core full (8/8)" });
  });

  it("a link that is gone: the Task waits", async () => {
    const r = rig();
    const task = await finishedTask(r);
    r.core.resumeFailsWith = "there is no live link to this Core";
    await reassign(r, task.id);

    expect(r.core.starts).toHaveLength(1);
    expect(await getTask(A, task.id)).toMatchObject({ status: "assigned", attemptCount: 1, lastError: "waiting: Core not connected" });
  });
});
