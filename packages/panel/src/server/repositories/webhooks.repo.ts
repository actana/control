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

/** Unprocessed outbox rows for this owner, oldest first. */
export async function findPendingOutbox(ownerId: number, limit: number): Promise<WebhookOutboxRow[]> {
  return panelDb()
    .select()
    .from(webhookOutbox)
    .where(ownedBy(webhookOutbox, ownerId, isNull(webhookOutbox.processedAt)))
    .orderBy(asc(webhookOutbox.createdAt), asc(webhookOutbox.id))
    .limit(limit);
}

/**
 * Webhooks of this owner that subscribe to `eventType` and reach `coreId`
 * (or every Core when the event has no Core).
 */
export async function findMatchingWebhooks(
  ownerId: number,
  eventType: WebhookEventType,
  coreId: string | null,
): Promise<WebhookRow[]> {
  const rows = await panelDb()
    .select()
    .from(webhooks)
    .where(ownedBy(webhooks, ownerId, sql`${eventType} = any(${webhooks.events})`));
  if (rows.length === 0) return [];
  const coreIds = await findWebhookCoreIds(
    ownerId,
    rows.filter((r) => !r.allCores).map((r) => r.id),
  );
  return rows.filter((row) => {
    if (row.allCores) return true;
    if (!coreId) return false;
    return (coreIds.get(row.id) ?? []).includes(coreId);
  });
}

export async function markOutboxProcessed(ownerId: number, id: string, now: number): Promise<void> {
  await panelDb()
    .update(webhookOutbox)
    .set({ processedAt: now })
    .where(ownedBy(webhookOutbox, ownerId, and(eq(webhookOutbox.id, id), isNull(webhookOutbox.processedAt))));
}

export async function insertDeliveries(rows: NewDeliveryRow[]): Promise<WebhookDeliveryRow[]> {
  if (rows.length === 0) return [];
  return panelDb()
    .insert(webhookDeliveries)
    .values(rows.map((r) => ({ ...r, ownerId: r.ownerId })))
    .returning();
}

/**
 * Claim due pending deliveries for this owner with a lease. A row whose lease
 * has expired may be claimed again under the same id (the receiver
 * de-duplicates on it).
 */
export async function claimDueDeliveries(
  ownerId: number,
  now: number,
  leaseUntil: number,
  limit: number,
): Promise<WebhookDeliveryRow[]> {
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
      .limit(limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    const claimed: WebhookDeliveryRow[] = [];
    for (const row of due) {
      const updated = await tx
        .update(webhookDeliveries)
        .set({ claimedUntil: leaseUntil, updatedAt: now })
        .where(
          ownedBy(
            webhookDeliveries,
            ownerId,
            and(
              eq(webhookDeliveries.id, row.id),
              eq(webhookDeliveries.status, "pending"),
              or(isNull(webhookDeliveries.claimedUntil), lte(webhookDeliveries.claimedUntil, now)),
            ),
          ),
        )
        .returning();
      if (updated[0]) claimed.push(updated[0]);
    }
    return claimed;
  });
}

export async function markDeliveryDelivered(
  ownerId: number,
  id: string,
  now: number,
  statusCode: number,
): Promise<void> {
  await panelDb()
    .update(webhookDeliveries)
    .set({
      status: "delivered",
      deliveredAt: now,
      updatedAt: now,
      claimedUntil: null,
      lastStatusCode: statusCode,
      lastError: null,
    })
    .where(ownedBy(webhookDeliveries, ownerId, eq(webhookDeliveries.id, id)));
}

export async function markDeliveryRetryOrFailed(
  ownerId: number,
  id: string,
  now: number,
  next: {
    attemptCount: number;
    nextAttemptAt: number;
    status: "pending" | "failed";
    statusCode: number | null;
    error: string | null;
  },
): Promise<void> {
  await panelDb()
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
    .where(ownedBy(webhookDeliveries, ownerId, eq(webhookDeliveries.id, id)));
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
