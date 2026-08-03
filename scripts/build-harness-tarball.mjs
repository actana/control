#!/usr/bin/env node
// Build the Harness release tarball for this machine's platform.
//
// Produces `actana-harness-<version>-<target>.tar.gz` containing:
//
//   bin/actana              launcher — execs the bundled Node on the actana CLI
//   node/bin/node           pinned Node runtime (downloaded from nodejs.org,
//                           SHA-256 verified against that release's SHASUMS256.txt)
//   app/actana-cli.cjs      the `actana` CLI (setup, status, token, daemon, …)
//   app/harness-entry.cjs   the esbuild-bundled Harness daemon
//   app/node_modules/       the runtime dependency closure, natives included
//   harness-manifest.json   version + core-link protocol version + target
//
// An extracted tarball needs nothing from the host: no system Node, no
// `npm install`, no network. `scripts/smoke-harness-tarball.mjs` is what
// proves that claim.
//
// Native modules are copied from THIS host's install, never cross-compiled —
// so the build refuses to produce a target its host cannot honestly build.
// CI runs one real-architecture runner per target.
//
// Usage:
//   node scripts/build-harness-tarball.mjs [--out-dir <dir>] [--version <v>]
//                                          [--target <t>] [--node-version <v>]
//                                          [--cache-dir <dir>]
//
// --out-dir      Where the tarball lands (default: artifacts/harness).
// --version      Release version, bare semver (default: root package.json).
// --target       Sanity check — must match the host's own target.
// --node-version Node runtime to bundle (default: BUNDLED_NODE_VERSION).
// --cache-dir    Where downloaded Node tarballs are kept (default: .cache/node-dist).
//
// Writes the tarball path and its SHA-256 to stdout on success; exits non-zero
// with a `[harness-tarball]` message on any failure.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { makeFail, parseArgs, stringFlag } from "./lib/cli.mjs";
import { digestFile } from "./lib/hash.mjs";
import {
  BUNDLED_NODE_VERSION,
  DEPENDENCY_PRUNE_PATHS,
  HARNESS_RUNTIME_DEPENDENCIES,
  LAUNCHER_SCRIPT,
  buildManifest,
  findTarget,
  hostTarget,
  nodeDistDirName,
  nodeDistShasumsUrl,
  nodeDistTarballUrl,
  parseCoreLinkProtocolVersion,
  parseShasums,
  planDependencyLayout,
  prebuildDirName,
  tarballName,
  tarballRootDirName,
} from "./lib/harness-tarball.mjs";

const fail = makeFail("harness-tarball");
const log = (message) => console.log(`[harness-tarball] ${message}`);

const repoRoot = path.resolve(import.meta.dirname, "..");

/** Run a command, failing the build with its output when it exits non-zero. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited ${result.status}`);
}

/**
 * Find an installed package directory the way Node's resolver would, by
 * walking `node_modules` directories upward from `fromDir`.
 *
 * Done by hand rather than through `require.resolve(name + "/package.json")`
 * because a package with an `exports` map that omits `./package.json`
 * (reflect-metadata, among others) refuses that subpath — and the manifest is
 * exactly what the dependency walk needs to read.
 *
 * Returns the real path: pnpm links `node_modules/<name>` into a content
 * store, and only the store copy has the package's own dependencies beside it.
 */
