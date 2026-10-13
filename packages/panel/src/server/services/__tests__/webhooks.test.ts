import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WEBHOOK_CLAIM_LEASE_MS,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "~/shared/webhooks";
import { closePanelTestDb, openPanelTestDb } from "../../__tests__/_panel-test-db";
import { signWebhookBody, verifyWebhookSignature } from "../webhook-signing";

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
const { claimAndFanOutOneOutbox, countDeliveriesForOutbox } = await import(
  "../../repositories/webhooks.repo"
);

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
    expect(before.rows[0].n).toBe(1);

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
    const task = await createTask(A, { title: "t" }, 1);
    const before = (await testDb.pool.query("select count(*)::int as n from webhook_outbox")).rows[0].n;
    await expect(
      commentAndReassign(A, task.id, { authorKind: "user", authorName: "u", body: "nope" }),
    ).rejects.toThrow(/cannot move/);
    const after = (await testDb.pool.query("select count(*)::int as n from webhook_outbox")).rows[0].n;
    expect(after).toBe(before);
  });
});

describe("fan-out is exactly once per outbox row (R2)", () => {
  it("fans the same outbox row out twice and still has one delivery", async () => {
    const { webhook } = await createWebhook(
      A,
      { url: "https://hooks.example.test/once", events: ["task.created"] },
      1,
      { lookup: publicLookup },
    );
    await createTask(A, { title: "t" }, 10);
    const outbox = await testDb.pool.query("select id from webhook_outbox where event_type = 'task.created'");
    const outboxId = outbox.rows[0].id as string;

    // First fan-out processes and marks the row.
    const first = await claimAndFanOutOneOutbox(A, 20);
    expect(first).toMatchObject({ outboxId, deliveryCount: 1 });
    expect(await countDeliveriesForOutbox(A, outboxId)).toBe(1);

    // Simulate a crash mid-fan-out: clear processed_at and try again. The unique
    // key on (outbox_id, webhook_id) keeps a second delivery from appearing.
    await testDb.pool.query("update webhook_outbox set processed_at = null where id = $1", [outboxId]);
    const second = await claimAndFanOutOneOutbox(A, 30);
    expect(second).toMatchObject({ outboxId, deliveryCount: 0 });
    expect(await countDeliveriesForOutbox(A, outboxId)).toBe(1);
    const ids = await testDb.pool.query(
      "select id, webhook_id from webhook_deliveries where outbox_id = $1",
      [outboxId],
    );
    expect(ids.rows).toHaveLength(1);
    expect(ids.rows[0].webhook_id).toBe(webhook.id);
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
    const task = await createTask(A, { title: "t", startNow: true, coreId: "core-a" }, 1000);
    await changeTaskStatus(A, task.id, "in_progress", 2000);

    const sent: { deliveryId: string; timestamp: string; body: string }[] = [];
    const send = vi.fn(async (input: {
      url: string;
      secret: string;
      deliveryId: string;
      timestamp: string;
      body: string;
    }) => {
      expect(verifyWebhookSignature(secret, input.timestamp, input.body, signWebhookBody(secret, input.timestamp, input.body))).toBe(
        true,
      );
      expect(input.url).toBe(webhook.url);
      sent.push({ deliveryId: input.deliveryId, timestamp: input.timestamp, body: input.body });
      return { kind: "sent" as const, statusCode: 200 };
    });

    const tick = await runWebhookDeliveryTick([A], 3000, { send: send as never });
    expect(tick.fannedOut).toBeGreaterThanOrEqual(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sent[0]!.body).type).toBe("task.status_changed");

    const rows = await testDb.pool.query(
      "select id, status, attempt_count from webhook_deliveries where webhook_id = $1",
      [webhook.id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ status: "delivered", attempt_count: 0 });
    expect(rows.rows[0].id).toBe(sent[0]!.deliveryId);

    await runWebhookDeliveryTick([A], 4000, { send: send as never });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("claim lease and marks (R3)", () => {
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

  it("ignores a late mark that no longer holds the claim", async () => {
    const { markDeliveryRetryOrFailed } = await import("../../repositories/webhooks.repo");
    await createWebhook(
      A,
      { url: "https://hooks.example.test/late", events: ["task.created"] },
      1,
      { lookup: publicLookup },
    );
    await createTask(A, { title: "t" }, 1);
    await runWebhookDeliveryTick([A], 100, {
      send: async () => ({ kind: "sent", statusCode: 200 }),
    });
    const row = await testDb.pool.query(
      "select id, status from webhook_deliveries",
    );
    expect(row.rows[0].status).toBe("delivered");
    const applied = await markDeliveryRetryOrFailed(A, row.rows[0].id as string, 200, 999, {
      attemptCount: 1,
      nextAttemptAt: 300,
      status: "pending",
      statusCode: 500,
      error: "late",
    });
    expect(applied).toBe(false);
    const after = await testDb.pool.query("select status from webhook_deliveries");
    expect(after.rows[0].status).toBe("delivered");
  });

  it("reads the clock at send time, not at tick start", async () => {
    await createWebhook(
      A,
      { url: "https://hooks.example.test/ts", events: ["task.created"] },
      1,
      { lookup: publicLookup },
    );
    await createTask(A, { title: "t" }, 1);
    let n = 0;
    const clock = () => {
      n += 1;
      // Fan-out and claim read earlier; the send-time read must be later.
      return n < 3 ? 1000 : 5555;
    };
    let seen = "";
    await runWebhookDeliveryTick([A], 1000, {
      clock,
      send: async (input) => {
        seen = input.timestamp;
        return { kind: "sent", statusCode: 200 };
      },
    });
    expect(seen).toBe("5555");
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
    const taskB = await createTask(A, { title: "tb", startNow: true, coreId: "core-b" }, 1);
    await changeTaskStatus(A, taskB.id, "in_progress", 10);
    const send = vi.fn(async () => ({ kind: "sent" as const, statusCode: 200 }));
    await runWebhookDeliveryTick([A], 20, { send: send as never });
    expect(send).not.toHaveBeenCalled();
    expect(
      (await testDb.pool.query("select count(*)::int as n from webhook_deliveries where webhook_id = $1", [onlyA.id]))
        .rows[0].n,
    ).toBe(0);

    const taskA = await createTask(A, { title: "ta", startNow: true, coreId: "core-a" }, 25);
    await changeTaskStatus(A, taskA.id, "in_progress", 30);
    await runWebhookDeliveryTick([A], 40, { send: send as never });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("retries and pruning", () => {
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
    await runWebhookDeliveryTick([A], now, { send: send as never, clock: () => now });
    expect(send).toHaveBeenCalledTimes(1);

    for (let i = 0; i < WEBHOOK_RETRY_DELAYS_MS.length; i++) {
      const row = await testDb.pool.query(
        "select status, attempt_count, next_attempt_at from webhook_deliveries",
      );
      expect(row.rows[0].status).toBe("pending");
      expect(Number(row.rows[0].attempt_count)).toBe(i + 1);
      now = Number(row.rows[0].next_attempt_at);
      await runWebhookDeliveryTick([A], now, { send: send as never, clock: () => now });
    }
    expect(send).toHaveBeenCalledTimes(1 + WEBHOOK_RETRY_DELAYS_MS.length);
    const final = await testDb.pool.query("select status, attempt_count from webhook_deliveries");
    expect(final.rows[0].status).toBe("failed");
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
    // A running Task cannot be deleted (#722): it finishes first.
    await changeTaskStatus(A, task.id, "done", 5);
    await deleteTask(A, task.id, 6);
    await pingWebhook(A, webhook.id, 7);

    const types = (
      await testDb.pool.query("select event_type from webhook_outbox order by created_at, id")
    ).rows.map((r) => r.event_type);
    expect(types).toEqual([
      "task.created",
      "task.updated",
      "task.status_changed",
      "comment.created",
      "task.status_changed",
      "task.deleted",
      "ping",
    ]);
  });
});

describe("sendSignedWebhook on the wire (R4)", () => {
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

  it("pins the TCP host to the looked-up address with the original host as SNI and Host", async () => {
    const seen: { host?: string | null; servername?: string; headers?: Record<string, unknown> } = {};
    const result = await sendSignedWebhook(
      {
        url: "https://hooks.example.test/pin",
        secret: "s",
        deliveryId: "d-pin",
        timestamp: "42",
        body: '{"pin":true}',
      },
      {
        lookup: async () => ["203.0.113.10"],
        request: ((
          options: { host?: string | null; servername?: string; headers?: Record<string, unknown> },
          cb?: (res: EventEmitter & { statusCode: number; resume: () => void }) => void,
        ) => {
          seen.host = options.host;
          seen.servername = options.servername;
          seen.headers = options.headers;
          const req = new EventEmitter() as EventEmitter & {
            write: (chunk: string, enc: string) => void;
            end: () => void;
            destroy: (err?: Error) => void;
          };
          req.write = () => {};
          req.end = () => {
            const res = new EventEmitter() as EventEmitter & {
              statusCode: number;
              resume: () => void;
            };
            res.statusCode = 200;
            res.resume = () => {};
            if (cb) cb(res);
          };
          req.destroy = () => {};
          return req as never;
        }) as never,
      },
    );
    expect(result).toEqual({ kind: "sent", statusCode: 200 });
    expect(seen.host).toBe("203.0.113.10");
    expect(seen.servername).toBe("hooks.example.test");
    expect(seen.headers?.Host).toBe("hooks.example.test");
    // Replacing the pin with the hostname would fail this assertion.
    expect(seen.host).not.toBe("hooks.example.test");
  });

  it("delivers signed headers a receiver can verify with the create secret", async () => {
    const { execFileSync } = await import("node:child_process");
    const keyPath = path.join(tmpRoot, "key.pem");
    const certPath = path.join(tmpRoot, "cert.pem");
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-keyout",
          keyPath,
          "-out",
          certPath,
          "-days",
          "1",
          "-nodes",
          "-subj",
          "/CN=hooks.example.test",
        ],
        { stdio: "pipe" },
      );
    } catch {
      throw new Error("openssl is required for the on-the-wire signature proof");
    }

    const { webhook, secret } = await createWebhook(
      A,
      { url: "https://hooks.example.test/wire", events: ["task.created"] },
      1,
      { lookup: publicLookup },
    );
    await createTask(A, { title: "wire", startNow: true }, 1);

    let hits = 0;
    let wireBody = "";
    const headersSeen: Record<string, string | string[] | undefined> = {};
    const server = https.createServer(
      { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
      (req, res) => {
        hits += 1;
        headersSeen[WEBHOOK_SIGNATURE_HEADER] = req.headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()];
        headersSeen[WEBHOOK_TIMESTAMP_HEADER] = req.headers[WEBHOOK_TIMESTAMP_HEADER.toLowerCase()];
        headersSeen[WEBHOOK_DELIVERY_HEADER] = req.headers[WEBHOOK_DELIVERY_HEADER.toLowerCase()];
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          wireBody = Buffer.concat(chunks).toString("utf8");
          res.writeHead(200);
          res.end("ok");
        });
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const ca = fs.readFileSync(certPath);
    // Trust this test cert via `ca` — do not set NODE_TLS_REJECT_UNAUTHORIZED.
    const requestWithCa = (
      options: https.RequestOptions,
      cb?: (res: import("node:http").IncomingMessage) => void,
    ) => https.request({ ...options, ca }, cb);

    try {
      await runWebhookDeliveryTick([A], 50, {
        send: (input) =>
          sendSignedWebhook(
            { ...input, url: `https://hooks.example.test:${port}/wire` },
            {
              lookup: publicLookup,
              connectTo: "127.0.0.1",
              timeoutMs: 2000,
              request: requestWithCa as never,
            },
          ),
      });
      expect(hits).toBe(1);
      const signature = String(headersSeen[WEBHOOK_SIGNATURE_HEADER] ?? "");
      const timestamp = String(headersSeen[WEBHOOK_TIMESTAMP_HEADER] ?? "");
      const deliveryId = String(headersSeen[WEBHOOK_DELIVERY_HEADER] ?? "");
      expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(timestamp).toMatch(/^\d+$/);
      expect(deliveryId.length).toBeGreaterThan(0);
      expect(verifyWebhookSignature(secret, timestamp, wireBody, signature)).toBe(true);
      expect(JSON.parse(wireBody).type).toBe("task.created");
      void webhook;
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("does not follow redirects", async () => {
    const { execFileSync } = await import("node:child_process");
    const keyPath = path.join(tmpRoot, "key2.pem");
    const certPath = path.join(tmpRoot, "cert2.pem");
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-keyout",
          keyPath,
          "-out",
          certPath,
          "-days",
          "1",
          "-nodes",
          "-subj",
          "/CN=hooks.example.test",
        ],
        { stdio: "pipe" },
      );
    } catch {
      throw new Error("openssl is required for the redirect proof");
    }

    let hits = 0;
    const server = https.createServer(
      { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
      (req, res) => {
        hits += 1;
        expect(req.headers.host).toMatch(/^hooks\.example\.test/);
        res.writeHead(302, { location: "https://hooks.example.test/elsewhere" });
        res.end();
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const ca = fs.readFileSync(certPath);
    const requestWithCa = (
      options: https.RequestOptions,
      cb?: (res: import("node:http").IncomingMessage) => void,
    ) => https.request({ ...options, ca }, cb);

    try {
      const result = await sendSignedWebhook(
        {
          url: `https://hooks.example.test:${port}/hook`,
          secret: "s",
          deliveryId: "d-redirect",
          timestamp: "99",
          body: '{"ok":true}',
        },
        {
          lookup: publicLookup,
          connectTo: "127.0.0.1",
          timeoutMs: 2000,
          request: requestWithCa as never,
        },
      );
      expect(result).toEqual({ kind: "failed", statusCode: 302, error: "redirect not followed" });
      expect(hits).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
