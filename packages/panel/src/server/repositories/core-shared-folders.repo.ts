import { and, eq, ne } from "drizzle-orm";
import { ownedBy } from "~/db/owner";
import { panelDb } from "~/db/panel-db-handle";
import { coreSharedFolders } from "~/db/pg-schema";

export type CoreSharedFolderRow = typeof coreSharedFolders.$inferSelect;

export async function findSharedFolder(ownerId: number, coreId: string): Promise<CoreSharedFolderRow | null> {
  const rows = await panelDb()
    .select()
    .from(coreSharedFolders)
    .where(ownedBy(coreSharedFolders, ownerId, eq(coreSharedFolders.coreId, coreId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findAllSharedFolders(ownerId: number): Promise<CoreSharedFolderRow[]> {
  return panelDb().select().from(coreSharedFolders).where(ownedBy(coreSharedFolders, ownerId));
}

/** Every Core of this owner whose folder is attached (or erroring): the ones a scheduler keeps a key fresh for. */
export async function findLiveSharedFolders(ownerId: number): Promise<CoreSharedFolderRow[]> {
  return panelDb()
    .select()
    .from(coreSharedFolders)
    .where(ownedBy(coreSharedFolders, ownerId, ne(coreSharedFolders.state, "pending")));
}

export async function updateSharedFolder(
  ownerId: number,
  coreId: string,
  fields: Partial<Pick<CoreSharedFolderRow, "state" | "s3Prefix" | "keyExpiresAt" | "lastError">>,
  now: number,
): Promise<void> {
  await panelDb()
    .update(coreSharedFolders)
    .set({ ...fields, updatedAt: now })
    .where(ownedBy(coreSharedFolders, ownerId, eq(coreSharedFolders.coreId, coreId)));
}

/** Only an attached or erroring folder: a Core whose pairing is pending is never moved by a timer. */
export async function updateLiveSharedFolder(
  ownerId: number,
  coreId: string,
  fields: Partial<Pick<CoreSharedFolderRow, "state" | "keyExpiresAt" | "lastError">>,
  now: number,
): Promise<void> {
  await panelDb()
    .update(coreSharedFolders)
    .set({ ...fields, updatedAt: now })
    .where(
      ownedBy(coreSharedFolders, ownerId, and(eq(coreSharedFolders.coreId, coreId), ne(coreSharedFolders.state, "pending"))),
    );
}
