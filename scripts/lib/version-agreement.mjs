// The version vocabulary, in one module (ADR 0037; ADR 0036 C1; ADR 0023 D3, D7).
//
// A version in this repository was six independent strings that happened to be
// equal. This module is the one definition they are all derived from and the
// one comparison that reads actual content rather than the name a string was
// derived from.
//
// ── The vocabulary ──────────────────────────────────────────────────────────
//
//   line        `x.y.z`. The unit of versioning. It is what the six manifests
//               carry, what a train branch is named for, and what an image's
//               `org.opencontainers.image.version` label says.
//   release     the line's release. Git tag `vx.y.z`, image tags `x.y.z` and
//               possibly `latest`, npm version `x.y.z`.
//   beta        the line's beta. Git tag and GitHub Release `vx.y.z-beta`,
//               image tag `x.y.z-beta`, asset filenames `…-x.y.z-beta-…`.
//               **Exactly that string, with no counter of any kind**
//               (ADR 0036 C1).
//   prerelease  any other prerelease of the line — in practice the backport
//               release candidate `x.y.z-rc.N` (ADR 0023 D30), whose shape
//               carries an identifier by design. ADR 0036 C1 binds the beta
//               channel only and says so; a counted *beta* is the banned form,
//               a counted rc is the specified one.
//
// A line resolves to a release, a beta or a candidate, and all of them carry
// the same line — which is why `lineOf` is the function every surface is
// compared through: the manifests inside a beta's bytes say `0.4.1`, not
// `0.4.1-beta`, because the cut stamps the line and a beta is a publish from
// the train, not a second stamp (ADR 0036 D1, D7).
//
// ── What this is not ────────────────────────────────────────────────────────
//
// It is not a semver library. `packages/shared/src/semver.ts` compares
// versions and `scripts/lib/release-latest.mjs` decides `latest`; neither
// question is asked here. This module answers one: **do the strings on the
// several surfaces agree with the content of the tree they claim to describe.**

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The manifests a cut stamps (ADR 0023 D3, amended by #152 and #157).
 *
 * **Three lists hold this set and a test binds each pair**: this one, the
 * `MANIFESTS` bash array in `ci.yml`'s `Train rules` job, and the `files=()`
 * array in `docs/ci-cd.md` § "Cutting a train" that a person cuts from.
 * `scripts/__tests__/version-agreement.test.mjs` asserts this one equals the
 * other two and `scripts/__tests__/workflows.test.mjs` asserts those two equal
 * each other, so extending any one of them without the others is red rather
 * than a train cut with a manifest missed.
 */
export const MANIFESTS = [
  "package.json",
  "packages/cli/package.json",
  "packages/core/package.json",
  "packages/panel/package.json",
  "packages/sdk/package.json",
  "packages/shared/package.json",
];

/**
 * The seventh place a cut writes the line, and deliberately **not** a seventh
 * manifest (ADR 0036 D4).
 *
 * `install.sh` carries the line so that the copy on a train installs that
 * train's beta and the copy on `main` installs the release, out of bytes that
 * become identical at the promotion fast-forward (0036 D1, D2). It is not a
 * workspace package, so adding it to `MANIFESTS` would break the property
 * `assert_manifest_set` exists to hold — every listed file exists, and every
 * workspace package is listed. It gets its own assertion instead, which is
 * what this pair is for.
 */
export const INSTALLER_STAMP_FILE = "install.sh";
export const INSTALLER_STAMP_PATTERN = /^LINE="([^"]*)"$/m;

/** A line: three numeric components and nothing else. */
export const LINE_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The one beta suffix there is (ADR 0036 C1). */
export const BETA_SUFFIX = "-beta";

