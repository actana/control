#!/usr/bin/env node
// End-to-end test — agent CLI detection and offers on a fresh systemd machine.
//
// This is issue 05's acceptance criteria run against a machine that genuinely
// has no agent CLI on it, which is the one thing no unit test can supply:
//
//   • a fresh machine has none of them, `--no-agents` installs none, and a run
//     with no terminal neither prompts nor installs;
//   • `actana agents install <id>` runs the vendor's own installer and leaves
//     a working CLI on PATH; an unknown id fails with the supported list;
//   • the Harness reflects the new CLI with no restart — the daemon's pid is
//     unchanged and a test client dialling the core-link sees it `available`,
//     which is exactly what a paired Panel would see;
//   • `--with-<agent>` installs unattended, with no terminal anywhere;
//   • on a terminal, setup offers every *still* missing agent one at a time,
//     and an accepted offer leaves a working vendor-installed CLI on PATH.
//
// Usage:
//   node scripts/e2e-actana-agents-linux.mjs --tarball <file> [--distro <id>] [--keep]
//
// --tarball <file>  A linux-* tarball from scripts/build-harness-tarball.mjs.
//                   Must match the Docker daemon's architecture.
// --distro <id>     Which distribution to install on (scripts/lib/container-matrix.mjs).
//                   Defaults to ubuntu. Unlike the hermetic suites this one is
//                   not crossed over the matrix — what it tests is a vendor's
//                   installer, which does not vary by distribution.
// --keep            Leave the container running for poking at after a failure.
//
// Needs network from inside the container: unlike the other installer e2es
// this one is NOT hermetic, because "installed via the vendor's official
// method" is only worth asserting against the vendor's actual method. Three
// agents are installed for real, each by a self-contained shell installer with
// no npm or Node prerequisite. Codex is the one always declined here — its
// official method is `npm install -g`, and an npm on the image would be a
// prerequisite this test does not otherwise need.

import * as fs from "node:fs";
import * as path from "node:path";

import { parseArgs, stringFlag } from "./lib/cli.mjs";
import { distroDockerfile, distroFlag, imageTag } from "./lib/container-matrix.mjs";
import { dialAndListAgentAvailability, extractToken, makeDie } from "./lib/harness-smoke.mjs";
import {
  OPERATOR,
  pickHostPort,
  startSystemdContainer,
  waitForPort,
} from "./lib/systemd-container.mjs";

const die = makeDie("agents-e2e");
const log = (message) => console.log(`[agents-e2e] ${message}`);

const CONTAINER_PORT = 8443;

