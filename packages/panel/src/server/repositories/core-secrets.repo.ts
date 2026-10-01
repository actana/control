import { eq } from "drizzle-orm";
import { ownedBy } from "~/db/owner";
import { panelDb } from "~/db/panel-db-handle";
import { coreSecrets } from "~/db/pg-schema";

/** The sealed blob of one owner's Core, or null. Every query filters on `owner_id` (ADR 0041 D15). */
export async function findSealedSecrets(ownerId: number, coreId: string): Promise<Uint8Array | null> {
  const rows = await panelDb()
    .select({ sealed: coreSecrets.sealed })
    .from(coreSecrets)
    .where(ownedBy(coreSecrets, ownerId, eq(coreSecrets.coreId, coreId)))
    .limit(1);
  return rows[0]?.sealed ?? null;
}
