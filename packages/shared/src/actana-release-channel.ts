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

// -- Lines ---------------------------------------------------------------------
//
// A **line** is `x.y.z`, and it resolves to either its release or its beta
// (ADR 0036 D1, D2). It is deliberately not a second meaning for
// {@link ReleaseChannel} above: that type already means *which repository and
// which hosts releases are read from*, and overloading it with
// stable-versus-beta would make the two meanings indistinguishable in exactly
// the code that resolves both (ADR 0036 D6).
//
// This half is created here and consumed twice — by the CLI through
// `actana-release.ts`, and by `install.sh`, which mirrors the same rule in
// POSIX sh (#317). The module's own header rule is why they live together:
// an installer that resolved releases differently from the CLI would be a
// second, subtly different front door.

/**
 * The suffix a beta version carries. Exactly `-beta`, and never a counter.
 *
 * A beta tag *moves* — it is re-cut at a new commit on every beta cut of the
 * line (ADR 0036 D7) — so the version string stays the same across cuts and
 * there is no `.N` to order. Nothing that compares versions may be built
 * around ordering counters, because there are none to order.
 */
export const BETA_SUFFIX = "-beta";

/** `0.4.1` → `0.4.1-beta`. The one beta version a line can have. */
export function betaVersionForLine(line: string): string {
  return `${line}${BETA_SUFFIX}`;
}

/** Whether a version is a line's beta — `0.4.1-beta`, and nothing else. */
export function isBetaVersion(version: string): boolean {
  return version.endsWith(BETA_SUFFIX) && version.length > BETA_SUFFIX.length;
}

/** The line a version belongs to: `0.4.1-beta` → `0.4.1`, `0.4.1` → `0.4.1`. */
export function lineOf(version: string): string {
  return version.replace(/^v/i, "").split(/[-+]/)[0];
}

/** The releases-API URL for one named tag — `/releases/tags/v<version>`. */
export function releaseTagUrl(channel: ReleaseChannel, version: string): string {
  return `${channel.apiBase}/repos/${channel.repo}/releases/tags/v${version}`;
}

/**
 * How a line resolved, and to what.
 *
 * The kind is carried rather than inferred from the string so a caller can say
 * *why* it is installing what it is installing — "this line has no release yet,
 * so you are getting its beta" is a different sentence from "this is the
 * release", and an operator on a train deserves the difference.
 */
export type LineResolution =
  | { kind: "pinned"; version: string }
  | { kind: "release"; version: string }
  | { kind: "beta"; version: string }
  | { kind: "latest" };

/**
 * ADR 0036 D2's resolution rule, as a decision over answers already gathered.
 *
 * In order: an explicit pin wins; then the release `v<line>` if that Release
 * exists; then `v<line>-beta` if that one does; otherwise `/releases/latest`,
 * which is what the installer and `actana update` read today and which stays
 * the terminal fallback for a line that has published nothing at all.
 *
 * **No step enumerates releases, and this signature is what makes that
 * structural.** `GET /repos/<repo>/releases` returns every release across
 * *all* lines newest-first, so "the newest prerelease" would hand a machine
 * installing one line's beta the beta of another. The two inputs here are
 * existence answers about two *named* tags, so there is no listing to be
 * tempted by and no ordering to get wrong — which is also why this is pure and
 * lives beside the URL builders rather than behind a fetcher.
 */
export function resolveLine(opts: {
  line: string;
  /** An explicit `--version` / `ACTANA_VERSION`, unchanged and never second-guessed. */
  requested?: string;
  /** Whether the Release `v<line>` exists. */
  releaseExists: boolean;
  /** Whether the Release `v<line>-beta` exists. */
  betaExists: boolean;
}): LineResolution {
  if (opts.requested) return { kind: "pinned", version: opts.requested.replace(/^v/i, "") };
  if (opts.releaseExists) return { kind: "release", version: opts.line };
  if (opts.betaExists) return { kind: "beta", version: betaVersionForLine(opts.line) };
  return { kind: "latest" };
}
