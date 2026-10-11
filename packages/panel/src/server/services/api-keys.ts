import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  findApiKeyById,
  findApiKeyCoreIds,
  findApiKeys,
  findApiKeysByPrefix,
  insertApiKey,
  revokeApiKeyRow,
  type ApiKeyRow,
} from "../repositories/api-keys.repo";
import { NotFoundError, ValidationError } from "../errors";
import { newId } from "./_ids";
import {
  isApiKeyPermission,
  normalizeApiKeyPermissions,
  type ApiKeyPermission,
} from "~/shared/api-key-permissions";

/**
 * API keys (#572): credentials a user creates for the public REST API.
 *
 * A key looks like `ak_<owner id>_<43 characters>`. The plaintext is returned
 * once, by {@link createApiKey}, and is never stored, logged or returned
 * again: the row keeps the sha256 of the whole key and a display prefix (the
 * owner part and the first six characters of the secret). The owner id in the
 * key is only where to look; the owner a call runs as is the stored row's.
 *
 * Revocation is final. {@link revokeApiKey} stamps `revoked_at` once, the
 * database refuses to change it afterwards, and a revoked key never
 * authenticates again.
 *
 * A key is created with its permissions (#688, `~/shared/api-key-permissions`)
 * and keeps them: the gate and the MCP server ask {@link hasPermission} before
 * a route or a tool runs. Keys from before #688 hold the full set.
 *
 * Expiry is optional (#689). A key created with `expiresAt` stops
 * authenticating at that instant, and the caller cannot tell an expired key
 * from a revoked or unknown one: all three are null from
 * {@link authenticateApiKey}, so a 401 on every surface. A key created
 * without one, and every key from before the column existed, lives until it
 * is revoked.
 */

const KEY_SECRET_BYTES = 32;
const KEY_PATTERN = /^ak_(\d{1,9})_([A-Za-z0-9_-]{43})$/;
const PREFIX_SECRET_CHARS = 6;
export const MAX_API_KEY_NAME_LENGTH = 80;

/** What an API key is as the owner sees it. There is no hash and no plaintext in it. */
export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  /** True when the key reaches every Core of its owner. */
  allCores: boolean;
  /** The Cores a restricted key reaches; empty when {@link ApiKey.allCores}. */
  coreIds: string[];
  /** What the key may do, in canonical order. Never empty. */
  permissions: ApiKeyPermission[];
  createdAt: number;
  revokedAt: number | null;
  /** When the key stops authenticating on its own; null for a key that lives until it is revoked. */
  expiresAt: number | null;
};

/** The Cores an authenticated key may reach. */
export type ApiKeyScope = { allCores: true } | { allCores: false; coreIds: ReadonlySet<string> };

export type ApiKeyPrincipal = {
  ownerId: number;
  keyId: string;
  scope: ApiKeyScope;
  permissions: ReadonlySet<ApiKeyPermission>;
};

function hashKey(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

/** A row's permissions as the known set, in canonical order. The check constraint keeps the column to known values. */
function permissionsOf(row: ApiKeyRow): ApiKeyPermission[] {
  return normalizeApiKeyPermissions(row.permissions.filter(isApiKeyPermission));
}

function toApiKey(row: ApiKeyRow, coreIds: string[]): ApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    allCores: row.allCores,
    coreIds: row.allCores ? [] : coreIds,
    permissions: permissionsOf(row),
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
    expiresAt: row.expiresAt,
  };
}

/** True when a key with this `expiresAt` has expired at `now`. Null never expires. */
export function isApiKeyExpired(expiresAt: number | null, now: number): boolean {
  return expiresAt !== null && expiresAt <= now;
}

/**
 * Create a key for `ownerId`. `coreIds` omitted or null means every Core of the
 * owner; otherwise the key is restricted to those Cores, which must all be the
 * owner's. `permissions` is what the key may do: at least one, each a known
 * one; there is no default, the caller says. `expiresAt` omitted or null means
 * the key lives until it is revoked; otherwise it is an epoch-ms instant after
 * `now`, and the key stops authenticating there. The returned `key` is the
 * plaintext, and this is the only time it exists outside the caller.
 */
