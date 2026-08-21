#!/usr/bin/env node
// Smoke test — the Core image boots, and a Panel pairs with it (ADR 0016 D36).
//
// This is what replaced `panel-e2e-core-in-a-box`, and it is a straight
// upgrade rather than a rename: that job booted a systemd fixture with
// `--privileged` and the host cgroup so `actana setup` had a machine to install
// a tarball onto, and it asserted pairing against bytes no operator ever
// receives. Nothing here is privileged, there is no init system, and the image
// under test is the one CI pushes.
//
// It does NOT replace the installer e2e (`e2e-actana-setup-linux.mjs`, D36).
// The two share the daemon binary and nothing else: different arrival (`docker
// pull` vs a checksum-verified `curl | bash`), different PID 1, different
// service management, different install location, and lifecycle verbs that are
// deliberately degraded here.
//
// The legs, in order:
//
//   • the built image's config carries tini as ENTRYPOINT and drops to `core`;
//   • a plain `docker run` — no privileges, no host mounts — boots the daemon
//     and mints an identity on the empty volume, printing no credential at all;
//   • tini is PID 1 and the daemon is a child of PID 1 (D14), read out of /proc;
//   • the lifecycle verbs the image owns refuse, and each names its Docker
//     equivalent rather than just saying no (D16);
//   • `docker compose exec core actana pair new` mints a one-time code inside
//     the container, and a real Panel — booted as the deployable it is — checks
//     the CA fingerprint, spends the code in "Add Core", and the panel link
//     reports the Core connected;
//   • `docker restart` is a no-op for pairing: same identity, still no
//     credential in the log, and the same Panel reconnects untouched (D17);
//   • and destroying the volume — the `docker compose down -v` motion — is the
//     one thing that unpairs: the replacement Core mints a different identity
//     and the Panel's stored credentials stop opening it.
//
// Needs a Docker daemon and a built Panel (`pnpm build`). Everything it
// creates carries a unique suffix and is removed on exit; the image is left
// behind on purpose — CI scans and pushes the very bytes that passed.
//
// Usage:
//   node scripts/smoke-core-image.mjs [--image <tag>] [--skip-build]
//                                     [--target <linux-x64|linux-arm64>]
//                                     [--panel-entry <file>] [--timeout <ms>]
//
// --image <tag>     Image tag to build and/or run (default: actana-core:smoke)
// --skip-build      Run an already-built image instead of building first
// --target <id>     Also assert the baked tarball was built for this target,
//                   which is the failure a cross-architecture build produces
// --panel-entry <f> The built Panel server entry (default: the dist path)
// --timeout <ms>    Per-boot readiness wait (default: 120000)

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseArgs, stringFlag } from "./lib/cli.mjs";
import { LISTENING_SENTINEL, makeDie, pickFreePort } from "./lib/core-smoke.mjs";
import {
  PANEL_SESSION_COOKIE,
  PanelLink,
  delay,
  pollUntil,
  startPanelService,
} from "./lib/panel-e2e.mjs";
import {
  CORE_APP_ROOT,
  CORE_HOME,
  CORE_REFUSED_VERBS,
  repoRoot,
} from "./lib/panel-image.mjs";

const die = makeDie("core-image-smoke");
const log = (message) => console.log(`[core-image-smoke] ${message}`);

const args = parseArgs(process.argv.slice(2));
const image = stringFlag(args, "image", die) ?? "actana-core:smoke";
const target = stringFlag(args, "target", die);
const timeoutMs = Number(stringFlag(args, "timeout", die) ?? 120_000);
// `Number("abc")` is NaN and `Date.now() >= NaN` is false forever, so a
// mistyped timeout would hang every wait below rather than fail.
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) die(`--timeout must be a positive number of ms`);

const suffix = `${process.pid}-${Date.now().toString(36)}`;
const OPERATOR = { name: "Smoke Operator", password: "smoke-operator-passphrase" };

/** The identity the daemon mints into its volume on first boot. */
const MATERIAL_FILE = `${CORE_HOME}/.config/actana/material.json`;

