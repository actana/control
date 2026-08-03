#!/usr/bin/env node
// End-to-end test — `actana setup` on a fresh systemd machine.
//
// This is issue 02's acceptance criteria run as a test, against the real
// artifact in a real init system rather than a mock of one:
//
//   • extracting the tarball and running `actana setup` leaves an active user
//     unit, a running daemon, and a printed pairing token — with no sudo,
//     which the image guarantees by not containing sudo at all;
//   • the printed token decodes as a Registration blob and a test client
//     dials the core-link with it (the same dial the tarball smoke makes);
//   • `status` / `token` / `start` / `stop` / `restart` / `logs` control and
//     report the daemon;
//   • re-running setup upgrades in place — one unit, same pairing credentials;
//   • lingering is on, and the daemon comes back after the machine reboots.
//
// It also carries issue 06's remaining lifecycle, on the same machine and in
// the order an operator would meet it:
//
//   • `update` lands a newer release from a fixture release channel, restarts
//     the daemon on it, and `status` reports the new version — while a
//     tampered download aborts and leaves the old install running;
//   • `update --version` installs exactly that release (the Panel↔Core
//     version-lock recovery);
//   • after `token regenerate`, a client dialling with the old blob is
//     rejected and the new blob works;
//   • `uninstall` leaves no unit, launcher or install files and keeps the data
//     dir; `--purge-data` removes that too.
//
// The machine itself — a privileged systemd container driven through a real
// logind session — comes from `scripts/lib/systemd-container.mjs`, which
// issue 03's one-liner e2e shares. The release channel is the same fixture
// server that e2e shares too, reached over `host.docker.internal`.
//
// Usage:
//   node scripts/e2e-actana-setup-linux.mjs --tarball <file> [--distro <id>] [--keep]
//
// --tarball <file>  A linux-* tarball from scripts/build-harness-tarball.mjs.
//                   Must match the Docker daemon's architecture.
// --distro <id>     Which distribution to install on (scripts/lib/container-matrix.mjs).
//                   Defaults to ubuntu; CI runs every one of them.
// --keep            Leave the container running for poking at after a failure.
//
// Requires a working Docker (or Podman aliased to `docker`) that can run a
// privileged container — systemd needs cgroup write access.

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
import { dialAndListProjects, extractToken, makeDie } from "./lib/harness-smoke.mjs";
import { tarballName as releaseAssetName } from "./lib/harness-tarball.mjs";
import {
  OPERATOR,
  pickHostPort,
  startSystemdContainer,
  waitForPort,
} from "./lib/systemd-container.mjs";

const die = makeDie("setup-e2e");
const log = (message) => console.log(`[setup-e2e] ${message}`);

const CONTAINER_PORT = 8443;

