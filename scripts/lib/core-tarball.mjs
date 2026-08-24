// Pure helpers for the per-platform Core tarball build.
//
// Everything here is side-effect free so `scripts/__tests__/core-tarball.test.mjs`
// can cover the parts that are easy to get subtly wrong — target/arch mapping,
// Node dist URLs, SHASUMS parsing and formatting, the runtime dependency walk —
// without downloading a Node runtime or shelling out to tar.
//
// The I/O that uses these lives in scripts/build-core-tarball.mjs and
// scripts/compose-core-shasums.mjs.

import path from "node:path";

/**
 * Node runtime bundled into every Core tarball. Kept in lockstep with the
 * `node-version` the CI workflows install — a Core that ships a different
 * Node than the one its native modules were built against will not load them.
 */
export const BUNDLED_NODE_VERSION = "24.15.0";

/**
 * The three Core release targets. A tag publishes exactly four assets: these
 * three tarballs and the `SHA256SUMS` covering them (ADR 0016 D28, as
 * amended). Windows operators, and Intel Mac operators, run the web Panel and
 * host their Cores elsewhere; WSL counts as Linux and is `linux-*`, and an
 * Intel Mac runs its Core from the Core image.
 *
 * `mac-arm64` is the one target whose leg costs real money: macOS runners bill
 * at 10×, so it builds only on a release tag, behind the `macos-release`
 * environment's manual approval, and never on a pull request — which is what
 * keeps D35's cost posture intact.
 *
 * Adding a row here is not a local edit. Every one of these has to move with
 * it, or the release ships something incoherent:
 *
 *   1. `.github/workflows/release.yml` — a leg on a runner of that
 *      architecture. The tarballs carry native modules copied from the build
 *      host, so a cross-compiled leg is a guess, not a build.
 *   2. That workflow's `compose-core-shasums.mjs --expect`, and the asset
 *      count asserted by the `github-release` job — or the release ships a
 *      `SHA256SUMS` covering less than the release does.
 *   3. `install.sh`'s `detect_target`, which maps a machine to one of these
 *      names, and refuses by name the platforms that are deliberately absent.
 *   4. `releaseTargetFor` in `packages/cli/src/actana-release.ts` — `actana
 *      update` is the second front door and must agree with the installer on
 *      every shape, refusals included.
 *   5. The tests over all four: `scripts/__tests__/core-tarball.test.mjs`,
 *      `scripts/__tests__/install-sh.test.mjs`, and
 *      `packages/core/src/__tests__/actana-release.test.ts`.
 *
 * `nodeDistId` is the Node.org tarball's platform slug; `platform`/`arch` are
 * the `process.platform`/`process.arch` values a build host must report, since
 * the native modules are copied from the host's own install (never
 * cross-compiled).
 */
export const CORE_TARGETS = Object.freeze([
  Object.freeze({ target: "linux-x64", platform: "linux", arch: "x64", nodeDistId: "linux-x64" }),
  Object.freeze({ target: "linux-arm64", platform: "linux", arch: "arm64", nodeDistId: "linux-arm64" }),
  Object.freeze({ target: "mac-arm64", platform: "darwin", arch: "arm64", nodeDistId: "darwin-arm64" }),
]);

/**
 * Packages the Core `require()`s at runtime rather than bundling.
 *
 * Must cover every `external` in `packages/core/build.mjs` that the Core
 * actually needs — the unit test asserts that, so adding an external without
 * adding it here is a red build rather than a tarball that dies on boot.
 */
export const CORE_RUNTIME_DEPENDENCIES = Object.freeze([
  "better-sqlite3",
  "node-pty",
  "ws",
  "selfsigned",
  // `undici` is the CLI's, not the daemon's: since #288 the tarball's
  // `app/actana-cli.cjs` is the *unified* `actana`, so the client nouns — and
  // `project cp` / `project files`, which reach a Core's HTTPS routes with an
  // mTLS `fetch` (ADR 0028) — run from inside the image. The bundle marks it
  // external, so without this row a container Session's `actana project files`
  // fails on a module that is not there.
  "undici",
]);