const DIAL_TIMEOUT_MS = 60_000;

/** Everything to take away on the way out, newest first. */
const teardown = [];
process.on("exit", () => {
  for (const undo of teardown.reverse()) {
    try {
      undo();
    } catch {
      /* a failed cleanup must not mask the failure being cleaned up after */
    }
  }
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(1));

function docker(dockerArgs, { allowFailure = false } = {}) {
  const result = spawnSync("docker", dockerArgs, { encoding: "utf8" });
  if (result.error) die(`docker ${dockerArgs[0]}: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    die(`docker ${dockerArgs.join(" ")} exited ${result.status}:\n${result.stderr}`);
  }
  return result;
}

/**
 * A Core container on a fresh named volume, booted the way the reference
 * compose boots one: no privileges, no host paths, one volume, and the public
 * host and port as environment.
 *
 * `ACTANA_PORT` is set rather than left at 8443 so the published port and the
 * port inside agree — a pairing hands the Panel this Core's own
 * `publicHost:port` as the endpoint it will dial, and a Core whose published
 * port differed would hand back an address nothing answers on.
 */
async function bootCore(name, { port } = {}) {
  const id = `actana-core-smoke-${name}-${suffix}`;
  const containerName = id;
  const volumeName = id;
  port ??= await pickFreePort();

  docker(["volume", "create", volumeName]);
  teardown.push(() => docker(["volume", "rm", "-f", volumeName], { allowFailure: true }));
  teardown.push(() => docker(["rm", "-f", containerName], { allowFailure: true }));

  const container = {
    name: containerName,
    volume: volumeName,
    port,
    endpoint: `wss://127.0.0.1:${port}`,
    /** Boots this container has announced and `waitForCoreLink` has consumed. */
    boots: 0,
    /**
     * The container's output. `tail: "all"` is not a nicety — the "no
     * credential is ever printed" assertion reads the whole life of the
     * container, and a truncated tail would let a PEM header scroll out of
     * sight and the check pass.
     */
    logs: (tail = "60") => {
      const result = docker(["logs", "--tail", tail, containerName], { allowFailure: true });
      return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    },
    exec: (argv, options) => docker(["exec", containerName, ...argv], options),
    start: () => {
      docker([
        "run",
        "--detach",
        "--name",
        containerName,
        "--restart",
        "unless-stopped",
        "--publish",
        `127.0.0.1:${port}:${port}`,
        "--env",
        "ACTANA_PUBLIC_HOST=127.0.0.1",
        "--env",
        `ACTANA_PORT=${port}`,
        "--env",
        `ACTANA_LABEL=${name}`,
        "--volume",
        `${volumeName}:${CORE_HOME}`,
        image,
      ]);
    },
  };

  container.start();
  await waitForCoreLink(container);
  return container;
}

/**
 * Wait until the *daemon* says it is listening — never until the published
 * port answers.
 *
 * Docker binds `127.0.0.1:${port}` on the host when the container starts, and
 * `docker-proxy` completes the handshake whether or not anything inside is
 * listening yet. A TCP probe therefore returns on its first iteration, before
 * `loadOrMintMaterial()` has written the blob this script then reads, and the
 * same vacuous wait is used by the restart and second-boot legs too.
 *
 * `core-entry` prints `@@AC_CORE_LISTENING@@` once `PtyCoreLinkServer` is
 * actually listening, and it prints it *after* minting and persisting — so a
 * wait that ends on the sentinel guarantees the blob is on disk. `docker logs`
 * survives a restart, so each boot is counted rather than merely looked for:
 * `container.boots` is the number of sentinels this container has already
 * announced, and the wait ends only on the next one.
 */
async function waitForCoreLink(container) {
  const deadline = Date.now() + timeoutMs;
  const expected = container.boots + 1;
  for (;;) {
    const logs = container.logs("all");
    if (logs.split(LISTENING_SENTINEL).length - 1 >= expected) {
      container.boots = expected;
      return;
    }
    // A container that died has nothing left to announce, so waiting out the
    // full timeout would only delay the same failure and bury the reason.
    if (!isRunning(container)) {
      die(`${container.name} exited before it announced boot ${expected}:\n${logs}`);
    }
    if (Date.now() >= deadline) {
      die(
        `${container.name} never announced boot ${expected} (${LISTENING_SENTINEL}) ` +
          `within ${timeoutMs}ms. Container logs:\n${logs}`,
      );
    }
    await delay(500);
  }
}

/** Whether Docker still considers the container running. */
function isRunning(container) {
  const result = docker(["inspect", "--format", "{{.State.Running}}", container.name], {
    allowFailure: true,
  });
  return result.status === 0 && result.stdout.trim() === "true";
}

/**
 * Every process in the container, as `{pid, ppid, comm, cmdline}`.
 *
 * Read out of `/proc` by a shell loop rather than with `ps`: the Core image
 * installs no `procps`, and a smoke that needs a package the image does not
 * ship would be asserting against something other than the shipped bytes.
 * `ppid` is field 4 of `/proc/<pid>/stat`, counted after the `)` that closes
 * the comm field — a comm containing a space or a bracket makes every
 * field-number-from-the-left answer wrong, which is the classic way to read
 * this file incorrectly.
 *
 * `comm` and `cmdline` are both read because they answer different questions.
 * `comm` is a 15-byte *thread* name the process can rename at will — Node
 * renames its main thread to `MainThread`, so `comm` never says `node` for the
 * daemon. `cmdline` is argv, NUL-separated, and its argv[0] is the path the
 * kernel was asked to execute. Tab-delimited because argv contains spaces and
 * `comm` may too; `cmdline` is last so it can hold the rest of the line.
 */
const PROC_TABLE_SH = [
  "for p in /proc/[0-9]*; do",
  '  [ -r "$p/stat" ] || continue;',
  // Every read is `cat … 2>/dev/null`, including the one feeding `tr`: a
  // process can exit between the glob and the read, and a redirect that fails
  // is reported by the *shell*, which `tr`'s own 2>/dev/null would not silence.
  // The loser of that race is a blank line the parser drops.
  `  printf '%s\\t%s\\t%s\\t%s\\n' "\${p#/proc/}" "$(sed -e 's/.*) //' "$p/stat" 2>/dev/null | cut -d' ' -f2)" "$(cat "$p/comm" 2>/dev/null)" "$(cat "$p/cmdline" 2>/dev/null | tr '\\0' ' ')";`,
  "done",
].join("\n");

function processTable(container) {
  const read = container.exec(["sh", "-c", PROC_TABLE_SH]);
  return read.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([pid, ppid, comm]) => pid?.trim() && ppid?.trim() && comm?.trim())
    .map(([pid, ppid, comm, cmdline]) => ({
      pid: Number(pid.trim()),
      ppid: Number(ppid.trim()),
      comm: comm.trim(),
      // Empty for a kernel thread, and for anything whose /proc entry vanished
      // between the two reads. Neither is the daemon, so an empty string is a
      // non-match rather than a special case.
      cmdline: (cmdline ?? "").trim(),
      argv0: (cmdline ?? "").trim().split(/\s+/)[0] ?? "",
    }));
}

