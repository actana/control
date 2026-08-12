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
 *   4. `releaseTargetFor` in `packages/core/src/actana-release.ts` — `actana
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
 * Tarball basename for a release. `version` is the bare semver (no `v` prefix)
 * so the name matches what `actana --version` reports.
 */
export function tarballName(version, target) {
  return `actana-core-${version}-${target}.tar.gz`;
}

/** Top-level directory inside a tarball — extraction never litters the CWD. */
export function tarballRootDirName(version, target) {
  return `actana-core-${version}-${target}`;
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