/** Externals in the Core build that deliberately do not ship in the tarball. */
export const UNBUNDLED_EXTERNALS = Object.freeze([]);

/**
 * The `bin/actana` launcher.
 *
 * Deliberately the smallest thing that satisfies "extract and run": resolve
 * the install root from the script's own location and exec the bundled Node on
 * the `actana` CLI, which owns every verb (`setup`, `status`, `token`,
 * `start`/`stop`/`restart`/`logs`, and the `daemon` verb the systemd unit
 * execs).
 *
 * The self-resolution is doing real work: an operator reaches this script in
 * place, through `PATH`, and through a symlink from `~/.local/bin`, and all
 * three have to find the same install root.
 */
export const LAUNCHER_SCRIPT = `#!/bin/sh
# actana — Core launcher. Execs the bundled Node runtime on the bundled
# actana CLI so nothing about the host's Node (or absence of one) matters.
set -eu

# Resolve this script's own path — absolute, then symlinks followed — so the
# install root is right whether we were run in place, off PATH, or via a link.
self=$0
case $self in
  /*) ;;
  */*) self=$PWD/$self ;;
  *) self=$(command -v -- "$self") ;;
esac
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *) self=\${self%/*}/$link ;;
  esac
done

# -P so the root is the physical path — the same string however the operator
# reached the script, and stable if a symlinked parent is later repointed.
ACTANA_ROOT=$(cd -P "\${self%/*}/.." && pwd)
export ACTANA_ROOT

# The Core resolves bundled resources relative to its app path.
AC_APP_PATH=\${AC_APP_PATH:-"$ACTANA_ROOT/app"}
export AC_APP_PATH

exec "$ACTANA_ROOT/node/bin/node" "$ACTANA_ROOT/app/actana-cli.cjs" "$@"
`;

/**
 * Dependencies declared as runtime deps that only ever run at install time,
 * pruned along with their own closures.
 *
 * `prebuild-install` is better-sqlite3's postinstall downloader — dozens of
 * packages the Core never `require()`s. The tarball ships the already-built
 * binding, so nothing in it can reach this code.
 */
export const DEPENDENCY_EXCLUSIONS = Object.freeze(["prebuild-install"]);

/**
 * Paths dropped from a copied dependency, relative to its package root.
 *
 * These are build inputs and intermediates (gyp sources, the SQLite
 * amalgamation, `.o` files) that no runtime `require()` reaches — but they are
 * most of the weight. The tarball smoke (`scripts/smoke-core-tarball.mjs`)
 * is what proves the prune list stayed safe.
 */
export const DEPENDENCY_PRUNE_PATHS = Object.freeze([
  "binding.gyp",
  path.join("build", "Release", "obj.target"),
  path.join("build", "Release", ".deps"),
  path.join("build", "deps"),
  path.join("build", "Makefile"),
  "deps",
  "src",
]);

/**
 * The `prebuilds/<dir>` node-pty loads from at runtime.
 *
 * node-pty publishes prebuilds for every platform it supports — including two
 * Windows sets whose `.pdb` symbol files are ~40 MB of the package. The build
 * keeps this one directory and drops the rest.
 */
export function prebuildDirName(descriptor) {
  return `${descriptor.platform}-${descriptor.arch}`;
}

/** Look up a target descriptor by name. Returns undefined for unknown names. */
export function findTarget(name) {
  return CORE_TARGETS.find((t) => t.target === name);
}

/** The target a build host can legitimately produce, or undefined if unsupported. */
export function hostTarget(platform, arch) {
  return CORE_TARGETS.find((t) => t.platform === platform && t.arch === arch);
}

/** Directory name inside the Node.org tarball (also the tarball's basename). */
export function nodeDistDirName(nodeVersion, nodeDistId) {
  return `node-v${nodeVersion}-${nodeDistId}`;
}

/** URL of the Node.org runtime tarball for a target. */
export function nodeDistTarballUrl(nodeVersion, nodeDistId) {
  return `https://nodejs.org/dist/v${nodeVersion}/${nodeDistDirName(nodeVersion, nodeDistId)}.tar.gz`;
}