/** The process table as a failure message reads it — `ps`-shaped, pid order. */
function formatProcesses(processes) {
  return ["  PID  PPID COMM            COMMAND"]
    .concat(
      [...processes]
        .sort((a, b) => a.pid - b.pid)
        .map(
          (p) =>
            `${String(p.pid).padStart(5)} ${String(p.ppid).padStart(5)} ` +
            `${p.comm.padEnd(15)} ${p.cmdline}`,
        ),
    )
    .join("\n");
}

/**
 * The identity this Core minted into its volume.
 *
 * Read out of `material.json` rather than off a printed artifact, because since
 * #287 there is no printed artifact: a Core emits nothing, and what an operator
 * does instead is `actana pair new`. `coreId` and `caCert` are what the
 * assertions below compare across a restart and across a destroyed volume.
 */
function readIdentity(container) {
  const read = container.exec(["cat", MATERIAL_FILE], { allowFailure: true });
  if (read.status !== 0) {
    die(`no material at ${MATERIAL_FILE} in ${container.name}:\n${container.logs()}`);
  }
  let material;
  try {
    material = JSON.parse(read.stdout);
  } catch {
    return die(`${MATERIAL_FILE} in ${container.name} is not JSON`);
  }
  for (const field of ["coreId", "caCert", "bearerSecret"]) {
    if (typeof material[field] !== "string" || material[field] === "") {
      die(`${MATERIAL_FILE} in ${container.name} has no usable ${field}`);
    }
  }
  return { coreId: material.coreId, caCert: material.caCert, bearerSecret: material.bearerSecret };
}

