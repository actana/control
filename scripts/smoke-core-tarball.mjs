#!/usr/bin/env node
// Smoke test — a released Core tarball is self-sufficient.
//
// Extracts the tarball into a temp dir and runs `bin/actana daemon` — the
// launcher, the bundled CLI, and the verb the systemd unit execs — with every
// Node scrubbed from PATH, then makes the shared boot-and-dial assertion
// (see scripts/lib/core-smoke.mjs).
//
// It also checks the thing a Core tarball is that a container image is not:
// self-identifying. The asset name, the directory the archive extracts to and
// the `core-manifest.json` at its root each state the version and the target,
// the two consumers read different ones, and this is where they are proven to
// be the same string on real bytes rather than in the builder's own variables
// (ADR 0036 D18, D20). A beta is where it matters most — `0.4.1-beta` on all
// three surfaces is what stops a beta install reporting `0.4.1`.
//
// This is the acceptance criterion of the per-platform tarball work stated as
// a test: "extracting a tarball on its target platform and running the
// launcher boots a dialable Core with no system Node." If a future change
// forgets a native module, prunes something load-bearing, or bundles a Node
// whose ABI disagrees with the prebuilds, this fails here rather than on an
// operator's fresh VM.
//
// The criterion's "no network fetches" half is not enforced here — sandboxing
// egress portably across both targets is more machinery than it is worth,
// and the build is what guarantees it: everything the Core loads is copied
// into the tarball, and nothing in the boot path fetches.
//
// Usage:
//   node scripts/smoke-core-tarball.mjs --tarball <file> [--timeout <ms>]
//
// --tarball <file>  The .tar.gz produced by scripts/build-core-tarball.mjs.
// --timeout <ms>    Boot-marker wait (default: 60000 — cold extraction on a
//                   CI runner is slower than booting an already-built bundle).
//
// Exit codes: 0 on pass, non-zero on any failure. On failure the tail of the
// launcher's stdout/stderr is printed so triage doesn't need a rerun.

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseArgs, stringFlag } from "./lib/cli.mjs";
import { assertTarballSurfaces } from "./lib/core-tarball.mjs";
import {
  assertBootsAndDials,
  assertRefusesUnsafeEnv,
  coreSmokeEnv,
  makeDie,
  pickFreePort,
} from "./lib/core-smoke.mjs";

const die = makeDie("tarball-smoke");
const log = (message) => console.log(`[tarball-smoke] ${message}`);

/**
 * PATH with every directory containing a `node` executable removed.
 *
 * "No system Node" is the claim under test, and the only way to test it is to
 * make sure a system Node could not have been used even by accident.
 */
function pathWithoutNode(rawPath) {
  const dirs = (rawPath ?? "").split(path.delimiter).filter(Boolean);
  return dirs
    .filter((dir) => {
      try {
        return !fs.existsSync(path.join(dir, "node"));
      } catch {
        return true;
      }
    })
    .join(path.delimiter);
}

/** Extract the tarball and return its single top-level directory. */
function extractTarball(tarball, extractDir) {
  const extract = spawnSync("tar", ["-xzf", tarball, "-C", extractDir], { stdio: "inherit" });
  if (extract.status !== 0) die(`tar -xzf ${tarball} exited ${extract.status}`);

  // One top-level directory per tarball, by construction.
  const entries = fs.readdirSync(extractDir);
  if (entries.length !== 1) {
    die(`expected one top-level directory in the tarball, found: ${entries.join(", ")}`);
  }
  return path.join(extractDir, entries[0]);
}

