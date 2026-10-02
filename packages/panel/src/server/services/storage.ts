import { createPrivateKey, type KeyObject } from "node:crypto";
import {
  createR2KeyIssuer,
  createSeaweedfsKeyIssuer,
  publicJwks,
  createStsKeyIssuer,
  createSupabaseKeyIssuer,
  type SharedKeyIssuer,
} from "@actana/sdk/shared-key";
import { findSealedMasterKey, findStorageConfig, upsertStorageConfig } from "../repositories/storage.repo";
import { ConflictError, ValidationError } from "../errors";
import { OPERATOR_ID } from "./operator";
import { openSecret, sealSecret } from "./secrets-at-rest";
import {
  DEFAULT_UPLOAD_SIZE_LIMIT_BYTES,
  STORAGE_BACKEND_KINDS,
  type StorageBackendKind,
  type StorageConfigInput,
  type StorageConfigView,
} from "~/shared/storage-wire";

/**
 * Where the Shared folders live, and the master key that issues each Core's 1-hour key (#564, ADR 0041
 * D5, D33; Settings › Storage #566 / #565). The config is plain columns; the master key is sealed with
 * `secrets-at-rest.ts`, the mechanism `core_secrets` uses, and has **two readers**: {@link storageKeyIssuer},
 * which hands it to the SDK issuer and returns the issuer, and {@link storageJwks}, which keeps only the
 * public half. Nothing in this file returns the key, logs it,
 * puts it in an error message or sends it to a Core or a browser; the view of the config says only whether
 * one is set and when it was last rotated.
 */

/** The backends this Panel can issue keys for. Default selection is SeaweedFS (screen 08). */
export const STORAGE_BACKENDS = STORAGE_BACKEND_KINDS;
export type StorageBackend = StorageBackendKind;

export const DEFAULT_OIDC_AUDIENCE = "actana-shared";
export const DEFAULT_REGION = "us-east-1";
export const DEFAULT_BACKEND: StorageBackend = "seaweedfs";

export type { StorageConfigView, StorageConfigInput } from "~/shared/storage-wire";

/** What the issuer needs to name a Core's folder: where it is, and which prefix holds the Cores. */
export type StorageTarget = {
  endpoint: string;
  bucket: string;
  prefix: string;
  region: string;
};

/** An operator-facing refusal; the message never carries the key. */
export class StorageNotConfiguredError extends ConflictError {
  readonly code = "storage-not-configured";
  constructor(message = "Storage is not configured: set the endpoint, bucket, prefix and master key first.") {
    super(message);
    this.name = "StorageNotConfiguredError";
  }
}

const EMPTY_VIEW: StorageConfigView = {
  configured: false,
  backend: null,
  endpoint: null,
  bucket: null,
  prefix: null,
  region: null,
  oidcIssuer: null,
  oidcAudience: null,
  keyId: null,
  roleArn: null,
  accountId: null,
  parentAccessKeyId: null,
  anonKey: null,
  masterKeySet: false,
  masterKeyRotatedAt: null,
  uploadSizeLimitBytes: null,
  updatedAt: null,
};

export async function getStorageConfig(ownerId = OPERATOR_ID): Promise<StorageConfigView> {
  const row = await findStorageConfig(ownerId);
  if (!row) return EMPTY_VIEW;
  return {
    // Not usable until the master key is in: an endpoint with no key issues nothing.
    configured: row.masterKeySet,
    backend: row.backend as StorageBackend,
    endpoint: row.endpoint,
    bucket: row.bucket,
    prefix: row.prefix,
    region: row.region,
    oidcIssuer: row.oidcIssuer || null,
    oidcAudience: row.oidcAudience || null,
    keyId: row.keyId || null,
    roleArn: row.roleArn || null,
    accountId: row.accountId || null,
    parentAccessKeyId: row.parentAccessKeyId || null,
    anonKey: row.anonKey || null,
    masterKeySet: row.masterKeySet,
    masterKeyRotatedAt: row.masterKeyRotatedAt,
    uploadSizeLimitBytes: row.uploadSizeLimitBytes,
    updatedAt: row.updatedAt,
  };
}

