#!/usr/bin/env node
// End-to-end test — `actana setup` on macOS, against launchd.
//
// This is issue 04's acceptance criteria run as a test, on the machine it is
// about. Unlike the Linux e2e there is no container: a Mac's launchd is the
// host's launchd, and a LaunchAgent bootstrapped into anything other than the
// operator's own domain would not be the thing being tested. So the test runs
// as the current user with a scratch `HOME`, and boots the agent out again on
// the way out.
//
//   • extracting the tarball and running `actana setup` leaves a loaded
//     LaunchAgent, a running daemon, and a printed pairing token, with no sudo
//     asked for. Note this is weaker evidence than the Linux e2e's, which runs
//     in an image with no sudo binary on it at all and so cannot escalate even
//     by accident. A CI Mac is the host, so the same trick is not available;
//     the assertion here is that setup neither prompted for nor printed a sudo
//     step, plus the unit tests asserting no `sudo` command is ever run.
//   • the printed token decodes as a Registration blob and a test client dials
//     the core-link with it (the same dial the tarball smoke makes);
//   • `status` / `token` / `start` / `stop` / `restart` / `logs` control and
//     report the daemon, `logs` through launchd's own mechanism;
//   • re-running setup upgrades in place — one plist, same pairing credentials;
//   • unloading the agent and re-running setup over it is idempotent;
//   • issue 06's remaining lifecycle on launchd: `update` lands a newer
//     release from a fixture release channel (and a tampered one aborts,
//     leaving the old install running), `--version` pins exactly one release,
//     `token regenerate` makes the old blob's dial fail while the new one
//     works, and `uninstall` leaves no plist, launcher or install files —
//     keeping the data dir unless `--purge-data` is passed.
//
// Reboot persistence is the one criterion CI cannot exercise (a GitHub runner
// is destroyed rather than rebooted, and a LaunchAgent needs a login to come
// back). It lands on the manual checklist in
// `docs/harness-macos-prerelease-checklist.md` instead.
//
// Usage:
//   node scripts/e2e-actana-setup-macos.mjs --tarball <file> [--keep]
//
// --tarball <file>  A mac-* tarball from scripts/build-harness-tarball.mjs.
//                   Must match this machine's architecture.
// --keep            Leave the scratch home and the loaded agent behind.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseArgs, stringFlag } from "./lib/cli.mjs";
import {
  bumpPatch,
  parseAssetName,
  repackWithVersion,
  startFixtureServerProcess,
} from "./lib/fixture-release.mjs";
import { dialAndListProjects, makeDie, pickFreePort } from "./lib/harness-smoke.mjs";
import { tarballName as releaseAssetName } from "./lib/harness-tarball.mjs";
import {
  extractPairingToken,
  runCaptured,
  until,
  waitForTcpPort,
} from "./lib/setup-e2e.mjs";

const die = makeDie("setup-e2e-mac");
const log = (message) => console.log(`[setup-e2e-mac] ${message}`);

const LABEL = "com.actana.harness";

/** How long launchd is given to finish tearing a booted-out job down. */
const UNLOAD_TIMEOUT_MS = 10_000;

/**
 * The launchd domain the agent lives in.
 *
 * Mirrors `chooseLaunchdDomain` in the CLI rather than assuming `gui/<uid>`:
 * a CI runner may have no Aqua session, and the test has to look where the
 * CLI actually put the job.
 */