/** A beta: a line and the bare word, with nothing after it. */
export const BETA_PATTERN = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)${BETA_SUFFIX}$`);

/**
 * Any prerelease of a line. The character class is `release.yml`'s own tag
 * regex, so a string this module accepts is a string that workflow accepts.
 */
export const PRERELEASE_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-([0-9A-Za-z.-]+)$/;

/** `true` for `x.y.z`. */
export const isLine = (version) => LINE_PATTERN.test(String(version ?? ""));

/** `true` for `x.y.z-beta`, and for nothing that carries a counter. */
export const isBeta = (version) => BETA_PATTERN.test(String(version ?? ""));

/**
 * The line a version belongs to, or `null` if the string is not a version at
 * all.
 *
 * This is the comparison every surface goes through. A release, its beta and
 * its release candidate are three publications of one line, and the tree they
 * were all built from carries that line and nothing else.
 */
export function lineOf(version) {
  const value = String(version ?? "");
  if (isLine(value)) return value;
  const prerelease = PRERELEASE_PATTERN.exec(value);
  return prerelease ? `${prerelease[1]}.${prerelease[2]}.${prerelease[3]}` : null;
}

/** The beta of a line. Throws on anything that is not a line. */
export function betaOf(line) {
  if (!isLine(line)) throw new TypeError(`not a line: ${JSON.stringify(line)}`);
  return `${line}${BETA_SUFFIX}`;
}

/**
 * `release` for `x.y.z`, `beta` for `x.y.z-beta`, `prerelease` for any other
 * prerelease of a line, `null` for anything that is not a version.
 */
export function channelOf(version) {
  if (isLine(version)) return "release";
  if (isBeta(version)) return "beta";
  return PRERELEASE_PATTERN.test(String(version ?? "")) ? "prerelease" : null;
}

/**
 * Why a version string is not one this repository writes, or `null` when it is.
 *
 * The counted forms are called out by name rather than lumped into "bad
 * shape", because `0.4.1-beta.1` is what every semver habit produces and ADR
 * 0036 C1 bans it on every surface — the git tag, the Release, the image tags,
 * the asset filenames and anything npm would see.
 */
export function versionProblem(version) {
  const value = String(version ?? "");
  if (value === "") return "it is empty";
  // Checked before `channelOf`, because a counted beta is a well-formed
  // prerelease and would otherwise be waved through as one. That is the whole
  // trap: `0.4.1-beta.1` is what every semver habit produces, it parses
  // cleanly everywhere, and it is banned on every surface.
  const counted = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta[._-]?(.+)$/.exec(value);
  if (counted) {
    return (
      `it is a counted beta — a beta version string is exactly \`x.y.z${BETA_SUFFIX}\`, ` +
      `with nothing after the word (ADR 0036 C1). Drop the \`${counted[4]}\`: ` +
      `\`${counted[1]}.${counted[2]}.${counted[3]}${BETA_SUFFIX}\` is the whole string, and ` +
      "the beta tag moves per cut rather than being counted (ADR 0036 D7)"
    );
  }
  if (channelOf(value)) return null;
  return (
    `it is not a version this repository publishes — a line \`x.y.z\`, its beta ` +
    `\`x.y.z${BETA_SUFFIX}\` (ADR 0036 C1), or a release candidate \`x.y.z-rc.N\` (ADR 0023 D30)`
  );
}

// ── The surfaces ─────────────────────────────────────────────────────────────

/**
 * The git tag a version is published under. `vx.y.z` or `vx.y.z-beta`; the
 * release tag is immutable and the beta tag moves per cut (ADR 0023 D44 as
 * amended, ADR 0036 D7).
 */
export function gitTagFor(version) {
  if (!channelOf(version)) throw new TypeError(`not a version: ${JSON.stringify(version)}`);
  return `v${version}`;
}

/** The version a git tag names, or `null` if the tag is not one of ours. */
export function versionFromGitTag(tag) {
  const value = String(tag ?? "");
  if (!value.startsWith("v")) return null;
  const version = value.slice(1);
  return channelOf(version) ? version : null;
}

/** The moving image tag a train publishes on every merge (ADR 0023 D7). */
export function trainImageTagFor(line) {
  if (!isLine(line)) throw new TypeError(`not a line: ${JSON.stringify(line)}`);
  return `beta-${line}`;
}

/**
 * The line an image tag is about, or `null` for a tag that is not
 * version-bearing (`latest`, `sha-abc1234`, `pr-64202608`).
 *
 * The two beta spellings are the trap this function exists to remove:
 * `beta-0.4.1` is the train's moving tag and `0.4.1-beta` is the beta
 * release's, they are different tags in the same repositories, and both are
 * the line `0.4.1`.
 */
export function lineFromImageTag(tag) {
  const value = String(tag ?? "");
  if (value.startsWith("beta-")) return isLine(value.slice(5)) ? value.slice(5) : null;
  return lineOf(value);
}

/**
 * Every place a version string is written, what writes it, and what is
 * authoritative for it (ADR 0037 D2).
 *
 * The catalogue is data rather than prose so it can be asserted: the ADR names
 * every row, and `scripts/__tests__/version-agreement.test.mjs` fails when a
 * row is added here and not there. `authority: "tree"` means the string is
 * checked against the manifests in the bytes it describes; `"derived"` means
 * it is computed from a string that was.
 */