export async function createApiKey(
  ownerId: number,
  input: { name: string; coreIds?: string[] | null; permissions: readonly string[]; expiresAt?: number | null },
  now = Date.now(),
): Promise<{ apiKey: ApiKey; key: string }> {
  const name = input.name.trim();
  if (!name) throw new ValidationError("an API key needs a name");
  if (name.length > MAX_API_KEY_NAME_LENGTH) {
    throw new ValidationError(`an API key's name is at most ${MAX_API_KEY_NAME_LENGTH} characters`);
  }
  const coreIds = input.coreIds ?? null;
  if (coreIds && coreIds.length === 0) {
    throw new ValidationError("a restricted API key needs at least one Core; leave the Cores out to reach every Core");
  }
  const unknown = input.permissions.find((p) => !isApiKeyPermission(p));
  if (unknown !== undefined) throw new ValidationError(`unknown API key permission: ${String(unknown).slice(0, 40)}`);
  const permissions = normalizeApiKeyPermissions(input.permissions as ApiKeyPermission[]);
  if (permissions.length === 0) throw new ValidationError("an API key needs at least one permission");
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= now)) {
    throw new ValidationError("an API key's expiry is an instant in the future, in epoch milliseconds; leave it out for a key that never expires");
  }
  const secret = randomBytes(KEY_SECRET_BYTES).toString("base64url");
  const key = `ak_${ownerId}_${secret}`;
  const result = await insertApiKey(
    {
      id: newId("key"),
      ownerId,
      name,
      prefix: `ak_${ownerId}_${secret.slice(0, PREFIX_SECRET_CHARS)}`,
      keyHash: hashKey(key).toString("hex"),
      allCores: coreIds === null,
      permissions,
      createdAt: now,
      revokedAt: null,
      expiresAt,
    },
    coreIds,
  );
  if (result.kind === "no-core") throw new ValidationError("a Core named for this API key does not exist");
  return { apiKey: toApiKey(result.key, coreIds ? [...new Set(coreIds)].sort() : []), key };
}

export async function listApiKeys(ownerId: number): Promise<ApiKey[]> {
  const rows = await findApiKeys(ownerId);
  const coreIds = await findApiKeyCoreIds(ownerId);
  return rows.map((row) => toApiKey(row, coreIds.get(row.id) ?? []));
}

/**
 * Revoke a key, now and for good. Revoking a revoked key is a no-op that
 * returns it as it is; another owner's key is not found.
 */
export async function revokeApiKey(ownerId: number, id: string, now = Date.now()): Promise<ApiKey> {
  await revokeApiKeyRow(ownerId, id, now);
  const row = await findApiKeyById(ownerId, id);
  if (!row) throw new NotFoundError("no such API key");
  return toApiKey(row, (await findApiKeyCoreIds(ownerId, [id])).get(id) ?? []);
}

/**
 * Resolve a presented key to the principal it runs as, or null for a key that
 * is malformed, unknown, revoked or expired at `now`: the caller cannot tell
 * which, and neither can an attacker. The stored hash and the presented key's
 * hash are both 32 bytes and are compared with `timingSafeEqual`.
 */
export async function authenticateApiKey(presented: string, now = Date.now()): Promise<ApiKeyPrincipal | null> {
  const match = KEY_PATTERN.exec(presented);
  if (!match) return null;
  const ownerId = Number(match[1]);
  const prefix = `ak_${ownerId}_${match[2]!.slice(0, PREFIX_SECRET_CHARS)}`;
  const presentedHash = hashKey(presented);
  let found: ApiKeyRow | null = null;
  for (const row of await findApiKeysByPrefix(ownerId, prefix)) {
    const stored = Buffer.from(row.keyHash, "hex");
    if (stored.length === presentedHash.length && timingSafeEqual(stored, presentedHash)) found = row;
  }
  if (!found || found.revokedAt !== null || isApiKeyExpired(found.expiresAt, now)) return null;
  const permissions: ReadonlySet<ApiKeyPermission> = new Set(permissionsOf(found));
  if (found.allCores) return { ownerId: found.ownerId, keyId: found.id, scope: { allCores: true }, permissions };
  const coreIds = (await findApiKeyCoreIds(found.ownerId, [found.id])).get(found.id) ?? [];
  return { ownerId: found.ownerId, keyId: found.id, scope: { allCores: false, coreIds: new Set(coreIds) }, permissions };
}

/** Whether a key's scope reaches a Core. */
export function scopeReaches(scope: ApiKeyScope, coreId: string): boolean {
  return scope.allCores || scope.coreIds.has(coreId);
}

/** Whether a key may do what `permission` covers (#688). */
export function hasPermission(principal: Pick<ApiKeyPrincipal, "permissions">, permission: ApiKeyPermission): boolean {
  return principal.permissions.has(permission);
}

/** The 403 a key without a permission gets, worded once for REST and MCP alike. */
export function missingPermissionMessage(permission: ApiKeyPermission): string {
  return `this API key lacks the ${permission} permission`;
}
