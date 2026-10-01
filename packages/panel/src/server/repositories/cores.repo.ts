import { asc, eq, lt } from "drizzle-orm";
import { ownedBy } from "~/db/owner";
import { panelDb } from "~/db/panel-db-handle";
import { coreSecrets, coreSharedFolders, cores } from "~/db/pg-schema";

export type CoreRow = typeof cores.$inferSelect;

/** Every query here filters on `owner_id` (ADR 0041 D15): one owner's Cores are never another's. */

export async function findAllCores(ownerId: number): Promise<CoreRow[]> {
  return panelDb()
    .select()
    .from(cores)
    .where(ownedBy(cores, ownerId))
    .orderBy(asc(cores.createdAt), asc(cores.id));
}

export async function findCoreById(ownerId: number, id: string): Promise<CoreRow | null> {
  const rows = await panelDb()
    .select()
    .from(cores)
    .where(ownedBy(cores, ownerId, eq(cores.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findCoreByEndpoint(ownerId: number, endpoint: string): Promise<CoreRow | null> {
  const rows = await panelDb()
    .select()
    .from(cores)
    .where(ownedBy(cores, ownerId, eq(cores.endpoint, endpoint)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Insert a Core and its sealed secrets in one transaction: a Core the dialer
 * has no credentials for would sit "unreachable" forever. False, with nothing
 * written, when the owner already has a Core at that endpoint.
 */
export async function insertCoreWithSecrets(
  row: CoreRow,
  sealed: Uint8Array,
  opts: { pendingSharedFolder?: boolean } = {},
): Promise<boolean> {
  return panelDb().transaction(async (tx) => {
    const inserted = await tx
      .insert(cores)
      .values(row)
      .onConflictDoNothing({ target: [cores.ownerId, cores.endpoint] })
      .returning({ id: cores.id });
    if (inserted.length === 0) return false;
    await tx
      .insert(coreSecrets)
      .values({ coreId: row.id, ownerId: row.ownerId, sealed, updatedAt: row.updatedAt });
    // In the same transaction, so a Core paired from the Panel is never visible without its pending
    // folder: a Core with no row reads as one registered before 0.5.0, which is not asked for storage.
    if (opts.pendingSharedFolder) {
      await tx.insert(coreSharedFolders).values({
        coreId: row.id,
        ownerId: row.ownerId,
        state: "pending",
        s3Prefix: "",
        updatedAt: row.updatedAt,
      });
    }
    return true;
  });
}

export async function updateCoreLabel(
  ownerId: number,
  id: string,
  label: string,
  now: number,
): Promise<void> {
  await panelDb()
    .update(cores)
    .set({ label, updatedAt: now })
    .where(ownedBy(cores, ownerId, eq(cores.id, id)));
}

/** Forward only: a stale cursor from a racing writer changes nothing. */
export async function advanceCoreCursorRow(
  ownerId: number,
  id: string,
  lastEventId: number,
  now: number,
): Promise<void> {
  await panelDb()
    .update(cores)
    .set({ lastEventId, updatedAt: now })
    .where(ownedBy(cores, ownerId, eq(cores.id, id), lt(cores.lastEventId, lastEventId)));
}

/** Delete a Core and its secrets together. False for an id this owner does not have. */
export async function deleteCoreWithSecrets(ownerId: number, id: string): Promise<boolean> {
  return panelDb().transaction(async (tx) => {
    await tx.delete(coreSecrets).where(ownedBy(coreSecrets, ownerId, eq(coreSecrets.coreId, id)));
    const removed = await tx
      .delete(cores)
      .where(ownedBy(cores, ownerId, eq(cores.id, id)))
      .returning({ id: cores.id });
    return removed.length > 0;
  });
}