export const SURFACES = [
  {
    id: "manifests",
    what: "the six package.json manifests",
    writtenBy: "the cut, docs/ci-cd.md § Cutting a train",
    authority: "tree",
  },
  {
    id: "train-branch",
    what: "the train branch name beta/x.y.z",
    writtenBy: "a person, at the cut",
    authority: "tree",
  },
  {
    id: "installer-stamp",
    what: "install.sh's LINE stamp",
    writtenBy: "the cut, docs/ci-cd.md § Cutting a train",
    authority: "tree",
  },
  {
    id: "git-tag",
    what: "the git tag vx.y.z and vx.y.z-beta",
    writtenBy: "promote.yml advance, and a beta cut",
    authority: "tree",
  },
  {
    id: "train-image-tag",
    what: "the image tag beta-x.y.z",
    writtenBy: "ci.yml train-tags",
    authority: "tree",
  },
  {
    id: "release-image-tag",
    what: "the image tags x.y.z, x.y.z-beta and latest",
    writtenBy: "release.yml, container-image.yml, a beta retag",
    authority: "tree",
  },
  {
    id: "image-version-label",
    what: "org.opencontainers.image.version on both images",
    writtenBy: "container-image.yml, from the checkout",
    authority: "tree",
  },
  {
    id: "npm-version",
    what: "the npm versions of @actana/sdk and @actana/cli",
    writtenBy: "release.yml npm, from the packed manifests",
    authority: "tree",
  },
  {
    id: "tarball",
    what: "asset filenames, the archive root and core-manifest.json",
    writtenBy: "scripts/lib/core-tarball.mjs, from RELEASE_VERSION",
    authority: "derived",
  },
];

// ── The comparison ───────────────────────────────────────────────────────────

/**
 * Read the six manifests, from the working tree or from a git object.
 *
 * `gitRef` reads through `git show <ref>:<path>` rather than checking the ref
 * out, because the two callers that need a ref other than HEAD — `release.yml`
 * resolving a tag and `promote.yml` resolving a train tip — both already have
 * a full clone and neither should have to move its working tree to ask what a
 * manifest says.
 */
export function readManifestVersions({ root = process.cwd(), gitRef = null, manifests = MANIFESTS } = {}) {
  return manifests.map((file) => {
    let raw;
    try {
      raw = gitRef
        ? // stderr ignored: `git show` writes "fatal: invalid object name" once
          // per file, and six copies of one fact is not a diagnosis. The caller
          // reports the ref as a single problem.
          execFileSync("git", ["show", `${gitRef}:${file}`], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          })
        : fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      return { file, version: null, missing: true };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { file, version: null, unreadable: true };
    }
    const version = typeof parsed.version === "string" ? parsed.version : null;
    return { file, version, missing: false, unreadable: version === null };
  });
}

/**
 * The line `install.sh` is stamped with, read the same two ways the manifests
 * are.
 *
 * Three outcomes, and they are different failures: the file is not there, the
 * file is there and carries no `LINE=` assignment at all — a cut that deleted
 * the stamp, or a tree from before it existed — and the file carries one.
 */
export function readInstallerStamp({ root = process.cwd(), gitRef = null } = {}) {
  const entry = { file: INSTALLER_STAMP_FILE, kind: "stamp", version: null, missing: false, unstamped: false };
  let raw;
  try {
    raw = gitRef
      ? execFileSync("git", ["show", `${gitRef}:${INSTALLER_STAMP_FILE}`], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        })
      : fs.readFileSync(path.join(root, INSTALLER_STAMP_FILE), "utf8");
  } catch {
    return { ...entry, missing: true };
  }
  const match = INSTALLER_STAMP_PATTERN.exec(raw);
  if (!match) return { ...entry, unstamped: true };
  return { ...entry, version: match[1] };
}

/**
 * Compare a version string on some surface against the manifests in the tree
 * it claims to describe.
 *
 * `expected` is the surface's own string — a train branch's `0.4.1`, a tag's
 * `0.4.1` or `0.4.1-beta`, an image tag's line. The manifests are compared
 * against its **line**, because a beta and its release are two publications of
 * one stamped line (ADR 0036 D1).
 *
 * Returns every problem rather than the first: a cut that missed one manifest
 * and a cut that missed five should not read the same in a log.
 */