/**
 * `actana pair new` inside the container — the operator's actual gesture.
 *
 * `pair` is deliberately not on the image's refusal table (ADR 0016 D13): it is
 * about *this* Core rather than its lifecycle, and enrolling a client on the
 * Core in front of you is the case a container makes most. The three labelled
 * lines it puts on stdout are the contract this parses.
 */
function pairNew(container, label) {
  const run = container.exec(["actana", "pair", "new", "--label", label], { allowFailure: true });
  if (run.status !== 0) {
    die(`\`actana pair new\` in ${container.name} exited ${run.status}:\n${run.stdout}${run.stderr}`);
  }
  const field = (name) => {
    const match = run.stdout.match(new RegExp(`^${name}\\s+(\\S+)$`, "m"));
    if (!match) die(`\`actana pair new\` printed no ${name} line:\n${run.stdout}`);
    return match[1];
  };
  const code = field("Pairing code");
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) die(`\`actana pair new\` printed ${code} as a code`);
  return { code, fingerprint: field("CA fingerprint"), sessionId: field("Session") };
}

// ─── The image, before anything runs ─────────────────────────────────────────

if (!args["skip-build"]) {
  log(`building ${image} from deploy/core.Dockerfile …`);
  // The build context is deploy/ and the tarball lives at the repo root under
  // artifacts/, which .dockerignore excludes — hence the named context. Same
  // invocation container-image.yml makes.
  const build = spawnSync(
    "docker",
    [
      "build",
      "--file",
      "deploy/core.Dockerfile",
      "--build-context",
      "tarball=artifacts/core",
      "--tag",
      image,
      "deploy",
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (build.status !== 0) {
    die(`docker build exited ${build.status} — is there a Core tarball in artifacts/core?`);
  }
}

// D14, on the built bytes: a Dockerfile line saying tini is the entrypoint is
// not evidence that the image carries it, and this is exactly the kind of
// clause a "simplify the Dockerfile" edit drops.
log("verifying the built image's entrypoint and identity …");
const config = JSON.parse(docker(["image", "inspect", "--format", "{{json .Config}}", image]).stdout);
if ((config?.Entrypoint ?? []).join(" ") !== "/usr/bin/tini --") {
  die(`${image} entrypoint is ${JSON.stringify(config?.Entrypoint)}, expected ["/usr/bin/tini","--"]`);
}
if ((config?.Cmd ?? []).join(" ") !== "actana daemon") {
  die(`${image} cmd is ${JSON.stringify(config?.Cmd)}, expected ["actana","daemon"]`);
}
if (config?.User !== "core") die(`${image} runs as ${JSON.stringify(config?.User)}, expected core`);

// ─── Boot 1: an empty volume mints an identity ───────────────────────────────

log("booting the Core on a clean volume …");
const core = await bootCore("first");
const first = readIdentity(core);
log(`the Core minted ${first.coreId} on the empty volume`);

// #287: a first boot emits no credential. It used to print one blob and write
// `registration-blob.txt` beside the material; both are gone, and the assertion
// that they stay gone belongs on the image that actually ships.
assertNoCredentialInLogs("the first boot");
if (core.exec(["test", "-e", `${CORE_HOME}/.config/actana/registration-blob.txt`], {
  allowFailure: true,
}).status === 0) {
  die("the first boot wrote a registration-blob.txt — the hand-carry is meant to be gone");
}

/** No boot, ever, puts credential material where an operator reads logs. */
function assertNoCredentialInLogs(what) {
  const logs = core.logs("all");
  if (/BEGIN (CERTIFICATE|PRIVATE KEY|RSA PRIVATE KEY)/.test(logs)) {
    die(`${what} printed certificate material into the log:\n${core.logs()}`);
  }
  if (logs.includes("@@AC_CORE_REGISTRATION_BLOB@@") || /paste this into your Panel/.test(logs)) {
    die(`${what} printed a registration blob:\n${core.logs()}`);
  }
}

// D12 — the identity is pinned by number, because a uid that exists nowhere on
// the host makes every bind-mounted repo unreadable to the operator who owns it.
const identity = core.exec(["id", "-u"]).stdout.trim() + ":" + core.exec(["id", "-g"]).stdout.trim();
if (identity !== "1000:1000") die(`the Core runs as ${identity}, expected 1000:1000`);

// D14 — node-pty forks a shell and the shell forks a Harness, so a Harness
// whose shell exited first reparents to PID 1. libuv only reaps children Node
// spawned itself, so a Core at PID 1 accumulates zombies until the PID table
// fills.
//
// What that needs is a topology, not an integer: tini at PID 1, and the daemon
// as tini's child rather than PID 1 itself. The daemon's own number is not the
// launcher's to promise — `bin/actana` is `#!/bin/sh` and runs `command -v`,
// `readlink` and a `cd -P` subshell before it `exec`s, each forking a PID that
// exits again, so `core-tarball.mjs` gaining or losing one `$(…)` would move
// it. Asserting PPID 1 fails in the case D14 is actually about (a daemon that
// *is* PID 1, reaping nothing) and in no other.
//
// Identified by argv[0], not by `comm`. `bin/actana` ends in
//
//   exec "$ACTANA_ROOT/node/bin/node" "$ACTANA_ROOT/app/actana-cli.cjs" "$@"
//
// so the daemon's argv[0] is the bundled Node's own path — a fact about what
// the launcher runs, which is what this assertion is about. `comm` cannot
// answer it: it is the *thread* name, capped at 15 bytes and renameable, and
// Node calls its main thread `MainThread`, so `comm === "node"` matched nothing
// and failed on every boot of a healthy image. Matching the basename rather
// than the whole path keeps the install root out of the predicate.
const isDaemon = (process) => /(^|\/)node$/.test(process.argv0);
const processes = processTable(core);
const pid1 = processes.find((process) => process.pid === 1);
if (pid1?.comm !== "tini") {
  die(`PID 1 is ${JSON.stringify(pid1?.comm)}, expected tini:\n${formatProcesses(processes)}`);
}
const daemon = processes.find((process) => isDaemon(process) && process.ppid === 1);
if (!daemon) {
  die(
    `no node process is a child of PID 1, so nothing is reaping the Harnesses ` +
      `node-pty orphans:\n${formatProcesses(processes)}`,
  );
}
log(`tini is PID 1 and the daemon (pid ${daemon.pid}) is its child`);

if (target) {
  // A cross-architecture tarball surfaces as `exec format error` at first boot
  // if nothing checks; naming the target says which build input was wrong.
  const manifest = core.exec(["cat", `${CORE_APP_ROOT}/core-manifest.json`]).stdout;
  const baked = JSON.parse(manifest)?.target;
  if (baked !== target) die(`the baked tarball reports target ${baked}, expected ${target}`);
  log(`the baked Core tarball is ${target}`);
}

// D16 — the verbs the image owns refuse *and* name the Docker command that
// does the same job. "Not available" on its own leaves an operator with a Core
// they cannot restart and nothing to type.
log("verifying the lifecycle verbs refuse and name their Docker equivalent …");
for (const verb of CORE_REFUSED_VERBS) {
  const refused = core.exec(["actana", verb], { allowFailure: true });
  const said = `${refused.stdout ?? ""}${refused.stderr ?? ""}`;
  if (refused.status === 0) die(`\`actana ${verb}\` succeeded in the container; it must refuse`);
  if (!said.includes("docker compose")) {
    die(`\`actana ${verb}\` refused without naming its Docker equivalent:\n${said.trim()}`);
  }
}
log(`${CORE_REFUSED_VERBS.join(", ")} all refuse with a Docker command to run instead`);

// #288, criterion 3 and D7 — the other half, and the half this issue exists
// for: **a client noun runs inside the image, with no `npm install` and no
// second binary.**
//
// The refusal loop above proves the machine verbs still refuse, which was
// already true before #288. What was not true is this: the Core installs the
// `actana-sessions` skill onto its own machine and that skill teaches
// `actana core ls`, `actana session start` and `actana events tail` — every
// one of which was `unknown command` to the `actana` on that machine's PATH.
//
// It is right today by *dispatch ordering* — `actana-cli.ts` checks
// `CLIENT_NOUNS` before it consults the container refusal table — and dispatch
// ordering is exactly the kind of thing a later refactor reorders silently. So
// it is run, in the image, against the binary the tarball actually staged.
//
// `core ls` is the right verb to ask first: it needs no credential and dials
// nothing, so a healthy answer is unambiguous. A refusal, an `unknown command`
// or a non-zero status is the regression.
log("verifying a client noun runs in the image with no npm install …");
const clientNoun = core.exec(["actana", "core", "ls"], { allowFailure: true });
const clientSaid = `${clientNoun.stdout ?? ""}${clientNoun.stderr ?? ""}`;
if (clientNoun.status !== 0) {
  die(
    `\`actana core ls\` exited ${clientNoun.status} in the container — a Session on this Core ` +
      `cannot drive Cores out of the box (#288 criterion 3):\n${clientSaid.trim()}`,
  );
}
if (/unknown command|does not run in a container/.test(clientSaid)) {
  die(`\`actana core ls\` is not this binary's verb in the container:\n${clientSaid.trim()}`);
}

// **And the registry is not empty.** Answering the verb was only half of
// criterion 3 — *"a fresh Session can run `actana core ls` **and** `actana
// session …`"*. Until #288 D9 reached the container this leg accepted the
// empty-registry sentence, which meant every session verb on this machine
// answered `no Core registered` while the `actana-sessions` skill the Core
// installs said the opposite: *"on a machine that is itself a Core, that Core is
// already registered and already selected"*. The daemon now wires itself into
// its own machine's registry at boot (`core-self-register.ts`), and this is
// where that becomes a property of the built image rather than a unit test.
if (/No Cores registered/.test(clientSaid)) {
  die(
    "`actana core ls` found an empty registry in the container — this Core did not register " +
      "itself with its own CLI, so every `actana session …` here answers `no Core registered` " +
      "and the installed skill's rule is false on this machine (#288 D9, criterion 3):\n" +
      clientSaid.trim(),
  );
}
const registry = JSON.parse(core.exec(["actana", "core", "ls", "--json"]).stdout);
const selected = registry.filter((row) => row.current);
if (selected.length !== 1) {
  die(
    `expected exactly one selected Core in the container's registry, found ${selected.length}: ` +
      JSON.stringify(registry),
  );
}
// The loopback address, not `ACTANA_PUBLIC_HOST`: the CLI doing the dialling
// shares a network namespace with the daemon, and the public host is the address
// *other* machines use — here it may not route at all. Every server cert carries
// 127.0.0.1 in its SAN for exactly this dial.
if (selected[0].endpoint !== `wss://127.0.0.1:${core.port}`) {
  die(
    `the container's own Core is registered at ${selected[0].endpoint}, expected ` +
      `wss://127.0.0.1:${core.port} — a Session here dials the Core over loopback`,
  );
}
log(`the container's own Core is registered as ${selected[0].name} and selected`);

// The second verb of criterion 3, end to end: this one dials, authenticates
// with the bearer out of the registry entry the daemon just wrote, and reads a
// frame back. `core ls` passing while this fails is precisely the gap #294's
// review found, so it is asserted rather than inferred.
const sessions = core.exec(["actana", "session", "ls", "--json"], { allowFailure: true });
const sessionsSaid = `${sessions.stdout ?? ""}${sessions.stderr ?? ""}`;
if (sessions.status !== 0) {
  die(
    `\`actana session ls\` exited ${sessions.status} on the Core's own machine — criterion 3 ` +
      `asks for \`core ls\` *and* \`session …\`:\n${sessionsSaid.trim()}`,
  );
}
if (!Array.isArray(JSON.parse(sessions.stdout))) {
  die(`\`actana session ls --json\` did not answer with a list:\n${sessionsSaid.trim()}`);
}
log("`actana session ls` reaches this Core from inside its own container");
// The same binary answered a machine verb a moment ago, and it is the tarball's
// — so this is D7's "running it inside the image answers both an operator verb
// and a client noun", proven on the built image rather than argued.
const version = core.exec(["actana", "--version"]);
if (!/^actana \d+\.\d+\.\d+/.test((version.stdout ?? "").trim())) {
  die(`\`actana --version\` did not answer as the unified CLI:\n${(version.stdout ?? "").trim()}`);
}
log("`actana core ls` answers in the image, from the same binary as `actana --version`");

// ─── A Panel pairs with it ───────────────────────────────────────────────────

const panelEntry = path.resolve(
  stringFlag(args, "panel-entry", die) ??
    path.join(repoRoot, "packages", "panel", "dist", "server", "server.js"),
);
if (!fs.existsSync(panelEntry)) die(`no built Panel at ${panelEntry} — run \`pnpm build\` first`);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-core-image-panel-"));
teardown.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));

