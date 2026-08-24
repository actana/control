// Version precedence — "is that version newer than this one?", answered the
// way semver §11 answers it, prereleases included.
//
// **This rule exists twice in the repository and the two must agree.**
// `scripts/lib/release-latest.mjs` implements it for the release workflows
// (`compareReleaseVersions`, `comparePrereleaseIdentifiers`); this module
// implements it for the two product surfaces — `actana update` and the update
// check both surfaces read (ADR 0036 D8). They cannot share a file: the script
// half is plain `.mjs` run by `node` inside a workflow step with no build, and
// the TypeScript half ships inside the Core tarball and the Panel bundle. So
// they share a *test* instead — `scripts/__tests__/version-rule-agreement.test.mjs`
// runs both over the same table and fails when they answer differently.
//
// The clause that made this necessary is a prerelease being below its own
// release: `0.4.1-beta` < `0.4.1`. Comparing only the numeric core called those
// two equal, and that single answer was two bugs (#322) — a Core installed
// from a beta was never told its own line's release existed, and a bare
// `actana update` resolved `/releases/latest`, which excludes prereleases, and
// walked the machine backwards to the previous release.
//
// On the vocabulary: a **line** is `x.y.z` and resolves to either its release
// or its beta (ADR 0036 D1, D2). A beta version string is exactly `x.y.z-beta`
// on every surface and carries no counter — nothing here is built around
// ordering counters, and `-beta` is compared as the ordinary alphanumeric
// identifier it is.

/** Strip a leading `v`/`V` prefix from a version string (e.g. release tags). */
export function stripVersionPrefix(version: string): string {
  return version.trim().replace(/^v/i, "");
}

/** Core numeric segment before any `-` prerelease or `+` build suffix. */
export function versionCore(version: string): string {
  return stripVersionPrefix(version).split(/[-+]/)[0];
}

/**
 * `1.2.4`, `1.2.4-rc.1`, `0.4.1-beta`, optionally `v`-prefixed.
 *
 * Mirrors `parseReleaseVersion`'s regex in `scripts/lib/release-latest.mjs`,
 * with two deliberate differences, both of them about what reaches each half:
 * this one accepts the `v` prefix, because the strings here come from release
 * tags and from `core-manifest.json` rather than from a caller that already
 * normalised them; and it accepts `+build` metadata, which the script half
 * rejects because `+` is not a legal Docker tag character. Build metadata is
 * then *ignored* for precedence, which is semver §10 and is what this function
 * has always done.
 */
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  /** The `-` suffix's identifiers, or null for a release. */
  prerelease: string | null;
};

function parse(version: string): ParsedVersion | null {
  const match = VERSION.exec(stripVersionPrefix(String(version ?? "")));
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined ? null : prerelease,
  };
}

/**
 * Whether a version string is a prerelease — `0.4.1-beta`, `1.2.4-rc.1`.
 *
 * The Core's own version is the caller that matters: a machine installed from
 * a beta is *ahead* of `/releases/latest`, which excludes prereleases, and
 * that is what `actana update`'s downgrade guard turns into a sentence rather
 * than a silent walk backwards. Unparseable is not a prerelease.
 */
export function isPrereleaseVersion(version: string): boolean {
  return parse(version)?.prerelease != null;
}

/**
 * Semver §11.4 identifier precedence: field by field, numeric fields compared
 * numerically and ranking below alphanumeric ones, and a shorter run of
 * otherwise equal fields ranking lower — `rc.1` < `rc.2` < `rc.2.1`.
 *
 * `rc.2` < `rc.10` is the property this exists for: as strings it is the other
 * way round. A `-beta` string never reaches the numeric branch — it has one
 * identifier and no counter — so the branch is exercised by the backport
 * release candidates ADR 0023 D30 publishes.
 */
function comparePrereleaseIdentifiers(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");
  const numeric = /^\d+$/;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === undefined) return -1;
    if (right[i] === undefined) return 1;
    const isNumericLeft = numeric.test(left[i]);
    const isNumericRight = numeric.test(right[i]);
    if (isNumericLeft && isNumericRight) {
      if (Number(left[i]) !== Number(right[i])) return Number(left[i]) < Number(right[i]) ? -1 : 1;
      continue;
    }
    if (isNumericLeft !== isNumericRight) return isNumericLeft ? -1 : 1;
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Semver precedence for two parsed versions: `-1`, `0` or `1`.
 *
 * Line by line the same decision as `compareReleaseVersions` in
 * `scripts/lib/release-latest.mjs`, including the clause both bugs turned on:
 * a prerelease is below its own release, so `0.4.1-beta` < `0.4.1`.
 */
function compare(left: ParsedVersion, right: ParsedVersion): number {
  for (const field of ["major", "minor", "patch"] as const) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return comparePrereleaseIdentifiers(left.prerelease, right.prerelease);
}

/**
 * Whether `remote` is a strictly newer version than `local`.
 *
 * Unparseable on either side answers `false` rather than throwing: every
 * caller is a background check or an update guard, and neither has anywhere
 * useful to put an exception. `false` means "say nothing, change nothing",
 * which is the safe answer for both.
 */
export function isNewerSemver(remote: string, local: string): boolean {
  const r = parse(remote);
  const l = parse(local);
  if (!r || !l) return false;
  return compare(r, l) > 0;
}
