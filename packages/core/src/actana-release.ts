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
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  latestReleaseUrl,
  parseLatestTag,
  type ReleaseChannel,
} from "@actana/shared/actana-release-channel";

export {
  DEFAULT_API_BASE,
  DEFAULT_DOWNLOAD_BASE,
  DEFAULT_REPO,
  latestReleaseUrl,
  parseLatestTag,
  releaseChannel,
  type ReleaseChannel,
} from "@actana/shared/actana-release-channel";

/** The checksum asset every release carries, named as the release workflow names it. */
export const SHASUMS_ASSET = "SHA256SUMS";

/** Fetching bytes — the only impure thing in the update path's release half. */
export type ReleaseFetcher = {
  /** GET a URL as text. Throws when the request fails or answers non-2xx. */
  fetchText(url: string): Promise<string>;
  /** GET a URL into a file. Throws rather than leaving a partial file behind. */
  download(url: string, destPath: string): Promise<void>;
};

/**
 * GitHub's API rejects requests without one, and a named agent is what shows
 * up in rate-limit and abuse reports if an update loop ever misbehaves.
 */
const USER_AGENT = "actana-cli";

/**
 * The real fetcher: `fetch` over the network.
 *
 * A download lands on `<dest>.part` and is renamed into place, so a connection
 * that drops halfway can never leave a file that looks like a complete tarball
 * — the digest would catch it anyway, but a half-file that survives a crash
 * would be a puzzle rather than a retry.
 */
export function nodeReleaseFetcher(): ReleaseFetcher {
  const get = async (url: string): Promise<Response> => {
    const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return response;
  };

  return {
    async fetchText(url) {
      return (await get(url)).text();
    },
    async download(url, destPath) {
      const response = await get(url);
      if (!response.body) throw new Error("the release server sent an empty response");
      const partial = `${destPath}.part`;
      try {
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
        fs.renameSync(partial, destPath);
      } catch (err) {
        fs.rmSync(partial, { force: true });
        throw err;
      }
    },
  };
}

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
