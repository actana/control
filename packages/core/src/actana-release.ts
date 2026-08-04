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

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Where the project publishes releases. Matches `install.sh`'s defaults. */
export const DEFAULT_REPO = "actana/control";
export const DEFAULT_API_BASE = "https://api.github.com";
export const DEFAULT_DOWNLOAD_BASE = "https://github.com";

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

/** Which repository, and which hosts its releases are read from. */
export type ReleaseChannel = {
  repo: string;
  /** Host serving the releases API (`/repos/<repo>/releases/latest`). */
  apiBase: string;
  /** Host serving release assets (`/<repo>/releases/download/<tag>/<asset>`). */
  downloadBase: string;
};

/**
 * Resolve the channel to read releases from.
 *
 * One `baseUrl` replaces both of GitHub's hosts, exactly as `install.sh`'s
 * `--base-url` does. That is what lets a fixture server stand in for GitHub in
 * tests and in a hand-run rehearsal, with no published release involved.
 */
export function releaseChannel(opts: { repo?: string; baseUrl?: string }): ReleaseChannel {
  const repo = opts.repo || DEFAULT_REPO;
  if (!opts.baseUrl) {
    return { repo, apiBase: DEFAULT_API_BASE, downloadBase: DEFAULT_DOWNLOAD_BASE };
  }
  const base = opts.baseUrl.replace(/\/+$/, "");
  return { repo, apiBase: base, downloadBase: base };
}

/**
 * The release target for a machine, or null when there is no build for it.
 *
 * Windows is not an omission: Windows operators run the web Panel and host
 * their Cores on macOS/Linux (WSL counts as Linux).
 */
export function releaseTargetFor(platform: NodeJS.Platform, arch: string): string | null {
  const os = platform === "darwin" ? "mac" : platform === "linux" ? "linux" : null;
  const cpu = arch === "x64" || arch === "arm64" ? arch : null;
  return os && cpu ? `${os}-${cpu}` : null;
}

/** The tarball asset name for a version and target. */
export function releaseAssetName(version: string, target: string): string {
  return `actana-core-${version}-${target}.tar.gz`;
}

/** The releases-API URL for the newest published release. */
export function latestReleaseUrl(channel: ReleaseChannel): string {
  return `${channel.apiBase}/repos/${channel.repo}/releases/latest`;
}

/** The download URL for one asset of one release. */
export function assetUrl(channel: ReleaseChannel, version: string, asset: string): string {
  return `${channel.downloadBase}/${channel.repo}/releases/download/v${version}/${asset}`;
}

/**
 * The bare version in a release payload's `tag_name`, or null when there is
 * none — a 404 body, an error object, or anything that is not a release.
 */
export function parseLatestTag(json: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const tag = (parsed as Record<string, unknown>).tag_name;
  if (typeof tag !== "string" || tag === "") return null;
  return tag.replace(/^v/, "");
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
