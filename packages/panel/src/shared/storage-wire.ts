// The Shared-folder storage config and the connection test, as the browser sees them (#564).
//
// There is no field for the master key in any type here, and that is the point: it goes in through a
// write-only request and never comes back, in a type or on the wire.

/** What a read of the storage config says. `masterKeySet` is the only thing it says about the key. */
export type StorageConfigView = {
  configured: boolean;
  backend: "seaweedfs" | null;
  endpoint: string | null;
  bucket: string | null;
  prefix: string | null;
  region: string | null;
  oidcIssuer: string | null;
  oidcAudience: string | null;
  keyId: string | null;
  masterKeySet: boolean;
  updatedAt: number | null;
};

/** The write: the master key is optional (absent keeps the stored one) and never read back. */
export type StorageConfigInput = {
  backend: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  region?: string;
  oidcIssuer: string;
  oidcAudience?: string;
  keyId: string;
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
