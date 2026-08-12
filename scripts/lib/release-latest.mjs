// Which tags a release publishes, and — the whole point of this module —
// whether `latest` is one of them (ADR 0023 D26, D28, D30).
//
// `release.yml` has two modes. **Promote** re-points the verified `beta-x.y.z`
// digest at `x.y.z`; **backport** builds `1.2.4` from `release/1.2` because no
// beta train exists for an old line and there is therefore no digest to
// promote. The second one is where two library defaults, neither written by
// anyone, quietly do the wrong thing:
//
//   * the old `resolve` emitted `tags="$version latest"` for any version
//     without a `-` in it, and
//   * `gh release create` was called with no `--latest` flag at all, and the
//     API defaults `make_latest` to `true`.
//
// Publish `1.2.4` after `1.4.0` and `:latest` moves **backwards**, *and*
// `/releases/latest` starts answering `v1.2.4` — which is what `install.sh`
// installs by default and what the in-product update checker compares against.
// Every 1.4.x user is told an older version is available. The failure is
// silent, it reaches end users, and it stays dormant until the first backport.
//
// ── Why this is a module and not four lines of shell ─────────────────────────
//
// D28 asks for the guard on **both** surfaces — the Docker tag and the GitHub
// Release — and two independent implementations of one rule is exactly how the
// surfaces drift apart. So there is one decision here, taken once, and the two
// surfaces are two renderings of the same boolean: `tags` for Docker,
// `latest` for `gh release create --latest=`. They cannot disagree, because
// there is nothing for them to disagree about.
//
// It is pure and away from git and the network so that every branch of it is
// testable — including the one that matters most and can never be reached in
// CI without cutting a real backport.
//
// ── The three reasons `latest` is withheld, in the order they are tested ─────
//
//   1. backport mode, unconditionally and before anything is compared. Not
//      "backports usually lose the comparison" — a backport never even asks
//      the question. This is D28's "structurally incapable": the comparison
//      that could say yes is not reached, so no arrangement of published
//      versions, and no bug in the comparison itself, can produce `latest`
//      from a backport.
//   2. a prerelease (`1.2.4-rc.1`, D30). It publishes its own version and
//      nothing else, on both surfaces.
//   3. losing the highest-version test — an explicit "is this the highest
//      released version?" rather than "is this not a prerelease?", which is
//      the test the old code was missing entirely.
//
// `assertNeverLatest` then re-checks the result on the way out. It is
// unreachable by construction and kept anyway: D28's own words are "belt and
// braces is proportionate", and this is the cheapest brace there is.

/** The two modes `release.yml` resolves a tag into (ADR 0023 D26). */
export const RELEASE_MODES = ["promote", "backport"];

/** `1.2.4` / `1.2.4-rc.1` — three components, optional prerelease, no build metadata. */
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Parse a bare version (no leading `v`) into its parts, or `null`.
 *
 * `+build` metadata is rejected rather than ignored: `+` is not a legal
 * character in a Docker tag, so a version carrying it has no tag to publish
 * under, and `1.0.0+abc` would not read as a prerelease below — it would move
 * `:latest`.
 */
export function parseReleaseVersion(version) {
  const match = VERSION.exec(String(version ?? ""));
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined ? null : prerelease,
  };
}

/** Whether a version string is a prerelease (`1.2.4-rc.1`). */
export function isPrerelease(version) {
  return parseReleaseVersion(version)?.prerelease != null;
}

const comparePrereleaseIdentifiers = (a, b) => {
  // Semver §11.4: identifiers are compared field by field, numeric ones
  // numerically and below alphanumeric ones, and a shorter run of otherwise
  // equal fields is lower — `rc.1` < `rc.2` < `rc.2.1`.
  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === undefined) return -1;
    if (right[i] === undefined) return 1;
    const numeric = /^\d+$/;
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
};

/**
 * Semver precedence. `-1`, `0` or `1`; unparseable versions throw rather than
 * sorting somewhere arbitrary.
 */
export function compareReleaseVersions(a, b) {
  const left = parseReleaseVersion(a);
  const right = parseReleaseVersion(b);
  if (!left) throw new Error(`not a version: ${a}`);
  if (!right) throw new Error(`not a version: ${b}`);
  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  // A prerelease is below its own release: 1.2.4-rc.1 < 1.2.4.
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return comparePrereleaseIdentifiers(left.prerelease, right.prerelease);
}

/**
 * Normalise the tag ladder into bare versions: `v1.2.4` → `1.2.4`, anything
 * that is not a version tag dropped.
 *
 * The published set comes from `git tag --list 'v*'`, which is the record a
 * release leaves behind (D40), so it is the honest answer to "what has been
 * released" even for a version whose GitHub Release someone later edited.
 */
export function publishedVersionsFromTags(tags) {
  return (Array.isArray(tags) ? tags : String(tags ?? "").split(/\s+/))
    .map((tag) => String(tag).trim())
    .filter(Boolean)
    .map((tag) => (tag.startsWith("v") ? tag.slice(1) : tag))
    .filter((version) => parseReleaseVersion(version) !== null);
}

/**
 * Is `version` the highest version released so far?
 *
 * Prereleases in the published set are ignored on both sides: `1.5.0-rc.1`
 * existing must not stop `1.4.1` taking `latest`, because nobody is running
 * an rc as their `:latest`. The version being released is allowed to be
 * present already — the tag is pushed before the release runs (D40), so it is
 * in its own ladder.
 */
