// `harness-manifest.json` — the tarball's self-description, written by
// `scripts/build-harness-tarball.mjs` at the tarball root.
//
// `actana setup` reads it to learn which version it is installing and which
// directory that version gets; `actana status` reports the protocol version
// from it so the Panel's version-lock gate has something to compare against.

import * as fs from "node:fs";
import * as path from "node:path";

/** The manifest fields the CLI relies on. */
export type HarnessManifest = {
  /** Bare semver — also the `versions/<v>` directory name. */
  version: string;
  /** The core-link protocol version this build speaks. */
  protocolVersion: string;
  /** `linux-x64`, `mac-arm64`, … */
  target: string;
  platform: string;
  arch: string;
  nodeVersion: string;
};

/** Full path to the manifest inside an extracted tarball. */
export function manifestPath(installRoot: string): string {
  return path.join(installRoot, "harness-manifest.json");
}

/**
 * Read and validate the manifest at an install root.
 *
 * Returns null when the file is absent, unparseable, or missing a field —
 * every one of those means "this directory is not an extracted Harness
 * tarball", which is the only distinction a caller needs to make.
 */
export function readHarnessManifest(installRoot: string): HarnessManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath(installRoot), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const fields = ["version", "protocolVersion", "target", "platform", "arch", "nodeVersion"];
  for (const field of fields) {
    if (typeof o[field] !== "string" || o[field] === "") return null;
  }
  return {
    version: o.version as string,
    protocolVersion: o.protocolVersion as string,
    target: o.target as string,
    platform: o.platform as string,
    arch: o.arch as string,
    nodeVersion: o.nodeVersion as string,
  };
}