/** How long the Harness gets to notice a newly installed CLI. */
const AVAILABILITY_TIMEOUT_MS = 30_000;

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

  const hostPort = await pickHostPort();
  const machine = await startSystemdContainer({
    tag: imageTag("agents", distro.id),
    name: `actana-agents-e2e-${distro.id}-${process.pid}`,
    containerPort: CONTAINER_PORT,
    hostPort,
    // `curl` and `unzip` are what the vendor installers themselves need;
    // `util-linux` carries `script(1)`, which is how this test gives the CLI a
    // terminal to prompt on while still feeding it scripted answers.
    dockerfile: distroDockerfile(distro.id, {
      packages: ["curl", "ca-certificates", "unzip", "util-linux"],
      fail: die,
    }),
    keep: args.keep === true,
    die,
    log,
  });
  const { mustAsOperator, asOperator } = machine;

  /** Whether a command resolves on the operator's PATH, in a fresh session. */
  const onPath = (command) => asOperator(`command -v ${command}`).status === 0;

  /** The daemon's pid, as systemd knows it. */
  const mainPid = () =>
    mustAsOperator(
      "systemctl --user show actana-harness.service --property=MainPID --value",
    ).stdout.trim();

  const tarballName = path.basename(tarball);
  machine.copyToOperator(tarball);
  const extracted = `/home/${OPERATOR}/${path.basename(tarballName, ".tar.gz")}`;
  mustAsOperator(`cd ~ && tar -xzf ${tarballName}`);

  // ─── the machine really has no agent CLIs ───
  for (const command of ["claude", "codex", "cursor-agent", "opencode"]) {
    if (onPath(command)) {
      die(`the image already has ${command} on it — nothing below would prove anything`);
    }
  }
  log("fresh machine: no agent CLI on PATH");

  // ─── a run with no terminal installs nothing ───
  // `machinectl shell` hands the CLI a PTY, so `</dev/null` is what makes this
  // the no-terminal case — the same shape as `curl … | bash`.
  const quiet = mustAsOperator(
    `${extracted}/bin/actana setup --public-host 127.0.0.1 --yes --no-agents </dev/null`,
  );
  const { blob } = extractToken(quiet.stdout, "actana setup", die);
  if (onPath("opencode")) die("--no-agents installed an agent CLI anyway", quiet.stdout.split("\n"));
  log("`--no-agents` installed nothing");

  const piped = mustAsOperator(`${extracted}/bin/actana setup --public-host 127.0.0.1 </dev/null`);
  if (!/actana agents install/.test(piped.stdout)) {
    die("a non-interactive setup never said how to install the missing CLIs", piped.stdout.split("\n"));
  }
  if (/^Install /m.test(piped.stdout)) {
    die("a setup with no terminal prompted anyway", piped.stdout.split("\n"));
  }
  if (onPath("opencode")) die("a setup with no terminal installed an agent CLI unasked");
  log("a run with no terminal prompted for nothing and installed nothing");

  // ─── unknown ids fail with the list ───
  const unknown = asOperator("actana agents install gemini");
  if (unknown.status !== 2) {
    die(`\`actana agents install gemini\` exited ${unknown.status}, expected 2`);
  }
  if (!/opencode/.test(unknown.stdout + unknown.stderr)) {
    die("an unknown agent id was rejected without naming the supported ones");
  }
  log("an unknown agent id fails with the supported list");

  // ─── `actana agents install` runs the real vendor installer ───
  await waitForPort(hostPort, die);
  const pidBefore = mainPid();
  log("running the real OpenCode installer — this downloads from the vendor");
  const installed = mustAsOperator("actana agents install opencode");
  if (!installed.stdout.includes("Installing OpenCode")) {
    die("`actana agents install` did not say what it was running", installed.stdout.split("\n"));
  }
  if (!onPath("opencode")) {
    die("opencode is not on the operator's PATH after installing it", installed.stdout.split("\n"));
  }
  log("opencode is on PATH");

  // ─── the Harness sees it, and did not restart to do so ───
  const dialed = { ...blob, endpoint: `wss://127.0.0.1:${hostPort}` };
  const deadline = Date.now() + AVAILABILITY_TIMEOUT_MS;
  for (;;) {
    const availability = await dialAndListAgentAvailability(dialed);
    if (availability?.opencode?.status === "available") break;
    if (Date.now() >= deadline) {
      die(
        "the Harness still does not see opencode as available: " +
          JSON.stringify(availability?.opencode),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  log("a Panel dialling the core-link sees the new agent");

  // The criterion is "without a daemon restart" — so the daemon that answered
  // has to be the same process that was running before the install.
  const pidAfter = mainPid();
  if (pidAfter !== pidBefore || pidBefore === "0") {
    die(`the daemon restarted to notice the new agent (pid ${pidBefore} → ${pidAfter})`);
  }
  log(`the daemon never restarted (pid ${pidAfter})`);

  const status = mustAsOperator("actana status");
  if (!status.stdout.includes("healthy") || !/opencode\s+available/.test(status.stdout)) {
    die("`actana status` does not show a healthy Core with the new agent", status.stdout.split("\n"));
  }
  const again = mustAsOperator("actana agents install opencode");
  if (!/already installed/i.test(again.stdout)) {
    die("re-installing an agent did not report it as already installed", again.stdout.split("\n"));
  }
  log("`actana status` shows the new agent, and re-installing it does nothing");

  // ─── --with-<agent> installs unattended ───
  log("running the real Claude Code installer through --with-claude-code");
  const withFlag = mustAsOperator(
    `${extracted}/bin/actana setup --public-host 127.0.0.1 --with-claude-code </dev/null`,
  );
  if (/^Install /m.test(withFlag.stdout)) {
    die("--with-<agent> prompted instead of installing", withFlag.stdout.split("\n"));
  }
  if (!onPath("claude")) {
    die("--with-claude-code did not leave claude on PATH", withFlag.stdout.split("\n"));
  }
  if (onPath("cursor-agent")) die("--with-claude-code installed an agent nobody asked for");
  log("`--with-<agent>` installed exactly that agent, unattended");

  // ─── on a terminal, every still-missing agent is offered ───
  // `script -qec` runs the CLI under a real pty while stdin stays a pipe this
  // test writes the answers into. Lingering was enabled by the first setup and
  // is not asked about twice, so the prompts here are exactly the two offers:
  // decline Codex (its official installer wants an npm this image has no other
  // reason to carry), accept Cursor CLI.
  log("answering setup's offers on a terminal — accepting Cursor CLI installs it for real");
  const offered = mustAsOperator(
    `printf 'n\\ny\\n' | script -qec ` +
      `"${extracted}/bin/actana setup --public-host 127.0.0.1" /dev/null`,
  );
  // If lingering ever were asked again, it would eat the Codex answer and every
  // assertion below would be about the wrong prompt.
  if (/lingering/i.test(offered.stdout)) {
    die("setup asked about lingering again — the scripted answers are misaligned", offered.stdout.split("\n"));
  }
  for (const label of ["Codex", "Cursor CLI"]) {
    if (!offered.stdout.includes(`Install ${label}`)) {
      die(`setup never offered ${label} on a terminal`, offered.stdout.split("\n"));
    }
  }
  // The two already on the machine must not be offered again.
  for (const label of ["Claude Code", "OpenCode"]) {
    if (offered.stdout.includes(`Install ${label}`)) {
      die(`setup offered ${label}, which is already installed`, offered.stdout.split("\n"));
    }
  }
  if (!onPath("cursor-agent")) {
    die("an accepted offer did not leave cursor-agent on PATH", offered.stdout.split("\n"));
  }
  if (onPath("codex")) die("a declined offer installed Codex anyway");
  log("setup offered each missing agent; the accepted one is installed, the declined one is not");

  // ─── and the Panel's view has followed all of it ───
  await waitForPort(hostPort, die);
  const finalAvailability = await dialAndListAgentAvailability(dialed);
  for (const agent of ["opencode", "claude-code", "cursor-cli"]) {
    if (finalAvailability?.[agent]?.status !== "available") {
      die(
        `the Harness does not report ${agent} as available: ` +
          JSON.stringify(finalAvailability?.[agent]),
      );
    }
  }
  if (finalAvailability?.codex?.status !== "missing") {
    die(`the declined agent is not reported missing: ${JSON.stringify(finalAvailability?.codex)}`);
  }
  log("the Harness's published availability matches what was installed");

  log(
    `OK — agent detection, offers, and \`actana agents install\` work on a fresh ${distro.label} machine`,
  );
  process.exit(0);
}

void main().catch((err) => {
  console.error(`[agents-e2e] unexpected error: ${err.stack || err.message}`);
  process.exit(1);
});
