// The release channel, as `actana update` sees it.
//
// This is the CLI-side half of what `install.sh` does in POSIX sh: map this
// machine to a release target, resolve `latest` (or take a pinned version),
// name the assets, and read the `SHA256SUMS` that decides whether a download
// is the one the release describes. The two must agree on every one of those
// shapes — an update that resolved releases differently from the installer
// would be a second, subtly different front door.
//
// Everything here is pure except the fetch port: URLs in, strings out, so the
// resolution rules are unit-testable without a network or a release existing.
// The bytes themselves come through {@link ReleaseFetcher}, which
// `actana-update.ts` drives and tests replace with a local fixture.
//
// The channel's own shape — the repository, its hosts, the `releases/latest`
// URL and the tag inside a release payload — lives in
// `@actana/shared/actana-release-channel`, because the Panel's update check
// reads the same endpoint and cannot import the Core (ADR 0016 D3). It is
// re-exported here so this stays the one release module the CLI imports.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
  latestReleaseUrl,
  parseLatestTag,
  type ReleaseChannel,
} from "@actana/shared/actana-release-channel";
import type { ReleaseFetcher } from "@actana/shared/actana-release-fetch";

export { nodeReleaseFetcher, type ReleaseFetcher } from "@actana/shared/actana-release-fetch";

export {
  BETA_SUFFIX,
  betaVersionForLine,
  DEFAULT_API_BASE,
  DEFAULT_DOWNLOAD_BASE,
  DEFAULT_REPO,
  isBetaVersion,
  latestReleaseUrl,
  lineOf,
  parseLatestTag,
  releaseChannel,
  releaseTagUrl,
  resolveLine,
  type LineResolution,
  type ReleaseChannel,
} from "@actana/shared/actana-release-channel";

/** The checksum asset every release carries, named as the release workflow names it. */
export const SHASUMS_ASSET = "SHA256SUMS";

/**
 * The release target for a machine, or null when there is no build for it.
 *
 * Three targets: `linux-x64`, `linux-arm64`, `mac-arm64`. Windows is not an
 * omission — Windows operators run the web Panel and host their Cores on Linux
 * (WSL counts as Linux).
 *
 * **An Intel Mac returns null on purpose.** `darwin`/`x64` is the one
 * combination that looks like it ought to have an asset and never will: the
 * on-device install is Apple silicon only, and an Intel Mac runs its Core from
 * the container image. Answering `"mac-x64"` here would make `actana update`
 * fail two steps later with "release 0.2.0 has no build for mac-x64", which
 * reads as a broken release rather than as the decision it is. `install.sh`'s
 * `detect_target` refuses at the same point, for the same reason.
 */
export function releaseTargetFor(platform: NodeJS.Platform, arch: string): string | null {
  const cpu = arch === "x64" || arch === "arm64" ? arch : null;
  if (!cpu) return null;
  if (platform === "linux") return `linux-${cpu}`;
  if (platform === "darwin") return cpu === "arm64" ? "mac-arm64" : null;
  return null;
}

/** The tarball asset name for a version and target. */
export function releaseAssetName(version: string, target: string): string {
  return `actana-core-${version}-${target}.tar.gz`;
}

/** The download URL for one asset of one release. */
export function assetUrl(channel: ReleaseChannel, version: string, asset: string): string {
  return `${channel.downloadBase}/${channel.repo}/releases/download/v${version}/${asset}`;
}

/** `<digest>  <name>` (coreutils) and `<digest> *<name>` (shasum binary mode). */
const SHASUM_LINE = /^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/;

/**
 * Read a `SHA256SUMS` file into `name → digest`.
 *
 * Lines that are not digest lines are skipped rather than rejected: a release's
 * checksum file is generated, but nothing stops a future one from carrying a
 * header, and refusing to read it at all would be a worse failure than
 * ignoring the line.
 */
export function parseShasums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = SHASUM_LINE.exec(line.trim());
    if (match) sums.set(match[2].trim(), match[1].toLowerCase());
  }
  return sums;
}

/** The SHA-256 of a file on disk, as the hex digest a `SHA256SUMS` line carries. */
export function sha256OfFile(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/**
 * Which version an update should install.
 *
 * A pinned version costs no API call — an update that still asked what the
 * latest release was would be one API change away from quietly installing
 * something else than the operator named.
 *
 * **`/releases/latest` cannot see a prerelease**, by GitHub's definition of
 * that endpoint, so on a machine installed from a beta this answers with the
 * *previous* release — `0.4.0` for a machine running `0.4.1-beta`. That is not
 * corrected here, because it is the right answer to the question this function
 * asks ("what is the newest release?"). Deciding that installing it would move
 * the machine backwards is a different question, and it is answered by
 * `runActanaUpdate`'s downgrade guard in `actana-update.ts` (#322).
 *
 * Resolving a *line* to its release or its beta is a third question again —
 * ADR 0036 D2's rule, spelled as `resolveLine` in the shared channel module
 * and re-exported above. `actana update` does not use it yet: teaching it a
 * beta channel of its own is explicitly not #322.
 */
export async function resolveReleaseVersion(
  fetcher: ReleaseFetcher,
  channel: ReleaseChannel,
  requested?: string,
): Promise<string> {
  if (requested) return requested.replace(/^v/, "");

  const url = latestReleaseUrl(channel);
  let body: string;
  try {
    body = await fetcher.fetchText(url);
  } catch (err) {
    throw new Error(
      `could not fetch ${url}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Either ${channel.repo} has no releases, or this machine cannot reach it — ` +
        "check the network, or pin a version with --version.",
    );
  }
  const version = parseLatestTag(body);
  if (!version) {
    throw new Error(`no release tag in the answer from ${url} — is ${channel.repo} the right repository?`);
  }
  return version;
}