/** URL of the Node.org checksum manifest covering every artifact of a release. */
export function nodeDistShasumsUrl(nodeVersion) {
  return `https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`;
}

/**
 * Parse a `sha256  filename` manifest (Node.org's SHASUMS256.txt, or one of
 * ours) into a `filename -> digest` map.
 *
 * Tolerates the `*filename` binary-mode marker and blank lines; throws on a
 * line that is neither blank nor a well-formed entry, so a truncated or HTML
 * error-page download fails here rather than as a mystery digest mismatch.
 */
export function parseShasums(text) {
  const entries = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const match = /^([0-9a-f]{64})\s+\*?(\S.*)$/.exec(line);
    if (!match) throw new Error(`unparseable checksum line: ${JSON.stringify(raw)}`);
    entries.set(match[2].trim(), match[1]);
  }
  return entries;
}

/**
 * Render a `SHA256SUMS` release asset: two spaces between digest and name,
 * sorted by name so re-running the build produces a byte-identical file.
 */
export function formatShasums(entries) {
  const rows = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return rows.map(([name, digest]) => `${digest}  ${name}`).join("\n") + "\n";
}

/**
 * The version string a Core tarball is allowed to carry.
 *
 * `x.y.z` is a release. `x.y.z-beta` is a beta, and it is exactly that on
 * every surface — the git tag, the Release, the image tags, the asset filename
 * — with no counter, no run number and no short sha after the word (ADR 0036
 * C1). A backport's release candidate keeps its identifier (`1.2.4-rc.1`, ADR
 * 0023 D30), so the rule is not "no prerelease": it is that a prerelease which
 * calls itself a beta is the one fixed string and nothing longer.
 *
 * The `v` prefix belongs to tags. It is not part of a version here — the asset
 * name, the archive root and the manifest all carry the bare string — so a
 * caller reading a tag strips it before this.
 */
const CORE_VERSION_PATTERN = /^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** The beta channel's whole prerelease identifier (ADR 0036 C1). */
export const BETA_PRERELEASE = "beta";

/**
 * Split a Core version into `{ version, line, prerelease }`, or throw naming
 * the rule it broke.
 *
 * Every surface goes through this: `tarballName`, `tarballRootDirName` and
 * `buildManifest` all call it. The version appears in three places at once and
 * that is the property ADR 0036 D18 keeps rather than removes — so the one
 * thing that must not exist is a path by which a string reaches one of the
 * three without passing the same gate as the other two.
 */
export function assertCoreVersion(version) {
  const match = typeof version === "string" ? CORE_VERSION_PATTERN.exec(version) : null;
  if (!match) {
    throw new Error(
      `unusable Core version: ${JSON.stringify(version)} — expected x.y.z, x.y.z-beta or ` +
        `x.y.z-<prerelease>, with no leading v`,
    );
  }
  const [, line, prerelease] = match;
  if (
    prerelease !== undefined &&
    prerelease.toLowerCase().startsWith(BETA_PRERELEASE) &&
    prerelease !== BETA_PRERELEASE
  ) {
    throw new Error(
      `counted beta version: ${version} — a beta is exactly ${line}-${BETA_PRERELEASE}, with ` +
        `nothing after the word, on every surface (ADR 0036 C1)`,
    );
  }
  return { version, line, prerelease: prerelease ?? null };
}

/** Whether a version names this line's beta rather than its release. */
export function isBetaVersion(version) {
  return assertCoreVersion(version).prerelease === BETA_PRERELEASE;
}

/**
 * Tarball basename for a release. `version` is the bare semver (no `v` prefix)
 * so the name matches what `actana --version` reports — and, for a beta, the
 * `x.y.z-beta` the tag and the manifest carry unchanged.
 */
export function tarballName(version, target) {
  assertCoreVersion(version);
  return `actana-core-${version}-${target}.tar.gz`;
}

