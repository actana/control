#!/usr/bin/env node
// End-to-end test — the whole Linux install story on a fresh systemd machine,
// entered the way an operator enters it: the real `curl … | bash` one-liner.
//
// This is the *only* installer e2e (ADR 0016 D36). The one-liner is the entry
// point rather than a suite of its own, so the lifecycle assertions run on the
// machine the one-liner produced instead of on a second machine that a
// duplicated install phase set up:
//
//   • the one-liner ends with a running Core, registered in this machine's own
//     `actana`, whose credential a test client can dial the core-link with —
//     with no `--yes` passed, because a piped (non-TTY) run must prompt for
//     nothing, and **printing no credential of its own** (#287);
//   • `--version` installs that exact release; with no flag, the latest;
//   • `status` / `start` / `stop` / `restart` / `logs` control and report the
//     daemon, and `pair new` mints a code on it;
//   • re-running the one-liner upgrades in place — one unit, same pairing
//     credentials, and a pre-rename `actana-harness.service` is taken out on
//     the way;
//   • lingering is on, and the daemon comes back after the machine reboots;
//   • `update` lands a newer release from a fixture release channel, restarts
//     the daemon on it, and `status` reports the new version — while a tampered
//     download aborts and leaves the old install running;
//   • `update --version` installs exactly that release (the Panel↔Core
//     version-lock recovery);
//   • after `token regenerate`, a client dialling with the old credential is
//     rejected, and the identity on disk is a new one;
//   • `uninstall` leaves no unit, launcher or install files and keeps the data
//     dir; `--purge-data` removes that too.
//
// install-sh's negative cases — a bad checksum, an unknown platform,
// `--version` pinning, non-TTY behaviour, flag passthrough, exit codes — are
// covered hermetically and in under a second by
// `scripts/__tests__/install-sh.test.mjs`, and are deliberately not repeated
// here: each one costs a whole extra one-liner run on a real container. What
// only a real machine can prove is that the script works against a real init
// system with a real tarball, and that is the install below.
//
// The one negative case that does run here is the tampered *update*, and it is
// here for the assertion rather than for the checksum: what has to hold is that
// a refused download leaves the Core that was running still running.
//
// The machine itself — a privileged systemd container driven through a real
// logind session — comes from `scripts/lib/systemd-container.mjs`. The release
// channel is `scripts/fixture-release-server.mjs`, which serves `install.sh`
// and the tarballs over `host.docker.internal`; until the repo is public it is
// the only way to exercise the installer at all.
//
// Only one tarball is ever built. The other releases are the same verified
// bytes repacked with a bumped manifest version — genuinely different releases
// as far as resolution, install directory and `status` are concerned, without a
// second twenty-minute build.
//
// Usage:
//   node scripts/e2e-actana-setup-linux.mjs --tarball <file> [--distro <id>] [--keep]
//
// --tarball <file>  A linux-* tarball from scripts/build-core-tarball.mjs.
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
import { dialAndListProjects, makeDie } from "./lib/core-smoke.mjs";
import { tarballName as releaseAssetName } from "./lib/core-tarball.mjs";
import {
  OPERATOR,
  pickHostPort,
  startSystemdContainer,
  waitForPort,
} from "./lib/systemd-container.mjs";

const die = makeDie("setup-e2e");
const log = (message) => console.log(`[setup-e2e] ${message}`);

const CONTAINER_PORT = 8443;

