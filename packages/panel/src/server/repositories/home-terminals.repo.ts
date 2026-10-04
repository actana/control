import { asc, eq } from "drizzle-orm";
import { ownedBy } from "~/db/owner";
import { panelDb } from "~/db/panel-db-handle";
import { homeTerminals } from "~/db/pg-schema";

export type HomeTerminalRow = typeof homeTerminals.$inferSelect;
export type NewHomeTerminalRow = typeof homeTerminals.$inferInsert;

/** Every query here filters on `owner_id` (ADR 0041 D15). */

export async function findHomeTerminals(ownerId: number): Promise<HomeTerminalRow[]> {
  return panelDb()
    .select()
    .from(homeTerminals)
    .where(ownedBy(homeTerminals, ownerId))
    .orderBy(asc(homeTerminals.position), asc(homeTerminals.createdAt));
}

export async function findHomeTerminalById(
  ownerId: number,
  id: string,
): Promise<HomeTerminalRow | null> {
  const rows = await panelDb()
    .select()
    .from(homeTerminals)
    .where(ownedBy(homeTerminals, ownerId, eq(homeTerminals.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertHomeTerminal(row: NewHomeTerminalRow): Promise<void> {
  await panelDb().insert(homeTerminals).values({ ...row, ownerId: row.ownerId });
}

export async function updateHomeTerminalRow(
  ownerId: number,
  id: string,
  patch: Partial<HomeTerminalRow>,
): Promise<void> {
  await panelDb()
    .update(homeTerminals)
    .set(patch)
    .where(ownedBy(homeTerminals, ownerId, eq(homeTerminals.id, id)));
}

export async function deleteHomeTerminalRow(ownerId: number, id: string): Promise<number> {
  const removed = await panelDb()
    .delete(homeTerminals)
    .where(ownedBy(homeTerminals, ownerId, eq(homeTerminals.id, id)))
    .returning({ id: homeTerminals.id });
  return removed.length;
}
