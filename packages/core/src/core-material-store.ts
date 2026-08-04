// Core material store — persists cert material + bearer secret to disk so
// the daemon can reload the same CA + certs across reboots (ADR 0003
// "Auto-start").
//
// Without persistence the daemon would generate fresh certs on each start,
// invalidating the Panel's pinned client cert. The material file lives at
// `{configDir}/material.json` and contains the full CertMaterial (CA + server
// + client certs/keys) plus the bearer HMAC secret and coreId. Re-running
// `core install` overwrites the file (reissue); the SQLite DB lives in a
// separate user-data dir and is never touched by this store.
//
// Core process only — never imported by the browser.

import * as fs from "node:fs";
import * as path from "node:path";
import log from "./log";

/**
 * The persisted Core material — everything the daemon needs to restart
 * with the same identity (same CA, same certs, same bearer secret + coreId).
 * Written by `core install`; read by `core-entry.ts` on daemon boot when
 * `AC_CORE_MATERIAL_FILE` is set.
 */
export type PersistedMaterial = {
  /** PEM-encoded self-signed CA cert. */
  caCert: string;
  /** PEM-encoded CA private key. */
  caKey: string;
  /** PEM-encoded server cert presented in the mTLS handshake. */
  serverCert: string;
  /** PEM-encoded server private key. */
  serverKey: string;
  /** PEM-encoded Panel client cert. */
  clientCert: string;
  /** PEM-encoded Panel client private key. */
  clientKey: string;
  /** HMAC secret for the bearer ({@link BearerSecret}). */
  bearerSecret: string;
  /** The coreId embedded in the bearer. */
  coreId: string;
};

/** The filename inside the config dir. */
export const MATERIAL_FILENAME = "material.json";

/** The full path to the material file for a given config dir. */
export function materialFilePath(configDir: string): string {
  return path.join(configDir, MATERIAL_FILENAME);
}

/** Best-effort chmod to owner-only. No-op on non-POSIX filesystems. */
function restrictPermissions(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
  } catch {
    /* best effort */
  }
}

/**
 * Persist material to `{configDir}/material.json` as JSON. Creates `configDir`
 * if it does not exist. Overwrites any existing material (reissue). The file is
 * chmod'd to 0o600 because it contains private keys.
 */
export function persistMaterial(configDir: string, material: PersistedMaterial): void {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const filePath = materialFilePath(configDir);
  fs.writeFileSync(filePath, JSON.stringify(material, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  restrictPermissions(filePath);
}

/**
 * Load material from `{configDir}/material.json`. Returns `null` for a missing
 * file, corrupt JSON, or a payload missing required fields / wrong-typed
 * fields — the caller treats null as "generate fresh material" (first boot).
 */
/**
 * Load material from `{configDir}/material.json`. Returns `null` for a missing
 * file, corrupt JSON, or a payload missing required fields / wrong-typed
 * fields — the caller treats null as "generate fresh material" (first boot).
 */
export function loadMaterial(configDir: string): PersistedMaterial | null {
  return loadMaterialFromFile(materialFilePath(configDir));
}

/**
 * Load material from an explicit file path. Returns `null` for a missing file,
 * corrupt JSON, or a payload missing required fields / wrong-typed fields.
 * Used by `core-entry.ts` which receives the full path via
 * `AC_CORE_MATERIAL_FILE`.
 */
export function loadMaterialFromFile(filePath: string): PersistedMaterial | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn("core-material.load: corrupt JSON", { filePath });
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (
    typeof o.caCert !== "string" ||
    typeof o.caKey !== "string" ||
    typeof o.serverCert !== "string" ||
    typeof o.serverKey !== "string" ||
    typeof o.clientCert !== "string" ||
    typeof o.clientKey !== "string" ||
    typeof o.bearerSecret !== "string" ||
    typeof o.coreId !== "string"
  ) {
    log.warn("core-material.load: missing or wrong-typed fields", { filePath });
    return null;
  }
  return {
    caCert: o.caCert,
    caKey: o.caKey,
    serverCert: o.serverCert,
    serverKey: o.serverKey,
    clientCert: o.clientCert,
    clientKey: o.clientKey,
    bearerSecret: o.bearerSecret,
    coreId: o.coreId,
  };
}