/** How the container reaches the fixture release server on the host. */
const HOST_ALIAS = "host.docker.internal";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._.length > 0) die(`unexpected argument: ${args._[0]}`);

  const distro = distroFlag(args, die);
  const tarballFlag = stringFlag(args, "tarball", die);
  if (!tarballFlag) die("--tarball <file> is required");
  const tarball = path.resolve(tarballFlag);
  if (!fs.existsSync(tarball)) die(`no tarball at ${tarball}`);
  if (!path.basename(tarball).includes("-linux-")) {
    die(`${path.basename(tarball)} is not a linux tarball — this test runs Linux containers`);
  }

  log(`installing on ${distro.label}`);
  const hostPort = await pickHostPort();
  const machine = await startSystemdContainer({
    tag: imageTag("setup", distro.id),
    name: `actana-e2e-${distro.id}-${process.pid}`,
    containerPort: CONTAINER_PORT,
    hostPort,
    dockerfile: distroDockerfile(distro.id, { fail: die }),
    extraRunArgs: ["--add-host", `${HOST_ALIAS}:host-gateway`],
    keep: args.keep === true,
    die,
    log,
  });
  const { mustAsOperator, asOperator } = machine;

  const tarballName = path.basename(tarball);
  machine.copyToOperator(tarball);
  const extracted = `/home/${OPERATOR}/${path.basename(tarballName, ".tar.gz")}`;

  // ─── setup ───
  log("running `actana setup`");
  const setup = mustAsOperator(
    `cd ~ && tar -xzf ${tarballName} && ${extracted}/bin/actana setup --public-host 127.0.0.1 --yes`,
  );
  const { blob } = extractToken(setup.stdout, "actana setup", die);
  log("setup printed a decodable pairing token");

  if (!/pairing token/i.test(setup.stdout)) {
    die("setup never used the words 'pairing token'", setup.stdout.split("\n"));
  }

  const active = mustAsOperator("systemctl --user is-active actana-harness.service");
  if (active.stdout.trim() !== "active") {
    die(`unit is ${active.stdout.trim()}, expected active`, [setup.stdout]);
  }
  const enabled = mustAsOperator("systemctl --user is-enabled actana-harness.service");
  if (enabled.stdout.trim() !== "enabled") {
    die(`unit is ${enabled.stdout.trim()}, expected enabled`);
  }
  log("user unit is active and enabled");

  // ─── the token actually works ───
  await waitForPort(hostPort, die);
  const dialed = { ...blob, endpoint: `wss://127.0.0.1:${hostPort}` };
  let projects;
  try {
    projects = await dialAndListProjects(dialed);
  } catch (err) {
    die(`core-link dial with the pairing token failed: ${err.message}`, [setup.stdout]);
  }
  if (!Array.isArray(projects) || projects.length !== 0) {
    die(`projectsList did not return []: got ${JSON.stringify(projects)}`);
  }
  log("a test client dialled the core-link with the pairing token");

  // ─── linger ───
  const linger = mustAsOperator(`loginctl show-user ${OPERATOR} --property=Linger`);
  if (!linger.stdout.includes("Linger=yes")) {
    die(`lingering was not enabled: ${linger.stdout.trim()}`, [setup.stdout]);
  }
  log("lingering is enabled — the daemon survives logout");

  // ─── status / token ───
  const status = mustAsOperator("actana status");
  for (const expected of ["healthy", "wss://127.0.0.1:8443", "Linger"]) {
    if (!status.stdout.includes(expected)) {
      die(`actana status is missing ${JSON.stringify(expected)}`, status.stdout.split("\n"));
    }
  }
  log("`actana status` reports a healthy Core");

  const reprint = mustAsOperator("actana token");
  if (extractToken(reprint.stdout, "actana token", die).blob.caCert !== blob.caCert) {
    die("`actana token` reprinted a different Core's material");
  }
  log("`actana token` reprints the same pairing token");

  // ─── start / stop / restart / logs ───
  mustAsOperator("actana stop");
  if (asOperator("actana status").status === 0) {
    die("`actana status` reported healthy while the daemon was stopped");
  }
  mustAsOperator("actana start");
  mustAsOperator("actana restart");
  await waitForPort(hostPort, die);
  mustAsOperator("actana status");
  log("stop / start / restart drive the daemon");

  const logs = mustAsOperator("actana logs -n 50");
  if (!logs.stdout.includes("actana-harness")) {
    die("`actana logs` showed nothing from the daemon's unit", logs.stdout.split("\n"));
  }
  log("`actana logs` shows the daemon's journal");

  // ─── idempotent re-run ───
  log("re-running `actana setup` over the existing install");
  const again = mustAsOperator(`${extracted}/bin/actana setup --public-host 127.0.0.1 --yes`);
  // Not byte equality: the bearer inside carries a fresh expiry every time it
  // is signed. What must not change is the material the Panel pinned — a new
  // CA or client cert means the paired Panel is locked out.
  const reissued = extractToken(again.stdout, "the second actana setup", die).blob;
  if (reissued.caCert !== blob.caCert || reissued.clientCert !== blob.clientCert) {
    die("re-running setup replaced the pairing credentials — a paired Panel would break");
  }
  // One unit file, and one enablement link pointing at it. `default.target.wants`
  // is systemd's own bookkeeping and belongs there; a second unit or a second
  // link would be the duplicate the criterion is about.
  const units = mustAsOperator("ls -1 ~/.config/systemd/user/*.service");
  if (units.stdout.trim().split("\n").length !== 1) {
    die(`re-running setup left more than one unit file`, units.stdout.split("\n"));
  }
  const wants = mustAsOperator("ls -1 ~/.config/systemd/user/default.target.wants");
  if (wants.stdout.trim() !== "actana-harness.service") {
    die(`unexpected enablement links: ${JSON.stringify(wants.stdout.trim())}`);
  }
  await waitForPort(hostPort, die);
  mustAsOperator("actana status");
  log("re-running setup upgraded in place: one unit, same token, still healthy");

  // ─── survives a reboot ───
  log("restarting the machine");
  await machine.reboot();
  await waitForPort(hostPort, die);
  const afterReboot = mustAsOperator("actana status");
  if (!afterReboot.stdout.includes("healthy")) {
    die("the Harness did not come back after a reboot", afterReboot.stdout.split("\n"));
  }
  // The identity must survive too — a Core that reboots into fresh certs is a
  // Core the operator has to re-pair.
  const afterRebootToken = extractToken(
    mustAsOperator("actana token").stdout,
    "actana token after reboot",
    die,
  );
  if (afterRebootToken.blob.caCert !== blob.caCert) {
    die("the Harness came back with different material — the Panel would be locked out");
  }
  log("the Harness came back after reboot with the same identity");

  // ─── update ───
  //
  // Two more releases from the one tarball that was built: the same verified
  // bytes with a bumped manifest version, which is a genuinely different
  // release as far as resolution, install directory and `status` are concerned.
  const parsed = parseAssetName(path.basename(tarball));
  const installedVersion = parsed.version;
  const nextVersion = bumpPatch(installedVersion);
  const latestVersion = bumpPatch(nextVersion);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-update-e2e-"));
  process.on("exit", () => fs.rmSync(workDir, { recursive: true, force: true }));
  const releaseDir = path.join(workDir, "releases");
  fs.mkdirSync(releaseDir, { recursive: true });
  const seed = path.join(releaseDir, path.basename(tarball));
  fs.copyFileSync(tarball, seed);
  repackWithVersion(seed, nextVersion, workDir, die);
  repackWithVersion(seed, latestVersion, workDir, die);
  fs.rmSync(seed);
  log(`serving releases v${nextVersion} and v${latestVersion} (latest)`);

  // Two views of the same releases: one honest, one that corrupts every
  // tarball it serves. Same assets, so the only difference `update` can see is
  // the one the checksum is there to catch.
  const server = await startFixtureServerProcess({
    dir: releaseDir,
    port: await pickHostPort(),
    die,
  });
  const tamperedServer = await startFixtureServerProcess({
    dir: releaseDir,
    port: await pickHostPort(),
    corrupt: [
      releaseAssetName(nextVersion, parsed.target),
      releaseAssetName(latestVersion, parsed.target),
    ],
    die,
  });
  const baseUrl = `http://${HOST_ALIAS}:${server.port}`;
  const tamperedUrl = `http://${HOST_ALIAS}:${tamperedServer.port}`;

  // A tampered download first, so the "leaves the old install untouched"
  // assertion is made against a Core that is still the one setup installed.
  const tampered = asOperator(`actana update --base-url ${tamperedUrl}`);
  if (tampered.status === 0) die("`actana update` accepted a download that failed its checksum");
  if (!/checksum/i.test(tampered.stdout + tampered.stderr)) {
    die("the aborted update never mentioned the checksum", [tampered.stdout, tampered.stderr]);
  }
  await waitForPort(hostPort, die);
  const afterTampered = mustAsOperator("actana status");
  if (!afterTampered.stdout.includes(installedVersion)) {
    die(
      `a failed update changed the running version — expected ${installedVersion} still`,
      afterTampered.stdout.split("\n"),
    );
  }
  const versionsAfterTampered = mustAsOperator("ls -1 ~/.local/share/actana/versions");
  if (versionsAfterTampered.stdout.trim() !== installedVersion) {
    die(
      "a failed update left a new version directory behind",
      versionsAfterTampered.stdout.split("\n"),
    );
  }
  log("a tampered download aborted and left the old install untouched");

  // Pinned, so the version-lock recovery path is what runs: the newest release
  // is v${latestVersion}, and this must install the other one.
  const pinnedUpdate = mustAsOperator(
    `actana update --base-url ${baseUrl} --version ${nextVersion}`,
  );
  if (!pinnedUpdate.stdout.includes(nextVersion)) {
    die("`actana update --version` did not report the pinned version", pinnedUpdate.stdout.split("\n"));
  }
  await waitForPort(hostPort, die);
  const pinnedStatus = mustAsOperator("actana status");
  if (!pinnedStatus.stdout.includes(nextVersion) || !pinnedStatus.stdout.includes("healthy")) {
    die(`status does not report a healthy v${nextVersion}`, pinnedStatus.stdout.split("\n"));
  }
  log(`\`actana update --version ${nextVersion}\` installed exactly that release`);

  // Unpinned: the latest release, and the daemon running on it.
  mustAsOperator(`actana update --base-url ${baseUrl}`);
  await waitForPort(hostPort, die);
  const latestStatus = mustAsOperator("actana status");
  if (!latestStatus.stdout.includes(latestVersion) || !latestStatus.stdout.includes("healthy")) {
    die(`status does not report a healthy v${latestVersion}`, latestStatus.stdout.split("\n"));
  }
  // The material is untouched by an update, so the Panel that was paired is
  // still paired — and the token still dials.
  const afterUpdateToken = extractToken(mustAsOperator("actana token").stdout, "actana token", die);
  if (afterUpdateToken.blob.caCert !== blob.caCert) {
    die("updating replaced the pairing credentials — a paired Panel would break");
  }
  await dialAndListProjects({ ...afterUpdateToken.blob, endpoint: `wss://127.0.0.1:${hostPort}` });
  log("`actana update` landed the latest release, restarted, and stayed paired");

  server.stop();
  tamperedServer.stop();

  // ─── token regenerate ───
  const regenerated = mustAsOperator("actana token regenerate --yes");
  const freshBlob = extractToken(regenerated.stdout, "actana token regenerate", die).blob;
  if (freshBlob.caCert === blob.caCert || freshBlob.clientCert === blob.clientCert) {
    die("`actana token regenerate` reissued the same credentials");
  }
  await waitForPort(hostPort, die);

  // The old blob must now be refused. This is the criterion, and it is checked
  // against the running daemon rather than against the file on disk.
  let oldStillWorks = false;
  try {
    await dialAndListProjects(
      { ...afterUpdateToken.blob, endpoint: `wss://127.0.0.1:${hostPort}` },
      10_000,
    );
    oldStillWorks = true;
  } catch {
    /* expected — the old CA no longer signs anything this daemon trusts */
  }
  if (oldStillWorks) die("the old pairing token still dialled after `token regenerate`");

  const withNew = await dialAndListProjects({
    ...freshBlob,
    endpoint: `wss://127.0.0.1:${hostPort}`,
  });
  if (!Array.isArray(withNew)) die("the regenerated pairing token could not dial the Core");
  log("`actana token regenerate` invalidated the old credentials and issued working ones");

  // ─── uninstall ───
  mustAsOperator("actana uninstall --yes");

  const traces = asOperator(
    "ls ~/.config/systemd/user/*.service 2>/dev/null; " +
      "ls ~/.local/bin/actana 2>/dev/null; " +
      "ls -d ~/.local/share/actana/versions ~/.local/share/actana/current 2>/dev/null; true",
  );
  if (traces.stdout.trim() !== "") {
    die(`uninstall left files behind: ${traces.stdout.trim()}`);
  }
  const unitState = asOperator("systemctl --user is-active actana-harness.service");
  if (unitState.stdout.trim() === "active") die("uninstall left the unit running");
  if (asOperator(`ls -d ~/.local/share/actana/data`).status !== 0) {
    die("uninstall removed the data dir without --purge-data");
  }
  log("`actana uninstall` removed the unit, launcher and install, and kept the data");

  // The launcher is gone, so this runs the CLI out of the extracted tarball —
  // which is also how an operator who uninstalled and changed their mind does it.
  mustAsOperator(`${extracted}/bin/actana uninstall --purge-data --yes`);
  const dataTraces = asOperator("ls -d ~/.local/share/actana ~/.config/actana 2>/dev/null; true");
  if (dataTraces.stdout.trim() !== "") {
    die(`--purge-data left data behind: ${dataTraces.stdout.trim()}`);
  }
  log("`actana uninstall --purge-data` removed the data dir and the credentials too");

  log(`OK — actana setup and the lifecycle verbs work on a fresh ${distro.label} machine`);
  process.exit(0);
}

void main().catch((err) => {
  console.error(`[setup-e2e] unexpected error: ${err.stack || err.message}`);
  process.exit(1);
});
