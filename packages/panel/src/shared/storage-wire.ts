// The Shared-folder storage config and the connection test, as the browser sees them (#564, #566).
//
// There is no field for the master key in any type here, and that is the point: it goes in through a
// write-only request and never comes back, in a type or on the wire.

/** Backends this Panel can show and issue keys for. SeaweedFS is the default (screen 08, #566). */
export const STORAGE_BACKEND_KINDS = ["seaweedfs", "sts", "supabase", "r2"] as const;
export type StorageBackendKind = (typeof STORAGE_BACKEND_KINDS)[number];

/** What a read of the storage config says. `masterKeySet` is the only thing it says about the key. */
export type StorageConfigView = {
  configured: boolean;
  backend: StorageBackendKind | null;
  /** The S3 API host a Core's key signs against. */
  endpoint: string | null;
  /** The STS AssumeRole URL (`sts`) or the Supabase project URL (`supabase`); null for the other backends. */
  issuerEndpoint: string | null;
  bucket: string | null;
  prefix: string | null;
  region: string | null;
  oidcIssuer: string | null;
  oidcAudience: string | null;
  keyId: string | null;
  /** STS AssumeRole ARN (Generic STS backend). */
  roleArn: string | null;
  /** Cloudflare account id (R2 backend). */
  accountId: string | null;
  /** Parent R2 S3 access key id (R2 backend). */
  parentAccessKeyId: string | null;
  /** Supabase anon key (public; returned so the Core can sign S3 requests). */
  anonKey: string | null;
  masterKeySet: boolean;
  /** When the sealed master key was last written; null until one is set. */
  masterKeyRotatedAt: number | null;
  /** Max upload bytes from the Panel Files tab and the SDK. Default 512 MiB. */
  uploadSizeLimitBytes: number | null;
  updatedAt: number | null;
};

/** One Core's Shared folder as the Settings › Storage page lists it (screen 08). */
export type StorageCoreFolderView = {
  coreId: string;
  label: string;
  /** `<prefix>/<core id>/` once known. */
  prefix: string;
  /** Sum of object sizes under the Core's folder, or null when it could not be listed. */
  sizeBytes: number | null;
  keyExpiresAt: number | null;
  state: "pending" | "attached" | "error";
  /** True when the Core's dial is not connected (key may be expired → read-only). */
  offline: boolean;
  error: string | null;
};

/** The write: the master key is optional (absent keeps the stored one) and never read back. */
export type StorageConfigInput = {
  backend: string;
  /** The S3 API host. For `supabase` it may be left empty: it is then `<project URL>/storage/v1/s3`. */
  endpoint: string;
  /** Required for `sts` (the AssumeRole URL) and `supabase` (the project URL); ignored for the others. */
  issuerEndpoint?: string;
  bucket: string;
  prefix: string;
  region?: string;
  oidcIssuer?: string;
  oidcAudience?: string;
  keyId?: string;
  roleArn?: string;
  accountId?: string;
  parentAccessKeyId?: string;
  anonKey?: string;
  /** Bytes. Omit to keep the stored limit; first configure defaults to 512 MiB. */
  uploadSizeLimitBytes?: number;
  /**
   * Write-only master material. Shape depends on backend:
   * - seaweedfs: RSA private key PEM
   * - sts: JSON `{ "accessKeyId", "secretAccessKey" }`
   * - r2: the Cloudflare API token (plain string)
   * - supabase: JSON `{ "serviceRoleKey", "jwtSecret" }`
   */
  masterKey?: string;
};

/** What the connection test proved. `reachOther` is expected to be false: the key must not reach another Core's folder. */
export type SharedConnectionResult = {
  folder: string;
  expiresAt: number;
  read: boolean;
  write: boolean;
  listOwn: boolean;
  reachOther: boolean;
};

/** A key that does what a Core's key must: its own folder, and nothing else. */
export function connectionPassed(result: SharedConnectionResult): boolean {
  return result.read && result.write && result.listOwn && !result.reachOther;
}

/** `cores/` and `/cores` are one prefix; the Core's own folder is `<prefix>/<core id>/`. */
export function derivedFolder(prefix: string, coreId: string): string {
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/${coreId}/` : `${coreId}/`;
}

/** The S3 API path Supabase serves under a project's URL. */
export const SUPABASE_S3_PATH = "/storage/v1/s3";

/** Default upload size limit on screen 08: 512 MB per file. */
export const DEFAULT_UPLOAD_SIZE_LIMIT_BYTES = 512 * 1024 * 1024;
