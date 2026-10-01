// Signed webhooks for Task events (#574). Pure constants and helpers the
// Panel's server (and later the Settings UI) share; no I/O here.

/** Events a webhook may subscribe to, plus the `ping` test. */
export const WEBHOOK_EVENT_TYPES = [
  "task.created",
  "task.updated",
  "task.status_changed",
  "task.deleted",
  "comment.created",
  "ping",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Task / comment events only — `ping` is a test, not a change. */
export const WEBHOOK_CHANGE_EVENT_TYPES = [
  "task.created",
  "task.updated",
  "task.status_changed",
  "task.deleted",
  "comment.created",
] as const satisfies readonly WebhookEventType[];

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return typeof value === "string" && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Retry delays after a failed send (#574): 1 m, 5 m, 30 m, 2 h, 6 h, then the
 * delivery is marked failed. Indexed by the attempt that just failed
 * (`attempt_count` before it is incremented).
 */
export const WEBHOOK_RETRY_DELAYS_MS = Object.freeze([
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
] as const);

/** Deliveries older than this are pruned. */
export const WEBHOOK_DELIVERY_RETENTION_MS = 14 * 24 * 60 * 60_000;

/** How long a worker holds a claimed delivery before another may take it. */
export const WEBHOOK_CLAIM_LEASE_MS = 60_000;

export const WEBHOOK_SIGNATURE_HEADER = "X-Webhook-Signature";
export const WEBHOOK_TIMESTAMP_HEADER = "X-Webhook-Timestamp";
export const WEBHOOK_DELIVERY_HEADER = "X-Webhook-Delivery";
