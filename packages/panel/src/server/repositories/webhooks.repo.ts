import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { ownedBy } from "~/db/owner";
import { panelDb, type PanelDb } from "~/db/panel-db-handle";
import { cores, webhookCores, webhookDeliveries, webhookOutbox, webhooks } from "~/db/pg-schema";
import type { WebhookEventType } from "~/shared/webhooks";

export type WebhookRow = typeof webhooks.$inferSelect;
export type WebhookOutboxRow = typeof webhookOutbox.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
export type NewOutboxRow = typeof webhookOutbox.$inferInsert;
export type NewDeliveryRow = typeof webhookDeliveries.$inferInsert;

/** A drizzle transaction handle repositories share with the Tasks write path. */
export type PanelTx = Parameters<Parameters<PanelDb["transaction"]>[0]>[0];

function newDeliveryId(): string {
  return `wd-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}
/**
 * Every query here filters on `owner_id` (ADR 0041 D15): one owner's webhooks,
 * outbox rows and deliveries are never another's.
 */

export type InsertWebhookResult =
  | { kind: "no-core" }
  | { kind: "ok"; webhook: WebhookRow };

/** `coreIds` is null for every Core; otherwise the Cores this webhook is restricted to. */
export async function insertWebhook(row: WebhookRow, coreIds: string[] | null): Promise<InsertWebhookResult> {
  return panelDb().transaction(async (tx): Promise<InsertWebhookResult> => {
    if (coreIds) {
      const owned = await tx
        .select({ id: cores.id })
        .from(cores)
        .where(ownedBy(cores, row.ownerId, inArray(cores.id, coreIds)))
        .for("share");
      if (owned.length !== new Set(coreIds).size) return { kind: "no-core" };
    }
    const [webhook] = await tx
      .insert(webhooks)
      .values({ ...row, ownerId: row.ownerId, allCores: coreIds === null })
      .returning();
    if (coreIds) {
      await tx
        .insert(webhookCores)
        .values([...new Set(coreIds)].map((coreId) => ({ webhookId: row.id, coreId, ownerId: row.ownerId })));
    }
    return { kind: "ok", webhook: webhook! };
  });
}

export async function findWebhooks(ownerId: number): Promise<WebhookRow[]> {
  return panelDb()
    .select()
    .from(webhooks)
    .where(ownedBy(webhooks, ownerId))
    .orderBy(asc(webhooks.createdAt), asc(webhooks.id));
}

export async function findWebhookById(ownerId: number, id: string): Promise<WebhookRow | null> {
  const rows = await panelDb()
    .select()
    .from(webhooks)
    .where(ownedBy(webhooks, ownerId, eq(webhooks.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findWebhookCoreIds(ownerId: number, webhookIds?: string[]): Promise<Map<string, string[]>> {
  const rows = await panelDb()
    .select({ webhookId: webhookCores.webhookId, coreId: webhookCores.coreId })
    .from(webhookCores)
    .where(ownedBy(webhookCores, ownerId, webhookIds ? inArray(webhookCores.webhookId, webhookIds) : undefined))
    .orderBy(asc(webhookCores.webhookId), asc(webhookCores.coreId));
  const byHook = new Map<string, string[]>();
  for (const r of rows) byHook.set(r.webhookId, [...(byHook.get(r.webhookId) ?? []), r.coreId]);
  return byHook;
}

export async function deleteWebhookRow(ownerId: number, id: string): Promise<boolean> {
  const removed = await panelDb()
    .delete(webhooks)
    .where(ownedBy(webhooks, ownerId, eq(webhooks.id, id)))
    .returning({ id: webhooks.id });
  return removed.length > 0;
}

/** Write an outbox row inside an open transaction (the Task change's). */
export async function insertOutboxInTx(tx: PanelTx, row: NewOutboxRow): Promise<WebhookOutboxRow> {
  const [stored] = await tx.insert(webhookOutbox).values({ ...row, ownerId: row.ownerId }).returning();
  return stored!;
}

export async function insertOutbox(row: NewOutboxRow): Promise<WebhookOutboxRow> {
  return panelDb().transaction((tx) => insertOutboxInTx(tx, row));
}

/**
 * Webhooks of this owner that subscribe to `eventType` and reach `coreId`
 * (or every Core when the event has no Core).
 */
export async function findMatchingWebhooks(
  ownerId: number,
  eventType: WebhookEventType,
  coreId: string | null,
  tx: PanelTx | PanelDb = panelDb(),
): Promise<WebhookRow[]> {
  const rows = await tx
    .select()
    .from(webhooks)
    .where(ownedBy(webhooks, ownerId, sql`${eventType} = any(${webhooks.events})`));
  if (rows.length === 0) return [];
  const restricted = rows.filter((r) => !r.allCores).map((r) => r.id);
  let coreIds = new Map<string, string[]>();
  if (restricted.length) {
    const scoped = await tx
      .select({ webhookId: webhookCores.webhookId, coreId: webhookCores.coreId })
      .from(webhookCores)
      .where(ownedBy(webhookCores, ownerId, inArray(webhookCores.webhookId, restricted)))
      .orderBy(asc(webhookCores.webhookId), asc(webhookCores.coreId));
    coreIds = new Map<string, string[]>();
    for (const r of scoped) coreIds.set(r.webhookId, [...(coreIds.get(r.webhookId) ?? []), r.coreId]);
  }
  return rows.filter((row) => {
    if (row.allCores) return true;
    if (!coreId) return false;
    return (coreIds.get(row.id) ?? []).includes(coreId);
  });
}

function pingTargetWebhookId(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { data?: { webhookId?: unknown } };
    return typeof parsed.data?.webhookId === "string" ? parsed.data.webhookId : null;
  } catch {
    return null;
  }
}

/**
 * Lock one pending outbox row, insert deliveries for matching webhooks
 * (`ON CONFLICT DO NOTHING` on `(outbox_id, webhook_id)`), and mark it processed
 * — all in one transaction, so a crash cannot fan the same event out twice under
 * new delivery ids (#574 R2).
 */
export async function claimAndFanOutOneOutbox(
  ownerId: number,
  now: number,
): Promise<{ outboxId: string; deliveryCount: number } | null> {
  return panelDb().transaction(async (tx) => {
    const locked = await tx
      .select()
      .from(webhookOutbox)
      .where(ownedBy(webhookOutbox, ownerId, isNull(webhookOutbox.processedAt)))
      .orderBy(asc(webhookOutbox.createdAt), asc(webhookOutbox.id))
      .limit(1)
      .for("update", { skipLocked: true });
    const row = locked[0];
    if (!row) return null;

    const eventType = row.eventType as WebhookEventType;
    let hooks: WebhookRow[] =
      eventType === "ping" ? [] : await findMatchingWebhooks(ownerId, eventType, row.coreId, tx);
    if (eventType === "ping") {
      const targetId = pingTargetWebhookId(row.payload);
      if (targetId) {
        const found = await tx
          .select()
          .from(webhooks)
          .where(ownedBy(webhooks, ownerId, eq(webhooks.id, targetId)))
          .limit(1);
        if (found[0]) hooks = [found[0]];
      }
    }

    const deliveries: NewDeliveryRow[] = hooks.map((hook) => ({
      id: newDeliveryId(),
      ownerId,
      webhookId: hook.id,
      outboxId: row.id,
      eventType: row.eventType,
      payload: row.payload,
      status: "pending" as const,
      attemptCount: 0,
      nextAttemptAt: now,
      claimedUntil: null,
      lastStatusCode: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      deliveredAt: null,
    }));
    let deliveryCount = 0;
    if (deliveries.length > 0) {
      const inserted = await tx
        .insert(webhookDeliveries)
        .values(deliveries.map((r) => ({ ...r, ownerId: r.ownerId })))
        .onConflictDoNothing({
          target: [webhookDeliveries.outboxId, webhookDeliveries.webhookId],
        })
        .returning({ id: webhookDeliveries.id });
      deliveryCount = inserted.length;
    }
    await tx
      .update(webhookOutbox)
      .set({ processedAt: now })
      .where(ownedBy(webhookOutbox, ownerId, and(eq(webhookOutbox.id, row.id), isNull(webhookOutbox.processedAt))));
    return { outboxId: row.id, deliveryCount };
  });
}

/**
 * Claim one due pending delivery with a lease that covers a single send.
 * A row whose lease has expired may be claimed again under the same id.
 */
export async function claimOneDueDelivery(
  ownerId: number,
  now: number,
  leaseUntil: number,
): Promise<WebhookDeliveryRow | null> {
  return panelDb().transaction(async (tx) => {
    const due = await tx
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(
        ownedBy(
          webhookDeliveries,
          ownerId,
          and(
            eq(webhookDeliveries.status, "pending"),
            lte(webhookDeliveries.nextAttemptAt, now),
            or(isNull(webhookDeliveries.claimedUntil), lte(webhookDeliveries.claimedUntil, now)),
          ),
        ),
      )
      .orderBy(asc(webhookDeliveries.nextAttemptAt), asc(webhookDeliveries.id))
      .limit(1)
      .for("update", { skipLocked: true });
    const id = due[0]?.id;
    if (!id) return null;
    const updated = await tx
      .update(webhookDeliveries)
      .set({ claimedUntil: leaseUntil, updatedAt: now })
      .where(
        ownedBy(
          webhookDeliveries,
          ownerId,
          and(
            eq(webhookDeliveries.id, id),
            eq(webhookDeliveries.status, "pending"),
            or(isNull(webhookDeliveries.claimedUntil), lte(webhookDeliveries.claimedUntil, now)),
          ),
        ),
      )
      .returning();
    return updated[0] ?? null;
  });
}

/**
 * Mark delivered only while this worker still holds the claim and the row is
 * still pending — a late mark from an overlapping tick cannot undo another.
 */
export async function markDeliveryDelivered(
  ownerId: number,
  id: string,
  now: number,
  statusCode: number,
  claimedUntil: number,
): Promise<boolean> {
  const rows = await panelDb()
    .update(webhookDeliveries)
    .set({
      status: "delivered",
      deliveredAt: now,
      updatedAt: now,
      claimedUntil: null,
      lastStatusCode: statusCode,
      lastError: null,
    })
    .where(
      ownedBy(
        webhookDeliveries,
        ownerId,
        and(
          eq(webhookDeliveries.id, id),
          eq(webhookDeliveries.status, "pending"),
          eq(webhookDeliveries.claimedUntil, claimedUntil),
        ),
      ),
    )
    .returning({ id: webhookDeliveries.id });
  return rows.length > 0;
}

/** Same claim guard as {@link markDeliveryDelivered}. */
export async function markDeliveryRetryOrFailed(
  ownerId: number,
  id: string,
  now: number,
  claimedUntil: number,
  next: {
    attemptCount: number;
    nextAttemptAt: number;
    status: "pending" | "failed";
    statusCode: number | null;
    error: string | null;
  },
): Promise<boolean> {
  const rows = await panelDb()
    .update(webhookDeliveries)
    .set({
      status: next.status,
      attemptCount: next.attemptCount,
      nextAttemptAt: next.nextAttemptAt,
      updatedAt: now,
      claimedUntil: null,
      lastStatusCode: next.statusCode,
      lastError: next.error,
    })
    .where(
      ownedBy(
        webhookDeliveries,
        ownerId,
        and(
          eq(webhookDeliveries.id, id),
          eq(webhookDeliveries.status, "pending"),
          eq(webhookDeliveries.claimedUntil, claimedUntil),
        ),
      ),
    )
    .returning({ id: webhookDeliveries.id });
  return rows.length > 0;
}

/** Delete this owner's deliveries older than `cutoff` (14-day retention). Returns how many went. */
export async function pruneOldDeliveries(ownerId: number, cutoff: number): Promise<number> {
  const removed = await panelDb()
    .delete(webhookDeliveries)
    .where(ownedBy(webhookDeliveries, ownerId, lte(webhookDeliveries.createdAt, cutoff)))
    .returning({ id: webhookDeliveries.id });
  return removed.length;
}

export async function findDeliveriesForWebhook(
  ownerId: number,
  webhookId: string,
  limit = 20,
): Promise<WebhookDeliveryRow[]> {
  return panelDb()
    .select()
    .from(webhookDeliveries)
    .where(ownedBy(webhookDeliveries, ownerId, eq(webhookDeliveries.webhookId, webhookId)))
    .orderBy(desc(webhookDeliveries.createdAt), asc(webhookDeliveries.id))
    .limit(limit);
}

/**
 * The newest delivery for each of the named webhooks of this owner. Used by
 * Settings › API & integrations (screen 09) so the list can show last delivery
 * without an N+1 of {@link findDeliveriesForWebhook}.
 *
 * One row per webhook via Postgres `DISTINCT ON (webhook_id)` ordered newest
 * first — not every delivery of every webhook (payload included) for 14 days.
 */
export function lastDeliveriesQuery(ownerId: number, webhookIds: string[]) {
  return panelDb()
    .selectDistinctOn([webhookDeliveries.webhookId])
    .from(webhookDeliveries)
    .where(ownedBy(webhookDeliveries, ownerId, inArray(webhookDeliveries.webhookId, webhookIds)))
    .orderBy(
      asc(webhookDeliveries.webhookId),
      desc(webhookDeliveries.createdAt),
      asc(webhookDeliveries.id),
    );
}

export async function findLastDeliveriesForWebhooks(
  ownerId: number,
  webhookIds: string[],
): Promise<Map<string, WebhookDeliveryRow>> {
  const out = new Map<string, WebhookDeliveryRow>();
  if (webhookIds.length === 0) return out;
  const rows = await lastDeliveriesQuery(ownerId, webhookIds);
  for (const row of rows) {
    out.set(row.webhookId, row);
  }
  return out;
}

/** Count deliveries for an outbox row (tests: fan-out twice → still one). */
export async function countDeliveriesForOutbox(ownerId: number, outboxId: string): Promise<number> {
  const rows = await panelDb()
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(ownedBy(webhookDeliveries, ownerId, eq(webhookDeliveries.outboxId, outboxId)));
  return rows.length;
}
