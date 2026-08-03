#!/usr/bin/env node
// Serve a directory of Harness tarballs as if it were GitHub Releases.
//
// This is the hermetic stand-in the installer tests run against, exposed as a
// command so a person can use it too: point it at `artifacts/harness`, and the
// real one-liner installs a locally built Harness with no release published and
// no network involved.
//
//   node scripts/build-harness-tarball.mjs
//   node scripts/fixture-release-server.mjs --dir artifacts/harness --port 8788
//   curl -fsSL http://localhost:8788/install.sh | bash -s -- --base-url http://localhost:8788
//
// Usage:
//   node scripts/fixture-release-server.mjs --dir <dir> [--port <n>]
//                                           [--host <addr>] [--repo <slug>]
//                                           [--corrupt <asset>]
//
// --dir      Directory of `actana-harness-<version>-<target>.tar.gz` files.
//            Versions come from the file names; the newest is `latest`.
// --port     Port to listen on (default 8788; 0 picks a free one).
// --host     Address to bind (default 127.0.0.1; use 0.0.0.0 to serve a VM).
// --repo     Repository slug the paths are shaped for.
// --corrupt  Serve these assets (comma-separated) with a flipped byte, so
//            their checksums fail — for rehearsing a tampered download.

import * as fs from "node:fs";
import * as path from "node:path";

import { makeFail, parseArgs, stringFlag } from "./lib/cli.mjs";
import { DEFAULT_REPO, indexReleases, startFixtureReleaseServer } from "./lib/fixture-release.mjs";

const fail = makeFail("fixture-release");
const log = (message) => console.log(`[fixture-release] ${message}`);

const repoRoot = path.resolve(import.meta.dirname, "..");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._.length > 0) fail(`unexpected argument: ${args._[0]}`);

  const dirFlag = stringFlag(args, "dir", fail);
  if (!dirFlag) fail("--dir <dir> is required");
  const dir = path.resolve(dirFlag);
  if (!fs.existsSync(dir)) fail(`no such directory: ${dir}`);

  const portFlag = stringFlag(args, "port", fail, "8788");
  const port = Number(portFlag);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`bad --port: ${portFlag}`);

  // `--corrupt a --corrupt b` arrives as the last value only; parseArgs is
  // deliberately simple, so a comma-separated list is how you name several.
  const corruptFlag = stringFlag(args, "corrupt", fail, "");
  const corruptAssets = corruptFlag ? corruptFlag.split(",").map((s) => s.trim()).filter(Boolean) : [];

  const server = await startFixtureReleaseServer({
    dir,
    port,
    host: stringFlag(args, "host", fail, "127.0.0.1"),
    repo: stringFlag(args, "repo", fail, DEFAULT_REPO),
    scriptPath: path.join(repoRoot, "install.sh"),
    corruptAssets,
  });

  const releases = indexReleases(fs.readdirSync(dir));
  if (releases.length === 0) {
    log(`warning: no Harness tarballs in ${dir} — every release request will 404`);
  }
  for (const release of releases) {
    log(`release v${release.version}: ${[...release.assets.keys()].sort().join(", ")}`);
  }
  for (const asset of corruptAssets) {
    log(`serving ${asset} corrupted — its checksum will not verify`);
  }
  log(`listening on ${server.url} (${server.repo})`);
  log(`one-liner: curl -fsSL ${server.url}/install.sh | bash -s -- --base-url ${server.url}`);
}

void main().catch((err) => {
  fail(err.stack || err.message);
});
