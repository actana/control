#!/usr/bin/env node
// One command that puts you in front of a fresh remote VM with nothing on it.
//
// Everything CI does to the installer, it does with the prompts suppressed and
// nobody watching. This is the other half: a throwaway systemd machine, a
// fixture release channel serving the tarball you just built, and an
// interactive root-less shell inside the machine with the real one-liner
// printed above the prompt. Paste it, answer the questions, take the pairing
// token to a live Panel, and work the Core the way an operator would.
//
// Usage:
//   pnpm harness:rehearse
//   pnpm harness:rehearse -- --distro debian --port 9443
//
// --tarball <file>  Which build to serve. Defaults to the newest tarball in
//                   artifacts/harness for this machine's architecture.
// --distro <id>     Which distribution the fake VM runs (see
//                   scripts/lib/container-matrix.mjs). Defaults to ubuntu.
// --port <n>        Host port the Core is published on. Defaults to 8443,
//                   which is the port the printed pairing token names — pick
//                   another only if something already holds it, and read
//                   docs/harness-linux-rehearsal.md before you do.
// --keep            Leave the machine running after you exit the shell.
//
// The step-by-step is docs/harness-linux-rehearsal.md; this script is the
// "spin it up" half of it. Requires a Docker that can run a privileged
// container.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseArgs, stringFlag } from "./lib/cli.mjs";
import { distroDockerfile, distroFlag, imageTag } from "./lib/container-matrix.mjs";
import { startFixtureServerProcess } from "./lib/fixture-release.mjs";
import { makeDie } from "./lib/harness-smoke.mjs";
import { hostTarget, pickTarball, rehearsalOneLiner } from "./lib/rehearsal.mjs";
import { OPERATOR, pickHostPort, run, startSystemdContainer } from "./lib/systemd-container.mjs";

const die = makeDie("rehearse");
const log = (message) => console.log(`[rehearse] ${message}`);

const CONTAINER_PORT = 8443;

/**
 * The default host port, and the one the printed token will name.
 *
 * `actana setup --public-host 127.0.0.1` mints the Core's certificate for
 * loopback and its pairing token says `wss://127.0.0.1:8443`. Publishing the
 * container on the same number is what lets the token be pasted into a Panel
 * on this machine verbatim — the doc explains what to edit if it is taken.
 */
const DEFAULT_HOST_PORT = 8443;

/** How the machine reaches the fixture release server on the host. */
const HOST_ALIAS = "host.docker.internal";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._.length > 0) die(`unexpected argument: ${args._[0]}`);

  const distro = distroFlag(args, die);
  const repoRoot = path.resolve(import.meta.dirname, "..");

  // ─── which build is being rehearsed ───
  const target = hostTarget(process.arch, die);
  const explicit = stringFlag(args, "tarball", die);
  const artifactDir = path.join(repoRoot, "artifacts", "harness");
  const tarball = explicit
    ? path.resolve(explicit)
    : path.join(
        artifactDir,
        pickTarball(
          fs.existsSync(artifactDir) ? fs.readdirSync(artifactDir) : [],
          target,
          die,
        ),
      );
  if (!fs.existsSync(tarball)) die(`no tarball at ${tarball}`);

  const portFlag = stringFlag(args, "port", die);
  const hostPort = portFlag ? Number(portFlag) : DEFAULT_HOST_PORT;
  if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65_535) {
    die(`--port ${portFlag} is not a port number`);
  }

  // ─── the fixture release channel ───
  //
  // A copy, not the artifact directory itself: the fixture server derives its
  // release list from every tarball it can see, and rehearsing "the latest
  // release" should mean the one build chosen above.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-rehearse-"));
  const releaseDir = path.join(workDir, "releases");
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.copyFileSync(tarball, path.join(releaseDir, path.basename(tarball)));

  const server = await startFixtureServerProcess({
    dir: releaseDir,
    port: await pickHostPort(),
    die,
  });
  const baseUrl = `http://${HOST_ALIAS}:${server.port}`;

  // ─── the fake remote VM ───
  const name = `actana-rehearsal-${distro.id}`;
  run("docker", ["rm", "-f", name]); // a previous rehearsal left running

  // This script owns the machine's life, so `startSystemdContainer` is told to
  // keep it (below) and its own exit-time note about doing so is stale by the
  // time it prints — the teardown at the bottom has already run and said what
  // actually happened.
  let toreDown = false;
  const containerLog = (message) => {
    if (!toreDown) log(message);
  };

  const machine = await startSystemdContainer({
    tag: imageTag("rehearsal", distro.id),
    name,
    containerPort: CONTAINER_PORT,
    hostPort,
    // curl is the first word of the one-liner; nothing else is on this machine
    // that would not be on a fresh cloud VM.
    dockerfile: distroDockerfile(distro.id, { packages: ["curl", "ca-certificates"], fail: die }),
    extraRunArgs: ["--add-host", `${HOST_ALIAS}:host-gateway`],
    // The shell below is the point of the run, and a Ctrl-C in it reaches this
    // process too — destroying the machine out from under someone who only
    // meant to abort a command would be unhelpful. Cleanup is explicit, after
    // they exit.
    keep: true,
    die,
    log: containerLog,
  });

  const oneLiner = rehearsalOneLiner(baseUrl);
  const notes = [
    "",
    "──────────────────────────────────────────────────────────────────────",
    `  A fresh ${distro.label} machine is up, with no sudo and nothing`,
    "  installed. You are about to get a shell on it as `operator`.",
    "",
    "  Paste this inside — it is the real one-liner, pointed at a local",
    "  release channel serving the build you just made:",
    "",
    `    ${oneLiner}`,
    "",
    `  Serving: ${path.basename(tarball)}`,
    `  The Core will be reachable from this machine on port ${hostPort}.`,
    hostPort === DEFAULT_HOST_PORT
      ? "  The pairing token it prints can be pasted into a Panel as-is."
      : `  NOTE: the printed token will say :${CONTAINER_PORT} — edit it to :${hostPort}`,
    "",
    "  Walk-through:  docs/harness-linux-rehearsal.md",
    "  Type `exit` when you are done and this machine is destroyed.",
    "──────────────────────────────────────────────────────────────────────",
    "",
  ];
  console.log(notes.join("\n"));

  // A real login session, the same way the e2es reach the operator — without
  // one, `systemctl --user` and the linger prompt behave in ways no operator
  // ever sees. Interactive here, rather than scripted.
  const shell = run(
    "docker",
    ["exec", "-it", name, "machinectl", "shell", "--quiet", `${OPERATOR}@`, "/bin/bash", "-l"],
    { stdio: "inherit" },
  );

  toreDown = true;
  server.stop();
  if (args.keep === true) {
    log(`--keep: machine ${name} is still running`);
    log(`  get back in with: docker exec -it ${name} machinectl shell ${OPERATOR}@`);
    log(`  destroy it with:  docker rm -f ${name}`);
  } else {
    run("docker", ["rm", "-f", machine.name]);
    log("machine destroyed");
  }
  fs.rmSync(workDir, { recursive: true, force: true });
  process.exit(shell.status === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error(`[rehearse] unexpected error: ${err.stack || err.message}`);
  process.exit(1);
});