export function checkAgreement({ expected, versions, stamp = null, stampRequired = false }) {
  const problems = [];
  const shape = versionProblem(expected);
  if (shape) {
    problems.push({
      kind: "version-shape",
      title: "Not a version this repository writes",
      detail: `\`${expected}\` cannot be published: ${shape}.`,
    });
    return { line: null, problems };
  }
  const line = lineOf(expected);
  for (const entry of versions) {
    if (entry.missing) {
      problems.push({
        kind: "missing-manifest",
        file: entry.file,
        title: "A manifest in the version set is missing",
        detail:
          `${entry.file} is in the version set and is not in this tree. Either the file moved and ` +
          "the three lists that hold the set were not updated, or the package was deleted (ADR 0023 D3).",
      });
      continue;
    }
    if (entry.unreadable) {
      problems.push({
        kind: "unreadable-manifest",
        file: entry.file,
        title: "A manifest carries no version",
        detail: `${entry.file} has no string \`version\` field, so nothing in it can be compared.`,
      });
      continue;
    }
    if (entry.version !== line) {
      problems.push({
        kind: "drift",
        file: entry.file,
        title: `Version drift in ${entry.file}`,
        detail:
          `${entry.file} says ${entry.version}; the line is ${line}. Every manifest carries the ` +
          "line the cut stamped, and every published string is that line or its beta (ADR 0023 D3, ADR 0037 D1).",
      });
    }
  }
  if (stamp) {
    if (stamp.missing) {
      if (stampRequired) {
        problems.push({
          kind: "missing-stamp",
          file: stamp.file,
          title: "The installer is missing",
          detail: `${stamp.file} is not in this tree, so the line a fetched copy would install cannot be checked.`,
        });
      }
    } else if (stamp.unstamped) {
      // Silent unless the caller asked for it. A tree from before the stamp
      // existed is a real thing to run this against — an old tag re-released —
      // and refusing it there would be refusing history. On a train it is a
      // cut that forgot, which is exactly what must go red (ADR 0036 D1, D4).
      if (stampRequired) {
        problems.push({
          kind: "unstamped-installer",
          file: stamp.file,
          title: "The installer carries no line stamp",
          detail:
            `${stamp.file} has no \`LINE="x.y.z"\` assignment. A train cut without it serves the ` +
            "previous line's beta from its own door, silently, because the resolution reads the stamp " +
            "and nothing else (ADR 0036 D1, D2). See docs/ci-cd.md § \"Cutting a train\".",
        });
      }
    } else if (stamp.version !== line) {
      problems.push({
        kind: "drift",
        file: stamp.file,
        title: `Version drift in ${stamp.file}`,
        detail:
          `${stamp.file} is stamped ${stamp.version}; the line is ${line}. The stamp is what decides ` +
          "which release a fetched copy of the installer installs, so a stale one points this line's " +
          "door at another line's build (ADR 0036 D1, D2).",
      });
    }
  }
  return { line, problems };
}

/**
 * The version label both images carry, and the comparison every image tag is
 * held to (ADR 0037 D4).
 *
 * The label is the **line**, so one rule covers all four version-bearing image
 * tags: `beta-x.y.z` from a train, `x.y.z` and `latest` from a promotion, and
 * `x.y.z-beta` from a beta retag are the same bytes carrying the same line.
 *
 * The two wrong answers this exists to catch are both live today: the Core
 * images inherit `org.opencontainers.image.version=24.04` from the Ubuntu base,
 * and the Panel images carry no version label at all.
 */
export function imageVersionProblem({ label, expected }) {
  const line = lineOf(expected);
  if (line === null) return `\`${expected}\` is not a version this repository publishes.`;
  if (!label) {
    return (
      "the image carries no `org.opencontainers.image.version` label, so its bytes say nothing " +
      `about what version they are. Expected ${line} — the line in the manifests these bytes were built from.`
    );
  }
  if (label === line) return null;
  if (label === "24.04") {
    return (
      "the image's `org.opencontainers.image.version` is `24.04`, which is the Ubuntu base's own " +
      `version inherited through \`FROM\` — not this repository's. Expected ${line}. Rebuild it: the ` +
      "label is written from the checkout's manifests, and an image predating that is one this check refuses."
    );
  }
  return (
    `the image's \`org.opencontainers.image.version\` is \`${label}\`, and the line being published ` +
    `is ${line}. The bytes self-report a different version than the tag they would be published under.`
  );
}
