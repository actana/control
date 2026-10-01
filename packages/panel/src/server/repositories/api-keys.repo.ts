import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { ownedBy } from "~/db/owner";
import { panelDb } from "~/db/panel-db-handle";
import { apiKeyCores, apiKeys, cores } from "~/db/pg-schema";

export type ApiKeyRow = typeof apiKeys.$inferSelect;

/**
 * Every query here filters on `owner_id` (ADR 0041 D15): one owner's API keys
 * are never another's. A key is only written after every Core it names was
 * found under the same owner, in the same transaction.
 */

export type InsertApiKeyResult =
  /** A named Core is not this owner's. Nothing was written. */
  | { kind: "no-core" }
  | { kind: "ok"; key: ApiKeyRow };

/** `coreIds` is null for a key that reaches every Core; otherwise the Cores it is restricted to. */
export async function insertApiKey(row: ApiKeyRow, coreIds: string[] | null): Promise<InsertApiKeyResult> {
  return panelDb().transaction(async (tx): Promise<InsertApiKeyResult> => {
    if (coreIds) {
      const owned = await tx
        .select({ id: cores.id })
        .from(cores)
        .where(ownedBy(cores, row.ownerId, inArray(cores.id, coreIds)))
        .for("share");
      if (owned.length !== new Set(coreIds).size) return { kind: "no-core" };
    }
    const [key] = await tx.insert(apiKeys).values({ ...row, ownerId: row.ownerId, allCores: coreIds === null }).returning();
    if (coreIds) {
      await tx
        .insert(apiKeyCores)
        .values([...new Set(coreIds)].map((coreId) => ({ keyId: row.id, coreId, ownerId: row.ownerId })));
    }
    return { kind: "ok", key: key! };
  });
}

export async function findApiKeys(ownerId: number): Promise<ApiKeyRow[]> {
  return panelDb()
    .select()
    .from(apiKeys)
    .where(ownedBy(apiKeys, ownerId))
    .orderBy(asc(apiKeys.createdAt), asc(apiKeys.id));
}

export async function findApiKeyById(ownerId: number, id: string): Promise<ApiKeyRow | null> {
  const rows = await panelDb()
    .select()
    .from(apiKeys)
    .where(ownedBy(apiKeys, ownerId, eq(apiKeys.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

/** The candidates for a presented key: the display prefix is not secret, and the hash compare decides which is it. */
export async function findApiKeysByPrefix(ownerId: number, prefix: string): Promise<ApiKeyRow[]> {
  return panelDb()
    .select()
    .from(apiKeys)
    .where(ownedBy(apiKeys, ownerId, eq(apiKeys.prefix, prefix)));
}

/** The Cores of every restricted key of this owner, as key id to Core ids. */
export async function findApiKeyCoreIds(ownerId: number, keyIds?: string[]): Promise<Map<string, string[]>> {
  const rows = await panelDb()
    .select({ keyId: apiKeyCores.keyId, coreId: apiKeyCores.coreId })
    .from(apiKeyCores)
    .where(ownedBy(apiKeyCores, ownerId, keyIds ? inArray(apiKeyCores.keyId, keyIds) : undefined))
    .orderBy(asc(apiKeyCores.keyId), asc(apiKeyCores.coreId));
  const byKey = new Map<string, string[]>();
  for (const r of rows) byKey.set(r.keyId, [...(byKey.get(r.keyId) ?? []), r.coreId]);
  return byKey;
}

/** Stamp `revoked_at` on a key that is not revoked yet. Null when the owner has no such key, or it was revoked already. */
export async function revokeApiKeyRow(ownerId: number, id: string, now: number): Promise<ApiKeyRow | null> {
  const rows = await panelDb()
    .update(apiKeys)
    .set({ revokedAt: now })
    .where(ownedBy(apiKeys, ownerId, and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt))))
    .returning();
  return rows[0] ?? null;
}
