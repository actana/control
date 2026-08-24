#!/usr/bin/env node
// Serve a directory of Core tarballs as if it were GitHub Releases.
//
// This is the hermetic stand-in the installer tests run against, exposed as a
// command so a person can use it too: point it at `artifacts/core`, and the
// real one-liner installs a locally built Core with no release published and
// no network involved.
//
//   node scripts/build-core-tarball.mjs
//   node scripts/fixture-release-server.mjs --dir artifacts/core --port 8788
//   curl -fsSL http://localhost:8788/install.sh | bash -s -- --base-url http://localhost:8788
//
// Usage:
//   node scripts/fixture-release-server.mjs --dir <dir> [--port <n>]
//                                           [--host <addr>] [--repo <slug>]
//                                           [--corrupt <asset>]
//
// --dir      Directory of `actana-core-<version>-<target>.tar.gz` files.
//            Versions come from the file names; the newest non-prerelease is
//            `latest`, and a `x.y.z-beta` name is served on its own tag —
//            which is what a beta line's installer asks for (ADR 0036 D2).
// --port     Port to listen on (default 8788; 0 picks a free one).
// --host     Address to bind (default 127.0.0.1; use 0.0.0.0 to serve a VM).
// --repo     Repository slug the paths are shaped for.
// --corrupt  Serve these assets (comma-separated) with a flipped byte, so
//            their checksums fail — for rehearsing a tampered download.

import * as fs from "node:fs";
import * as path from "node:path";

import { makeFail, parseArgs, stringFlag } from "./lib/cli.mjs";
import {
  DEFAULT_REPO,
  indexReleases,
  isPrerelease,
  latestRelease,
  startFixtureReleaseServer,
} from "./lib/fixture-release.mjs";
import { rehearsalSetupCommand } from "./lib/rehearsal.mjs";

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
    log(`warning: no Core tarballs in ${dir} — every release request will 404`);
  }
  for (const release of releases) {
    // Prereleases are called out because `/releases/latest` skips them, the way
    // GitHub's does — so a directory whose newest tarball is a beta still
    // answers `latest` with the release under it, and the line that says so is
    // cheaper than working out why the installer chose the other one.
    const kind = isPrerelease(release.version) ? "prerelease" : "release";
    log(`${kind} v${release.version}: ${[...release.assets.keys()].sort().join(", ")}`);
  }
  const latest = latestRelease(releases);
  log(latest ? `latest: v${latest.version}` : "latest: nothing — every version here is a prerelease");
  for (const asset of corruptAssets) {
    log(`serving ${asset} corrupted — its checksum will not verify`);
  }
  log(`listening on ${server.url} (${server.repo})`);
  // Two lines, because the one-liner installs and does not activate since #316
  // (ADR 0036 C2). A hint that named only the first would leave a developer at
  // an installed, inactive machine with nothing to run next — which is exactly
  // the state the second command exists for.
  log(`install:   curl -fsSL ${server.url}/install.sh | bash -s -- --base-url ${server.url}`);
  log(`then:      ${rehearsalSetupCommand()}   (or the exact line the install printed)`);
}

void main().catch((err) => {
  fail(err.stack || err.message);
});
