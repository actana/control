import { sql } from "drizzle-orm";
import { ownedBy } from "~/db/owner";
import { panelDb } from "~/db/panel-db-handle";
import { storageConfig } from "~/db/pg-schema";

/** Every field of the config but the master key. The sealed key has its own reader, and only the issuer calls it. */
export type StorageConfigRow = Omit<typeof storageConfig.$inferSelect, "masterKeySealed"> & {
  masterKeySet: boolean;
};

export type StorageConfigFields = Omit<typeof storageConfig.$inferInsert, "ownerId" | "masterKeySealed">;

export async function findStorageConfig(ownerId: number): Promise<StorageConfigRow | null> {
  const rows = await panelDb()
    .select({
      ownerId: storageConfig.ownerId,
      backend: storageConfig.backend,
      endpoint: storageConfig.endpoint,
      bucket: storageConfig.bucket,
      prefix: storageConfig.prefix,
      region: storageConfig.region,
      oidcIssuer: storageConfig.oidcIssuer,
      oidcAudience: storageConfig.oidcAudience,
      keyId: storageConfig.keyId,
      roleArn: storageConfig.roleArn,
      accountId: storageConfig.accountId,
      parentAccessKeyId: storageConfig.parentAccessKeyId,
      anonKey: storageConfig.anonKey,
      // Whether a key is stored, computed in the database: the sealed key itself is not selected here.
      masterKeySet: sql<boolean>`${storageConfig.masterKeySealed} is not null`,
      masterKeyRotatedAt: storageConfig.masterKeyRotatedAt,
      uploadSizeLimitBytes: storageConfig.uploadSizeLimitBytes,
      updatedAt: storageConfig.updatedAt,
    })
    .from(storageConfig)
    .where(ownedBy(storageConfig, ownerId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return row;
}

/** The sealed master key of one owner, or null. Read by the key issuer and by nothing that answers a request. */
export async function findSealedMasterKey(ownerId: number): Promise<Uint8Array | null> {
  const rows = await panelDb()
    .select({ sealed: storageConfig.masterKeySealed })
    .from(storageConfig)
    .where(ownedBy(storageConfig, ownerId))
    .limit(1);
  return rows[0]?.sealed ?? null;
}

/** Set or replace the config. `sealed` undefined keeps the key already stored (a config edit is not a rotation). */
export async function upsertStorageConfig(
  ownerId: number,
  fields: StorageConfigFields,
  sealed: Uint8Array | undefined,
): Promise<void> {
  const set = { ...fields, ...(sealed === undefined ? {} : { masterKeySealed: sealed }) };
  await panelDb()
    .insert(storageConfig)
    .values({ ...fields, ownerId, masterKeySealed: sealed ?? null })
    .onConflictDoUpdate({ target: storageConfig.ownerId, set });
}