log("booting the Panel …");
const panel = await startPanelService({
  bin: path.join(repoRoot, "packages", "panel", "bin", "panel.mjs"),
  serverEntry: panelEntry,
  dataDir,
  port: await pickFreePort(),
  log,
}).catch((err) => die(`the Panel service failed to boot: ${err.message}`, err.logLines));
teardown.push(() => panel.kill());

const setup = await panel.client.post("/api/auth/setup", OPERATOR);
if (setup.status !== 200) die(`POST /api/auth/setup → ${setup.status}: ${setup.text.slice(0, 200)}`);
if (!panel.client.jar.get(PANEL_SESSION_COOKIE)) die("setup issued no session cookie");

// The operator's two steps, in order: mint a code on the Core, then check the
// fingerprint the Panel is presented against the one the Core printed before
// the code goes anywhere.
const enrollment = pairNew(core, "smoke-panel");
const inspected = await panel.client.post("/api/cores/pairing/inspect", {
  address: `127.0.0.1:${core.port}`,
});
if (inspected.status !== 200) {
  die(`pairing inspect → ${inspected.status}: ${inspected.text.slice(0, 200)}`);
}
if (inspected.body?.identity?.fingerprint !== enrollment.fingerprint) {
  die(
    `the Panel was presented ${inspected.body?.identity?.fingerprint}, but this Core printed ` +
      `${enrollment.fingerprint} — the fingerprint an operator compares is not the one dialled`,
  );
}