function resolvePackageDir(name, fromDir) {
  let dir = path.resolve(fromDir);
  for (;;) {
    if (path.basename(dir) !== "node_modules") {
      const candidate = path.join(dir, "node_modules", name, "package.json");
      if (fs.existsSync(candidate)) {
        return {
          dir: fs.realpathSync(path.dirname(candidate)),
          packageJson: JSON.parse(fs.readFileSync(candidate, "utf8")),
        };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function downloadNodeRuntime(nodeVersion, descriptor, cacheDir) {
  const dirName = nodeDistDirName(nodeVersion, descriptor.nodeDistId);
  const archiveName = `${dirName}.tar.gz`;
  const archivePath = path.join(cacheDir, archiveName);

  fs.mkdirSync(cacheDir, { recursive: true });

  // Node.org's SHASUMS256.txt is the integrity check for the runtime we
  // bundle. Fetched every time (it is a few KB) so a poisoned cache entry
  // cannot survive a rebuild.
  const shasumsResponse = await fetch(nodeDistShasumsUrl(nodeVersion));
  if (!shasumsResponse.ok) {
    fail(`could not fetch Node SHASUMS256.txt: HTTP ${shasumsResponse.status}`);
  }
  const shasums = parseShasums(await shasumsResponse.text());
  const expected = shasums.get(archiveName);
  if (!expected) fail(`Node ${nodeVersion} publishes no ${archiveName}`);

  if (fs.existsSync(archivePath) && (await digestFile(archivePath, "sha256")) === expected) {
    log(`node runtime cache hit: ${archivePath}`);
  } else {
    log(`downloading ${nodeDistTarballUrl(nodeVersion, descriptor.nodeDistId)}`);
    const response = await fetch(nodeDistTarballUrl(nodeVersion, descriptor.nodeDistId));
    if (!response.ok) fail(`could not fetch Node runtime: HTTP ${response.status}`);
    fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));

    const actual = await digestFile(archivePath, "sha256");
    if (actual !== expected) {
      fs.rmSync(archivePath, { force: true });
      fail(`Node runtime checksum mismatch: expected ${expected}, got ${actual}`);
    }
    log(`node runtime verified against SHASUMS256.txt`);
  }

  const extractDir = path.join(cacheDir, dirName);
  if (!fs.existsSync(path.join(extractDir, "bin", "node"))) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    run("tar", ["-xzf", archivePath, "-C", cacheDir]);
  }
  return extractDir;
}

/**
 * Copy an installed package into the staged `app/node_modules`, dropping build
 * inputs and every node-pty prebuild except the target's.
 *
 * Nested `node_modules` are skipped: `planDependencyLayout` decides where every
 * package goes, and following pnpm's symlinks here would copy whole closures
 * over again under each dependent.
 */
function copyDependency(name, sourceDir, destDir, descriptor) {
  const keepPrebuild = path.join("prebuilds", prebuildDirName(descriptor));

  fs.cpSync(sourceDir, destDir, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const rel = path.relative(sourceDir, src);
      if (rel === "") return true;
      const segments = rel.split(path.sep);
      if (segments.includes("node_modules")) return false;
      if (DEPENDENCY_PRUNE_PATHS.some((p) => rel === p || rel.startsWith(`${p}${path.sep}`))) {
        return false;
      }
      // Keep `prebuilds/` itself and the one directory under it.
      if (segments[0] === "prebuilds" && segments.length > 1) {
        return rel === keepPrebuild || rel.startsWith(`${keepPrebuild}${path.sep}`);
      }
      return true;
    },
  });

  assertEntryPointSurvivedPrune(name, destDir);
  log(`bundled ${name}`);
}

/**
 * Fail if pruning removed the file a package's `main` points at.
 *
 * The prune list drops `src/` and `deps/` from every package, which is right
 * for today's closure but would silently gut a future dependency whose `main`
 * is `src/index.js` — and only the smoked target would notice. Checking here
 * makes it a build error on every target instead.
 */
