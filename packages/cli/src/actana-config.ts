// `actana.json` — what `actana setup` decided, so the other verbs don't have
// to guess.
//
// `status` needs the endpoint and the installed version; `token` needs the
// endpoint to build a Core's own registry entry; `update` (issue 06) needs to know
// which version is current. Keeping that in one small readable file beside
// `material.json` means an operator can also just look at it.
//
// No secrets live here — the CA, certs, and bearer secret stay in
// `material.json`, which is chmod 0600. This file is deliberately boring.

import * as fs from "node:fs";
import * as path from "node:path";
import log from "@actana/shared/log";

/** The filename inside the config dir. */
export const ACTANA_CONFIG_FILENAME = "actana.json";

/** What `actana setup` recorded about this install. */
export type ActanaConfig = {
  /** The installed Core version (from the tarball manifest). */
  version: string;
  /** The port the daemon listens on. */
  port: number;
  /** The address the daemon binds. */
  host: string;
  /**
   * The reachable address in the cert SAN, and this Core's endpoint.
   *
   * The **primary** since #347 — the first of {@link publicHosts}. It stays a
   * single string because an endpoint is a single address, and every reader
   * here (`status`, `token`, {@link endpointFor}) wants exactly that one.
   */
  publicHost: string;
  /**
   * Every address this Core's certificate covers, in the operator's order
   * (#347). Absent in a config written before the field existed, which reads as
   * the one-entry list `[publicHost]` — the answer that config was recording.
   */
  publicHosts?: string[];
  /** Human-friendly alias carried in this Core's credential. */
  label: string;
  /** The versioned install tree `current` points at. */
  installDir: string;
  /** `AC_USER_DATA_DIR` — where the SQLite lives. */
  dataDir: string;
};

/** Full path to `actana.json` for a config dir. */
export function actanaConfigPath(configDir: string): string {
  return path.join(configDir, ACTANA_CONFIG_FILENAME);
}

/** Write `actana.json`, creating the config dir. Overwrites on a re-run. */
export function writeActanaConfig(configDir: string, config: ActanaConfig): void {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    actanaConfigPath(configDir),
    JSON.stringify(config, null, 2) + "\n",
    "utf8",
  );
}

/**
 * Read `actana.json`. Returns null for a missing file, corrupt JSON, or a
 * payload missing required fields — every caller treats null as "nothing is
 * installed here yet", which is the right reading of all three.
 *
 * Unknown fields are dropped rather than rejected, so a machine downgraded to
 * an older CLI still reads its own config.
 */
export function readActanaConfig(configDir: string): ActanaConfig | null {
  let raw: string;
  try {
    raw = fs.readFileSync(actanaConfigPath(configDir), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn("actana-config.load: corrupt JSON", { configDir });
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (
    typeof o.version !== "string" ||
    typeof o.port !== "number" ||
    typeof o.host !== "string" ||
    typeof o.publicHost !== "string" ||
    typeof o.label !== "string" ||
    typeof o.installDir !== "string" ||
    typeof o.dataDir !== "string"
  ) {
    log.warn("actana-config.load: missing or wrong-typed fields", { configDir });
    return null;
  }
  return {
    version: o.version,
    port: o.port,
    host: o.host,
    publicHost: o.publicHost,
    // A list only when the file has a usable one. Anything else falls through
    // to `configPublicHosts`, which reads a config written before #347 as the
    // single host it recorded rather than as a Core with no addresses.
    ...(Array.isArray(o.publicHosts) &&
    o.publicHosts.every((host) => typeof host === "string" && host.trim().length > 0)
      ? { publicHosts: o.publicHosts.map((host) => (host as string).trim()) }
      : {}),
    label: o.label,
    installDir: o.installDir,
    dataDir: o.dataDir,
  };
}

/**
 * The `wss://` endpoint the Panel dials. Always `wss://` — a registration blob
 * carrying anything else is rejected by the Panel (ADR 0002).
 */
/**
 * The addresses this install's certificate covers, from either shape of config.
 *
 * A config written before #347 records one `publicHost` and no list, and it
 * means the same thing a one-entry list means — so it is read as one rather
 * than as an install with nothing configured. That keeps a machine that
 * upgrades from re-issuing its certificate on the next `actana setup`.
 */
export function configPublicHosts(
  config: Pick<ActanaConfig, "publicHost" | "publicHosts">,
): string[] {
  const listed = config.publicHosts ?? [];
  return listed.length > 0 ? listed : [config.publicHost];
}

export function endpointFor(config: Pick<ActanaConfig, "publicHost" | "port">): string {
  const host = config.publicHost.includes(":") && !config.publicHost.startsWith("[")
    ? `[${config.publicHost}]`
    : config.publicHost;
  return `wss://${host}:${config.port}`;
}
