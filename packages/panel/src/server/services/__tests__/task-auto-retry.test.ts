import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { autoRetryCauseSignature, taskAutoRetryView } from "~/shared/auto-retry";
import { closePanelTestDb, openPanelTestDb, seedWebhook } from "../../__tests__/_panel-test-db";

const testDb = await openPanelTestDb();
const { ValidationError } = await import("../../errors");
const { setAutoRetrySettings } = await import("../auto-retry-settings");
const {
  changeTaskStatus,
  claimTask,
  clearAutoRetryPending,
  createTask,
  createTaskDetailed,
  getTask,
  listTaskComments,
  listTaskHistory,
  scheduleAutoRetry,
  setAutoRetryNotice,
  updateTask,
} = await import("../tasks");

const A = 1;
const MIN = 60_000;

beforeAll(async () => {
  await testDb.pool.query("alter table operator drop constraint operator_single_row");
  await testDb.pool.query(
    "insert into operator (id, name, password_hash, created_at, password_changed_at) values (1, 'A', 'h', 1, 1)",
  );
  await testDb.pool.query(
    "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ('core-a', 1, 'A', 'https://a', 1, 1)",
  );
});
beforeEach(async () => {
  await testDb.pool.query("truncate webhooks, webhook_outbox, task_comments, task_status_history, tasks cascade");
  await testDb.pool.query("delete from app_settings where key like 'tasks.autoRetry.%'");
  await seedWebhook(testDb, A);
});
afterAll(async () => {
  await closePanelTestDb(testDb);
});

/** A Task opted in with `maxAttempts`, claimed and running its first attempt. */
async function running(maxAttempts = 3) {
  const task = await createTask(A, { title: "t", startNow: true, coreId: "core-a", agent: "ag", autoRetry: { maxAttempts } }, 1000);
  await claimTask(A, task.id, 2000);
  return task.id;
}
const schedule = { attempt: 1, exitCode: 143, cause: autoRetryCauseSignature(143, "killed"), delayMs: MIN, max: 3 };