/** Top-level directory inside a tarball — extraction never litters the CWD. */
export function tarballRootDirName(version, target) {
  assertCoreVersion(version);
  return `actana-core-${version}-${target}`;
}

/**
 * A target name as it appears in an asset name: two lowercase words. Kept
 * loose, because `findTarget` below is what decides which of them exist.
 */
const TARBALL_NAME_PATTERN = /^actana-core-(.+)-([a-z]+-[a-z0-9]+)\.tar\.gz$/;

/**
 * Split a tarball basename back into `{ version, target }`, or null when the
 * name is not one this build could have produced — an unknown target, a
 * version this repository refuses to build, or a file that is simply not ours.
 *
 * The inverse of `tarballName`, which the unit test pins by round-tripping the
 * pair. `install.sh` derives the same two fields from the same name in POSIX
 * sh (ADR 0016 D29), which is why this is a parser rather than a `split`.
 */
export function parseTarballName(name) {
  const match = TARBALL_NAME_PATTERN.exec(name);
  if (!match) return null;
  const [, version, target] = match;
  if (!findTarget(target)) return null;
  try {
    assertCoreVersion(version);
  } catch {
    return null;
  }
  return { version, target };
}

/**
 * The one version a `SHA256SUMS` covers, and the targets it covers it for.
 *
 * A release's checksum file and a beta's are the same shape over different
 * bytes, and the one thing neither may be is a mixture: `SHA256SUMS` is an
 * asset of a single Release, and a file listing `0.4.1` and `0.4.1-beta` side
 * by side is exactly the confusion ADR 0036 D20 rules out. Two tarballs
 * claiming one target are refused for a duller reason — one of them is a
 * leftover, and there is no way to tell which.
 */
export function assertShasumsSet(names) {
  const byTarget = new Map();
  let version;
  for (const name of names) {
    const parsed = parseTarballName(name);
    if (!parsed) throw new Error(`not a Core tarball asset name: ${name}`);
    if (version === undefined) {
      version = parsed.version;
    } else if (parsed.version !== version) {
      throw new Error(
        `two versions in one checksum set: ${version} and ${parsed.version} (${name})`,
      );
    }
    const seen = byTarget.get(parsed.target);
    if (seen) throw new Error(`two ${parsed.target} tarballs: ${seen} and ${name}`);
    byTarget.set(parsed.target, name);
  }
  if (version === undefined) throw new Error("no Core tarballs to cover");
  return { version, targets: [...byTarget.keys()] };
}

/**
 * Extract `CORE_LINK_PROTOCOL_VERSION` from the text of
 * `packages/sdk/src/core-link-frames.ts`.
 *
 * The tarball must embed the protocol version so `actana status` and the
 * Panel's needs-update gate can compare against it, but the build script is
 * plain `.mjs` and cannot import the TypeScript source. Reading the literal
 * keeps a single definition; the unit test runs this against the real file so
 * a rename can't silently start shipping a stale version.
 */
export function parseCoreLinkProtocolVersion(source) {
  const match = /CORE_LINK_PROTOCOL_VERSION\s*=\s*"([^"]+)"/.exec(source);
  if (!match) {
    throw new Error("could not find CORE_LINK_PROTOCOL_VERSION in core-link-frames.ts");
  }
  return match[1];
}

/**
 * The `core-manifest.json` written at the tarball root.
 *
 * Deliberately flat and boring: `actana update` and `actana status` read it,
 * and so does the installer when deciding whether an existing install is
 * older than the release it just downloaded.
 */
export function buildManifest({ version, protocolVersion, target, nodeVersion }) {
  const descriptor = findTarget(target);
  if (!descriptor) throw new Error(`unknown target: ${target}`);
  assertCoreVersion(version);
  return {
    name: "actana-core",
    version,
    protocolVersion,
    target,
    platform: descriptor.platform,
    arch: descriptor.arch,
    nodeVersion,
  };
}