/** How the container reaches the fixture release servers on the host. */
const HOST_ALIAS = "host.docker.internal";

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

  // ─── two release channels, four releases, one build ───
  //
  // Split in two on purpose: "the latest release" has to mean v${firstLatest}
  // while the one-liner is being re-run and v${latestVersion} once `update` is
  // the thing under test, and a channel cannot serve two answers to the same
  // question.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-installer-e2e-"));
  process.on("exit", () => fs.rmSync(workDir, { recursive: true, force: true }));

  const pinnedVersion = parsed.version;
  const firstLatest = bumpPatch(pinnedVersion);
  const nextVersion = bumpPatch(firstLatest);
  const latestVersion = bumpPatch(nextVersion);

  const installDir = path.join(workDir, "install-channel");
  fs.mkdirSync(installDir, { recursive: true });
  fs.copyFileSync(tarball, path.join(installDir, path.basename(tarball)));
  repackWithVersion(path.join(installDir, path.basename(tarball)), firstLatest, workDir, die);

  const updateDir = path.join(workDir, "update-channel");
  fs.mkdirSync(updateDir, { recursive: true });
  const updateSeed = path.join(updateDir, path.basename(tarball));
  fs.copyFileSync(tarball, updateSeed);
  repackWithVersion(updateSeed, nextVersion, workDir, die);
  repackWithVersion(updateSeed, latestVersion, workDir, die);
  fs.rmSync(updateSeed);

  const startChannel = async (dir) => {
    const server = await startFixtureServerProcess({ dir, port: await pickHostPort(), die });
    return { url: `http://${HOST_ALIAS}:${server.port}`, stop: server.stop };
  };

  const installChannel = await startChannel(installDir);
  log(`install channel serving v${pinnedVersion} (pinned) and v${firstLatest} (latest)`);

  // ─── the machine ───
  log(`installing on ${distro.label}`);
  const hostPort = await pickHostPort();
  const machine = await startSystemdContainer({
    tag: imageTag("installer", distro.id),
    name: `actana-installer-e2e-${distro.id}-${process.pid}`,
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

  /**
   * The credential `actana setup` wired into this machine's own registry.
   *
   * Read out of the registry with `cat`, because that is now the only place it
   * exists: #287 removed the printed artifact these assertions used to pick out
   * of stdout. `actana core ls --json` names the entry — derived from the
   * label, so it is the machine's hostname unless `--label` said otherwise.
   */
  const storedCredential = () => {
    const listed = mustAsOperator("actana core ls --json");
    let rows;
    try {
      rows = JSON.parse(listed.stdout);
    } catch {
      return die("`actana core ls --json` did not print JSON", listed.stdout.split("\n"));
    }
    if (!Array.isArray(rows) || rows.length !== 1) {
      return die(`expected exactly one registered Core, got ${JSON.stringify(rows)}`);
    }
    const text = mustAsOperator(`cat ~/.config/actana/cores/${rows[0].name}.txt`).stdout.trim();
    const parsed = JSON.parse(Buffer.from(text, "base64").toString("utf8"));
    for (const field of ["endpoint", "caCert", "clientCert", "clientKey", "bearer"]) {
      if (typeof parsed[field] !== "string" || parsed[field] === "") {
        die(`the registry entry for ${rows[0].name} has no usable ${field}`);
      }
    }
    return parsed;
  };

  /** The one-liner, exactly as the docs print it. */
  const oneLiner = (url, flags) =>
    `curl -fsSL ${url}/install.sh | bash -s -- --base-url ${url} ${flags}`;

  // ─── the real thing, pinned, with no flag that suppresses prompts ───
  log(`running the one-liner pinned to v${pinnedVersion}`);
  const install = mustAsOperator(
    oneLiner(installChannel.url, `--version ${pinnedVersion} --public-host 127.0.0.1`),
  );
  // #287: the install emits no credential. A PEM header or a base64 blob on
  // stdout would be the hand-carry back, and the one-liner is where an operator
  // would find it.
  if (/BEGIN (CERTIFICATE|PRIVATE KEY|RSA PRIVATE KEY)/.test(install.stdout)) {
    die("the install printed certificate material", install.stdout.split("\n"));
  }
  if (!/actana pair new/.test(install.stdout)) {
    die("the install never said how to enroll a client", install.stdout.split("\n"));
  }
  const blob = storedCredential();
  // Nothing asked the operator anything: no `--yes` was passed, and the run
  // still finished. A prompt would have hung until the session timed out.
  if (/\[Y\/n\]|\(y\/n\)/i.test(install.stdout)) {
    die("a piped install prompted for input", install.stdout.split("\n"));
  }
  log("the one-liner installed unattended, printed no credential, and named `pair new`");

  const active = mustAsOperator("systemctl --user is-active actana-core.service");
  if (active.stdout.trim() !== "active") {
    die(`unit is ${active.stdout.trim()}, expected active`, install.stdout.split("\n"));
  }
  const enabled = mustAsOperator("systemctl --user is-enabled actana-core.service");
  if (enabled.stdout.trim() !== "enabled") {
    die(`unit is ${enabled.stdout.trim()}, expected enabled`);
  }
  log("user unit is active and enabled");

  // ─── the credential setup wired in actually works ───
  await waitForPort(hostPort, die);
  let projects;
  try {
    projects = await dialAndListProjects({ ...blob, endpoint: `wss://127.0.0.1:${hostPort}` });
  } catch (err) {
    die(`core-link dial with the wired credential failed: ${err.message}`, install.stdout.split("\n"));
  }
  if (!Array.isArray(projects) || projects.length !== 0) {
    die(`projectsList did not return []: got ${JSON.stringify(projects)}`);
  }
  log("a test client dialled the core-link with the credential setup registered");

  // ─── linger ───
  const linger = mustAsOperator(`loginctl show-user ${OPERATOR} --property=Linger`);
  if (!linger.stdout.includes("Linger=yes")) {
    die(`lingering was not enabled: ${linger.stdout.trim()}`, install.stdout.split("\n"));
  }
  log("lingering is enabled — the daemon survives logout");

  // ─── status / pair ───
  //
  // Read once the port is up, not straight off the back of the install: a
  // status taken before the daemon is listening would be reporting on a race.
  const afterInstall = mustAsOperator("actana status");
  for (const expected of ["healthy", "wss://127.0.0.1:8443", "Linger"]) {
    if (!afterInstall.stdout.includes(expected)) {
      die(`actana status is missing ${JSON.stringify(expected)}`, afterInstall.stdout.split("\n"));
    }
  }
  if (!afterInstall.stdout.includes(pinnedVersion)) {
    die(`--version ${pinnedVersion} did not install that version`, afterInstall.stdout.split("\n"));
  }
  log(`\`actana status\` reports a healthy Core on the pinned v${pinnedVersion}`);

  // The verb that replaced the reprint. It has to work on the machine the
  // one-liner produced, and it must not put the code on stdout twice or leak a
  // credential while doing it.
  const minted = mustAsOperator("actana pair new --label e2e-panel");
  if (!/Pairing code\s+[A-Z2-9]{4}-[A-Z2-9]{4}/.test(minted.stdout)) {
    die("`actana pair new` printed no pairing code", minted.stdout.split("\n"));
  }
  if (!/CA fingerprint\s+[0-9A-F]{2}(:[0-9A-F]{2}){31}/.test(minted.stdout)) {
    die("`actana pair new` printed no CA fingerprint", minted.stdout.split("\n"));
  }
  if (/BEGIN (CERTIFICATE|PRIVATE KEY)/.test(minted.stdout)) {
    die("`actana pair new` printed certificate material", minted.stdout.split("\n"));
  }
  const reprint = asOperator("actana token");
  if (reprint.status === 0) die("`actana token` still reprints something — #287 removed it");
  // Both streams: `machinectl shell` folds the session's stderr into the
  // `docker exec`'s stdout, so a refusal written to stderr arrives on `stdout`
  // here. Every other check in this file reads the pair for the same reason.
  const refusal = `${reprint.stdout}${reprint.stderr}`;
  if (!/actana pair new/.test(refusal)) {
    die("`actana token` refused without naming `actana pair new`", refusal.split("\n"));
  }
  log("`actana pair new` mints a code, and `actana token` refuses and says so");

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
  if (!logs.stdout.includes("actana-core")) {
    die("`actana logs` showed nothing from the daemon's unit", logs.stdout.split("\n"));
  }
  log("`actana logs` shows the daemon's journal");

  // ─── re-running the one-liner upgrades in place, over a pre-rename machine ───
  //
  // The whole migration this release has. A developer machine installed while
  // the daemon was still called a Harness carries `actana-harness.service` as
  // well, enabled and running out of the same tree on the same port — so a
  // re-run that only installed `actana-core.service` would leave two daemons
  // fighting over one socket. `sleep` stands in for the old daemon: what is
  // being tested is that setup stops, disables and removes the unit, not what
  // the unit ran.
  log("planting a pre-rename actana-harness.service");
  mustAsOperator(
    [
      "cat > ~/.config/systemd/user/actana-harness.service <<'UNIT'",
      "[Unit]",
      "Description=Actana Control Harness (pre-rename)",
      "",
      "[Service]",
      "Type=simple",
      "ExecStart=/bin/sleep 3600",
      "",
      "[Install]",
      "WantedBy=default.target",
      "UNIT",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now actana-harness.service",
    ].join("\n"),
  );
  // Asserted, not assumed: if planting ever silently failed, every check below
  // would pass against a machine that never had the old unit at all.
  const plantedState = mustAsOperator("systemctl --user is-active actana-harness.service");
  if (plantedState.stdout.trim() !== "active") {
    die(`the planted pre-rename unit is ${plantedState.stdout.trim()}, expected active`);
  }

  log("re-running the one-liner with no version pinned");
  mustAsOperator(oneLiner(installChannel.url, "--public-host 127.0.0.1"));
  // Not byte equality: the bearer inside carries a fresh expiry every time it
  // is signed. What must not change is the material the Panel pinned — a new
  // CA or client cert means the paired Panel is locked out.
  const reissued = storedCredential();
  if (reissued.caCert !== blob.caCert || reissued.clientCert !== blob.clientCert) {
    die("the upgrade replaced the pairing credentials — a paired Panel would break");
  }
  const afterUpgrade = mustAsOperator("actana status");
  if (!afterUpgrade.stdout.includes(firstLatest)) {
    die(
      `the unpinned re-run did not resolve the latest release (v${firstLatest})`,
      afterUpgrade.stdout.split("\n"),
    );
  }
  // One unit file, and one enablement link pointing at it. `default.target.wants`
  // is systemd's own bookkeeping and belongs there; a second unit or a second
  // link would be the duplicate the criterion is about.
  const units = mustAsOperator("ls -1 ~/.config/systemd/user/*.service");
  if (units.stdout.trim().split("\n").length !== 1) {
    die("the upgrade left more than one unit file", units.stdout.split("\n"));
  }
  const wants = mustAsOperator("ls -1 ~/.config/systemd/user/default.target.wants");
  if (wants.stdout.trim() !== "actana-core.service") {
    die(`unexpected enablement links: ${JSON.stringify(wants.stdout.trim())}`);
  }
  // Stopped as well as deleted: a unit file removed from under a running
  // service leaves the old daemon on the port until something reloads systemd.
  const legacyState = asOperator("systemctl --user is-active actana-harness.service");
  if (legacyState.stdout.trim() === "active") {
    die("the pre-rename unit is still running after setup — two daemons, one socket");
  }
  if (asOperator("test -e ~/.config/systemd/user/actana-harness.service").status === 0) {
    die("setup left the pre-rename unit file on disk");
  }
  await waitForPort(hostPort, die);
  mustAsOperator("actana status");
  log(`upgraded in place to v${firstLatest}: one unit, same credentials, still healthy`);

  // ─── survives a reboot ───
  log("restarting the machine");
  await machine.reboot();
  await waitForPort(hostPort, die);
  const afterReboot = mustAsOperator("actana status");
  if (!afterReboot.stdout.includes("healthy")) {
    die("the Core did not come back after a reboot", afterReboot.stdout.split("\n"));
  }
  // The identity must survive too — a Core that reboots into fresh certs is a
  // Core the operator has to re-pair.
  if (storedCredential().caCert !== blob.caCert) {
    die("the Core came back with different material — every paired client would be locked out");
  }
  log("the Core came back after reboot with the same identity");

  installChannel.stop();

  // ─── update ───
  const updateChannel = await startChannel(updateDir);
  log(`update channel serving v${nextVersion} and v${latestVersion} (latest)`);

  // The same releases, served by a second process that flips one byte of every
  // tarball it hands out. The checksums stay truthful, so the only difference
  // `update` can see is the one integrity checking exists to catch.
  const tamperedServer = await startFixtureServerProcess({
    dir: updateDir,
    port: await pickHostPort(),
    corrupt: [nextVersion, latestVersion].map((version) =>
      releaseAssetName(version, parsed.target),
    ),
    die,
  });

  // A tampered download first, so the "leaves the old install untouched"
  // assertion is made against the Core the one-liner installed.
  const tamperedUpdate = asOperator(
    `actana update --base-url http://${HOST_ALIAS}:${tamperedServer.port}`,
  );
  if (tamperedUpdate.status === 0) {
    die("`actana update` accepted a download that failed its checksum");
  }
  if (!/checksum/i.test(tamperedUpdate.stdout + tamperedUpdate.stderr)) {
    die("the aborted update never mentioned the checksum", [
      tamperedUpdate.stdout,
      tamperedUpdate.stderr,
    ]);
  }
  await waitForPort(hostPort, die);
  const afterTampered = mustAsOperator("actana status");
  if (!afterTampered.stdout.includes(firstLatest)) {
    die(
      `a failed update changed the running version — expected ${firstLatest} still`,
      afterTampered.stdout.split("\n"),
    );
  }
  // Not "exactly one version dir": the in-place upgrade above legitimately left
  // the release it replaced behind. What a failed update must not do is leave a
  // directory for the release it failed to install.
  const versionsAfterTampered = mustAsOperator("ls -1 ~/.local/share/actana/versions");
  for (const version of [nextVersion, latestVersion]) {
    if (versionsAfterTampered.stdout.split("\n").some((line) => line.trim() === version)) {
      die(
        `a failed update left a v${version} directory behind`,
        versionsAfterTampered.stdout.split("\n"),
      );
    }
  }
  log("a tampered download aborted and left the old install untouched");

  // Pinned, so the version-lock recovery path is what runs: the newest release
  // is v${latestVersion}, and this must install the other one.
  const pinnedUpdate = mustAsOperator(
    `actana update --base-url ${updateChannel.url} --version ${nextVersion}`,
  );
  if (!pinnedUpdate.stdout.includes(nextVersion)) {
    die(
      "`actana update --version` did not report the pinned version",
      pinnedUpdate.stdout.split("\n"),
    );
  }
  await waitForPort(hostPort, die);
  const afterPinnedUpdate = mustAsOperator("actana status");
  if (!afterPinnedUpdate.stdout.includes(nextVersion) || !afterPinnedUpdate.stdout.includes("healthy")) {
    die(`status does not report a healthy v${nextVersion}`, afterPinnedUpdate.stdout.split("\n"));
  }
  log(`\`actana update --version ${nextVersion}\` installed exactly that release`);

  // Unpinned: the latest release, and the daemon running on it.
  mustAsOperator(`actana update --base-url ${updateChannel.url}`);
  await waitForPort(hostPort, die);
  const latestStatus = mustAsOperator("actana status");
  if (!latestStatus.stdout.includes(latestVersion) || !latestStatus.stdout.includes("healthy")) {
    die(`status does not report a healthy v${latestVersion}`, latestStatus.stdout.split("\n"));
  }
  // The material is untouched by an update, so the Panel that was paired is
  // still paired — and the token still dials.
  const afterUpdate = storedCredential();
  if (afterUpdate.caCert !== blob.caCert) {
    die("updating replaced the pairing credentials — a paired Panel would break");
  }
  await dialAndListProjects({ ...afterUpdate, endpoint: `wss://127.0.0.1:${hostPort}` });
  log("`actana update` landed the latest release, restarted, and stayed paired");

  // ─── token regenerate ───
  const regenerated = mustAsOperator("actana token regenerate --yes");
  // It hands nothing out (#287): what it says is that every paired client is
  // locked out and how to pair one again.
  if (/BEGIN (CERTIFICATE|PRIVATE KEY)/.test(`${regenerated.stdout}${regenerated.stderr}`)) {
    die("`actana token regenerate` printed certificate material", regenerated.stdout.split("\n"));
  }
  if (!/actana pair new/.test(`${regenerated.stdout}${regenerated.stderr}`)) {
    die("`actana token regenerate` did not say how to pair again", regenerated.stderr.split("\n"));
  }
  await waitForPort(hostPort, die);

  // The old credential must now be refused. This is the criterion, and it is
  // checked against the running daemon rather than against the file on disk.
  let oldStillWorks = false;
  try {
    await dialAndListProjects(
      { ...afterUpdate, endpoint: `wss://127.0.0.1:${hostPort}` },
      10_000,
    );
    oldStillWorks = true;
  } catch {
    /* expected — the old CA no longer signs anything this daemon trusts */
  }
  if (oldStillWorks) die("the old credential still dialled after `token regenerate`");
  log("`actana token regenerate` invalidated every credential this Core had issued");

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
  const unitState = asOperator("systemctl --user is-active actana-core.service");
  if (unitState.stdout.trim() === "active") die("uninstall left the unit running");
  if (asOperator("ls -d ~/.local/share/actana/data").status !== 0) {
    die("uninstall removed the data dir without --purge-data");
  }
  log("`actana uninstall` removed the unit, launcher and install, and kept the data");

  // The launcher is gone, so getting a CLI back means running the one-liner
  // again — which is also what an operator who uninstalled and changed their
  // mind does, and the only route left once nothing is extracted on the disk.
  mustAsOperator(oneLiner(updateChannel.url, "--public-host 127.0.0.1"));
  await waitForPort(hostPort, die);
  log("the one-liner reinstalled onto a machine that had been uninstalled");

  mustAsOperator("actana uninstall --purge-data --yes");
  const dataTraces = asOperator("ls -d ~/.local/share/actana ~/.config/actana 2>/dev/null; true");
  if (dataTraces.stdout.trim() !== "") {
    die(`--purge-data left data behind: ${dataTraces.stdout.trim()}`);
  }
  log("`actana uninstall --purge-data` removed the data dir and the credentials too");

  updateChannel.stop();
  tamperedServer.stop();
  log(
    `OK — on ${distro.label} the one-liner installs, pins, upgrades in place, and the lifecycle verbs work`,
  );
  process.exit(0);
}

void main().catch((err) => {
  console.error(`[setup-e2e] unexpected error: ${err.stack || err.message}`);
  process.exit(1);
});
