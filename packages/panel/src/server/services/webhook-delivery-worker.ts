import {
  WEBHOOK_CLAIM_LEASE_MS,
  WEBHOOK_DELIVERY_RETENTION_MS,
  WEBHOOK_RETRY_DELAYS_MS,
  type WebhookEventType,
} from "~/shared/webhooks";
import {
  claimDueDeliveries,
  findMatchingWebhooks,
  findPendingOutbox,
  findWebhookById,
  insertDeliveries,
  markDeliveryDelivered,
  markDeliveryRetryOrFailed,
  markOutboxProcessed,
  pruneOldDeliveries,
  type NewDeliveryRow,
  type WebhookDeliveryRow,
  type WebhookOutboxRow,
} from "../repositories/webhooks.repo";
import { newId } from "./_ids";
import { OPERATOR_ID } from "./operator";
import { sendSignedWebhook } from "./webhook-deliver";
import { webhookSecret } from "./webhooks";

/**
 * Webhook delivery worker (#574): fan out pending outbox rows to matching
 * webhooks, claim due deliveries with a lease, sign and POST, retry on the
 * schedule, and prune deliveries older than 14 days.
 */

export type WebhookClock = () => number;

const DEFAULT_BATCH = 50;

function pingTargetWebhookId(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { data?: { webhookId?: unknown } };
    return typeof parsed.data?.webhookId === "string" ? parsed.data.webhookId : null;
  } catch {
    return null;
  }
}

async function fanOutOutbox(ownerId: number, row: WebhookOutboxRow, now: number): Promise<void> {
  const eventType = row.eventType as WebhookEventType;
  let hooks =
    eventType === "ping"
      ? []
      : await findMatchingWebhooks(ownerId, eventType, row.coreId);

  if (eventType === "ping") {
    const targetId = pingTargetWebhookId(row.payload);
    if (targetId) {
      const hook = await findWebhookById(ownerId, targetId);
      if (hook) hooks = [hook];
    }
  }

  const deliveries: NewDeliveryRow[] = hooks.map((hook) => ({
    id: newId("wd"),
    ownerId,
    webhookId: hook.id,
    outboxId: row.id,
    eventType: row.eventType,
    payload: row.payload,
    status: "pending",
    attemptCount: 0,
    nextAttemptAt: now,
    claimedUntil: null,
    lastStatusCode: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    deliveredAt: null,
  }));
  await insertDeliveries(deliveries);
  await markOutboxProcessed(ownerId, row.id, now);
}

export type WebhookSender = typeof sendSignedWebhook;

async function deliverOne(
  row: WebhookDeliveryRow,
  now: number,
  send: WebhookSender,
): Promise<void> {
  const hook = await findWebhookById(row.ownerId, row.webhookId);
  if (!hook) {
    await markDeliveryRetryOrFailed(row.ownerId, row.id, now, {
      attemptCount: row.attemptCount,
      nextAttemptAt: now,
      status: "failed",
      statusCode: null,
      error: "webhook deleted",
    });
    return;
  }
  const secret = webhookSecret(hook);
  if (!secret) {
    await markDeliveryRetryOrFailed(row.ownerId, row.id, now, {
      attemptCount: row.attemptCount,
      nextAttemptAt: now,
      status: "failed",
      statusCode: null,
      error: "webhook secret unreadable",
    });
    return;
  }

  const timestamp = String(now);
  const result = await send({
    url: hook.url,
    secret,
    deliveryId: row.id,
    timestamp,
    body: row.payload,
  });

  if (result.kind === "sent") {
    await markDeliveryDelivered(row.ownerId, row.id, now, result.statusCode);
    return;
  }

  const attemptCount = row.attemptCount + 1;
  const delay = WEBHOOK_RETRY_DELAYS_MS[row.attemptCount];
  if (delay === undefined) {
    await markDeliveryRetryOrFailed(row.ownerId, row.id, now, {
      attemptCount,
      nextAttemptAt: now,
      status: "failed",
      statusCode: result.kind === "failed" ? result.statusCode : null,
      error: result.error,
    });
    return;
  }
  await markDeliveryRetryOrFailed(row.ownerId, row.id, now, {
    attemptCount,
    nextAttemptAt: now + delay,
    status: "pending",
    statusCode: result.kind === "failed" ? result.statusCode : null,
    error: result.error,
  });
}

/** One tick: fan-out, deliver due rows, prune for each owner. */
export async function runWebhookDeliveryTick(
  ownerIds: readonly number[] = [OPERATOR_ID],
  now: number = Date.now(),
  opts: { batch?: number; send?: WebhookSender } = {},
): Promise<{ fannedOut: number; delivered: number; pruned: number }> {
  const batch = opts.batch ?? DEFAULT_BATCH;
  const send = opts.send ?? sendSignedWebhook;
  let fannedOut = 0;
  let delivered = 0;
  let pruned = 0;

  for (const ownerId of ownerIds) {
    for (const row of await findPendingOutbox(ownerId, batch)) {
      await fanOutOutbox(ownerId, row, now);
      fannedOut += 1;
    }
    const claimed = await claimDueDeliveries(ownerId, now, now + WEBHOOK_CLAIM_LEASE_MS, batch);
    for (const row of claimed) {
      await deliverOne(row, now, send);
      delivered += 1;
    }
    pruned += await pruneOldDeliveries(ownerId, now - WEBHOOK_DELIVERY_RETENTION_MS);
  }

  return { fannedOut, delivered, pruned };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the background tick (call from panel boot). Idempotent. */
export function startWebhookDeliveryWorker(
  intervalMs = 5_000,
  ownerIds: () => readonly number[] | Promise<readonly number[]> = () => [OPERATOR_ID],
  clock: WebhookClock = Date.now,
): void {
  if (timer) return;
  timer = setInterval(() => {
    void (async () => {
      try {
        await runWebhookDeliveryTick(await ownerIds(), clock());
      } catch (err) {
        console.error(
          `[panel] webhook delivery tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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
}