const added = await panel.client.post("/api/cores/pairing", {
  address: `127.0.0.1:${core.port}`,
  code: enrollment.code,
  sessionId: enrollment.sessionId,
  expectedFingerprint: enrollment.fingerprint,
  label: "smoke",
});
if (added.status !== 201) die(`pair Core → ${added.status}: ${added.text.slice(0, 200)}`);
// The Panel's registry key, not the Core's self-identity. `newCoreId()` in
// packages/panel/src/server/services/cores.ts mints a fresh `core_` handle per
// registration and nothing in that path adopts the bearer's `coreId` — the two
// share a prefix and nothing else. Asserting they are equal was asserting a
// contract that does not exist; what proves the pairing reached *this* Core is
// the dial below, which only a certificate this Core's CA signed can complete.
const coreId = added.body?.core?.id;
if (typeof coreId !== "string" || !coreId) {
  die(`the Panel registered the Core without returning an id: ${added.text.slice(0, 200)}`);
}

await assertConnects("the first pairing");
log(`the Panel is paired with ${coreId} over the core-link`);

/** Open a link and wait for the dial-status frame only the Panel can report. */
async function assertConnects(what) {
  const link = await PanelLink.open(panel.origin, panel.client.jar).catch((err) =>
    die(`${what}: the panel link would not open: ${err.message}`),
  );
  try {
    await link.waitFor(
      (f) => f.t === "dial" && f.status.coreId === coreId && f.status.state === "connected",
      { timeoutMs: DIAL_TIMEOUT_MS, label: `${what}: core ${coreId} to reach connected` },
    );
  } catch (err) {
    die(`${what}: ${err.message}\nCore logs:\n${core.logs()}`);
  } finally {
    link.close();
  }
}