function assertEntryPointSurvivedPrune(name, destDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(destDir, "package.json"), "utf8"));
  if (typeof manifest.main !== "string" || manifest.main === "") return;

  const candidates = [
    manifest.main,
    `${manifest.main}.js`,
    path.join(manifest.main, "index.js"),
  ];
  if (!candidates.some((candidate) => fs.existsSync(path.join(destDir, candidate)))) {
    fail(`${name}: pruning removed its main entry (${manifest.main}) — adjust DEPENDENCY_PRUNE_PATHS`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._.length > 0) fail(`unexpected argument: ${args._[0]}`);

  const descriptor = hostTarget(process.platform, process.arch);
  if (!descriptor) {
    fail(`no Harness target for this host (${process.platform}/${process.arch})`);
  }
  const requestedTarget = stringFlag(args, "target", fail);
  if (requestedTarget && requestedTarget !== descriptor.target) {
    // Native modules come from this host's install; there is no honest way to
    // produce another target's tarball here.
    if (!findTarget(requestedTarget)) fail(`unknown --target: ${requestedTarget}`);
    fail(`--target ${requestedTarget} cannot be built on a ${descriptor.target} host`);
  }

  const rootPackageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const version = (stringFlag(args, "version", fail) ?? rootPackageJson.version).replace(/^v/, "");
  const nodeVersion = stringFlag(args, "node-version", fail, BUNDLED_NODE_VERSION);
  const outDir = path.resolve(
    stringFlag(args, "out-dir", fail, path.join(repoRoot, "artifacts", "harness")),
  );
  const cacheDir = path.resolve(
    stringFlag(args, "cache-dir", fail, path.join(repoRoot, ".cache", "node-dist")),
  );

  const harnessDist = path.join(repoRoot, "packages", "harness", "dist");
  for (const required of ["harness-entry.cjs", "actana-cli.cjs"]) {
    if (fs.existsSync(path.join(harnessDist, required))) continue;
    fail(
      `no ${required} at ${harnessDist} — run \`pnpm --filter @actana/harness build\` first`,
    );
  }

  const protocolVersion = parseCoreLinkProtocolVersion(
    fs.readFileSync(path.join(repoRoot, "packages", "shared", "src", "core-link-frames.ts"), "utf8"),
  );

  log(`target=${descriptor.target} version=${version} node=${nodeVersion} protocol=${protocolVersion}`);

  const nodeDir = await downloadNodeRuntime(nodeVersion, descriptor, cacheDir);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-harness-pack-"));
  const rootName = tarballRootDirName(version, descriptor.target);
  const stageDir = path.join(workDir, rootName);
  try {
    fs.mkdirSync(path.join(stageDir, "node", "bin"), { recursive: true });
    fs.mkdirSync(path.join(stageDir, "app"), { recursive: true });
    fs.mkdirSync(path.join(stageDir, "bin"), { recursive: true });

    // Just the interpreter and its licence — npm, corepack, headers and man
    // pages are the bulk of a Node distribution and nothing here uses them.
    fs.cpSync(path.join(nodeDir, "bin", "node"), path.join(stageDir, "node", "bin", "node"), {
      dereference: true,
    });
    fs.cpSync(path.join(nodeDir, "LICENSE"), path.join(stageDir, "node", "LICENSE"));

    for (const entry of fs.readdirSync(harnessDist)) {
      fs.cpSync(path.join(harnessDist, entry), path.join(stageDir, "app", entry), {
        recursive: true,
        dereference: true,
      });
    }
    fs.writeFileSync(
      path.join(stageDir, "app", "package.json"),
      JSON.stringify({ name: "actana-harness-app", version, private: true, type: "commonjs" }, null, 2) + "\n",
    );

    const harnessDir = path.join(repoRoot, "packages", "harness");
    const layout = planDependencyLayout(HARNESS_RUNTIME_DEPENDENCIES, (name, fromDir) =>
      // Roots resolve as the Harness resolves them; transitive deps resolve
      // from their dependent, which is the only place pnpm exposes them.
      resolvePackageDir(name, fromDir ?? harnessDir),
    );
    for (const { name, sourceDir, installPath } of layout) {
      copyDependency(name, sourceDir, path.join(stageDir, "app", installPath), descriptor);
    }
    log(`bundled ${layout.length} runtime package(s)`);

    fs.writeFileSync(
      path.join(stageDir, "harness-manifest.json"),
      JSON.stringify(
        buildManifest({ version, protocolVersion, target: descriptor.target, nodeVersion }),
        null,
        2,
      ) + "\n",
    );

    const launcherPath = path.join(stageDir, "bin", "actana");
    fs.writeFileSync(launcherPath, LAUNCHER_SCRIPT);
    fs.chmodSync(launcherPath, 0o755);

    fs.mkdirSync(outDir, { recursive: true });
    const tarballPath = path.join(outDir, tarballName(version, descriptor.target));
    fs.rmSync(tarballPath, { force: true });
    run("tar", ["-czf", tarballPath, "-C", workDir, rootName], {
      // BSD tar on macOS otherwise writes `._` AppleDouble members for every
      // file carrying extended attributes.
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });

    const digest = await digestFile(tarballPath, "sha256");
    const sizeMb = (fs.statSync(tarballPath).size / 1024 / 1024).toFixed(1);
    log(`wrote ${tarballPath} (${sizeMb} MB)`);
    log(`sha256 ${digest}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

void main().catch((err) => {
  fail(err.stack || err.message);
});
