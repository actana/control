import { eq, lte } from "drizzle-orm";
import { ownedBy } from "~/db/owner";
import { panelDb } from "~/db/panel-db-handle";
import { panelSessions } from "~/db/pg-schema";

export type PanelSessionRow = typeof panelSessions.$inferSelect;

/** Every query here filters on `owner_id` (ADR 0041 D15): one owner's sessions are never another's. */

export async function insertPanelSession(row: PanelSessionRow): Promise<void> {
  await panelDb().insert(panelSessions).values({ ...row, ownerId: row.ownerId });
}

export async function findPanelSessionByTokenHash(
  ownerId: number,
  tokenHash: string,
): Promise<PanelSessionRow | null> {
  const rows = await panelDb()
    .select()
    .from(panelSessions)
    .where(ownedBy(panelSessions, ownerId, eq(panelSessions.tokenHash, tokenHash)))
    .limit(1);
  return rows[0] ?? null;
}

export async function touchPanelSession(
  ownerId: number,
  id: string,
  lastSeenAt: number,
  expiresAt: number,
): Promise<void> {
  await panelDb()
    .update(panelSessions)
    .set({ lastSeenAt, expiresAt })
    .where(ownedBy(panelSessions, ownerId, eq(panelSessions.id, id)));
}

export async function deletePanelSessionById(ownerId: number, id: string): Promise<void> {
  await panelDb()
    .delete(panelSessions)
    .where(ownedBy(panelSessions, ownerId, eq(panelSessions.id, id)));
}

export async function deletePanelSessionByTokenHash(ownerId: number, tokenHash: string): Promise<void> {
  await panelDb()
    .delete(panelSessions)
    .where(ownedBy(panelSessions, ownerId, eq(panelSessions.tokenHash, tokenHash)));
}

export async function deleteAllPanelSessions(ownerId: number): Promise<void> {
  await panelDb().delete(panelSessions).where(ownedBy(panelSessions, ownerId));
}

export async function deleteExpiredPanelSessions(ownerId: number, now: number): Promise<void> {
  await panelDb()
    .delete(panelSessions)
    .where(ownedBy(panelSessions, ownerId, lte(panelSessions.expiresAt, now)));
}
