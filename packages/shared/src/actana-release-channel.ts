// The release channel's shape — which repository publishes Actana, where its
// releases are read from, and how a release payload names its version.
//
// This lives in the wire-contract package rather than in the Core because both
// surfaces read it: `actana update` resolves a version to download from it
// (`@actana/core`'s `actana-release.ts`, which re-exports everything here so
// the CLI still has one release module), and the update *check* asks the same
// endpoint from the Panel, which cannot import the Core (ADR 0016 D3 — the two
// images must not depend on each other).
//
// `install.sh` resolves releases in POSIX sh against these same shapes. The two
// must agree: an installer that resolved releases differently from the CLI
// would be a second, subtly different front door.
//
// Pure: URLs and strings in, URLs and strings out. Nothing here fetches.

/** Where the project publishes releases. Matches `install.sh`'s defaults. */
export const DEFAULT_REPO = "actana/control";
export const DEFAULT_API_BASE = "https://api.github.com";
export const DEFAULT_DOWNLOAD_BASE = "https://github.com";

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

/** The releases-API URL for the newest published release. */
export function latestReleaseUrl(channel: ReleaseChannel): string {
  return `${channel.apiBase}/repos/${channel.repo}/releases/latest`;
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