/** Read and sanity-check the manifest the tarball embeds at its root. */
function readManifest(installRoot) {
  const manifestPath = path.join(installRoot, "core-manifest.json");
  if (!fs.existsSync(manifestPath)) die("tarball has no core-manifest.json at its root");

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const field of ["version", "protocolVersion", "target", "nodeVersion"]) {
    if (typeof manifest[field] !== "string" || manifest[field] === "") {
      die(`core-manifest.json is missing ${field}`);
    }
  }
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
    die(
      `tarball targets ${manifest.platform}/${manifest.arch}, this host is ` +
        `${process.platform}/${process.arch}`,
    );
  }
  return manifest;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._.length > 0) die(`unexpected argument: ${args._[0]}`);

  const timeoutMs = Number(stringFlag(args, "timeout", die, "60000"));
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) die(`bad --timeout: ${args.timeout}`);

  const tarballFlag = stringFlag(args, "tarball", die);
  if (!tarballFlag) die("--tarball <file> is required");
  const tarball = path.resolve(tarballFlag);
  if (!fs.existsSync(tarball)) die(`no tarball at ${tarball}`);

  const port = await pickFreePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "actana-core-smoke-"));
  const extractDir = path.join(tmpRoot, "extract");
  const tmpHome = path.join(tmpRoot, "home");
  const tmpUserData = path.join(tmpHome, ".actana-control", "data");
  fs.mkdirSync(extractDir, { recursive: true });
  fs.mkdirSync(tmpUserData, { recursive: true });

  const removeTmp = () => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  process.on("exit", removeTmp);

  const installRoot = extractTarball(tarball, extractDir);
  const manifest = readManifest(installRoot);

  // `install.sh` finds the extracted tree by rebuilding its name from the
  // version and target it downloaded, and `actana setup` installs into
  // `versions/<manifest.version>`. The two consumers therefore agree only for
  // as long as the three surfaces do.
  let surfaces;
  try {
    surfaces = assertTarballSurfaces({
      assetName: path.basename(tarball),
      rootDirName: path.basename(installRoot),
      manifest,
    });
  } catch (err) {
    die(err.message);
  }

  const launcher = path.join(installRoot, "bin", "actana");
  if (!fs.existsSync(launcher)) die("tarball has no bin/actana launcher");
  if (!(fs.statSync(launcher).mode & 0o111)) {
    die("bin/actana is not executable — the tarball lost its permission bits");
  }

  const scrubbedPath = pathWithoutNode(process.env.PATH);

  log(`tarball=${tarball}`);
  log(`asset name, archive root and manifest agree: ${surfaces.version} ${surfaces.target}`);
  log(
    `manifest version=${manifest.version} protocol=${manifest.protocolVersion} ` +
      `target=${manifest.target} node=${manifest.nodeVersion}`,
  );
  log(`launcher=${launcher}`);
  log(`PATH (node scrubbed)=${scrubbedPath || "(empty)"}`);
  log(`port=${port}`);

  // AC_APP_PATH is left unset on purpose: the launcher must derive it from its
  // own location, the way it will on an operator's machine.
  const env = coreSmokeEnv({
    home: tmpHome,
    userDataDir: tmpUserData,
    port,
    extra: { PATH: scrubbedPath },
  });
  delete env.AC_APP_PATH;

  let child;
  try {
    // `daemon` is the verb the systemd unit execs — the boot path under test.
    child = spawn(launcher, ["daemon"], { env, stdio: ["ignore", "pipe", "pipe"], detached: false });
  } catch (err) {
    die(`spawn(${launcher}) failed: ${err.message}`);
  }

  const cleanup = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already dead */
    }
    removeTmp();
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  await assertBootsAndDials(child, { home: tmpHome, port, timeoutMs, die, log });

  // The same launcher, the same tree, two environments it must refuse (#348).
  // Run after the good boot and on the same port, so "nothing is listening" is
  // a statement about this refusal rather than about a port that was never
  // used — the daemon above is stopped first for exactly that reason.
  child.kill("SIGTERM");
  await new Promise((resolve) => child.on("exit", resolve));
  await assertRefusesUnsafeEnv({
    launcher,
    argv: ["daemon"],
    env,
    port,
    timeoutMs,
    die,
    log,
  });

  log("OK — extracted tarball boots a dialable Core with no system Node");
  cleanup();
  process.exit(0);
}

void main().catch((err) => {
  console.error(`[tarball-smoke] unexpected error: ${err.stack || err.message}`);
  process.exit(1);
});
