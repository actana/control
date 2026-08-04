#!/usr/bin/env node
// End-to-end test — the real `curl … | bash` one-liner on a fresh machine.
//
// Issue 03's acceptance criteria, run as an operator would run them: a
// privileged systemd container with no sudo on it, a fixture server standing
// in for GitHub Releases, and the actual `install.sh` piped into bash.
//
//   • the one-liner ends with a running Core and a printed pairing token
//     that a test client can dial the core-link with;
//   • a wrong checksum and an unknown platform abort before anything from the
//     download runs, and leave the machine untouched;
//   • `--version` installs that exact release; with no flag, the latest;
//   • the piped (non-TTY) run prompts for nothing — no `--yes` is passed, and
//     the install still completes unattended;
//   • re-running the one-liner on an installed machine upgrades it in place:
//     one unit, the same pairing credentials, the newer version running.
//
// Two releases are needed to tell "pinned" from "latest" apart, and only one
// tarball is ever built — so the newer one is the same bytes repacked with a
// bumped manifest version. It is a real Core either way; what differs is
// the version the installer has to resolve and the directory setup installs
// it into.
//
// Usage:
//   node scripts/e2e-install-sh-linux.mjs --tarball <file> [--distro <id>] [--keep]
//
// --tarball <file>  A linux-* tarball from scripts/build-core-tarball.mjs.
//                   Must match the Docker daemon's architecture.
// --distro <id>     Which distribution to install on (scripts/lib/container-matrix.mjs).
//                   Defaults to ubuntu; CI runs every one of them.
// --keep            Leave the container running for poking at after a failure.
//
// Requires a working Docker that can run a privileged container.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseArgs, stringFlag } from "./lib/cli.mjs";
import { distroDockerfile, distroFlag, imageTag } from "./lib/container-matrix.mjs";
import {
  bumpPatch,
  parseAssetName,
  repackWithVersion,
  startFixtureServerProcess,
} from "./lib/fixture-release.mjs";
import { dialAndListProjects, extractToken, makeDie } from "./lib/core-smoke.mjs";
import { tarballName } from "./lib/core-tarball.mjs";
import { pickHostPort, startSystemdContainer, waitForPort } from "./lib/systemd-container.mjs";

const die = makeDie("install-sh-e2e");
const log = (message) => console.log(`[install-sh-e2e] ${message}`);

const CONTAINER_PORT = 8443;

/** How the container reaches a server on the host. */
const HOST_ALIAS = "host.docker.internal";

