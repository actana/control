import { randomBytes } from "node:crypto";
import * as dns from "node:dns/promises";
import { isIP } from "node:net";
import { NotFoundError, ValidationError } from "../errors";
import { findCoreById } from "../repositories/cores.repo";
import {
  deleteWebhookRow,
  findDeliveriesForWebhook,
  findWebhookById,
  findWebhookCoreIds,
  findWebhooks,
  insertOutbox,
  insertWebhook,
  type WebhookDeliveryRow,
  type WebhookRow,
} from "../repositories/webhooks.repo";
import {
  WEBHOOK_CHANGE_EVENT_TYPES,
  WEBHOOK_EVENT_TYPES,
  isWebhookEventType,
  type WebhookEventType,
} from "~/shared/webhooks";
import { newId } from "./_ids";
import { OPERATOR_ID } from "./operator";
import { openSecret, sealSecret } from "./secrets-at-rest";
import { isBlockedWebhookAddress } from "./webhook-ssrf";

/**
 * Webhooks (#574): create, list, delete and ping. The signing secret is shown
 * once at create and sealed at rest; deliveries are the worker's job.
 */

const SECRET_BYTES = 32;
export const MAX_WEBHOOK_URL_LENGTH = 2048;

export type WebhookUrlLookup = (hostname: string) => Promise<string[]>;

const defaultLookup: WebhookUrlLookup = async (hostname) => {
  if (isIP(hostname)) return [hostname];
  return (await dns.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);
};

export type Webhook = {
  id: string;
  url: string;
  events: WebhookEventType[];
  allCores: boolean;
  coreIds: string[];
  createdAt: number;
  updatedAt: number;
};

export type WebhookDelivery = {
  id: string;
  webhookId: string;
  eventType: string;
  status: string;
  attemptCount: number;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: number;
  deliveredAt: number | null;
};

function toWebhook(row: WebhookRow, coreIds: string[]): Webhook {
  return {
    id: row.id,
    url: row.url,
    events: row.events.filter(isWebhookEventType),
    allCores: row.allCores,
    coreIds: row.allCores ? [] : coreIds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDelivery(row: WebhookDeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    webhookId: row.webhookId,
    eventType: row.eventType,
    status: row.status,
    attemptCount: row.attemptCount,
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
  };
}

async function assertHttpsPublicUrl(url: string, lookup: WebhookUrlLookup): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError("webhook URL is not valid");
  }
  if (parsed.protocol !== "https:") throw new ValidationError("webhook URL must be https");
  if (url.length > MAX_WEBHOOK_URL_LENGTH) {
    throw new ValidationError(`webhook URL is at most ${MAX_WEBHOOK_URL_LENGTH} characters`);
  }
  const host = parsed.hostname;
  if (!host) throw new ValidationError("webhook URL is not valid");
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch (err) {
    throw new ValidationError(
      `webhook URL host could not be resolved: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (addresses.length === 0) throw new ValidationError("webhook URL host resolved to nothing");
  if (addresses.every((a) => isBlockedWebhookAddress(a))) {
    throw new ValidationError("webhook URL resolves to a private or otherwise blocked address");
  }
}

/**
 * Create a webhook. `coreIds` omitted or null means every Core; otherwise only
 * those Cores. The returned `secret` is plaintext once.
 */
export async function createWebhook(
  ownerId: number,
  input: { url: string; events: string[]; coreIds?: string[] | null },
  now = Date.now(),
  opts: { lookup?: WebhookUrlLookup } = {},
): Promise<{ webhook: Webhook; secret: string }> {
  const url = input.url.trim();
  if (!url) throw new ValidationError("a webhook needs a URL");
  await assertHttpsPublicUrl(url, opts.lookup ?? defaultLookup);
  const events = [...new Set(input.events.map((e) => e.trim()).filter(Boolean))];
  if (events.length === 0) throw new ValidationError("a webhook needs at least one event");
  for (const event of events) {
    if (!isWebhookEventType(event) || event === "ping") {
      throw new ValidationError(
        `unknown webhook event: ${event} (choose from ${WEBHOOK_CHANGE_EVENT_TYPES.join(", ")})`,
      );
    }
  }
  const coreIds = input.coreIds ?? null;
  if (coreIds && coreIds.length === 0) {
    throw new ValidationError(
      "a restricted webhook needs at least one Core; leave the Cores out to reach every Core",
    );
  }
  if (coreIds) {
    for (const coreId of coreIds) {
      if (!(await findCoreById(ownerId, coreId))) {
        throw new ValidationError("a Core named for this webhook does not exist");
      }
    }
  }
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const result = await insertWebhook(
    {
      id: newId("wh"),
      ownerId,
      url,
      secretSealed: sealSecret(secret),
      events,
      allCores: coreIds === null,
      createdAt: now,
      updatedAt: now,
    },
    coreIds,
  );
  if (result.kind === "no-core") throw new ValidationError("a Core named for this webhook does not exist");
  return {
    webhook: toWebhook(result.webhook, coreIds ? [...new Set(coreIds)].sort() : []),
    secret,
  };
}

export async function listWebhooks(ownerId: number = OPERATOR_ID): Promise<Webhook[]> {
  const rows = await findWebhooks(ownerId);
  const coreIds = await findWebhookCoreIds(ownerId);
  return rows.map((row) => toWebhook(row, coreIds.get(row.id) ?? []));
}

export async function deleteWebhook(ownerId: number, id: string): Promise<void> {
  if (!(await deleteWebhookRow(ownerId, id))) throw new NotFoundError("no such webhook");
}

/** Enqueue a `ping` for this webhook; the worker delivers it to this hook only. */
export async function pingWebhook(
  ownerId: number,
  id: string,
  now = Date.now(),
): Promise<{ outboxId: string }> {
  const row = await findWebhookById(ownerId, id);
  if (!row) throw new NotFoundError("no such webhook");
  const outboxId = newId("wob");
  await insertOutbox({
    id: outboxId,
    ownerId,
    eventType: "ping",
    payload: JSON.stringify({ id: outboxId, type: "ping", createdAt: now, data: { webhookId: id } }),
    coreId: null,
    createdAt: now,
    processedAt: null,
  });
  return { outboxId };
}

/** Open the sealed secret for a webhook row; null when the key cannot open it. */
export function webhookSecret(row: WebhookRow): string | null {
  return openSecret(Buffer.from(row.secretSealed));
}

export async function listWebhookDeliveries(
  ownerId: number,
  webhookId: string,
  limit = 20,
): Promise<WebhookDelivery[]> {
  if (!(await findWebhookById(ownerId, webhookId))) throw new NotFoundError("no such webhook");
  return (await findDeliveriesForWebhook(ownerId, webhookId, limit)).map(toDelivery);
}

export { WEBHOOK_EVENT_TYPES };