export function isHighestRelease(version, published) {
  if (isPrerelease(version)) return false;
  return publishedVersionsFromTags(published)
    .filter((other) => !isPrerelease(other))
    .every((other) => compareReleaseVersions(version, other) >= 0);
}

/**
 * The npm dist-tag a release publishes under — the third surface `latest`
 * reaches, and the one with a default nobody wrote.
 *
 * `npm publish` with no `--tag` takes `latest`, exactly as `gh release create`
 * with no `--latest` defaults `make_latest` to true and exactly as the old
 * `resolve` emitted a bare `latest` in its docker tag list. Two of those three
 * are already answered here; this is the third, answered in the same place and
 * off the same boolean, so the surfaces cannot drift.
 *
 * npm differs from the other two in one respect that decides the shape of this
 * function: a dist-tag is mandatory. Docker publishes the tags it is given and
 * a GitHub Release can simply not be latest, but every npm publish lands under
 * some tag, so "withhold `latest`" has to name a replacement rather than pass
 * nothing. Each of the four is a name with exactly one meaning:
 *
 *   * `latest`             — and only when D28 says latest moves. `npm i
 *                            @actana/sdk` resolves here.
 *   * `next`               — a prerelease on the main line (D30). The
 *                            conventional npm channel for "not the stable one";
 *                            no default install reaches it.
 *   * `release-<M>.<m>-next` — a prerelease of an old line. `next` alone would
 *                            put a backport's rc on the same tag as main's,
 *                            which are not the same channel.
 *   * `release-<M>.<m>`    — an old line's stable patch. `npm i
 *                            @actana/sdk@release-0.1` is how a consumer pinned
 *                            to that line gets it, and it is the tag a backport
 *                            moves *instead of* moving `latest`.
 *
 * None of the three non-`latest` names parses as a semver range, which npm
 * rejects as a dist-tag.
 */
export function npmDistTag({ mode, version, latest, prerelease }) {
  if (latest) return "latest";
  const parsed = parseReleaseVersion(version);
  if (!parsed) throw new Error(`not a version: ${version}`);
  const line = `release-${parsed.major}.${parsed.minor}`;
  if (prerelease) return mode === "backport" ? `${line}-next` : "next";
  return line;
}

/**
 * The one assertion D28 asks for, in the form it asks for: a backport is
 * incapable of emitting `latest` on any of the three surfaces.
 *
 * Called on the way out of `resolveReleaseTags`, where it cannot fire, and
 * exported so the workflow's own guard step and the tests call the same
 * function rather than a second opinion about the same rule.
 */
export function assertNeverLatest({ mode, tags = [], latest = false, npmTag = "" }) {
  if (mode !== "backport") return;
  const list = Array.isArray(tags) ? tags : String(tags).split(/\s+/).filter(Boolean);
  if (npmTag === "latest") {
    throw new Error(
      `backport mode resolved the npm dist-tag 'latest' for [${list.join(" ")}] — ` +
        "`npm i @actana/sdk` would then hand every consumer an old line's patch as a downgrade, " +
        "silently and on their next install (ADR 0023 D28).",
    );
  }
  if (!latest && !list.includes("latest")) return;
  throw new Error(
    `backport mode resolved latest=${latest} with tags [${list.join(" ")}] — ` +
      "a backport publishes a patch for an old line and must never move `latest` on Docker Hub " +
      "or on GitHub, because `install.sh` and the update checker both read it (ADR 0023 D28).",
  );
}

/**
 * The whole decision: what a release publishes, and what it must not.
 *
 * @param {object} input
 * @param {"promote"|"backport"} input.mode  where the tag lives (D26).
 * @param {string} input.version             bare version, no leading `v`.
 * @param {string[]|string} [input.published] the tag ladder, `v*` tags or bare.
 * @returns {{mode: string, version: string, tags: string[], latest: boolean,
 *            prerelease: boolean, npmTag: string, reason: string}}
 */
export function resolveReleaseTags({ mode, version, published = [] }) {
  if (!RELEASE_MODES.includes(mode)) {
    throw new Error(`unknown release mode '${mode}' — expected one of ${RELEASE_MODES.join(", ")}`);
  }
  const parsed = parseReleaseVersion(version);
  if (!parsed) {
    throw new Error(
      `not a release version: '${version}' — three components and no +build metadata (e.g. 1.2.4 or 1.2.4-rc.1)`,
    );
  }

  const prerelease = parsed.prerelease !== null;
  let latest;
  let reason;
  if (mode === "backport") {
    // First, and without consulting the ladder. See the header.
    latest = false;
    reason = `backport of ${version} from a release line — a backport never moves latest (D28)`;
  } else if (prerelease) {
    latest = false;
    reason = `${version} is a prerelease — it publishes its own version only (D30)`;
  } else if (isHighestRelease(version, published)) {
    latest = true;
    reason = `${version} is the highest released version`;
  } else {
    latest = false;
    const higher = publishedVersionsFromTags(published)
      .filter((other) => !isPrerelease(other) && compareReleaseVersions(other, version) > 0)
      .sort(compareReleaseVersions);
    reason = `${version} is not the highest released version — ${higher.join(", ")} ${
      higher.length === 1 ? "is" : "are"
    } above it`;
  }

  const tags = latest ? [version, "latest"] : [version];
  const npmTag = npmDistTag({ mode, version, latest, prerelease });
  assertNeverLatest({ mode, tags, latest, npmTag });
  return { mode, version, tags, latest, prerelease, npmTag, reason };
}
