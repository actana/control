import {
  WEBHOOK_CLAIM_LEASE_MS,
  WEBHOOK_DELIVERY_RETENTION_MS,
  WEBHOOK_RETRY_DELAYS_MS,
} from "~/shared/webhooks";
import {
  claimAndFanOutOneOutbox,
  claimOneDueDelivery,
  markDeliveryDelivered,
  markDeliveryRetryOrFailed,
  pruneOldDeliveries,
  type WebhookDeliveryRow,
} from "../repositories/webhooks.repo";
import { OPERATOR_ID } from "./operator";
import { sendSignedWebhook } from "./webhook-deliver";
import { webhookSecret } from "./webhooks";
import { findWebhookById } from "../repositories/webhooks.repo";

/**
 * Webhook delivery worker (#574): fan out pending outbox rows to matching
 * webhooks (one locked transaction each), claim one due delivery at a time with
 * a lease that covers that send, sign and POST, retry on the schedule, and
 * prune deliveries older than 14 days. Ticks do not overlap.
 */

export type WebhookClock = () => number;

const DEFAULT_BATCH = 50;

export type WebhookSender = typeof sendSignedWebhook;

async function deliverOne(
  row: WebhookDeliveryRow,
  claimedUntil: number,
  clock: WebhookClock,
  send: WebhookSender,
): Promise<void> {
  const hook = await findWebhookById(row.ownerId, row.webhookId);
  if (!hook) {
    await markDeliveryRetryOrFailed(row.ownerId, row.id, clock(), claimedUntil, {
      attemptCount: row.attemptCount,
      nextAttemptAt: clock(),
      status: "failed",
      statusCode: null,
      error: "webhook deleted",
    });
    return;
  }
  const secret = webhookSecret(hook);
  if (!secret) {
    await markDeliveryRetryOrFailed(row.ownerId, row.id, clock(), claimedUntil, {
      attemptCount: row.attemptCount,
      nextAttemptAt: clock(),
      status: "failed",
      statusCode: null,
      error: "webhook secret unreadable",
    });
    return;
  }

  // Timestamp is the send time, not the tick's start (R3).
  const sentAt = clock();
  const timestamp = String(sentAt);
  const result = await send({
    url: hook.url,
    secret,
    deliveryId: row.id,
    timestamp,
    body: row.payload,
  });

  const now = clock();
  if (result.kind === "sent") {
    await markDeliveryDelivered(row.ownerId, row.id, now, result.statusCode, claimedUntil);
    return;
  }

  const attemptCount = row.attemptCount + 1;
  const delay = WEBHOOK_RETRY_DELAYS_MS[row.attemptCount];
  if (delay === undefined) {
    await markDeliveryRetryOrFailed(row.ownerId, row.id, now, claimedUntil, {
      attemptCount,
      nextAttemptAt: now,
      status: "failed",
      statusCode: result.kind === "failed" ? result.statusCode : null,
      error: result.error,
    });
    return;
  }
  await markDeliveryRetryOrFailed(row.ownerId, row.id, now, claimedUntil, {
    attemptCount,
    nextAttemptAt: now + delay,
    status: "pending",
    statusCode: result.kind === "failed" ? result.statusCode : null,
    error: result.error,
  });
}

/** One tick: fan-out, deliver due rows one at a time, prune for each owner. */
export async function runWebhookDeliveryTick(
  ownerIds: readonly number[] = [OPERATOR_ID],
  now: number = Date.now(),
  opts: { batch?: number; send?: WebhookSender; clock?: WebhookClock } = {},
): Promise<{ fannedOut: number; delivered: number; pruned: number }> {
  const batch = opts.batch ?? DEFAULT_BATCH;
  const send = opts.send ?? sendSignedWebhook;
  const clock = opts.clock ?? (() => now);
  let fannedOut = 0;
  let delivered = 0;
  let pruned = 0;

  for (const ownerId of ownerIds) {
    for (let i = 0; i < batch; i++) {
      const result = await claimAndFanOutOneOutbox(ownerId, clock());
      if (!result) break;
      fannedOut += 1;
    }
    for (let i = 0; i < batch; i++) {
      const claimNow = clock();
      const leaseUntil = claimNow + WEBHOOK_CLAIM_LEASE_MS;
      const row = await claimOneDueDelivery(ownerId, claimNow, leaseUntil);
      if (!row) break;
      await deliverOne(row, leaseUntil, clock, send);
      delivered += 1;
    }
    pruned += await pruneOldDeliveries(ownerId, clock() - WEBHOOK_DELIVERY_RETENTION_MS);
  }

  return { fannedOut, delivered, pruned };
}

let timer: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;

/** Start the background tick (call from panel boot). Idempotent; ticks do not overlap. */
export function startWebhookDeliveryWorker(
  intervalMs = 5_000,
  ownerIds: () => readonly number[] | Promise<readonly number[]> = () => [OPERATOR_ID],
  clock: WebhookClock = Date.now,
): void {
  if (timer) return;
  timer = setInterval(() => {
    if (tickRunning) return;
    tickRunning = true;
    void (async () => {
      try {
        await runWebhookDeliveryTick(await ownerIds(), clock(), { clock });
      } catch (err) {
        console.error(
          `[panel] webhook delivery tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        tickRunning = false;
      }
    })();
  }, intervalMs);
  // Do not keep the process alive solely for the worker in tests / short runs.
  if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
}

/** @internal */
export function stopWebhookDeliveryWorkerForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
  tickRunning = false;
}