/** `cores/`, `/cores` and `cores` are one prefix; a `.`, a `..` or an empty segment is none. */
export function normalizePrefix(raw: string): string {
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) throw new ValidationError("The prefix is empty.");
  for (const segment of trimmed.split("/")) {
    if (!segment || segment === "." || segment === ".." || /[\\\u0000-\u001f]/.test(segment)) {
      throw new ValidationError("The prefix is not a plain path: no empty, . or .. segment.");
    }
  }
  return trimmed;
}

function requireUrl(raw: string, what: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ValidationError(`The ${what} is not a URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError(`The ${what} must be http:// or https://.`);
  }
  return url.origin + (url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, ""));
}

function requireText(raw: string, what: string): string {
  const value = raw.trim();
  if (!value) throw new ValidationError(`The ${what} is empty.`);
  return value;
}

/**
 * A PEM as a person pastes it: a password box is one line, so the newlines are often gone. Header, body and footer
 * are put back in the shape the parser wants. Anything that is not a PEM block is returned as it came, for the parser
 * to refuse without being quoted.
 */
function normalizePem(raw: string): string {
  const match = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(raw.trim());
  if (!match) return raw;
  const body = match[2]!.replace(/\s+/g, "");
  return `-----BEGIN ${match[1]}-----\n${body.match(/.{1,64}/g)?.join("\n") ?? ""}\n-----END ${match[1]}-----\n`;
}

/** The key must be an RSA private key; what the parser says is never repeated, it can quote the input. */
function parseMasterKeyPem(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new ValidationError("The master key is not a PEM private key.");
  }
  if (key.asymmetricKeyType !== "rsa") throw new ValidationError("The master key must be an RSA private key.");
  return key;
}

function parseStsMaster(raw: string): { accessKeyId: string; secretAccessKey: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError("The STS master key must be JSON with accessKeyId and secretAccessKey.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new ValidationError("The STS master key must be JSON with accessKeyId and secretAccessKey.");
  }
  const accessKeyId = String((parsed as { accessKeyId?: unknown }).accessKeyId ?? "").trim();
  const secretAccessKey = String((parsed as { secretAccessKey?: unknown }).secretAccessKey ?? "").trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new ValidationError("The STS master key must be JSON with accessKeyId and secretAccessKey.");
  }
  return { accessKeyId, secretAccessKey };
}

function parseSupabaseMaster(raw: string): { serviceRoleKey: string; jwtSecret: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError("The Supabase master key must be JSON with serviceRoleKey and jwtSecret.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new ValidationError("The Supabase master key must be JSON with serviceRoleKey and jwtSecret.");
  }
  const serviceRoleKey = String((parsed as { serviceRoleKey?: unknown }).serviceRoleKey ?? "").trim();
  const jwtSecret = String((parsed as { jwtSecret?: unknown }).jwtSecret ?? "").trim();
  if (!serviceRoleKey || !jwtSecret) {
    throw new ValidationError("The Supabase master key must be JSON with serviceRoleKey and jwtSecret.");
  }
  return { serviceRoleKey, jwtSecret };
}

function normalizeMasterMaterial(backend: StorageBackend, raw: string): string {
  if (backend === "seaweedfs") {
    const pem = normalizePem(raw);
    parseMasterKeyPem(pem);
    return pem;
  }
  if (backend === "sts") {
    const creds = parseStsMaster(raw);
    return JSON.stringify(creds);
  }
  if (backend === "supabase") {
    const secrets = parseSupabaseMaster(raw);
    return JSON.stringify(secrets);
  }
  // r2: the API token as a non-empty string
  const token = raw.trim();
  if (!token) throw new ValidationError("The R2 API token is empty.");
  return token;
}