// ─── Restart is a no-op for pairing ──────────────────────────────────────────

// D17. The daemon mints on an *absent* material file and loads on a present
// one, so a restart re-enters the load branch: the same CA, the same coreId, and
// every client paired before it still paired.
log("restarting the container — pairing must survive it untouched …");
docker(["restart", core.name]);
await waitForCoreLink(core);

const afterRestart = readIdentity(core);
if (afterRestart.coreId !== first.coreId) {
  die(`restart re-minted the identity: ${first.coreId} → ${afterRestart.coreId}`);
}
if (afterRestart.caCert !== first.caCert) {
  die("restart replaced the CA, so every paired client would be locked out");
}
assertNoCredentialInLogs("a restart");

await assertConnects("after a restart");
log("restart is a no-op for pairing — same identity, nothing emitted, still connected");

// ─── `down -v` is the only thing that unpairs ────────────────────────────────

// The volume is the pairing. Taking it away is what `docker compose down -v`
// does, and the replacement Core is a different Core — which is the honest
// answer, not a bug: the CA, the bearer secret and the Panel's client
// certificate all lived in that volume.
log("destroying the volume — the `down -v` motion …");
const staleEndpointPort = core.port;
docker(["rm", "-f", core.name]);
docker(["volume", "rm", "-f", core.volume]);

