import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";

/**
 * Webhooks list for Settings › API & integrations (screen 09 / #574 step 3):
 * each hook carries its newest delivery, and one owner's last delivery never
 * appears in another's list. Service-level (same owner guard the HTTP routes
 * call); the session gate is already covered by api-auth snapshots.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-webhooks-settings-"));
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");
delete process.env.AC_SECRETS_KEY;

const testDb = await openPanelTestDb();
const { resetSecretsKeyForTests } = await import("../services/secrets-at-rest");
resetSecretsKeyForTests();

const { createWebhook, listWebhooks } = await import("../services/webhooks");
const { insertOutbox, claimAndFanOutOneOutbox } = await import("../repositories/webhooks.repo");
const { newId } = await import("../services/_ids");

const publicLookup = async () => ["93.184.216.34"];

beforeAll(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  await testDb.pool.query("alter table operator drop constraint if exists operator_single_row");
  await testDb.pool.query(
    "insert into operator (id, name, password_hash, created_at, password_changed_at) values (1, 'A', 'h', 1, 1) on conflict do nothing",
  );
  await testDb.pool.query(
    "insert into operator (id, name, password_hash, created_at, password_changed_at) values (2, 'B', 'h', 1, 1) on conflict do nothing",
  );
});
beforeEach(async () => {
  await resetPanelState(testDb);
  await testDb.pool.query(
    "insert into operator (id, name, password_hash, created_at, password_changed_at) values (1, 'A', 'h', 1, 1) on conflict do nothing",
  );
  await testDb.pool.query(
    "insert into operator (id, name, password_hash, created_at, password_changed_at) values (2, 'B', 'h', 1, 1) on conflict do nothing",
  );
  for (const [id, owner] of [
    ["core-a", 1],
    ["core-b", 1],
    ["core-x", 2],
  ] as const) {
    await testDb.pool.query(
      "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ($1, $2, $1, $3, 1, 1)",
      [id, owner, `https://${id}`],
    );
  }
});
afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("listWebhooks last delivery", () => {
  it("includes each webhook's newest delivery", async () => {
    const { webhook } = await createWebhook(
      1,
      { url: "https://hooks.example.com/actana", events: ["task.created"] },
      Date.now(),
      { lookup: publicLookup },
    );
    await insertOutbox({
      id: newId("wob"),
      ownerId: 1,
      eventType: "task.created",
      payload: JSON.stringify({ type: "task.created" }),
      coreId: "core-a",
      createdAt: Date.now(),
      processedAt: null,
    });
    const fan = await claimAndFanOutOneOutbox(1, Date.now());
    expect(fan?.deliveryCount).toBe(1);

    const listed = await listWebhooks(1);
    const row = listed.find((w) => w.id === webhook.id);
    expect(row?.lastDelivery).toMatchObject({ webhookId: webhook.id, status: "pending" });
  });
});

describe("last delivery is owner-scoped (two owners)", () => {
  it("owner 1's list never carries owner 2's delivery, and the reverse", async () => {
    const a = await createWebhook(
      1,
      { url: "https://hooks.example.com/a", events: ["task.created"] },
      Date.now(),
      { lookup: publicLookup },
    );
    const b = await createWebhook(
      2,
      { url: "https://hooks.example.com/b", events: ["task.created"] },
      Date.now(),
      { lookup: publicLookup },
    );
    await insertOutbox({
      id: newId("wob"),
      ownerId: 1,
      eventType: "task.created",
      payload: "{}",
      coreId: "core-a",
      createdAt: Date.now(),
      processedAt: null,
    });
    await insertOutbox({
      id: newId("wob"),
      ownerId: 2,
      eventType: "task.created",
      payload: "{}",
      coreId: "core-x",
      createdAt: Date.now(),
      processedAt: null,
    });
    await claimAndFanOutOneOutbox(1, Date.now());
    await claimAndFanOutOneOutbox(2, Date.now());

    const for1 = await listWebhooks(1);
    const for2 = await listWebhooks(2);
    expect(for1.map((w) => w.id)).toEqual([a.webhook.id]);
    expect(for2.map((w) => w.id)).toEqual([b.webhook.id]);
    expect(for1[0]!.lastDelivery?.webhookId).toBe(a.webhook.id);
    expect(for2[0]!.lastDelivery?.webhookId).toBe(b.webhook.id);
    expect(JSON.stringify(for1)).not.toContain(b.webhook.id);
    expect(JSON.stringify(for2)).not.toContain(a.webhook.id);
  });
});