function parseUploadLimit(raw: number | undefined, existing: number | null | undefined): number {
  if (raw === undefined) return existing ?? DEFAULT_UPLOAD_SIZE_LIMIT_BYTES;
  if (!Number.isFinite(raw) || raw < 1 || raw > 10 * 1024 * 1024 * 1024) {
    throw new ValidationError("The upload size limit must be between 1 byte and 10 GiB.");
  }
  return Math.floor(raw);
}

/**
 * Set or replace the config. The master key, when given, is sealed before it touches the database.
 * Returns whether the sealed master key was replaced (a rotate), so callers can re-issue Core keys.
 */
export async function saveStorageConfig(
  input: StorageConfigInput,
  ownerId = OPERATOR_ID,
): Promise<{ view: StorageConfigView; rotated: boolean }> {
  if (!(STORAGE_BACKENDS as readonly string[]).includes(input.backend)) {
    throw new ValidationError(`The backend "${input.backend}" is not supported: use ${STORAGE_BACKENDS.join(", ")}.`);
  }
  const backend = input.backend as StorageBackend;
  const bucket = requireText(input.bucket, "bucket");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new ValidationError("The bucket is not a valid bucket name.");

  const existing = await findStorageConfig(ownerId);
  const now = Date.now();
  const fields = {
    backend,
    endpoint: requireUrl(input.endpoint, "endpoint"),
    bucket,
    prefix: normalizePrefix(input.prefix),
    region: requireText(input.region ?? existing?.region ?? DEFAULT_REGION, "region"),
    oidcIssuer: backend === "seaweedfs" ? requireText(input.oidcIssuer ?? "", "OIDC issuer") : (input.oidcIssuer ?? "").trim(),
    oidcAudience:
      backend === "seaweedfs"
        ? requireText(input.oidcAudience ?? DEFAULT_OIDC_AUDIENCE, "OIDC audience")
        : (input.oidcAudience ?? "").trim(),
    keyId: backend === "seaweedfs" ? requireText(input.keyId ?? "", "key id") : (input.keyId ?? "").trim(),
    roleArn: backend === "sts" ? requireText(input.roleArn ?? "", "role ARN") : (input.roleArn ?? "").trim(),
    accountId: backend === "r2" ? requireText(input.accountId ?? "", "account id") : (input.accountId ?? "").trim(),
    parentAccessKeyId:
      backend === "r2" ? requireText(input.parentAccessKeyId ?? "", "parent access key id") : (input.parentAccessKeyId ?? "").trim(),
    anonKey: backend === "supabase" ? requireText(input.anonKey ?? "", "anon key") : (input.anonKey ?? "").trim(),
    uploadSizeLimitBytes: parseUploadLimit(input.uploadSizeLimitBytes, existing?.uploadSizeLimitBytes),
    updatedAt: now,
    masterKeyRotatedAt: existing?.masterKeyRotatedAt ?? null,
  };

  let sealed: Buffer | undefined;
  let rotated = false;
  if (input.masterKey !== undefined) {
    const material = normalizeMasterMaterial(backend, input.masterKey);
    sealed = sealSecret(material);
    fields.masterKeyRotatedAt = now;
    rotated = true;
  } else if (!existing?.masterKeySet) {
    throw new ValidationError("The master key is required the first time storage is configured.");
  } else if (existing.backend !== backend) {
    throw new ValidationError(
      "Changing the storage backend requires a new master key for that backend; the sealed key cannot move across backends.",
    );
  }
  await upsertStorageConfig(ownerId, fields, sealed);
  return { view: await getStorageConfig(ownerId), rotated };
}

/** Where a Core's folder is, from the config alone; throws when storage is not configured. */
export async function storageTarget(ownerId = OPERATOR_ID): Promise<StorageTarget> {
  const view = await getStorageConfig(ownerId);
  if (!view.configured) throw new StorageNotConfiguredError();
  return { endpoint: view.endpoint!, bucket: view.bucket!, prefix: view.prefix!, region: view.region! };
}