// On the *same* published port the destroyed Core had, so the Panel's stored
// endpoint still reaches something. Boot it anywhere else and the dial fails
// with "connection refused", which would prove nothing about the credentials —
// the claim under test is that the material is gone, not that the container is.
const replacement = await bootCore("replacement", { port: staleEndpointPort });
const second = readIdentity(replacement);
if (second.coreId === first.coreId) {
  die("a Core booted on a destroyed volume kept its identity — `down -v` did not unpair");
}
if (second.caCert === first.caCert || second.bearerSecret === first.bearerSecret) {
  die("a Core booted on a destroyed volume reused its old credentials");
}

// And the Panel, which still holds the old pairing and is still dialling the
// address the replacement now answers on, must say so rather than sit in
// `connecting` or — much worse — reach `connected` against a Core that no
// longer shares its CA.
const stale = await pollUntil(
  "the Panel to report the old pairing no longer opens this Core",
  DIAL_TIMEOUT_MS,
  async () => {
    const listed = await panel.client.get("/api/cores");
    const entry = listed.body?.cores?.find((c) => c.id === coreId);
    if (!entry) die("the Core vanished from the Panel's registry when its volume did");
    return entry.dial?.state && entry.dial.state !== "connected" ? entry.dial : null;
  },
  { pollMs: 500 },
).catch((err) => die(`${err.message} — the Panel never noticed the unpairing`));
log(`the Panel reports the old pairing as ${stale.state}: \`down -v\` unpaired it`);

log(
  "PASS — the Core image boots unprivileged, emits no credential, pairs a Panel by code, " +
    "survives restart, unpairs on down -v",
);
process.exit(0);