/** Where the install dir would appear — the "nothing was installed" assertion. */
const INSTALL_ROOT = "~/.local/share/actana";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._.length > 0) die(`unexpected argument: ${args._[0]}`);

  const distro = distroFlag(args, die);
  const tarballFlag = stringFlag(args, "tarball", die);
  if (!tarballFlag) die("--tarball <file> is required");
  const tarball = path.resolve(tarballFlag);
  if (!fs.existsSync(tarball)) die(`no tarball at ${tarball}`);
  const parsed = parseAssetName(path.basename(tarball));
  if (!parsed) die(`${path.basename(tarball)} is not a Core release tarball`);
  if (!parsed.target.startsWith("linux-")) {
    die(`${parsed.target} is not a linux target — this test runs Linux containers`);
  }

  const repoRoot = path.resolve(import.meta.dirname, "..");
  const installSh = path.join(repoRoot, "install.sh");
  if (!fs.existsSync(installSh)) die(`no install.sh at ${installSh}`);

  // ─── the fixture release channel ───
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-install-e2e-"));
  process.on("exit", () => fs.rmSync(workDir, { recursive: true, force: true }));
  const releaseDir = path.join(workDir, "releases");
  fs.mkdirSync(releaseDir, { recursive: true });

  const pinnedVersion = parsed.version;
  fs.copyFileSync(tarball, path.join(releaseDir, path.basename(tarball)));
  const latestVersion = bumpPatch(pinnedVersion);
  repackWithVersion(path.join(releaseDir, path.basename(tarball)), latestVersion, workDir, die);
  log(`serving releases v${pinnedVersion} (pinned) and v${latestVersion} (latest)`);

  // Two views of the same releases: one honest, one that corrupts every
  // tarball it serves. Same assets, so the only difference the installer can
  // see is the one the checksum is there to catch.
  const server = await startFixtureServerProcess({
    dir: releaseDir,
    port: await pickHostPort(),
    die,
  });
  const tamperedServer = await startFixtureServerProcess({
    dir: releaseDir,
    port: await pickHostPort(),
    corrupt: [tarballName(pinnedVersion, parsed.target), tarballName(latestVersion, parsed.target)],
    die,
  });
  const baseUrl = `http://${HOST_ALIAS}:${server.port}`;
  const tamperedUrl = `http://${HOST_ALIAS}:${tamperedServer.port}`;

  log(`installing on ${distro.label}`);
  const hostPort = await pickHostPort();
  const machine = await startSystemdContainer({
    tag: imageTag("install-sh", distro.id),
    name: `actana-install-e2e-${distro.id}-${process.pid}`,
    containerPort: CONTAINER_PORT,
    hostPort,
    // curl is the first word of the one-liner; without it the test would be
    // measuring the image, not the installer.
    dockerfile: distroDockerfile(distro.id, { packages: ["curl", "ca-certificates"], fail: die }),
    extraRunArgs: ["--add-host", `${HOST_ALIAS}:host-gateway`],
    keep: args.keep === true,
    die,
    log,
  });
  const { asOperator, mustAsOperator } = machine;

  /** The one-liner, exactly as the docs print it. */
  const oneLiner = (url, flags) => `curl -fsSL ${url}/install.sh | bash -s -- --base-url ${url} ${flags}`;

  const nothingInstalled = (context) => {
    const traces = asOperator(
      `ls -d ${INSTALL_ROOT} 2>/dev/null; ls ~/.config/systemd/user/*.service 2>/dev/null; true`,
    );
    if (traces.stdout.trim() !== "") {
      die(`${context} left something behind: ${traces.stdout.trim()}`);
    }
  };

  // ─── an unknown platform aborts before downloading anything ───
  log("running the one-liner on a machine the release has no build for");
  mustAsOperator(
    `mkdir -p ~/fakebin && printf '#!/bin/sh\\ncase "$1" in -s) echo Linux ;; -m) echo i686 ;; esac\\n' > ~/fakebin/uname && chmod +x ~/fakebin/uname`,
  );
  // `export`, not a `PATH=… cmd` prefix: the prefix form would apply to curl
  // alone and leave the shim invisible to the script on the other side of the
  // pipe — which looks like a passing test right up until it silently is not.
  const unknownPlatform = asOperator(
    `export PATH=~/fakebin:$PATH\n${oneLiner(baseUrl, "--public-host 127.0.0.1")}`,
  );
  if (unknownPlatform.status === 0) {
    die("the one-liner succeeded on an unsupported architecture", unknownPlatform.stdout.split("\n"));
  }
  if (!/i686/.test(unknownPlatform.stdout) || !/unsupported architecture/i.test(unknownPlatform.stdout)) {
    die("the unknown-platform abort did not say what was wrong", unknownPlatform.stdout.split("\n"));
  }
  nothingInstalled("the unknown-platform run");
  mustAsOperator("rm -rf ~/fakebin");
  log("unsupported architecture: aborted with an actionable message, machine untouched");

  // ─── a bad checksum aborts before running anything ───
  log("running the one-liner against a server that serves a tampered tarball");
  const tampered = asOperator(oneLiner(tamperedUrl, "--public-host 127.0.0.1"));
  if (tampered.status === 0) {
    die("the one-liner installed a tarball whose checksum did not match", tampered.stdout.split("\n"));
  }
  if (!/checksum mismatch/i.test(tampered.stdout)) {
    die("the checksum abort did not say the checksum failed", tampered.stdout.split("\n"));
  }
  nothingInstalled("the tampered-download run");
  log("tampered download: refused, machine untouched");

  // ─── the real thing, pinned, with no flag that suppresses prompts ───
  log(`running the one-liner pinned to v${pinnedVersion}`);
  const install = mustAsOperator(
    oneLiner(baseUrl, `--version ${pinnedVersion} --public-host 127.0.0.1`),
  );
  const { blob } = extractToken(install.stdout, "the one-liner", die);
  if (!/pairing token/i.test(install.stdout)) {
    die("the install never used the words 'pairing token'", install.stdout.split("\n"));
  }
  // Nothing asked the operator anything: no `--yes` was passed, and the run
  // still finished. A prompt would have hung until the session timed out.
  if (/\[Y\/n\]|\(y\/n\)/i.test(install.stdout)) {
    die("a piped install prompted for input", install.stdout.split("\n"));
  }
  log("the one-liner installed unattended and printed a pairing token");

  const active = mustAsOperator("systemctl --user is-active actana-core.service");
  if (active.stdout.trim() !== "active") {
    die(`unit is ${active.stdout.trim()}, expected active`, install.stdout.split("\n"));
  }

  const status = mustAsOperator("actana status");
  if (!status.stdout.includes(pinnedVersion)) {
    die(`--version ${pinnedVersion} did not install that version`, status.stdout.split("\n"));
  }
  log(`the pinned version ${pinnedVersion} is what is installed and running`);

  await waitForPort(hostPort, die);
  let projects;
  try {
    projects = await dialAndListProjects({ ...blob, endpoint: `wss://127.0.0.1:${hostPort}` });
  } catch (err) {
    die(`core-link dial with the pairing token failed: ${err.message}`, install.stdout.split("\n"));
  }
  if (!Array.isArray(projects) || projects.length !== 0) {
    die(`projectsList did not return []: got ${JSON.stringify(projects)}`);
  }
  log("a test client dialled the core-link with the printed pairing token");

  // ─── re-running with no --version upgrades in place ───
  log("re-running the one-liner with no version pinned");
  const upgrade = mustAsOperator(oneLiner(baseUrl, "--public-host 127.0.0.1"));
  const upgraded = extractToken(upgrade.stdout, "the second one-liner", die).blob;
  // The credentials a paired Panel pinned must survive an upgrade; only the
  // bearer's expiry differs between two signings.
  if (upgraded.caCert !== blob.caCert || upgraded.clientCert !== blob.clientCert) {
    die("the upgrade replaced the pairing credentials — a paired Panel would break");
  }

  const afterUpgrade = mustAsOperator("actana status");
  if (!afterUpgrade.stdout.includes(latestVersion)) {
    die(
      `the unpinned re-run did not resolve the latest release (v${latestVersion})`,
      afterUpgrade.stdout.split("\n"),
    );
  }
  const units = mustAsOperator("ls -1 ~/.config/systemd/user/*.service");
  if (units.stdout.trim().split("\n").length !== 1) {
    die("upgrading left more than one unit file", units.stdout.split("\n"));
  }
  await waitForPort(hostPort, die);
  mustAsOperator("actana status");
  log(`upgraded in place to v${latestVersion}: one unit, same credentials, still healthy`);

  server.stop();
  tamperedServer.stop();
  log(
    `OK — on ${distro.label} the one-liner installs, verifies, pins, refuses tampering, and upgrades in place`,
  );
  process.exit(0);
}

void main().catch((err) => {
  console.error(`[install-sh-e2e] unexpected error: ${err.stack || err.message}`);
  process.exit(1);
});