/** The folder of one Core inside the configured bucket: `<prefix>/<core id>/`, which is what the role confines a Core to. */
export function coreFolderPrefix(prefix: string, coreId: string): string {
  return `${prefix}/${coreId}/`;
}

export type StorageIssuerOptions = { fetch?: typeof fetch; now?: () => number };

/**
 * The SDK's key issuer for this owner. **One of two places the master key is unsealed; the other is {@link storageJwks},
 * which keeps only the public half.** It goes into the
 * issuer's closure and nowhere else; the issuer returns the four fields of a Core's key and never the
 * key it signs with.
 */
export async function storageKeyIssuer(
  ownerId = OPERATOR_ID,
  opts: StorageIssuerOptions = {},
): Promise<{ issuer: SharedKeyIssuer; target: StorageTarget }> {
  const row = await findStorageConfig(ownerId);
  const sealed = await findSealedMasterKey(ownerId);
  if (!row || !sealed) throw new StorageNotConfiguredError();
  const material = openSecret(Buffer.from(sealed));
  if (material === null) {
    throw new StorageNotConfiguredError("The stored master key cannot be opened: set it again.");
  }
  const backend = row.backend as StorageBackend;
  const seams = {
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  };
  let issuer: SharedKeyIssuer;
  if (backend === "seaweedfs") {
    issuer = createSeaweedfsKeyIssuer({
      endpoint: row.endpoint,
      issuer: row.oidcIssuer,
      audience: row.oidcAudience,
      signingKey: material,
      keyId: row.keyId,
      ...seams,
    });
  } else if (backend === "sts") {
    const creds = parseStsMaster(material);
    issuer = createStsKeyIssuer({
      endpoint: row.endpoint,
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      roleArn: row.roleArn,
      bucket: row.bucket,
      prefix: row.prefix,
      region: row.region,
      ...seams,
    });
  } else if (backend === "r2") {
    issuer = createR2KeyIssuer({
      accountId: row.accountId,
      apiToken: material,
      parentAccessKeyId: row.parentAccessKeyId,
      bucket: row.bucket,
      prefix: row.prefix,
      ...seams,
    });
  } else if (backend === "supabase") {
    const secrets = parseSupabaseMaster(material);
    issuer = createSupabaseKeyIssuer({
      url: row.endpoint,
      serviceRoleKey: secrets.serviceRoleKey,
      jwtSecret: secrets.jwtSecret,
      anonKey: row.anonKey,
      bucket: row.bucket,
      prefix: row.prefix,
      ...seams,
    });
  } else {
    throw new StorageNotConfiguredError(`The backend "${row.backend}" is not supported.`);
  }
  return { issuer, target: { endpoint: row.endpoint, bucket: row.bucket, prefix: row.prefix, region: row.region } };
}

/**
 * The public half of the token signer, as the JWKS SeaweedFS fetches to verify the tokens {@link storageKeyIssuer}'s
 * issuer signs (#566): the SDK's `publicJwks` for the stored key under the configured `kid`, so the two cannot drift
 * and a rotation shows on the next read. **The second place the master key is unsealed**; the private key goes into
 * `publicJwks` and what comes back is public material. Another backend, no config or no key yet is an empty key set,
 * which verifies nothing, and never an error.
 */
export async function storageJwks(ownerId = OPERATOR_ID): Promise<{ keys: Record<string, unknown>[] }> {
  const row = await findStorageConfig(ownerId);
  if (!row || row.backend !== "seaweedfs") return { keys: [] };
  const sealed = await findSealedMasterKey(ownerId);
  if (!sealed) return { keys: [] };
  const material = openSecret(Buffer.from(sealed));
  if (material === null) return { keys: [] };
  return publicJwks(material, row.keyId);
}