/**
 * Assert that a built tarball says one thing about itself in all three of the
 * places it says anything: the asset name, the directory the archive extracts
 * to, and the `core-manifest.json` at that directory's root.
 *
 * This is the invariant ADR 0036 D18 leaves standing. A Core tarball
 * self-identifies — that is why a beta's bytes cannot be promoted to a release
 * by renaming them — and the value of a self-identifying artifact is exactly
 * zero if the three statements can disagree. Both consumers rely on them
 * agreeing: `install.sh` extracts and then looks for `bin/actana` under
 * `actana-core-$VERSION-$TARGET`, refusing the download if it is not there
 * (ADR 0016 D29), and `runActanaSetup` installs into `versions/<version>` off
 * the manifest and refuses a tree whose platform disagrees with the machine.
 * Split those two apart and an operator who downloaded a beta could end up
 * with a machine reporting a release version, which is the one outcome
 * ADR 0036 D20 rules out.
 *
 * Returns the `{ version, target }` all three agree on.
 */
export function assertTarballSurfaces({ assetName, rootDirName, manifest }) {
  const parsed = parseTarballName(assetName);
  if (!parsed) throw new Error(`not a Core tarball asset name: ${assetName}`);

  const expectedRoot = tarballRootDirName(parsed.version, parsed.target);
  if (rootDirName !== expectedRoot) {
    throw new Error(
      `${assetName} extracts to ${rootDirName}, not ${expectedRoot} — the asset name and the ` +
        `archive root disagree`,
    );
  }
  if (manifest.version !== parsed.version) {
    throw new Error(
      `${assetName} carries a manifest for ${manifest.version} — the asset name and the ` +
        `manifest disagree about the version`,
    );
  }
  if (manifest.target !== parsed.target) {
    throw new Error(
      `${assetName} carries a manifest for ${manifest.target} — the asset name and the ` +
        `manifest disagree about the target`,
    );
  }
  return parsed;
}

/**
 * Plan the `node_modules` tree the tarball ships, walking the runtime
 * dependency closure of `roots`.
 *
 * `resolvePackage(name, fromDir)` returns `{ dir, packageJson }` for an
 * installed package, resolved as `fromDir`'s own code would resolve it
 * (`undefined` for the roots). Under pnpm's strict layout a transitive
 * dependency like `bindings` is only visible from the package that declares
 * it, so the walk has to carry that context. It follows `dependencies` only —
 * dev and optional deps never ship.
 *
 * The output is the classic hoisted npm layout: everything goes to the top
 * `node_modules/<name>` unless that name is already taken by a different
 * version, in which case it nests under the package that requires it.
 * Flattening outright is not an option — the closure genuinely contains two
 * majors of tslib (via selfsigned), and a flat tree can only carry one.
 *
 * Returns an array of `{ name, version, sourceDir, installPath }` where
 * `installPath` is relative to the directory holding the top `node_modules`.
 */
export function planDependencyLayout(roots, resolvePackage) {
  const planned = [];
  const topLevel = new Map();

  const visit = (name, fromDir, parentPath, ancestors) => {
    if (DEPENDENCY_EXCLUSIONS.includes(name)) return;

    const resolved = resolvePackage(name, fromDir);
    if (!resolved) {
      throw new Error(
        `runtime dependency not installed: ${name}${fromDir ? ` (required by ${fromDir})` : ""}`,
      );
    }

    const version = resolved.packageJson.version;
    // Already resolvable at this version — Node's lookup walks up from the
    // dependent and will find the top-level copy or an enclosing one.
    if (topLevel.get(name) === version || ancestors.get(name) === version) return;

    let installPath;
    if (!topLevel.has(name)) {
      installPath = path.posix.join("node_modules", name);
      topLevel.set(name, version);
    } else {
      installPath = path.posix.join(parentPath, "node_modules", name);
    }
    planned.push({ name, version, sourceDir: resolved.dir, installPath });

    const nextAncestors = new Map(ancestors).set(name, version);
    for (const dependency of Object.keys(resolved.packageJson.dependencies ?? {})) {
      visit(dependency, resolved.dir, installPath, nextAncestors);
    }
  };

  for (const root of roots) visit(root, undefined, "", new Map());

  return planned;
}