describe("createTask autoRetry and fromTaskId", () => {
  it("stores nothing by default and a fresh counter when asked", async () => {
    expect((await createTask(A, { title: "plain" }, 1)).autoRetry).toBeNull();
    const t = await createTask(A, { title: "x", autoRetry: { maxAttempts: 2 } }, 1);
    expect(t.autoRetry).toEqual({ maxAttempts: 2, retries: 0, inherited: 0, notBefore: null, lastCause: null, notice: null });
    expect((await getTask(A, t.id)).autoRetry).toEqual(t.autoRetry);
  });

  it("null means off; a bad request is a ValidationError", async () => {
    expect((await createTask(A, { title: "x", autoRetry: null }, 1)).autoRetry).toBeNull();
    for (const bad of [0, 1.5, -1, "3"]) {
      await expect(createTask(A, { title: "x", autoRetry: { maxAttempts: bad as number } }, 1)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("clamps to the instance ceiling and says so", async () => {
    await setAutoRetrySettings(A, { maxAttemptsCeiling: 2 });
    const clamped = await createTaskDetailed(A, { title: "x", autoRetry: { maxAttempts: 3 } }, 1);
    expect(clamped.autoRetryClamped).toBe(true);
    expect(clamped.task.autoRetry?.maxAttempts).toBe(2);
    const fine = await createTaskDetailed(A, { title: "x", autoRetry: { maxAttempts: 2 } }, 1);
    expect(fine).toMatchObject({ autoRetryClamped: false, task: { autoRetry: { maxAttempts: 2 } } });
    expect((await createTaskDetailed(A, { title: "x", autoRetry: { maxAttempts: 9 } }, 1)).task.autoRetry?.maxAttempts).toBe(2);
  });

  it("a child of an auto-retry attempt gets no autoRetry (guard 4)", async () => {
    const parent = await running();
    await scheduleAutoRetry(A, parent, schedule, 3000);
    const child = await createTask(A, { title: "Resume", autoRetry: { maxAttempts: 3 }, fromTaskId: parent }, 4000);
    expect(taskAutoRetryView(child.autoRetry)).toBeNull();
    expect(child.autoRetry).toMatchObject({ optedIn: false, maxAttempts: 1, inherited: 1, retries: 0 });
  });

  it("a child of a Task that did not retry yet inherits the lineage's retries", async () => {
    const parent = await createTask(A, { title: "p", autoRetry: { maxAttempts: 3 } }, 1);
    const first = await createTask(A, { title: "c", autoRetry: { maxAttempts: 3 }, fromTaskId: parent.id }, 2);
    expect(first.autoRetry?.inherited).toBe(0);
    await testDb.pool.query(
      `update tasks set auto_retry = jsonb_set(jsonb_set(auto_retry, '{inherited}', '1'), '{retries}', '0') where id = $1`,
      [parent.id],
    );
    const second = await createTask(A, { title: "c2", autoRetry: { maxAttempts: 3 }, fromTaskId: parent.id }, 3);
    expect(second.autoRetry?.inherited).toBe(1);
  });

  it("the lineage survives a child without autoRetry: a grandchild starts with the inherited count", async () => {
    const a = await running();
    await scheduleAutoRetry(A, a, schedule, 3000);
    await testDb.pool.query(`update tasks set auto_retry = jsonb_set(auto_retry, '{retries}', '2') where id = $1`, [a]);
    const b = await createTask(A, { title: "B", autoRetry: { maxAttempts: 3 }, fromTaskId: a }, 4000);
    expect(taskAutoRetryView(b.autoRetry)).toBeNull();
    expect(b.autoRetry).toMatchObject({ optedIn: false, inherited: 2 });
    const c = await createTask(A, { title: "C", autoRetry: { maxAttempts: 3 }, fromTaskId: b.id }, 5000);
    expect(c.autoRetry).toMatchObject({ retries: 0, inherited: 2 });
    // A child with no request at all keeps the lineage too.
    const d = await createTask(A, { title: "D", fromTaskId: a }, 6000);
    expect(taskAutoRetryView(d.autoRetry)).toBeNull();
    expect((await createTask(A, { title: "E", autoRetry: { maxAttempts: 3 }, fromTaskId: d.id }, 7000)).autoRetry).toMatchObject({ inherited: 2 });
  });

  it("an operator's later update_task on a lineage-only Task opts it in and keeps the inherited count", async () => {
    const a = await running();
    await scheduleAutoRetry(A, a, schedule, 3000);
    const b = await createTask(A, { title: "B", autoRetry: { maxAttempts: 3 }, fromTaskId: a }, 4000);
    const on = await updateTask(A, b.id, { autoRetry: { maxAttempts: 3 } }, 5000);
    expect(on.autoRetry).toMatchObject({ maxAttempts: 3, retries: 0 });
    const row = await testDb.pool.query("select auto_retry from tasks where id = $1", [b.id]);
    expect(row.rows[0].auto_retry).toMatchObject({ inherited: 1 });
    expect((row.rows[0].auto_retry as { optedIn?: boolean }).optedIn).not.toBe(false);
  });

  it("ignores an unknown fromTaskId and one without a request", async () => {
    expect((await createTask(A, { title: "c", autoRetry: { maxAttempts: 3 }, fromTaskId: "nope" }, 1)).autoRetry?.inherited).toBe(0);
    const parent = await running();
    await scheduleAutoRetry(A, parent, schedule, 3000);
    expect(taskAutoRetryView((await createTask(A, { title: "c", fromTaskId: parent }, 1)).autoRetry)).toBeNull();
  });
});

describe("updateTask autoRetry", () => {
  it("sets, clamps and clears it at any status, including in_progress", async () => {
    const id = await running();
    expect((await updateTask(A, id, { autoRetry: { maxAttempts: 2 } }, 5000)).autoRetry).toMatchObject({ maxAttempts: 2, retries: 0 });
    await setAutoRetrySettings(A, { maxAttemptsCeiling: 1 });
    expect((await updateTask(A, id, { autoRetry: { maxAttempts: 3 } }, 5001)).autoRetry?.maxAttempts).toBe(1);
    expect((await updateTask(A, id, { autoRetry: null }, 5002)).autoRetry).toBeNull();
    const draft = await createTask(A, { title: "d" }, 1);
    expect((await updateTask(A, draft.id, { autoRetry: { maxAttempts: 3 } }, 5003)).autoRetry).toMatchObject({ maxAttempts: 1 });
  });

  it("switching it off keeps used retries, so on-off-on never resets the lineage", async () => {
    const id = await running();
    await scheduleAutoRetry(A, id, schedule, 3000);
    const off = await updateTask(A, id, { autoRetry: null }, 4000);
    expect(off.autoRetry).toMatchObject({ maxAttempts: 1, retries: 1, notBefore: null });
    const on = await updateTask(A, id, { autoRetry: { maxAttempts: 3 } }, 4001);
    expect(on.autoRetry).toMatchObject({ maxAttempts: 3, retries: 1 });
  });

  it("an empty update still follows the old rule: title and description need an editable status", async () => {
    const id = await running();
    await expect(updateTask(A, id, { title: "new" }, 5000)).rejects.toThrow(/cannot be edited/);
  });
});

describe("scheduleAutoRetry", () => {
  it("moves in_progress to assigned with notBefore, one system comment, a notice, history and outbox", async () => {
    const id = await running();
    const task = await scheduleAutoRetry(A, id, schedule, 10_000);
    expect(task).toMatchObject({
      status: "assigned",
      attemptCount: 1,
      coreId: "core-a",
      agent: "ag",
      sessionState: null,
      sessionStateAt: null,
      lastError: "waiting: auto-retry in 1 min",
    });
    const retry = task!.autoRetry!;
    expect(retry).toMatchObject({ retries: 1, notBefore: 10_000 + MIN, lastCause: "143|killed" });
    expect(retry.notice).toEqual({ id: 1, kind: "retry", text: "Auto-retry 2/3: previous Session exited (code 143) without a result" });
    const comments = (await listTaskComments(A, id)).filter((c) => c.authorKind === "system");
    expect(comments.map((c) => c.body)).toEqual(["Auto-retry 2/3: previous Session exited (code 143) without a result"]);
    expect((await listTaskHistory(A, id)).map((h) => `${h.fromStatus}>${h.toStatus}`)).toEqual([
      "null>assigned",
      "assigned>in_progress",
      "in_progress>assigned",
    ]);
    const events = await testDb.pool.query("select event_type, payload from webhook_outbox where created_at = 10000 order by id");
    expect(events.rows.map((r) => r.event_type).sort()).toEqual(["comment.created", "task.status_changed"]);
    const changed = JSON.parse(String(events.rows.find((r) => r.event_type === "task.status_changed")!.payload));
    expect(changed.data).toMatchObject({ from: "in_progress", to: "assigned", task: { autoRetry: { retries: 1, pendingAt: 10_000 + MIN } } });
  });

  it("writes unknown for a missing exit code and counts the notice up", async () => {
    const id = await running();
    const first = await scheduleAutoRetry(A, id, { ...schedule, exitCode: null }, 10_000);
    expect(first!.autoRetry!.notice!.text).toBe("Auto-retry 2/3: previous Session exited (code unknown) without a result");
    await claimTask(A, id, 20_000);
    const second = await scheduleAutoRetry(A, id, { ...schedule, attempt: 2, delayMs: 5 * MIN }, 30_000);
    expect(second!.autoRetry).toMatchObject({ retries: 2, notBefore: 30_000 + 5 * MIN, notice: { id: 2 } });
  });

  it("does nothing when the Task is not in_progress on that attempt, or has no autoRetry", async () => {
    const id = await running();
    expect(await scheduleAutoRetry(A, id, { ...schedule, attempt: 2 }, 10_000)).toBeNull();
    await changeTaskStatus(A, id, "failed", 5000);
    expect(await scheduleAutoRetry(A, id, schedule, 10_000)).toBeNull();
    expect((await getTask(A, id)).status).toBe("failed");
    const plain = await createTask(A, { title: "p", startNow: true }, 1);
    await claimTask(A, plain.id, 2);
    expect(await scheduleAutoRetry(A, plain.id, schedule, 10_000)).toBeNull();
    expect((await getTask(A, plain.id)).status).toBe("in_progress");
    expect(await scheduleAutoRetry(A, "missing", schedule, 10_000)).toBeNull();
    expect(await scheduleAutoRetry(2, id, schedule, 10_000)).toBeNull();
  });
});

describe("clearAutoRetryPending and setAutoRetryNotice", () => {
  it("clearAutoRetryPending ends only the back-off", async () => {
    const id = await running();
    await scheduleAutoRetry(A, id, schedule, 10_000);
    const cleared = await clearAutoRetryPending(A, id, 11_000);
    expect(cleared!.autoRetry).toMatchObject({ notBefore: null, retries: 1, lastCause: "143|killed", notice: { id: 1, kind: "retry" } });
    expect(await clearAutoRetryPending(A, id, 12_000)).toBeNull();
    const plain = await createTask(A, { title: "p" }, 1);
    expect(await clearAutoRetryPending(A, plain.id, 12_000)).toBeNull();
  });

  it("setAutoRetryNotice writes a new notice and ends a pending back-off, without a status move", async () => {
    const id = await running();
    await scheduleAutoRetry(A, id, schedule, 10_000);
    const gaveUp = await setAutoRetryNotice(A, id, "gave-up", "Auto-retry stopped: no progress in attempt 1", 11_000);
    expect(gaveUp).toMatchObject({ status: "assigned", updatedAt: 11_000, autoRetry: { notBefore: null, notice: { id: 2, kind: "gave-up", text: "Auto-retry stopped: no progress in attempt 1" } } });
    const plain = await createTask(A, { title: "p" }, 1);
    expect(await setAutoRetryNotice(A, plain.id, "gave-up", "x", 5)).toBeNull();
  });

  it("an operator move of a pending Task ends the back-off", async () => {
    const id = await running();
    await scheduleAutoRetry(A, id, schedule, 10_000);
    await changeTaskStatus(A, id, "draft", 11_000);
    expect((await getTask(A, id)).autoRetry).toMatchObject({ notBefore: null, retries: 1 });
  });
});
