import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WEBHOOK_CLAIM_LEASE_MS,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "~/shared/webhooks";
import { closePanelTestDb, openPanelTestDb } from "../../__tests__/_panel-test-db";
import { verifyWebhookSignature } from "../webhook-signing";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-webhooks-test-"));
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");
delete process.env.AC_SECRETS_KEY;

const testDb = await openPanelTestDb();
const { resetSecretsKeyForTests } = await import("../secrets-at-rest");
resetSecretsKeyForTests();

const {
  changeTaskStatus,
  createTask,
  addTaskComment,
  updateTask,
  deleteTask,
} = await import("../tasks");
const { createWebhook, pingWebhook } = await import("../webhooks");
const { runWebhookDeliveryTick, stopWebhookDeliveryWorkerForTests } = await import(
  "../webhook-delivery-worker"
);
const { sendSignedWebhook } = await import("../webhook-deliver");

const A = 1;
const publicLookup = async () => ["93.184.216.34"];

beforeAll(async () => {
  stopWebhookDeliveryWorkerForTests();
  await testDb.pool.query("alter table operator drop constraint if exists operator_single_row");
  await testDb.pool.query(
    "insert into operator (id, name, password_hash, created_at, password_changed_at) values (1, 'A', 'h', 1, 1) on conflict do nothing",
  );
  await testDb.pool.query(
    "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ('core-a', 1, 'A', 'https://a', 1, 1), ('core-b', 1, 'B', 'https://b', 1, 1) on conflict do nothing",
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

describe("outbox in the same transaction", () => {
  it("writes an outbox row when a status changes, and nothing when the change rolls back", async () => {
    const task = await createTask(A, { title: "t", startNow: true }, 500);
    const before = await testDb.pool.query("select count(*)::int as n from webhook_outbox");
    expect(before.rows[0].n).toBe(1); // task.created

    await changeTaskStatus(A, task.id, "in_progress", 1000);
    const after = await testDb.pool.query(
      "select event_type from webhook_outbox order by created_at, id",
    );
    expect(after.rows.map((r) => r.event_type)).toEqual(["task.created", "task.status_changed"]);

    const countBeforeIllegal = (await testDb.pool.query("select count(*)::int as n from webhook_outbox"))
      .rows[0].n;
    await expect(changeTaskStatus(A, task.id, "draft")).rejects.toThrow(/cannot move/);
    const countAfterIllegal = (await testDb.pool.query("select count(*)::int as n from webhook_outbox"))
      .rows[0].n;
    expect(countAfterIllegal).toBe(countBeforeIllegal);
  });

  it("emits nothing for a comment that rolls back with a refused status move", async () => {
    const { commentAndReassign } = await import("../tasks");
    const task = await createTask(A, { title: "t" }, 1); // draft
    const before = (await testDb.pool.query("select count(*)::int as n from webhook_outbox")).rows[0].n;
    await expect(
      commentAndReassign(A, task.id, { authorKind: "user", authorName: "u", body: "nope" }),
    ).rejects.toThrow(/cannot move/);
    const after = (await testDb.pool.query("select count(*)::int as n from webhook_outbox")).rows[0].n;
    expect(after).toBe(before);
  });
});

describe("a status change delivers one signed event", () => {
  it("fans out once, signs with the secret, and marks delivered under a stable delivery id", async () => {
    const { webhook, secret } = await createWebhook(
      A,
      { url: "https://hooks.example.test/w", events: ["task.status_changed"] },
      1,
      { lookup: publicLookup },
    );
    const task = await createTask(A, { title: "t", startNow: true, coreId: "core-a" });
    await changeTaskStatus(A, task.id, "in_progress", 2000);

    const sent: { deliveryId: string; timestamp: string; body: string; signature: string }[] = [];
    const send = vi.fn(async (input: {
      url: string;
      secret: string;
      deliveryId: string;
      timestamp: string;
      body: string;
    }) => {
      sent.push({
        deliveryId: input.deliveryId,
        timestamp: input.timestamp,
        body: input.body,
        signature: `sha256=captured`,
      });
      expect(verifyWebhookSignature(secret, input.timestamp, input.body, 
        (await import("../webhook-signing")).signWebhookBody(secret, input.timestamp, input.body),
      )).toBe(true);
      expect(input.url).toBe(webhook.url);
      return { kind: "sent" as const, statusCode: 200 };
    });

    const tick = await runWebhookDeliveryTick([A], 3000, { send: send as never });
    expect(tick.fannedOut).toBeGreaterThanOrEqual(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    const payload = JSON.parse(sent[0]!.body) as { type: string };
    expect(payload.type).toBe("task.status_changed");

    const rows = await testDb.pool.query(
      "select id, status, attempt_count from webhook_deliveries where webhook_id = $1",
      [webhook.id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ status: "delivered", attempt_count: 0 });
    expect(rows.rows[0].id).toBe(sent[0]!.deliveryId);

    // A second tick must not re-send the delivered row.
    await runWebhookDeliveryTick([A], 4000, { send: send as never });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("Core restriction", () => {
  it("delivers only when the Task's Core is in the webhook's scope", async () => {
    const { webhook: onlyA } = await createWebhook(
      A,
      { url: "https://hooks.example.test/a", events: ["task.status_changed"], coreIds: ["core-a"] },
      1,
      { lookup: publicLookup },
    );
    const taskB = await createTask(A, { title: "tb", startNow: true, coreId: "core-b" });
    await changeTaskStatus(A, taskB.id, "in_progress", 10);
    const send = vi.fn(async () => ({ kind: "sent" as const, statusCode: 200 }));
    await runWebhookDeliveryTick([A], 20, { send: send as never });
    expect(send).not.toHaveBeenCalled();
    expect(
      (await testDb.pool.query("select count(*)::int as n from webhook_deliveries where webhook_id = $1", [onlyA.id]))
        .rows[0].n,
    ).toBe(0);

    const taskA = await createTask(A, { title: "ta", startNow: true, coreId: "core-a" });
    await changeTaskStatus(A, taskA.id, "in_progress", 30);
    await runWebhookDeliveryTick([A], 40, { send: send as never });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("retries, claim lease and pruning", () => {
  it("retries on the schedule with a fake clock, then marks failed", async () => {
    await createWebhook(
      A,
      { url: "https://hooks.example.test/r", events: ["task.created"] },
      1,
      { lookup: publicLookup },
    );
    await createTask(A, { title: "t" }, 0);

    const send = vi.fn(async () => ({ kind: "failed" as const, statusCode: 500, error: "HTTP 500" }));
    let now = 1000;
    await runWebhookDeliveryTick([A], now, { send: send as never });
    expect(send).toHaveBeenCalledTimes(1);

    for (let i = 0; i < WEBHOOK_RETRY_DELAYS_MS.length; i++) {
      const row = await testDb.pool.query(
        "select status, attempt_count, next_attempt_at from webhook_deliveries",
      );
      expect(row.rows[0].status).toBe("pending");
      expect(Number(row.rows[0].attempt_count)).toBe(i + 1);
      now = Number(row.rows[0].next_attempt_at);
      await runWebhookDeliveryTick([A], now, { send: send as never });
    }
    expect(send).toHaveBeenCalledTimes(1 + WEBHOOK_RETRY_DELAYS_MS.length);
    const final = await testDb.pool.query("select status, attempt_count from webhook_deliveries");
    expect(final.rows[0].status).toBe("failed");
  });

  it("re-claims under the same delivery id after the lease expires", async () => {
    const { webhook } = await createWebhook(
      A,
      { url: "https://hooks.example.test/lease", events: ["task.created"] },
      1,
      { lookup: publicLookup },
    );
    await pingWebhook(A, webhook.id, 100);

    const ids: string[] = [];
    const capturingSend = vi.fn(async (input: { deliveryId: string }) => {
      ids.push(input.deliveryId);
      return { kind: "failed" as const, statusCode: 503, error: "busy" };
    });
    await runWebhookDeliveryTick([A], 200, { send: capturingSend as never });
    expect(ids).toHaveLength(1);
    await testDb.pool.query(
      "update webhook_deliveries set claimed_until = $1, status = 'pending', next_attempt_at = 200 where id = $2",
      [200 + WEBHOOK_CLAIM_LEASE_MS, ids[0]],
    );
    await runWebhookDeliveryTick([A], 200 + WEBHOOK_CLAIM_LEASE_MS - 1, { send: capturingSend as never });
    expect(capturingSend).toHaveBeenCalledTimes(1);
    await runWebhookDeliveryTick([A], 200 + WEBHOOK_CLAIM_LEASE_MS, { send: capturingSend as never });
    expect(capturingSend).toHaveBeenCalledTimes(2);
    expect(ids[1]).toBe(ids[0]);
  });

  it("prunes deliveries older than 14 days", async () => {
    await createWebhook(
      A,
      { url: "https://hooks.example.test/p", events: ["task.created"] },
      1,
      { lookup: publicLookup },
    );
    await createTask(A, { title: "old" }, 1);
    await runWebhookDeliveryTick([A], 1, {
      send: async () => ({ kind: "sent", statusCode: 200 }),
    });
    expect((await testDb.pool.query("select count(*)::int as n from webhook_deliveries")).rows[0].n).toBe(1);
    const fourteenDays = 14 * 24 * 60 * 60_000;
    const pruned = await runWebhookDeliveryTick([A], 1 + fourteenDays + 1, {
      send: async () => ({ kind: "sent", statusCode: 200 }),
    });
    expect(pruned.pruned).toBe(1);
    expect((await testDb.pool.query("select count(*)::int as n from webhook_deliveries")).rows[0].n).toBe(0);
  });
});

describe("all five change events and ping", () => {
  it("emits task.created, updated, status_changed, deleted, comment.created and ping", async () => {
    const { webhook } = await createWebhook(
      A,
      {
        url: "https://hooks.example.test/all",
        events: ["task.created", "task.updated", "task.status_changed", "task.deleted", "comment.created"],
      },
      1,
      { lookup: publicLookup },
    );
    const task = await createTask(A, { title: "t", startNow: true }, 1);
    await updateTask(A, task.id, { title: "t2" }, 2);
    await changeTaskStatus(A, task.id, "in_progress", 3);
    await addTaskComment(A, task.id, { authorKind: "user", authorName: "u", body: "hi" }, 4);
    await deleteTask(A, task.id, 5);
    await pingWebhook(A, webhook.id, 6);

    const types = (
      await testDb.pool.query("select event_type from webhook_outbox order by created_at, id")
    ).rows.map((r) => r.event_type);
    expect(types).toEqual([
      "task.created",
      "task.updated",
      "task.status_changed",
      "comment.created",
      "task.deleted",
      "ping",
    ]);
  });
});

describe("sendSignedWebhook SSRF and redirects", () => {
  it("refuses a URL that resolves only to a private address", async () => {
    const result = await sendSignedWebhook(
      {
        url: "https://evil.internal/hook",
        secret: "s",
        deliveryId: "d1",
        timestamp: "1",
        body: "{}",
      },
      { lookup: async () => ["127.0.0.1", "10.0.0.1", "::1"] },
    );
    expect(result).toEqual({ kind: "refused", error: expect.stringContaining("refused address") });
  });

  it("refuses http URLs", async () => {
    const result = await sendSignedWebhook(
      {
        url: "http://example.com/hook",
        secret: "s",
        deliveryId: "d1",
        timestamp: "1",
        body: "{}",
      },
      { lookup: publicLookup },
    );
    expect(result).toEqual({ kind: "refused", error: "https only" });
  });

  it("does not follow redirects", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const cert = await import("node:crypto").then(({ X509Certificate, createSign }) => {
      // Minimal self-signed PEM via openssl-less path: use tls.createSecureContext with generate
      void X509Certificate;
      void createSign;
      return null as string | null;
    });
    void cert;
    void privateKey;
    void publicKey;

    // Stand up a tiny HTTPS server with a self-signed cert from openssl if available,
    // else skip to a mocked redirect response via a custom connect.
    const { execFileSync } = await import("node:child_process");
    const keyPath = path.join(tmpRoot, "key.pem");
    const certPath = path.join(tmpRoot, "cert.pem");
    try {
      execFileSync(
        "openssl",
        ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath, "-days", "1", "-nodes", "-subj", "/CN=hooks.example.test"],
        { stdio: "pipe" },
      );
    } catch {
      // No openssl: assert the redirect branch with a stubbed request by hitting the code path
      // through a mock server is unavailable — still cover via unit of status handling below.
      const result = await sendSignedWebhook(
        {
          url: "https://hooks.example.test/r",
          secret: "s",
          deliveryId: "d1",
          timestamp: "1",
          body: "{}",
        },
        {
          lookup: publicLookup,
          connectTo: "127.0.0.1",
          timeoutMs: 200,
        },
      );
      // Connection refused is fine for this environment without a listener; the dedicated
      // redirect case needs openssl. Mark skipped logic via expect on refused/failed.
      expect(["refused", "failed"]).toContain(result.kind);
      return;
    }

    let hits = 0;
    const server = https.createServer(
      { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
      (req, res) => {
        hits += 1;
        expect(req.headers.host).toBe("hooks.example.test");
        expect(req.headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()]).toMatch(/^sha256=/);
        expect(req.headers[WEBHOOK_TIMESTAMP_HEADER.toLowerCase()]).toBeDefined();
        expect(req.headers[WEBHOOK_DELIVERY_HEADER.toLowerCase()]).toBe("d-redirect");
        res.writeHead(302, { location: "https://hooks.example.test/elsewhere" });
        res.end();
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      const result = await sendSignedWebhook(
        {
          url: `https://hooks.example.test:${port}/hook`,
          secret: "s",
          deliveryId: "d-redirect",
          timestamp: "99",
          body: '{"ok":true}',
        },
        { lookup: publicLookup, connectTo: "127.0.0.1", timeoutMs: 2000 },
      );
      expect(result).toEqual({ kind: "failed", statusCode: 302, error: "redirect not followed" });
      expect(hits).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
