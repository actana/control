import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WEBHOOK_CHANGE_EVENT_TYPES, WEBHOOK_EVENT_TYPES, isWebhookEventType } from "~/shared/webhooks";
import { closePanelTestDb, openPanelTestDb, seedWebhook } from "../../__tests__/_panel-test-db";
import { signWebhookBody, verifyWebhookSignature } from "../webhook-signing";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-webhooks-session-state-test-"));
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");
delete process.env.AC_SECRETS_KEY;

const testDb = await openPanelTestDb();
const { resetSecretsKeyForTests } = await import("../secrets-at-rest");
resetSecretsKeyForTests();

const { changeTaskStatus, createTask, setTaskSessionState } = await import("../tasks");
const { createWebhook } = await import("../webhooks");
const { runWebhookDeliveryTick, stopWebhookDeliveryWorkerForTests } = await import("../webhook-delivery-worker");

const A = 1;
const publicLookup = async () => ["93.184.216.34"];

type Sent = { deliveryId: string; timestamp: string; body: string };

beforeAll(async () => {
  stopWebhookDeliveryWorkerForTests();
  await testDb.pool.query("alter table operator drop constraint if exists operator_single_row");
  await testDb.pool.query(
    "insert into operator (id, name, password_hash, created_at, password_changed_at) values (1, 'A', 'h', 1, 1) on conflict do nothing",
  );
  await testDb.pool.query(
    "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ('core-a', 1, 'A', 'https://a', 1, 1) on conflict do nothing",
  );
});
beforeEach(async () => {
  stopWebhookDeliveryWorkerForTests();
  resetSecretsKeyForTests();
  await testDb.pool.query(
    "truncate webhook_deliveries, webhook_outbox, webhook_cores, webhooks, task_comments, task_status_history, tasks cascade",
  );
});
afterAll(async () => {
  stopWebhookDeliveryWorkerForTests();
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function runningTask() {
  const task = await createTask(A, { title: "t", startNow: true, coreId: "core-a" }, 1000);
  await changeTaskStatus(A, task.id, "in_progress", 2000);
  return task;
}

async function sessionStateEvents() {
  const rows = await testDb.pool.query(
    "select payload from webhook_outbox where event_type = 'task.session_state_changed' order by created_at, id",
  );
  return rows.rows.map((r) => JSON.parse(String(r.payload)));
}

describe("task.session_state_changed", () => {
  it("is a webhook change event a webhook can subscribe to", () => {
    expect(isWebhookEventType("task.session_state_changed")).toBe(true);
    expect(WEBHOOK_EVENT_TYPES).toContain("task.session_state_changed");
    expect(WEBHOOK_CHANGE_EVENT_TYPES).toContain("task.session_state_changed");
  });

  it("writes one event per change and none for a repeated state", async () => {
    await seedWebhook(testDb, A);
    const task = await runningTask();
    await setTaskSessionState(A, task.id, "working", 3000);
    await setTaskSessionState(A, task.id, "working", 3100);
    await setTaskSessionState(A, task.id, "needs-input", 4000);
    await setTaskSessionState(A, task.id, "needs-input", 4100);
    await setTaskSessionState(A, task.id, "working", 5000);
    await setTaskSessionState(A, task.id, "idle-no-result", 6000);

    const events = await sessionStateEvents();
    expect(events.map((e) => e.data.sessionState)).toEqual(["working", "needs-input", "working", "idle-no-result"]);
    expect(events.map((e) => e.data.from)).toEqual([null, "working", "needs-input", "working"]);
    expect(events.map((e) => e.data.sessionStateAt)).toEqual([3000, 4000, 5000, 6000]);
    for (const e of events) {
      expect(e.type).toBe("task.session_state_changed");
      expect(e.data.taskId).toBe(task.id);
      expect(typeof e.data.attempt).toBe("number");
      expect(e.data.task).toMatchObject({ id: task.id, status: "in_progress" });
    }
  });

  it("carries taskId, attempt, sessionState and sessionStateAt, and sends nothing for a Task that is not running", async () => {
    await seedWebhook(testDb, A);
    const task = await createTask(A, { title: "queued", coreId: "core-a" }, 1000);
    await setTaskSessionState(A, task.id, "working", 2000);
    expect(await sessionStateEvents()).toEqual([]);

    const running = await runningTask();
    await setTaskSessionState(A, running.id, "interrupted", 3000);
    const [event] = await sessionStateEvents();
    const row = await testDb.pool.query("select attempt_count from tasks where id = $1", [running.id]);
    expect(event.data).toMatchObject({
      taskId: running.id,
      attempt: row.rows[0].attempt_count,
      sessionState: "interrupted",
      sessionStateAt: 3000,
    });
  });

  it("is delivered once, signed like the other Task events, to a webhook that subscribed to it", async () => {
    const { webhook, secret } = await createWebhook(
      A,
      { url: "https://hooks.example.test/s", events: ["task.session_state_changed"] },
      1,
      { lookup: publicLookup },
    );
    const task = await runningTask();
    await setTaskSessionState(A, task.id, "needs-input", 3000);
    await setTaskSessionState(A, task.id, "needs-input", 3500);

    const sent: Sent[] = [];
    const send = vi.fn(async (input: { url: string; secret: string; deliveryId: string; timestamp: string; body: string }) => {
      expect(
        verifyWebhookSignature(secret, input.timestamp, input.body, signWebhookBody(secret, input.timestamp, input.body)),
      ).toBe(true);
      expect(input.url).toBe(webhook.url);
      expect(input.secret).toBe(secret);
      sent.push({ deliveryId: input.deliveryId, timestamp: input.timestamp, body: input.body });
      return { kind: "sent" as const, statusCode: 200 };
    });
    await runWebhookDeliveryTick([A], 4000, { send: send as never });

    expect(send).toHaveBeenCalledTimes(1);
    const body = JSON.parse(sent[0]!.body);
    expect(body.type).toBe("task.session_state_changed");
    expect(body.data).toMatchObject({ taskId: task.id, sessionState: "needs-input", sessionStateAt: 3000, from: null });
  });

  it("is not delivered to a webhook that subscribed to other events only", async () => {
    await createWebhook(A, { url: "https://hooks.example.test/o", events: ["task.status_changed"] }, 1, {
      lookup: publicLookup,
    });
    const task = await runningTask();
    await setTaskSessionState(A, task.id, "needs-input", 3000);
    const send = vi.fn(async () => ({ kind: "sent" as const, statusCode: 200 }));
    await runWebhookDeliveryTick([A], 4000, { send: send as never });
    const types = send.mock.calls.map((c) => JSON.parse((c as unknown as [{ body: string }])[0].body).type);
    expect(types).not.toContain("task.session_state_changed");
  });
});
