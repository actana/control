import { createPrivateKey, type KeyObject } from "node:crypto";
import { createSeaweedfsKeyIssuer, type SharedKeyIssuer } from "@actana/sdk/shared-key";
import { findSealedMasterKey, findStorageConfig, upsertStorageConfig } from "../repositories/storage.repo";
import { ConflictError, ValidationError } from "../errors";
import { OPERATOR_ID } from "./operator";
import { openSecret, sealSecret } from "./secrets-at-rest";
import type { StorageConfigInput, StorageConfigView } from "~/shared/storage-wire";

/**
 * Where the Shared folders live, and the master key that issues each Core's 1-hour key (#564, ADR 0041
 * D5, D33). The config is plain columns; the master key is sealed with `secrets-at-rest.ts`, the
 * mechanism `core_secrets` uses, and has **one reader**: {@link storageKeyIssuer}, which hands it to the
 * SDK issuer and returns the issuer. Nothing in this file returns the key, logs it, puts it in an error
 * message or sends it to a Core or a browser; the view of the config says only whether one is set.
 */

/** The backends this Panel can issue keys for. The SDK ships one issuer: SeaweedFS STS. */
export const STORAGE_BACKENDS = ["seaweedfs"] as const;
export type StorageBackend = (typeof STORAGE_BACKENDS)[number];

export const DEFAULT_OIDC_AUDIENCE = "actana-shared";
export const DEFAULT_REGION = "us-east-1";

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
  masterKeySet: false,
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
    oidcIssuer: row.oidcIssuer,
    oidcAudience: row.oidcAudience,
    keyId: row.keyId,
    masterKeySet: row.masterKeySet,
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
function parseMasterKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new ValidationError("The master key is not a PEM private key.");
  }
  if (key.asymmetricKeyType !== "rsa") throw new ValidationError("The master key must be an RSA private key.");
  return key;
}

/** Set or replace the config. The master key, when given, is sealed before it touches the database. */
export async function saveStorageConfig(
  input: StorageConfigInput,
  ownerId = OPERATOR_ID,
): Promise<StorageConfigView> {
  if (!(STORAGE_BACKENDS as readonly string[]).includes(input.backend)) {
    throw new ValidationError(`The backend "${input.backend}" is not supported: use ${STORAGE_BACKENDS.join(", ")}.`);
  }
  const bucket = requireText(input.bucket, "bucket");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new ValidationError("The bucket is not a valid bucket name.");
  const fields = {
    backend: input.backend,
    endpoint: requireUrl(input.endpoint, "endpoint"),
    bucket,
    prefix: normalizePrefix(input.prefix),
    region: requireText(input.region ?? DEFAULT_REGION, "region"),
    oidcIssuer: requireText(input.oidcIssuer, "OIDC issuer"),
    oidcAudience: requireText(input.oidcAudience ?? DEFAULT_OIDC_AUDIENCE, "OIDC audience"),
    keyId: requireText(input.keyId, "key id"),
    updatedAt: Date.now(),
  };
  const existing = await findStorageConfig(ownerId);
  let sealed: Buffer | undefined;
  if (input.masterKey !== undefined) {
    const pem = normalizePem(input.masterKey);
    parseMasterKey(pem);
    sealed = sealSecret(pem);
  } else if (!existing?.masterKeySet) {
    throw new ValidationError("The master key is required the first time storage is configured.");
  }
  await upsertStorageConfig(ownerId, fields, sealed);
  return getStorageConfig(ownerId);
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
 * The SDK's key issuer for this owner. **The only place the master key is unsealed.** It goes into the
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
  const pem = openSecret(Buffer.from(sealed));
  if (pem === null) {
    throw new StorageNotConfiguredError("The stored master key cannot be opened: set it again.");
  }
  const issuer = createSeaweedfsKeyIssuer({
    endpoint: row.endpoint,
    issuer: row.oidcIssuer,
    audience: row.oidcAudience,
    signingKey: pem,
    keyId: row.keyId,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { issuer, target: { endpoint: row.endpoint, bucket: row.bucket, prefix: row.prefix, region: row.region } };
}