function resolveDomain() {
  const uid = process.getuid();
  for (const candidate of [`gui/${uid}`, `user/${uid}`]) {
    if (spawnSync("launchctl", ["print", candidate]).status === 0) return candidate;
  }
  return `gui/${uid}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._.length > 0) die(`unexpected argument: ${args._[0]}`);
  if (process.platform !== "darwin") die("this test runs on macOS — it drives launchd directly");

  const tarballFlag = stringFlag(args, "tarball", die);
  if (!tarballFlag) die("--tarball <file> is required");
  const tarball = path.resolve(tarballFlag);
  if (!fs.existsSync(tarball)) die(`no tarball at ${tarball}`);
  const expectedTarget = process.arch === "arm64" ? "mac-arm64" : "mac-x64";
  if (!path.basename(tarball).includes(expectedTarget)) {
    die(`${path.basename(tarball)} is not a ${expectedTarget} tarball — this machine is ${process.arch}`);
  }

  const domain = resolveDomain();
  const target = `${domain}/${LABEL}`;
  log(`launchd domain: ${domain}`);

  /** Wait for launchd to finish unloading the agent, or say who left it there. */
  const untilAgentUnloaded = (what) =>
    until(
      `${what} to unload the LaunchAgent`,
      UNLOAD_TIMEOUT_MS,
      () => spawnSync("launchctl", ["print", target]).status !== 0,
      (message) => die(`${message} — KeepAlive would restart the daemon`),
    );

  // A pre-existing install would make every assertion below ambiguous, and
  // booting somebody's real Core out from under them is not this test's call.
  if (spawnSync("launchctl", ["print", target]).status === 0) {
    die(`${LABEL} is already loaded in ${domain} — refusing to touch an existing install`);
  }

  // A scratch HOME: the LaunchAgent's plist, the install tree, the material and
  // the log all hang off it, so the runner's real home is never written to.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "actana-e2e-mac-"));
  const home = path.join(scratch, "home");
  fs.mkdirSync(home, { recursive: true });
  const keep = args.keep === true;

  const cleanup = () => {
    runCaptured("launchctl", ["bootout", target]);
    if (keep) {
      log(`--keep: leaving ${scratch} in place`);
      return;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  const port = await pickFreePort();

  /**
   * Run a command as the operator would, with the scratch home.
   *
   * `PATH` gets the scratch `~/.local/bin` so `actana` resolves the way it
   * does for an operator who followed the install instructions — and nothing
   * else changes, so a `sudo` on the PATH stays on it and the no-sudo claim
   * below is a real observation rather than an arranged one.
   */
  const asOperator = (script) =>
    runCaptured("/bin/bash", ["-lc", script], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${path.join(home, ".local", "bin")}:${process.env.PATH}`,
      },
      cwd: home,
    });

  const mustAsOperator = (script) => {
    const result = asOperator(script);
    if (result.status !== 0) {
      die(`operator script failed (${result.status}): ${script}`, [result.stdout, result.stderr]);
    }
    return result;
  };

  const tarballName = path.basename(tarball);
  fs.copyFileSync(tarball, path.join(home, tarballName));
  const extracted = path.join(home, path.basename(tarballName, ".tar.gz"));
  const plist = path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);

  // ─── setup ───
  log("running `actana setup`");
  const setup = mustAsOperator(
    `tar -xzf ${tarballName} && ${extracted}/bin/actana setup ` +
      `--public-host 127.0.0.1 --port ${port} --yes`,
  );
  const { blob } = extractPairingToken(setup.stdout, "actana setup", die);
  log("setup printed a decodable pairing token");

  if (!/pairing token/i.test(setup.stdout)) {
    die("setup never used the words 'pairing token'", setup.stdout.split("\n"));
  }
  // No sudo asked for. Weaker than the Linux leg's sudo-free image (see the
  // header) — `actana-setup.test.ts` carries the stronger assertion that no
  // `sudo` command is ever run.
  if (/\bsudo\b/.test(setup.stdout)) {
    die("setup asked the operator for sudo", setup.stdout.split("\n"));
  }

  if (!fs.existsSync(plist)) die(`setup wrote no LaunchAgent at ${plist}`);
  const printed = runCaptured("launchctl", ["print", target]);
  if (printed.status !== 0) {
    die(`the LaunchAgent is not loaded in ${domain}`, [printed.stdout, printed.stderr]);
  }
  if (!/state = running/.test(printed.stdout)) {
    die("the LaunchAgent is loaded but its daemon is not running", printed.stdout.split("\n"));
  }
  log("the LaunchAgent is loaded and its daemon is running");

  // ─── the token actually works ───
  await waitForTcpPort(port, die);
  let projects;
  try {
    projects = await dialAndListProjects({ ...blob, endpoint: `wss://127.0.0.1:${port}` });
  } catch (err) {
    die(`core-link dial with the pairing token failed: ${err.message}`, [setup.stdout]);
  }
  if (!Array.isArray(projects) || projects.length !== 0) {
    die(`projectsList did not return []: got ${JSON.stringify(projects)}`);
  }
  log("a test client dialled the core-link with the pairing token");

  // ─── status / token ───
  const status = mustAsOperator("actana status");
  for (const expected of ["healthy", `wss://127.0.0.1:${port}`, LABEL, "At login"]) {
    if (!status.stdout.includes(expected)) {
      die(`actana status is missing ${JSON.stringify(expected)}`, status.stdout.split("\n"));
    }
  }
  if (/Linger/.test(status.stdout)) {
    die("actana status talked about linger on a Mac", status.stdout.split("\n"));
  }
  log("`actana status` reports a healthy Core and names the LaunchAgent");

  const reprint = mustAsOperator("actana token");
  if (extractPairingToken(reprint.stdout, "actana token", die).blob.caCert !== blob.caCert) {
    die("`actana token` reprinted a different Core's material");
  }
  log("`actana token` reprints the same pairing token");

  // ─── start / stop / restart / logs ───
  mustAsOperator("actana stop");
  // `launchctl bootout` returns before launchd has finished tearing the job
  // down, so this waits rather than reading the domain one beat too early.
  await untilAgentUnloaded("`actana stop`");
  if (asOperator("actana status").status === 0) {
    die("`actana status` reported healthy while the daemon was stopped");
  }
  // Stopping twice must not be an error: an operator scripting a redeploy will
  // do exactly this.
  mustAsOperator("actana stop");
  mustAsOperator("actana start");
  await waitForTcpPort(port, die);
  mustAsOperator("actana restart");
  await waitForTcpPort(port, die);
  mustAsOperator("actana status");
  log("stop / start / restart drive the daemon");

  const logs = mustAsOperator("actana logs -n 200");
  if (logs.stdout.trim() === "") {
    die("`actana logs` showed nothing from the daemon", [logs.stderr]);
  }
  log("`actana logs` shows the daemon's output through launchd's log file");

  // ─── idempotent re-run over a loaded agent ───
  log("re-running `actana setup` over the loaded LaunchAgent");
  const again = mustAsOperator(
    `${extracted}/bin/actana setup --public-host 127.0.0.1 --port ${port} --yes`,
  );
  // Not byte equality: the bearer inside carries a fresh expiry every time it
  // is signed. What must not change is the material the Panel pinned.
  const reissued = extractPairingToken(again.stdout, "the second actana setup", die).blob;
  if (reissued.caCert !== blob.caCert || reissued.clientCert !== blob.clientCert) {
    die("re-running setup replaced the pairing credentials — a paired Panel would break");
  }
  const agents = fs.readdirSync(path.join(home, "Library", "LaunchAgents"));
  if (agents.length !== 1 || agents[0] !== `${LABEL}.plist`) {
    die(`re-running setup left ${JSON.stringify(agents)} in ~/Library/LaunchAgents`);
  }
  await waitForTcpPort(port, die);
  mustAsOperator("actana status");
  log("re-running setup upgraded in place: one plist, same token, still healthy");

  // ─── reinstall over an unloaded agent ───
  log("unloading the agent and re-running setup over it");
  mustAsOperator("actana stop");
  const reinstall = mustAsOperator(
    `${extracted}/bin/actana setup --public-host 127.0.0.1 --port ${port} --yes`,
  );
  if (extractPairingToken(reinstall.stdout, "the reinstall", die).blob.caCert !== blob.caCert) {
    die("reinstalling over an unloaded agent replaced the pairing credentials");
  }
  await waitForTcpPort(port, die);
  mustAsOperator("actana status");
  log("reinstalling over an unloaded agent is idempotent");

  // ─── update ───
  //
  // Two more releases out of the one tarball that was built: the same verified
  // bytes with a bumped manifest version, which is a genuinely different
  // release as far as resolution, install directory and `status` are concerned.
  const parsedAsset = parseAssetName(path.basename(tarball));
  if (!parsedAsset) die(`${path.basename(tarball)} is not a Harness release tarball`);
  const installedVersion = parsedAsset.version;
  const nextVersion = bumpPatch(installedVersion);
  const latestVersion = bumpPatch(nextVersion);

  const releaseDir = path.join(scratch, "releases");
  fs.mkdirSync(releaseDir, { recursive: true });
  const seed = path.join(releaseDir, path.basename(tarball));
  fs.copyFileSync(tarball, seed);
  repackWithVersion(seed, nextVersion, scratch, die);
  repackWithVersion(seed, latestVersion, scratch, die);
  fs.rmSync(seed);
  log(`serving releases v${nextVersion} and v${latestVersion} (latest)`);

  // Two views of the same releases: one honest, one that corrupts every
  // tarball it serves. Same assets, so the only difference `update` can see is
  // the one the checksum is there to catch.
  const server = await startFixtureServerProcess({
    dir: releaseDir,
    port: await pickFreePort(),
    host: "127.0.0.1",
    die,
  });
  const tamperedServer = await startFixtureServerProcess({
    dir: releaseDir,
    port: await pickFreePort(),
    host: "127.0.0.1",
    corrupt: [
      releaseAssetName(nextVersion, parsedAsset.target),
      releaseAssetName(latestVersion, parsedAsset.target),
    ],
    die,
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const tamperedUrl = `http://127.0.0.1:${tamperedServer.port}`;

  // A tampered download first, so "leaves the old install untouched" is
  // asserted against a Core that is still the one setup installed.
  const tampered = asOperator(`actana update --base-url ${tamperedUrl}`);
  if (tampered.status === 0) die("`actana update` accepted a download that failed its checksum");
  if (!/checksum/i.test(tampered.stdout + tampered.stderr)) {
    die("the aborted update never mentioned the checksum", [tampered.stdout, tampered.stderr]);
  }
  await waitForTcpPort(port, die);
  const afterTampered = mustAsOperator("actana status");
  if (!afterTampered.stdout.includes(installedVersion)) {
    die(
      `a failed update changed the running version — expected ${installedVersion} still`,
      afterTampered.stdout.split("\n"),
    );
  }
  const versionsDir = path.join(home, ".local", "share", "actana", "versions");
  if (fs.readdirSync(versionsDir).join(",") !== installedVersion) {
    die(`a failed update left a new version directory behind: ${fs.readdirSync(versionsDir)}`);
  }
  log("a tampered download aborted and left the old install untouched");

  // Pinned, so the version-lock recovery path is what runs: the newest release
  // is the other one, and this must install exactly what it names.
  const pinnedUpdate = mustAsOperator(
    `actana update --base-url ${baseUrl} --version ${nextVersion}`,
  );
  if (!pinnedUpdate.stdout.includes(nextVersion)) {
    die("`actana update --version` did not report the pinned version", pinnedUpdate.stdout.split("\n"));
  }
  await waitForTcpPort(port, die);
  const pinnedStatus = mustAsOperator("actana status");
  if (!pinnedStatus.stdout.includes(nextVersion) || !pinnedStatus.stdout.includes("healthy")) {
    die(`status does not report a healthy v${nextVersion}`, pinnedStatus.stdout.split("\n"));
  }
  log(`\`actana update --version ${nextVersion}\` installed exactly that release`);

  // Unpinned: the latest release, with launchd reloading the agent onto it.
  mustAsOperator(`actana update --base-url ${baseUrl}`);
  await waitForTcpPort(port, die);
  const latestStatus = mustAsOperator("actana status");
  if (!latestStatus.stdout.includes(latestVersion) || !latestStatus.stdout.includes("healthy")) {
    die(`status does not report a healthy v${latestVersion}`, latestStatus.stdout.split("\n"));
  }
  const afterUpdateToken = extractPairingToken(
    mustAsOperator("actana token").stdout,
    "actana token after update",
    die,
  );
  if (afterUpdateToken.blob.caCert !== blob.caCert) {
    die("updating replaced the pairing credentials — a paired Panel would break");
  }
  await dialAndListProjects({ ...afterUpdateToken.blob, endpoint: `wss://127.0.0.1:${port}` });
  log("`actana update` landed the latest release, reloaded the agent, and stayed paired");

  server.stop();
  tamperedServer.stop();

  // ─── token regenerate ───
  const regenerated = mustAsOperator("actana token regenerate --yes");
  const freshBlob = extractPairingToken(
    regenerated.stdout,
    "actana token regenerate",
    die,
  ).blob;
  if (freshBlob.caCert === blob.caCert || freshBlob.clientCert === blob.clientCert) {
    die("`actana token regenerate` reissued the same credentials");
  }
  await waitForTcpPort(port, die);

  let oldStillWorks = false;
  try {
    await dialAndListProjects(
      { ...afterUpdateToken.blob, endpoint: `wss://127.0.0.1:${port}` },
      10_000,
    );
    oldStillWorks = true;
  } catch {
    /* expected — the old CA no longer signs anything this daemon trusts */
  }
  if (oldStillWorks) die("the old pairing token still dialled after `token regenerate`");

  if (!Array.isArray(await dialAndListProjects({ ...freshBlob, endpoint: `wss://127.0.0.1:${port}` }))) {
    die("the regenerated pairing token could not dial the Core");
  }
  log("`actana token regenerate` invalidated the old credentials and issued working ones");

  // ─── uninstall ───
  mustAsOperator("actana uninstall --yes");

  if (fs.existsSync(plist)) die(`uninstall left the LaunchAgent at ${plist}`);
  await untilAgentUnloaded("`actana uninstall`");
  if (fs.existsSync(path.join(home, ".local", "bin", "actana"))) {
    die("uninstall left the launcher on the PATH");
  }
  if (fs.existsSync(versionsDir)) die("uninstall left the install trees behind");
  const dataDir = path.join(home, ".local", "share", "actana", "data");
  if (!fs.existsSync(dataDir)) die("uninstall removed the data dir without --purge-data");
  log("`actana uninstall` removed the agent, launcher and install, and kept the data");

  // The launcher is gone, so this runs the CLI out of the extracted tarball —
  // which is also how an operator who uninstalled and changed their mind does it.
  mustAsOperator(`${extracted}/bin/actana uninstall --purge-data --yes`);
  if (fs.existsSync(path.join(home, ".local", "share", "actana"))) {
    die("--purge-data left the install root behind");
  }
  if (fs.existsSync(path.join(home, ".config", "actana"))) {
    die("--purge-data left this Core's credentials behind");
  }
  log("`actana uninstall --purge-data` removed the data dir and the credentials too");

  log("OK — actana setup and the lifecycle verbs work on macOS through launchd");
  process.exit(0);
}

void main().catch((err) => {
  console.error(`[setup-e2e-mac] unexpected error: ${err.stack || err.message}`);
  process.exit(1);
});
