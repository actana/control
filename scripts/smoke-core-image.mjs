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
//   • the built image's config carries tini + entrypoint, starts as root (the
//     entrypoint's one step), and has no HOME and no identity variables baked in;
//   • a `docker run` with exactly the capability set compose gives the Core
//     (cap-drop ALL, SETUID and SETGID, no-new-privileges) boots the daemon and
//     mints an identity on the empty volume, printing no credential at all;
//   • tini is PID 1 and the daemon is a child of PID 1 (D14), read out of /proc;
//   • the privilege model (#559), read out of /proc and compared line for line:
//     the daemon's node process is `actana` (1001) with CAP_SETUID and CAP_SETGID
//     as its inheritable, permitted, effective, ambient and bounding sets and
//     no-new-privs; no process at all is root (tini, PID 1, is actana too, so it
//     can forward SIGTERM: `docker stop` exits 0 and the daemon logs its shutdown;
//     it reaps orphans); a planted `actana` in the home never runs; a Session — opened over the
//     core-link the way a client opens one — is `core` (1000) with no capability
//     in any set but the bounding set, and so is a `core exec` child; a Session
//     cannot read the state, `setuid` back, or signal the daemon; its terminal
//     works; and a Session that ignores HUP and TERM dies when it is stopped;
//   • the entrypoint refuses to start as 1000 or 1001, with a bounding set that is
//     not exactly SETUID and SETGID, and with a state volume of the wrong owner or
//     mode, without repairing it;
//   • no setuid, setgid or file capability anywhere in the image, no sudo;
//   • the lifecycle verbs the image owns refuse, and each names its Docker
//     equivalent rather than just saying no (D16);
//   • `docker exec -u actana core actana pair new` mints a one-time code
//     inside the container (as `core` it cannot), and a real Panel — booted as the deployable it is —
//     checks the CA fingerprint, spends the code in "Add Core", and the panel
//     link reports the Core connected;
//   • `docker restart` is a no-op for pairing: same identity, still no
//     credential in the log, and the same Panel reconnects untouched (D17);
//   • the daemon's state (material, pairings, database) is in /var/lib/actana on
//     a volume of its own, and the home volume holds none of it (#559); a hook
//     miss a Session appends to the drop box is read back by the daemon;
//   • destroying the home volume alone does not unpair, and destroying the state
//     volume — the `docker compose down -v` motion — is the one thing that does:
//     the replacement Core mints a different identity and the Panel's stored
//     credentials stop opening it.
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
import {
  FILE_CAPABILITY_SCAN,
  LISTENING_SENTINEL,
  checkProcessStatus,
  credentialFromMaterial,
  makeDie,
  openCoreSession,
  pickFreePort,
  checkNoRootProcesses,
  parseStatusScan,
  checkRootOwnedDirs,
  pathFromEnviron,
} from "./lib/core-smoke.mjs";
import {
  PANEL_SESSION_COOKIE,
  PanelLink,
  delay,
  pollUntil,
  startPanelService,
} from "./lib/panel-e2e.mjs";
import {
  CORE_APP_ROOT,
  CORE_DAEMON_CAPS,
  CORE_DAEMON_USER,
  CORE_HOME,
  CORE_HOOK_DROP_DIR,
  CORE_STATE_DATA_DIR,
  CORE_STATE_DIR,
  CORE_STATE_MATERIAL_FILE,
  CORE_REFUSED_VERBS,
  CORE_SESSION_USER,
  repoRoot,
} from "./lib/panel-image.mjs";
import { ensurePanelDatabase } from "./lib/postgres-fixture.mjs";
import { classifySessionStart } from "./lib/tarball-offline.mjs";

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

/** The identity the daemon mints into its state volume on first boot (#559). */
const MATERIAL_FILE = CORE_STATE_MATERIAL_FILE;

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
 * The capability flags the reference compose gives the Core (`cap_drop: ALL`,
 * `cap_add: SETUID SETGID`, `no-new-privileges`), as `docker run` spells them.
 * The smoke boots the Core with exactly these and nothing more, and a test
 * holds the list to the compose file.
 */
/** Where the root entrypoint lives: a root-owned directory of its own. */
const ENTRYPOINT_PATH = "/usr/libexec/actana/core-entrypoint.sh";

const COMPOSE_CORE_FLAGS = [
  "--cap-drop",
  "ALL",
  ...CORE_DAEMON_CAPS.flatMap((cap) => ["--cap-add", cap]),
  "--security-opt",
  "no-new-privileges:true",
];

/**
 * A Core container on a fresh named volume, booted the way the reference
 * compose boots one: the compose capability set and nothing else, no host paths,
 * two volumes (home and state, #559), and the public host and port as
 * environment.
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
  const stateVolumeName = `${id}-state`;
  port ??= await pickFreePort();

  docker(["volume", "create", volumeName]);
  teardown.push(() => docker(["volume", "rm", "-f", volumeName], { allowFailure: true }));
  docker(["volume", "create", stateVolumeName]);
  teardown.push(() => docker(["volume", "rm", "-f", stateVolumeName], { allowFailure: true }));
  teardown.push(() => docker(["rm", "-f", containerName], { allowFailure: true }));

  const container = {
    name: containerName,
    volume: volumeName,
    stateVolume: stateVolumeName,
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
    /**
     * `docker exec`, as `core` unless `options.user` says otherwise: a plain
     * `docker exec` is root with no DAC override (#559, D3), and the legs that
     * mean a Session's view say `core` out loud rather than lean on a default.
     */
    exec: (argv, { user = CORE_SESSION_USER.name, ...options } = {}) =>
      docker(["exec", "-u", user, containerName, ...argv], options),
    start: () => {
      docker([
        "run",
        "--detach",
        "--name",
        containerName,
        "--restart",
        "unless-stopped",
        ...COMPOSE_CORE_FLAGS,
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
        "--volume",
        `${stateVolumeName}:${CORE_STATE_DIR}`,
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
  // As the daemon's own user: the state is 0700 actana, which is the point.
  const read = container.exec(["cat", MATERIAL_FILE], { user: CORE_DAEMON_USER.name, allowFailure: true });
  if (read.status !== 0) {
    die(`no material at ${MATERIAL_FILE} in ${container.name}:\n${read.stderr}\n${container.logs()}`);
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
  // `-u actana`: pairing reads the identity from disk, and only the daemon's user can (D7).
  const run = container.exec(["actana", "pair", "new", "--label", label], {
    user: CORE_DAEMON_USER.name,
    allowFailure: true,
  });
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
// clause a "simplify the Dockerfile" edit drops. #559: the image starts as root
// for the entrypoint's one step, and carries neither a HOME nor the identity of
// `core` in its environment (a `docker exec -u core` CLI must not believe it is
// the daemon).
log("verifying the built image's entrypoint and identity …");
const config = JSON.parse(docker(["image", "inspect", "--format", "{{json .Config}}", image]).stdout);
// The entrypoint is the script; it execs tini after the switch, so tini is PID 1
// as the daemon's user (checked below on the running container).
if ((config?.Entrypoint ?? []).join(" ") !== ENTRYPOINT_PATH) {
  die(`${image} entrypoint is ${JSON.stringify(config?.Entrypoint)}, expected [${JSON.stringify(ENTRYPOINT_PATH)}]`);
}
// The image PATH has no directory `core` can write (a Session's planted `actana` would
// otherwise run for `docker exec -u actana … actana pair new`, or as root for a plain exec).
{
  const imagePath = (config?.Env ?? []).find((e) => e.startsWith("PATH="))?.slice(5) ?? "";
  if (!imagePath.startsWith("/opt/actana/bin:") || /\/home\/|\.local/.test(imagePath)) {
    die(`${image} PATH is ${JSON.stringify(imagePath)}: it must start with /opt/actana/bin and name no directory under the home`);
  }
}
// An absolute path: a PATH lookup after the switch would find a Session's planted `actana`.
if ((config?.Cmd ?? []).join(" ") !== "/opt/actana/bin/actana daemon") {
  die(`${image} cmd is ${JSON.stringify(config?.Cmd)}, expected ["/opt/actana/bin/actana","daemon"]`);
}
if (config?.User !== "0:0") {
  die(`${image} starts as ${JSON.stringify(config?.User)}, expected "0:0" (the entrypoint's switch)`);
}
for (const baked of (config?.Env ?? []).filter((e) => /^(HOME|AC_CORE_HOME|AC_CORE_UID|AC_CORE_GID)=/.test(e))) {
  die(`${image} bakes ${baked}; HOME is set by the runtime per user and the daemon's identity by the entrypoint`);
}
if (config?.WorkingDir !== "/") {
  die(`${image} WORKDIR is ${JSON.stringify(config?.WorkingDir)}, expected "/" (root has no DAC override in ${CORE_HOME})`);
}

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

// D12 and #559 — both users are pinned by number, because a uid that exists
// nowhere on the host makes every bind-mounted repo unreadable to the operator
// who owns it, and because the privilege model compares them.
for (const user of [CORE_SESSION_USER, CORE_DAEMON_USER]) {
  const numbers = core.exec(["sh", "-c", "printf %s:%s \"$(id -u)\" \"$(id -g)\""], { user: user.name }).stdout.trim();
  if (numbers !== `${user.uid}:${user.gid}`) die(`${user.name} is ${numbers}, expected ${user.uid}:${user.gid}`);
}
// HOME is the runtime's, per user: no ENV baked it.
for (const user of [CORE_SESSION_USER, CORE_DAEMON_USER]) {
  const wanted = user === CORE_SESSION_USER ? CORE_HOME : CORE_STATE_DIR;
  const home = core.exec(["sh", "-c", "printf %s \"$HOME\""], { user: user.name }).stdout.trim();
  if (home !== wanted) die(`HOME for ${user.name} is ${JSON.stringify(home)}, expected ${wanted}`);
}

// A login shell of core's (what `docker exec -u core core bash -l` and a Session's shell
// are) leads with the home's own bin, where Harness CLIs are installed; the image PATH
// does not. Both halves are the point: the image PATH names no directory under the home
// (checked on the config above), and core still finds its own tools.
{
  const loginPath = core.exec(["bash", "-lc", 'printf %s "$PATH"']).stdout.trim();
  if (loginPath.split(":")[0] !== `${CORE_HOME}/.local/bin`) {
    die(`a login shell of core has PATH ${JSON.stringify(loginPath)}: it must lead with ${CORE_HOME}/.local/bin`);
  }
}

// D3 — a plain `docker exec` is root, and that root has no DAC override: it
// reads neither the home nor the state. What an operator types is `-u core` or
// `-u actana`, and the compose file says so.
const rootExec = docker(["exec", core.name, "sh", "-c", "id -u; cat /proc/self/status"]).stdout;
if (rootExec.split("\n")[0] !== "0") die(`docker exec without -u is not root:\n${rootExec}`);
const rootCaps = rootExec.match(/^CapEff:\s+([0-9a-f]+)$/m)?.[1];
if (rootCaps !== "00000000000000c0") {
  die(`a plain docker exec holds CapEff=${rootCaps}, expected only SETUID and SETGID (00000000000000c0)`);
}
for (const unreadable of [CORE_HOME, MATERIAL_FILE, `${CORE_STATE_DIR}/data/missioncontrol.db`]) {
  const read = docker(["exec", core.name, "sh", "-c", `ls ${unreadable} 2>&1 >/dev/null || cat ${unreadable} 2>&1 >/dev/null`], {
    allowFailure: true,
  });
  const text = `${read.stdout}${read.stderr}`;
  if (!/Permission denied/.test(text)) {
    die(`root without a DAC override read ${unreadable} through a plain docker exec:\n${text}`);
  }
}
log("a plain docker exec is root with CAP_SETUID and CAP_SETGID only: it reads neither the home nor the state");

// #558 — sudo is gone from the image, not merely deconfigured.
if (core.exec(["sh", "-c", "command -v sudo"], { allowFailure: true }).status === 0) {
  die("sudo is on PATH — the package must be absent from the Core image (#558)");
}
if (core.exec(["test", "-e", "/etc/sudoers.d/core"], { allowFailure: true }).status === 0) {
  die("/etc/sudoers.d/core exists — NOPASSWD sudoers must be gone (#558)");
}
if (core.exec(["test", "-e", "/usr/local/libexec/core-fs-prep-wrap"], { allowFailure: true }).status === 0) {
  die("setuid prep wrap is in the image — it must be gone (#558)");
}
const setuidLeft = docker(
  ["run", "--rm", "-u", "0", "--entrypoint", "find", image, "/", "-xdev", "-type", "f", "-perm", "/6000"],
  { allowFailure: true },
);
if (setuidLeft.status !== 0) {
  die(`setuid/setgid scan exited ${setuidLeft.status}:\n${setuidLeft.stderr}`);
}
if ((setuidLeft.stdout ?? "").trim()) {
  die(`image still has setuid/setgid files:\n${setuidLeft.stdout}`);
}
log("sudo binary, sudoers.d/core, setuid wrap and setuid/setgid bits are absent");

// #559 — no file capabilities either: a file capability or a setuid bit is how a
// Session would turn the daemon's two capabilities into more. `getcap -r /` is
// not in the image, so the scan reads the `security.capability` xattr of every
// file itself, after proving on a planted file that it can see one.
const fileCaps = docker(["run", "--rm", "-u", "0", "--entrypoint", "python3", image, "-c", FILE_CAPABILITY_SCAN], {
  allowFailure: true,
});
if (fileCaps.status !== 0) {
  die(`the file-capability scan could not run (exit ${fileCaps.status}), so it proves nothing:\n${fileCaps.stdout}${fileCaps.stderr}`);
}
if ((fileCaps.stdout ?? "").trim()) {
  die(`image has file capabilities (the equivalent of a non-empty \`getcap -r /\`):\n${fileCaps.stdout}`);
}
log("no file capability anywhere in the image (getcap -r / is empty)");

// #559 — the entrypoint does one thing as root and cannot do it as anybody
// else: a run as `core` or as `actana` (a `user:` in compose, `docker run -u`)
// stops with a sentence, and boots no daemon.
for (const user of [CORE_SESSION_USER, CORE_DAEMON_USER]) {
  const refused = docker(["run", "--rm", "-u", String(user.uid), ...COMPOSE_CORE_FLAGS, image], { allowFailure: true });
  const said = `${refused.stderr}${refused.stdout}`;
  if (refused.status === 0) die(`the image started as uid ${user.uid}; the entrypoint must refuse it`);
  if (!said.includes(`must start as root (uid 0), not uid ${user.uid}`)) {
    die(`a start as uid ${user.uid} did not refuse clearly (exit ${refused.status}):\n${said}`);
  }
  if (said.includes(LISTENING_SENTINEL)) die(`a start as uid ${user.uid} booted the daemon:\n${said}`);
}
log("the entrypoint refuses to start as core (1000) or as actana (1001)");

// The bounding set must be exactly the compose one: `setpriv` cannot narrow it
// without CAP_SETPCAP, so a wider set (a bare `docker run`'s default) is refused
// with the number named, and no daemon boots.
const wideBoot = docker(["run", "--rm", image], { allowFailure: true });
const wideSaid = `${wideBoot.stderr}${wideBoot.stdout}`;
if (wideBoot.status === 0 || !/the bounding set is [0-9a-f]+, expected 00000000000000c0/.test(wideSaid) || wideSaid.includes(LISTENING_SENTINEL)) {
  die(`a start with docker's default capabilities was not refused for its bounding set (exit ${wideBoot.status}):\n${wideSaid}`);
}
log("the entrypoint refuses a bounding set that is not exactly SETUID and SETGID");

// A state volume with the wrong owner or the wrong mode is a failure and is never
// repaired here, not even with a `chown -R`: the entrypoint says so and nothing changes.
for (const [label, seed, said] of [
  ["owner", `chown -R 0:0 ${CORE_STATE_DIR}`, `${CORE_STATE_DIR} is 0:0 700 (uid:gid mode), expected 1001:1001 700`],
  ["mode", `chown -R 1001:1001 ${CORE_STATE_DIR} && chmod 0755 ${CORE_STATE_DIR}`, `${CORE_STATE_DIR} is 1001:1001 755 (uid:gid mode), expected 1001:1001 700`],
]) {
  const wrongState = `actana-core-smoke-wrong${label}-${suffix}`;
  docker(["volume", "create", wrongState]);
  teardown.push(() => docker(["volume", "rm", "-f", wrongState], { allowFailure: true }));
  const seedWrong = docker(
    ["run", "--rm", "-u", "0", "--entrypoint", "sh", "--volume", `${wrongState}:${CORE_STATE_DIR}`, image, "-c", `mkdir -p ${CORE_STATE_DIR}/data && ${seed}`],
    { allowFailure: true },
  );
  if (seedWrong.status !== 0) die(`seeding a state volume with the wrong ${label} failed:\n${seedWrong.stderr}${seedWrong.stdout}`);
  const before = docker(["run", "--rm", "-u", "0", "--entrypoint", "stat", "--volume", `${wrongState}:${CORE_STATE_DIR}`, image, "-c", "%u:%g %a", CORE_STATE_DIR, `${CORE_STATE_DIR}/data`]).stdout;
  const wrongBoot = docker(["run", "--rm", ...COMPOSE_CORE_FLAGS, "--volume", `${wrongState}:${CORE_STATE_DIR}`, image], { allowFailure: true });
  const wrongSaid = `${wrongBoot.stderr}${wrongBoot.stdout}`;
  if (wrongBoot.status === 0 || !wrongSaid.includes(said) || wrongSaid.includes(LISTENING_SENTINEL)) {
    die(`a state volume with the wrong ${label} did not stop the entrypoint with it named (exit ${wrongBoot.status}):\n${wrongSaid}`);
  }
  const after = docker(["run", "--rm", "-u", "0", "--entrypoint", "stat", "--volume", `${wrongState}:${CORE_STATE_DIR}`, image, "-c", "%u:%g %a", CORE_STATE_DIR, `${CORE_STATE_DIR}/data`]).stdout;
  if (after !== before) die(`the entrypoint changed a state volume it refused (${label}): ${before.trim()} -> ${after.trim()}`);
}
log("a state volume with the wrong owner or the wrong mode stops the entrypoint, which repairs nothing");

for (const [owned, want, user] of [
  [CORE_HOME, "1000:1000", CORE_SESSION_USER.name],
  [`${CORE_HOME}/shared`, "1000:1000", CORE_SESSION_USER.name],
  [CORE_STATE_DIR, "1001:1001", CORE_DAEMON_USER.name],
  // Inside the 0700 directory: only its owner can look.
  [CORE_STATE_DATA_DIR, "1001:1001", CORE_DAEMON_USER.name],
]) {
  const owner = core.exec(["stat", "-c", "%u:%g", owned], { user }).stdout.trim();
  if (owner !== want) die(`${owned} is owned by ${owner}, expected ${want}`);
}
log("the home and shared are owned by core (1000:1000), the daemon state by actana (1001:1001)");

// #559 — the daemon's state is in its own directory on its own volume, and the
// home volume holds none of it. A directory that is a mount point of its own is
// what makes "the core-home volume has no identity" true of a copy of the volume.
const stateStat = core.exec(["stat", "-c", "%u:%g %a", CORE_STATE_DIR]).stdout.trim();
if (stateStat !== "1001:1001 700") die(`${CORE_STATE_DIR} is ${stateStat}, expected 1001:1001 700`);
const mounts = core.exec(["cat", "/proc/self/mountinfo"]).stdout;
if (!mounts.split("\n").some((line) => line.split(" ")[4] === CORE_STATE_DIR)) {
  die(`${CORE_STATE_DIR} is not a mount point of its own:\n${mounts}`);
}
for (const kept of [MATERIAL_FILE, `${CORE_STATE_DATA_DIR}/missioncontrol.db`]) {
  // As the daemon's user: it is the only one that can see them.
  if (core.exec(["test", "-f", kept], { user: CORE_DAEMON_USER.name, allowFailure: true }).status !== 0) {
    die(`${kept} is missing — the daemon's state is not under ${CORE_STATE_DIR}\n${core.logs()}`);
  }
  // A Session's user cannot read it: this is what the whole change is for.
  const denied = core.exec(["cat", kept], { allowFailure: true });
  if (denied.status === 0 || !/Permission denied/.test(denied.stderr)) {
    die(`core could read ${kept} (exit ${denied.status}):\n${denied.stdout.slice(0, 200)}${denied.stderr}`);
  }
}
const listed = core.exec(["ls", CORE_STATE_DIR], { allowFailure: true });
if (listed.status === 0 || !/Permission denied/.test(listed.stderr)) {
  die(`core could list ${CORE_STATE_DIR} (exit ${listed.status}):\n${listed.stdout}${listed.stderr}`);
}
/** Daemon state found under the core home, which must be nothing. */
function stateInHome(container) {
  return container
    .exec([
      "find",
      CORE_HOME,
      "(",
      "-name",
      "material.json",
      "-o",
      "-name",
      "pairing.json*",
      "-o",
      "-name",
      "missioncontrol.db*",
      "-o",
      "-name",
      "update-check.json",
      "-o",
      "-name",
      "update-notice.json",
      ")",
    ])
    .stdout.trim();
}
const strayState = stateInHome(core);
if (strayState) die(`daemon state is under the core home:\n${strayState}`);
log(`material and database are in ${CORE_STATE_DIR}, a mount of its own; the home holds none`);

// The hook miss drop box: a Session (core) appends, the daemon reads it as
// untrusted input. The record below is read by the boot drain of the next
// restart, the only drain that does not wait a minute.
const dropDirMode = core.exec(["stat", "-c", "%a", CORE_HOOK_DROP_DIR]).stdout.trim();
const dropFileMode = core.exec(["stat", "-c", "%a", `${CORE_HOOK_DROP_DIR}/hook-misses.log`]).stdout.trim();
if (dropDirMode !== "711" || dropFileMode !== "622") {
  die(`hook drop box modes are ${dropDirMode}/${dropFileMode}, expected 711/622`);
}
const dropMarker = `smoke-${suffix}`;
core.exec([
  "sh",
  "-c",
  `printf '%s\\t%s\\t%s\\t%s\\n' 2026-01-01T00:00:00Z ${dropMarker} PostToolUse 28 >> ${CORE_HOOK_DROP_DIR}/hook-misses.log`,
]);

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

// ─── #559: the privilege model, read off /proc ──────────────────────────────

// What the kernel says about the daemon's node process, compared line for line
// (`checkProcessStatus` in lib/core-smoke.mjs). The daemon is `actana` with
// CAP_SETUID and CAP_SETGID as its inheritable, permitted, effective, ambient and
// bounding sets and nothing else, no supplementary group, and no-new-privs. Not
// "no capability looks wrong": a third capability, a lost ambient one or a root
// group all fail here, and so does `setpriv` doing something other than what the
// entrypoint says. This is the line the whole change stands on, and it is the
// node pid (not the launcher shell that `exec`ed into it) that is read.
const daemonStatus = core.exec(["cat", `/proc/${daemon.pid}/status`]).stdout;
const daemonProblems = checkProcessStatus(daemonStatus, "daemon");
if (daemonProblems.length > 0) {
  die(
    `the daemon's node process (pid ${daemon.pid}) is not exactly ${CORE_DAEMON_USER.name} ` +
      `with ${CORE_DAEMON_CAPS.join(" and ")} and no-new-privs:\n  ${daemonProblems.join("\n  ")}\n` +
      `--- /proc/${daemon.pid}/status ---\n${daemonStatus}`,
  );
}
log(
  `the daemon (pid ${daemon.pid}) is uid/gid ${CORE_DAEMON_USER.uid}, no groups, ` +
    `CapInh/CapPrm/CapEff/CapAmb/CapBnd 00000000000000c0 (${CORE_DAEMON_CAPS.join(" + ")}), NoNewPrivs 1`,
);

// And nothing in the container is root, tini included: it is uid 1001 so that it
// can signal and reap the daemon, and the entrypoint's `exec` left no root shell
// behind. The scan runs in a root exec, whose own shell is the one root process
// it must see (a scan that cannot see a root process proves nothing), and reads
// every pid's real and effective ids, uid and gid.
const everyStatus = docker([
  "exec",
  core.name,
  "sh",
  "-c",
  'printf "@@SELF %s\\n" "$$"; for p in /proc/[0-9]*; do printf "@@%s\\n" "${p#/proc/}"; cat "$p/status" 2>/dev/null; done',
]).stdout;
const { self: scanSelf, processes: statuses, unparsed: scanUnparsed } = parseStatusScan(everyStatus);
if (scanUnparsed.length > 0) die(`the root-process scan printed blocks that are neither a pid nor SELF:\n${scanUnparsed.join("\n")}`);
const rootProblems = checkNoRootProcesses(statuses, scanSelf);
if (rootProblems.length > 0) {
  die(`the root-process scan failed:\n  ${rootProblems.join("\n  ")}\n${formatProcesses(processTable(core))}`);
}
// PID 1 is tini, as the daemon's user, with the daemon's capabilities.
const initStatus = core.exec(["cat", "/proc/1/status"]).stdout;
const initProblems = checkProcessStatus(initStatus, "daemon");
if (initProblems.length > 0) {
  die(`PID 1 (tini) is not exactly ${CORE_DAEMON_USER.name} with ${CORE_DAEMON_CAPS.join(" and ")}:\n  ${initProblems.join("\n  ")}\n${initStatus}`);
}
log("no process of the container runs as root; tini (PID 1) is actana with the same two ambient capabilities")

// What runs as root, and what the daemon runs, cannot be swapped by a Session: the
// entrypoint (root, holding CAP_SETUID until its `exec`) lives in a root-owned
// directory of its own, and every directory on the daemon's own PATH — read back from
// its environment, not assumed — is root-owned and not writable. (The Node tarball once
// left /usr/local owned by uid 1000.) Read as `core`, the user who would do the swapping.
{
  // The daemon holds capabilities (c0), so only a process with its own credentials may
  // read its environment under /proc (the ptrace-read check needs a superset of its
  // permitted set): the root exec, which has CAP_SETUID and CAP_SETGID, becomes
  // exactly the daemon's user with exactly its capabilities, and then reads.
  const environ = docker(
    [
      "exec",
      core.name,
      "/usr/bin/setpriv",
      `--reuid=${CORE_DAEMON_USER.uid}`,
      `--regid=${CORE_DAEMON_USER.gid}`,
      "--clear-groups",
      "--inh-caps=-all,+setuid,+setgid",
      "--ambient-caps=-all,+setuid,+setgid",
      "cat",
      `/proc/${daemon.pid}/environ`,
    ],
    { allowFailure: true },
  );
  if (environ.status !== 0) die(`could not read the daemon's environment (pid ${daemon.pid}) with its own credentials: ${environ.stderr}`);
  const daemonPath = pathFromEnviron(environ.stdout);
  if (!daemonPath || daemonPath.length === 0) die("the daemon's environment has no PATH");
  const dirs = [path.posix.dirname(ENTRYPOINT_PATH), ...daemonPath];
  const stat = core.exec(["sh", "-c", 'for d in "$@"; do [ -d "$d" ] && stat -L -c "%n\t%u:%g\t%a" "$d"; done; true', "sh", ...dirs]);
  const seen = stat.stdout.split("\n").filter(Boolean).map((line) => {
    const [dir, owner, mode] = line.split("\t");
    return { path: dir, owner, mode };
  });
  const problems = checkRootOwnedDirs(seen);
  if (!seen.some((d) => d.path === path.posix.dirname(ENTRYPOINT_PATH))) problems.push("the entrypoint's directory was not read");
  if (problems.length > 0) die(`a directory root or the daemon executes from is not root-owned and closed:\n  ${problems.join("\n  ")}\nPATH ${daemonPath.join(":")}`);
  const beside = core.exec(["sh", "-c", `touch ${path.posix.dirname(ENTRYPOINT_PATH)}/planted 2>&1`], { allowFailure: true });
  if (beside.status === 0) die(`core created a file beside the root entrypoint in ${path.posix.dirname(ENTRYPOINT_PATH)}`);
  const swap = core.exec(["sh", "-c", `printf x >> ${ENTRYPOINT_PATH} 2>&1`], { allowFailure: true });
  if (swap.status === 0) die(`core wrote to the root entrypoint ${ENTRYPOINT_PATH}`);
  log(`the entrypoint's directory and the daemon's ${daemonPath.length} PATH entries are root-owned and closed to core, which cannot create or change a file there`);
}

// Nothing under the trees root and the daemon run from belongs to anyone but root.
// The scan must also see something, or an empty answer proves nothing.
{
  const trees = ["/opt/actana", "/usr/local", path.posix.dirname(ENTRYPOINT_PATH)];
  const foreign = core.exec(["find", ...trees, "!", "-uid", "0", "-print"]).stdout.trim();
  if (foreign) die(`files under ${trees.join(", ")} are not owned by uid 0 (core could swap them):\n${foreign.split("\n").slice(0, 20).join("\n")}`);
  const seenRoot = core.exec(["find", ...trees, "-uid", "0", "-name", "*", "-print", "-quit"]).stdout.trim();
  if (!seenRoot) die(`the ownership scan of ${trees.join(", ")} saw no root-owned file, so finding no other proves nothing`);
  log("everything under /opt/actana, /usr/local and /usr/libexec/actana is owned by uid 0");
}

// ─── A Session, as a client opens one ───────────────────────────────────────

// The credential a client holds: built, as `core-smoke.mjs` does for every smoke,
// from the identity the daemon wrote. Read as `actana` — the state is 0700 — and
// kept on the host only for the life of this run.
const credentialDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-core-image-credential-"));
teardown.push(() => fs.rmSync(credentialDir, { recursive: true, force: true }));
const materialCopy = path.join(credentialDir, "material.json");
fs.writeFileSync(
  materialCopy,
  core.exec(["cat", MATERIAL_FILE], { user: CORE_DAEMON_USER.name }).stdout,
  { mode: 0o600 },
);
const credential = credentialFromMaterial(materialCopy, core.endpoint);

log("opening a Session over the core-link …");
const shell = await openCoreSession(credential).catch((err) => die(`could not open a Session: ${err.message}\n${core.logs()}`));
teardown.push(() => shell.close());
await shell.prepare().catch((err) => die(`the Session's shell never answered: ${err.message}`));

/** Run a script in the Session, or die with everything the Session printed. */
async function inSession(script, what) {
  try {
    return await shell.run(script);
  } catch (err) {
    return die(`${what}: ${err.message}`);
  }
}

// What the kernel says about the Session itself (`$$`, the login shell the PTY
// started) and about a process it starts: `core`, no capability in any set but the
// bounding set, no supplementary group, no-new-privs.
for (const [label, pidExpr] of [["the Session's shell", "$$"], ["a process the Session starts", "self"]]) {
  const read = await inSession(`cat /proc/${pidExpr}/status`, `reading ${label}`);
  const problems = checkProcessStatus(read.output, "session");
  if (read.status !== 0 || problems.length > 0) {
    die(`${label} is not exactly ${CORE_SESSION_USER.name} with no capabilities:\n  ${problems.join("\n  ")}\n${read.output}`);
  }
}
log(`a Session is uid/gid ${CORE_SESSION_USER.uid}, no groups, CapInh/CapPrm/CapEff/CapAmb 0, CapBnd 00000000000000c0, NoNewPrivs 1`);

const who = await inSession('id -un; printf "%s\\n" "$HOME"', "asking who the Session is");
if (who.output !== `${CORE_SESSION_USER.name}\n${CORE_HOME}`) {
  die(`the Session is ${JSON.stringify(who.output)}, expected ${CORE_SESSION_USER.name} with HOME=${CORE_HOME}`);
}
// The daemon's environment does not reach a Session: none of its AC_ variables
// (but the hook ones) and nothing that points into its state.
const leaked = await inSession("env | grep -E '^AC_|/var/lib/actana' | grep -v '^AC_HOOK_'; true", "reading the Session's environment");
if (leaked.output.trim()) die(`the Session inherited the daemon's environment:\n${leaked.output}`);

// A Session cannot read what the daemon holds, cannot become the daemon, and
// cannot signal it: the three things the two capabilities would otherwise allow.
const readState = await inSession(`cat ${MATERIAL_FILE}`, "reading the daemon's state from a Session");
if (readState.status === 0 || !/Permission denied/.test(readState.output)) {
  die(`a Session read the daemon's identity (exit ${readState.status}):\n${readState.output.slice(0, 200)}`);
}
const becomeActana = await inSession(
  `setpriv --reuid=${CORE_DAEMON_USER.uid} --regid=${CORE_DAEMON_USER.gid} --clear-groups true`,
  "trying to become the daemon's user from a Session",
);
if (becomeActana.status === 0 || !/not permitted/i.test(becomeActana.output)) {
  die(`a Session switched to uid ${CORE_DAEMON_USER.uid} (exit ${becomeActana.status}): the capabilities are not gone:\n${becomeActana.output}`);
}
const signalDaemon = await inSession(`kill -0 ${daemon.pid}`, "signalling the daemon from a Session");
if (signalDaemon.status === 0 || !/not permitted/i.test(signalDaemon.output)) {
  die(`a Session could signal the daemon (pid ${daemon.pid}), exit ${signalDaemon.status}:\n${signalDaemon.output}`);
}
log("a Session cannot read the daemon's state, setuid to its user, or signal it");

// The terminal is usable although the pty slave was made by the daemon (`actana`)
// and the Session is another uid: its standard fds work, so do `stty` and
// `/dev/tty`, and a tool that makes a pty of its own does too. (`ls -l` of the
// slave is printed for whoever reads the log; it is not what is asserted.)
const tty = await inSession("tty", "asking for the Session's tty");
if (tty.status !== 0 || !/^\/dev\/pts\/\d+$/.test(tty.output)) {
  die(`the Session has no usable tty (exit ${tty.status}): ${JSON.stringify(tty.output)}`);
}
const slave = await inSession("ls -l $(tty)", "listing the Session's tty");
log(`the Session's tty is ${tty.output}: ${slave.output.trim()}`);
for (const [what, script, expect] of [
  ["stty size", "stty size", /^\d+ \d+$/],
  ["a write to /dev/tty", "echo reached-the-terminal > /dev/tty && echo ok", /^ok$/m],
  ["script(1) on a pty of its own", "script -qec tty /dev/null", /\/dev\/pts\/\d+/],
]) {
  const result = await inSession(script, what);
  if (result.status !== 0 || !expect.test(result.output)) {
    die(`${what} failed in the Session (exit ${result.status}): ${JSON.stringify(result.output)}`);
  }
}
log("the Session's terminal works: tty, stty, /dev/tty and script(1)");

// The two daemon operations that used to run in the daemon: both are `core`'s.
const madeName = `smoke-made-${suffix}`;
const created = await shell.request({ type: "dirCreate", parent: CORE_HOME, name: madeName });
if (created.type !== "dirCreateResult" || created.path !== `${CORE_HOME}/${madeName}`) {
  die(`dirCreate in the home answered ${JSON.stringify(created)}`);
}
const madeOwner = core.exec(["stat", "-c", "%u:%g", `${CORE_HOME}/${madeName}`]).stdout.trim();
if (madeOwner !== `${CORE_SESSION_USER.uid}:${CORE_SESSION_USER.gid}`) {
  die(`the folder the picker made is owned by ${madeOwner}, expected core (${CORE_SESSION_USER.uid}:${CORE_SESSION_USER.gid}): it was made by the daemon`);
}
const refusedCreate = await shell.request({ type: "dirCreate", parent: "/tmp", name: madeName });
if (refusedCreate.type !== "error" || !/only creates folders inside its home/.test(refusedCreate.message ?? "")) {
  die(`dirCreate outside the home was not refused by the helper: ${JSON.stringify(refusedCreate)}`);
}
log("the folder picker's new folder is made by core, and refused outside the home");

// `actana core exec` is a child of the daemon as well, and it too is `core`.
const exec = core.exec(["actana", "core", "exec", "--", "cat", "/proc/self/status"], { allowFailure: true });
if (exec.status !== 0) die(`\`actana core exec\` exited ${exec.status}:\n${exec.stdout}${exec.stderr}\n${core.logs()}`);
const execProblems = checkProcessStatus(exec.stdout, "session");
if (execProblems.length > 0) {
  die(`a \`core exec\` child is not exactly ${CORE_SESSION_USER.name} with no capabilities:\n  ${execProblems.join("\n  ")}\n${exec.stdout}`);
}
const execState = core.exec(["actana", "core", "exec", "--", "cat", MATERIAL_FILE], { allowFailure: true });
if (execState.status === 0 || !/Permission denied/.test(`${execState.stdout}${execState.stderr}`)) {
  die(`a \`core exec\` child read the daemon's identity (exit ${execState.status}):\n${execState.stdout.slice(0, 200)}${execState.stderr}`);
}
log("a `core exec` child is core with no capabilities, and cannot read the state either");

// The tarball's bundled `actana` inside the image (#580 T-405): the client nouns are the pinned,
// inlined `@actana/cli`, and the image is where an operator meets them. As `core`, against the Core
// this container runs and registered with itself, the verbs must answer. Offline is proven on the
// tarball itself (`scripts/smoke-core-tarball.mjs`, with the network refused); here the point is that the
// same bytes work installed under /opt/actana as the unprivileged user.
const cliSessions = core.exec(["actana", "session", "ls", "--json"], { allowFailure: true });
let cliSessionRows = null;
try {
  cliSessionRows = JSON.parse(cliSessions.stdout || "null");
} catch {
  /* reported below */
}
if (cliSessions.status !== 0 || !Array.isArray(cliSessionRows)) {
  die(`\`actana session ls --json\` in the image exited ${cliSessions.status}:\n${cliSessions.stdout}${cliSessions.stderr}\n${core.logs()}`);
}
for (const verb of [["files", "ls"], ["shared", "ls"], ["harness", "skills", "--json"]]) {
  const answer = core.exec(["actana", ...verb], { allowFailure: true });
  if (answer.status !== 0) {
    die(`\`actana ${verb.join(" ")}\` in the image exited ${answer.status}:\n${answer.stdout}${answer.stderr}\n${core.logs()}`);
  }
}
const cliVersion = core.exec(["actana", "--version"], { allowFailure: true });
if (cliVersion.status !== 0 || !/core-link protocol \d+\.\d+\.\d+/.test(cliVersion.stdout)) {
  die(`\`actana --version\` in the image did not state a core-link protocol: ${cliVersion.stdout}${cliVersion.stderr}`);
}
// The two verbs that need a session of their own. `session start --await-prompt` reaches the Core: with no
// harness in the image the Core refuses (`pty:spawn rejected`), and a Session that did start is killed.
const cliStart = core.exec(["actana", "session", "start", "--await-prompt", "hello"], { allowFailure: true });
const cliStartOutcome = classifySessionStart(cliStart);
if (cliStartOutcome.kind === "unexpected") {
  die(`\`actana session start --await-prompt\` in the image did not reach the Core: ${cliStartOutcome.why}\n${cliStart.stdout}${cliStart.stderr}\n${core.logs()}`);
}
if (cliStartOutcome.kind === "started") core.exec(["actana", "session", "kill", cliStartOutcome.id], { allowFailure: true });
// `events tail` follows forever, so it runs under `timeout`: the first line must be an event (exit 124 is the timeout).
const cliEvents = core.exec(["timeout", "10", "actana", "events", "tail", "--json", "--since", "start"], { allowFailure: true });
let firstEvent = null;
try {
  firstEvent = JSON.parse(cliEvents.stdout.split("\n")[0] || "null");
} catch {
  /* reported below */
}
if (typeof firstEvent?.eventId !== "number") {
  die(`\`actana events tail\` in the image streamed no event (exit ${cliEvents.status}):\n${cliEvents.stdout.slice(0, 300)}${cliEvents.stderr}\n${core.logs()}`);
}
log(
  "the bundled actana answers in the image as core: session ls, session start --await-prompt, events tail, " +
    "files ls, shared ls, harness skills, --version",
);

// Stop: a Session whose own process ignores HUP and TERM. The daemon is another
// uid with no CAP_KILL, so the stop is a SIGKILL sent as core (`killAsCore`),
// 1.5 s after the master is closed. Alive before the stop, gone after it.
log("stopping a Session that ignores HUP and TERM …");
const stuck = await openCoreSession(credential, {
  command: "trap '' HUP TERM; echo STOPPID=$$; while :; do sleep 1; done",
}).catch((err) => die(`could not open the Session to stop: ${err.message}`));
teardown.push(() => stuck.close());
const stuckPid = Number((await stuck.waitFor(/STOPPID=(\d+)/, "the stuck Session's pid").catch((err) => die(err.message)))[1]);
if (core.exec(["test", "-d", `/proc/${stuckPid}`], { allowFailure: true }).status !== 0) {
  die(`the stuck Session (pid ${stuckPid}) is not running before it is stopped`);
}
const killed = await stuck.kill();
if (killed.type !== "killResult" || killed.ok !== true) die(`the core-link did not accept the stop: ${JSON.stringify(killed)}`);
await pollUntil(
  `Session pid ${stuckPid}, which ignores HUP and TERM, to die after the stop`,
  20_000,
  async () => (core.exec(["test", "-d", `/proc/${stuckPid}`], { allowFailure: true }).status !== 0 ? true : null),
  { pollMs: 250 },
).catch((err) => die(`${err.message} — a stuck Session survives its stop (killAsCore did not reach it):\n${stuck.output()}`));
log(`the stuck Session (pid ${stuckPid}) is gone after the stop`);
stuck.close();
shell.close();

// Prep as root one-shot with the compose capability set (CHOWN + DAC_OVERRIDE)
// plus a hostile PATH and CORE_HOME — must leave /etc root-owned and home
// paths 1000:1000, and must not run a fake volume binary.
const marker = `${CORE_HOME}/.local/share/actana/fake-stat.log`;
core.exec([
  "sh",
  "-c",
  [
    `mkdir -p ${CORE_HOME}/.local/bin ${CORE_HOME}/.local/share/actana`,
    `printf '%s\\n' '#!/bin/sh' 'echo FAKE_STAT_RAN_AS_$(/usr/bin/id -u) >> ${marker}' 'exec /usr/bin/stat "$@"' > ${CORE_HOME}/.local/bin/stat`,
    `chmod +x ${CORE_HOME}/.local/bin/stat`,
    `rm -f ${marker}`,
  ].join(" && "),
]);
// Compose capability set that ships: CHOWN + DAC_OVERRIDE, no-new-privs, no net.
const coreInitCaps = [
  "--cap-drop",
  "ALL",
  "--cap-add",
  "CHOWN",
  "--cap-add",
  "DAC_OVERRIDE",
  "--security-opt",
  "no-new-privileges:true",
  "--network",
  "none",
];
const hostileScript = [
  `export PATH=${CORE_HOME}/.local/bin:/usr/sbin:/usr/bin`,
  "export CORE_HOME=/etc",
  "export CORE_UID=0",
  "prep_rc=0",
  "/usr/local/libexec/core-fs-prep.sh || prep_rc=$?",
  // Absolute /usr/bin/stat: this shell still has the hostile PATH. A bare
  // `stat` here would run the volume fake as root and trip the marker check,
  // even when prep correctly pinned PATH (CI run 36730945627).
  // Hard-code paths so a hostile CORE_HOME cannot redirect the assertion.
  "/usr/bin/stat -c '%u:%g %n' /etc /home/core /home/core/shared /var/lib/actana",
  'exit "$prep_rc"',
].join("; ");
const prepHostile = docker(
  [
    "run",
    "--rm",
    "-u",
    "0",
    ...coreInitCaps,
    "--entrypoint",
    "sh",
    "--volume",
    `${core.volume}:${CORE_HOME}`,
    image,
    "-c",
    hostileScript,
  ],
  { allowFailure: true },
);
const hostileOut = `${prepHostile.stdout ?? ""}${prepHostile.stderr ?? ""}`;
if (prepHostile.status !== 0) {
  die(`hostile-env prep exited ${prepHostile.status}:\n${hostileOut}`);
}
const hostileLines = new Set(
  hostileOut
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean),
);
for (const expected of [
  "0:0 /etc",
  `1000:1000 ${CORE_HOME}`,
  `1000:1000 ${CORE_HOME}/shared`,
  `${CORE_DAEMON_USER.uid}:${CORE_DAEMON_USER.gid} ${CORE_STATE_DIR}`,
]) {
  if (!hostileLines.has(expected)) {
    die(`hostile prep missing exact ownership line ${JSON.stringify(expected)}:\n${hostileOut}`);
  }
}
const fakeLog = core.exec(["sh", "-c", `cat ${marker} 2>/dev/null || true`], {
  allowFailure: true,
}).stdout;
if (/FAKE_STAT_RAN_AS_0/.test(fakeLog)) {
  die("fake ~/.local/bin/stat ran as root during prep — PATH was not pinned");
}
log("hostile PATH/CORE_HOME prep (compose caps) left /etc 0:0, the home 1000:1000 and the state 1001:1001");

// A Session plants an `actana` in its own ~/.local/bin — first on a Session's own
// PATH, and on no PATH of the image's or the daemon's — and opens the home to others
// (`chmod o+x ~`, which is core's to do and which a bind-mounted home may have from the
// host anyway). The entrypoint starts the daemon by absolute path and the image PATH
// names no directory under the home, so the fake must never run, as 1001 or as anyone.
// First prove the trap is armed: the daemon's user can reach the fake, or "it never
// ran" would mean nothing. The modes it changes are recorded and restored at the end.
const homeModePaths = [CORE_HOME, `${CORE_HOME}/.local`, `${CORE_HOME}/.local/bin`, `${CORE_HOME}/.local/share`, `${CORE_HOME}/.local/share/actana`];
core.exec(["mkdir", "-p", `${CORE_HOME}/.local/bin`, `${CORE_HOME}/.local/share/actana`]);
const homeModes = core
  .exec(["stat", "-c", "%a %n", ...homeModePaths])
  .stdout.split("\n")
  .filter(Boolean)
  .map((line) => line.split(" "));
if (homeModes.length !== homeModePaths.length) die(`could not record the home's modes: ${JSON.stringify(homeModes)}`);
const fakeActanaLog = `${CORE_HOME}/.local/share/actana/fake-actana.log`;
core.exec([
  "sh",
  "-c",
  [
    `mkdir -p ${CORE_HOME}/.local/bin ${CORE_HOME}/.local/share/actana`,
    `printf '%s\\n' '#!/bin/sh' 'echo FAKE_ACTANA_RAN_AS_$(/usr/bin/id -u) >> ${fakeActanaLog}' 'exec /opt/actana/bin/actana "$@"' > ${CORE_HOME}/.local/bin/actana`,
    `chmod +x ${CORE_HOME}/.local/bin/actana`,
    `chmod o+rx ${CORE_HOME} ${CORE_HOME}/.local ${CORE_HOME}/.local/bin ${CORE_HOME}/.local/share ${CORE_HOME}/.local/share/actana`,
    `chmod o+w ${CORE_HOME}/.local/share/actana`,
    `rm -f ${fakeActanaLog}`,
  ].join(" && "),
]);
const armed = core.exec(["sh", "-c", `test -x ${CORE_HOME}/.local/bin/actana && test -r ${CORE_HOME}/.local/bin/actana`], {
  user: CORE_DAEMON_USER.name,
  allowFailure: true,
});
if (armed.status !== 0) die("the planted actana is not reachable by the daemon's user, so the leg proves nothing");

// `docker stop` — and then a start with the fake in place. tini is PID 1 as the
// daemon's user, so it can forward SIGTERM: the daemon's own shutdown handler
// runs (it logs `core.shutdown`), the exit status is 0, and nothing waits out the
// grace period for a SIGKILL. A root tini without CAP_KILL would get EPERM, exit,
// and take the container down without the daemon ever hearing of it.
log("stopping the container: the daemon must hear SIGTERM and exit 0 …");
const stopStarted = Date.now();
docker(["stop", "--time", "30", core.name]);
const stopMs = Date.now() - stopStarted;
const stopExit = docker(["inspect", "--format", "{{.State.ExitCode}}", core.name]).stdout.trim();
const stopLogs = core.logs("all");
if (stopExit !== "0") die(`docker stop ended the Core with exit ${stopExit}, expected 0 (137 is a SIGKILL after the grace period):\n${core.logs()}`);
if (stopMs >= 25_000) die(`docker stop took ${stopMs} ms: the daemon did not stop on SIGTERM`);
if (!/core\.shutdown.*SIGTERM/.test(stopLogs)) {
  die(`the daemon never logged its shutdown (core.shutdown, SIGTERM): tini did not forward the signal:\n${core.logs()}`);
}
log(`docker stop: exit 0 in ${stopMs} ms, and the daemon logged its shutdown`);
docker(["start", core.name]);
await waitForCoreLink(core);
// Restart the default boot (no -u 0): entrypoint must not invoke prep, so the
// fake stat on the volume PATH cannot run as root on restart either.
docker(["restart", core.name]);
await waitForCoreLink(core);
if (!isRunning(core)) die("the Core is not running after the restarts");
log("the Core restarted with a planted actana in the home's .local/bin (the check that it never ran is after the pairing leg)");

// tini reaps what is reparented to it: a process orphaned by its Session is
// adopted by PID 1 (tini, not the daemon), and once it exits it is gone, not a zombie.
{
  const reaper = await openCoreSession(credentialFromMaterial(materialCopy, core.endpoint)).catch((err) => die(`could not open a Session: ${err.message}`));
  await reaper.prepare().catch((err) => die(`the Session's shell never answered: ${err.message}`));
  const orphaned = await reaper.run("sh -c '(sleep 3 & echo ORPHAN=$!); exit 0'", 10_000).catch((err) => die(`could not orphan a process: ${err.message}`));
  const orphan = Number(orphaned.output.match(/ORPHAN=(\d+)/)?.[1]);
  if (!Number.isInteger(orphan) || orphan <= 1) die(`no orphan pid was printed:\n${orphaned.output}`);
  const parent = () =>
    core.exec(["sh", "-c", `sed -e 's/.*) //' /proc/${orphan}/stat 2>/dev/null | cut -d' ' -f2`], { allowFailure: true }).stdout.trim();
  await pollUntil(`orphan ${orphan} to be adopted by PID 1`, 3_000, async () => (parent() === "1" ? true : null), { pollMs: 100 }).catch(() =>
    die(`orphan ${orphan}'s parent is ${JSON.stringify(parent())}, expected 1 (tini)`),
  );
  await pollUntil(`orphan ${orphan} to be reaped`, 10_000, async () => (core.exec(["test", "-e", `/proc/${orphan}`], { allowFailure: true }).status !== 0 ? true : null), {
    pollMs: 250,
  }).catch(() => die(`orphan ${orphan} is still in /proc after it exited (state ${core.exec(["sh", "-c", `sed -e 's/.*) //' /proc/${orphan}/stat | cut -c1`], { allowFailure: true }).stdout.trim()}): tini is not reaping`));
  reaper.close();
  log(`orphan ${orphan} was adopted by PID 1 and reaped (no zombie)`);
}
const fakeAfterRestart = core.exec(["sh", "-c", `cat ${marker} 2>/dev/null || true`], {
  allowFailure: true,
}).stdout;
if (/FAKE_STAT_RAN_AS_0/.test(fakeAfterRestart)) {
  die("fake ~/.local/bin/stat ran as root on container restart");
}
log("restart did not run a volume binary as root");

/** Run shipped prep with the compose capability set against a named volume. */
function runCoreInitOnVolume(volumeName) {
  return docker(
    [
      "run",
      "--rm",
      "-u",
      "0",
      ...coreInitCaps,
      "--entrypoint",
      "/usr/local/libexec/core-fs-prep.sh",
      "--volume",
      `${volumeName}:${CORE_HOME}`,
      image,
    ],
    { allowFailure: true },
  );
}

function assertSharedOwned(volumeName, label) {
  const check = docker(
    [
      "run",
      "--rm",
      "-u",
      "1000:1000",
      "--entrypoint",
      "stat",
      "--volume",
      `${volumeName}:${CORE_HOME}`,
      image,
      "-c",
      "%u:%g %a %n",
      `${CORE_HOME}/shared`,
    ],
    { allowFailure: true },
  );
  if (check.status !== 0) {
    die(`${label}: could not stat shared:\n${check.stderr}${check.stdout}`);
  }
  const line = (check.stdout ?? "").trim();
  if (!line.startsWith("1000:1000 ")) {
    die(`${label}: shared ownership is ${JSON.stringify(line)}, expected 1000:1000`);
  }
}

// #559 — a state volume that arrived root-owned is handed to `actana`, mount
// point only, by the same one-shot: the owner the entrypoint then demands.
log("verifying core-init hands a root-owned state volume to actana …");
const repairState = `actana-core-smoke-repairstate-${suffix}`;
docker(["volume", "create", repairState]);
teardown.push(() => docker(["volume", "rm", "-f", repairState], { allowFailure: true }));
docker(["run", "--rm", "-u", "0", "--entrypoint", "sh", "--volume", `${repairState}:${CORE_STATE_DIR}`, image, "-c", `chown 0:0 ${CORE_STATE_DIR}`]);
const repairRun = docker(
  [
    "run", "--rm", "-u", "0", ...coreInitCaps, "--entrypoint", "/usr/local/libexec/core-fs-prep.sh",
    "--volume", `${repairState}:${CORE_STATE_DIR}`, image,
  ],
  { allowFailure: true },
);
if (repairRun.status !== 0) die(`core-init on a root-owned state volume failed:\n${repairRun.stderr}${repairRun.stdout}`);
const repaired = docker(
  ["run", "--rm", "-u", "0", "--entrypoint", "stat", "--volume", `${repairState}:${CORE_STATE_DIR}`, image, "-c", "%u:%g %a", CORE_STATE_DIR],
).stdout.trim();
if (repaired !== `${CORE_DAEMON_USER.uid}:${CORE_DAEMON_USER.gid} 700`) {
  die(`core-init left the state volume ${repaired}, expected ${CORE_DAEMON_USER.uid}:${CORE_DAEMON_USER.gid} 700`);
}
log("core-init handed the state volume to actana (1001:1001, 0700)");

// Fresh named volume with noble-style 0750 home (HOME_MODE) that already has
// shared seeded — prep must still be able to search inside and exit 0.
log("verifying core-init on a fresh 0750 home volume (compose caps) …");
const freshVol = `actana-core-smoke-fresh0750-${suffix}`;
docker(["volume", "create", freshVol]);
teardown.push(() => docker(["volume", "rm", "-f", freshVol], { allowFailure: true }));
const seedFresh = docker(
  [
    "run",
    "--rm",
    "-u",
    "0",
    "--entrypoint",
    "sh",
    "--volume",
    `${freshVol}:${CORE_HOME}`,
    image,
    "-c",
    [
      `mkdir -p ${CORE_HOME}/shared ${CORE_HOME}/.local/share/actana/data ${CORE_HOME}/.config/actana ${CORE_HOME}/repos`,
      `chown -R 1000:1000 ${CORE_HOME}`,
      `chmod 0750 ${CORE_HOME}`,
    ].join(" && "),
  ],
  { allowFailure: true },
);
if (seedFresh.status !== 0) {
  die(`seeding fresh 0750 volume failed:\n${seedFresh.stderr}${seedFresh.stdout}`);
}
const prepFresh = runCoreInitOnVolume(freshVol);
if (prepFresh.status !== 0) {
  die(
    `core-init on fresh 0750 volume failed (need DAC_OVERRIDE?):\n` +
      `${prepFresh.stderr}${prepFresh.stdout}`,
  );
}
assertSharedOwned(freshVol, "fresh 0750 volume");
log("core-init succeeded on a fresh 0750 home volume");

// Upgrade path: 0.4.5-style volume has .local/.config but no ~/shared.
log("verifying core-init creates missing ~/shared under 0750 (compose caps) …");
const upgradeVol = `actana-core-smoke-noshared-${suffix}`;
docker(["volume", "create", upgradeVol]);
teardown.push(() => docker(["volume", "rm", "-f", upgradeVol], { allowFailure: true }));
const seedUpgrade = docker(
  [
    "run",
    "--rm",
    "-u",
    "0",
    "--entrypoint",
    "sh",
    "--volume",
    `${upgradeVol}:${CORE_HOME}`,
    image,
    "-c",
    [
      `mkdir -p ${CORE_HOME}/.local/share/actana/data ${CORE_HOME}/.config/actana ${CORE_HOME}/repos`,
      `rm -rf ${CORE_HOME}/shared`,
      `chown -R 1000:1000 ${CORE_HOME}`,
      `chmod 0750 ${CORE_HOME}`,
      `test ! -e ${CORE_HOME}/shared`,
    ].join(" && "),
  ],
  { allowFailure: true },
);
if (seedUpgrade.status !== 0) {
  die(`seeding no-shared upgrade volume failed:\n${seedUpgrade.stderr}${seedUpgrade.stdout}`);
}
const prepUpgrade = runCoreInitOnVolume(upgradeVol);
if (prepUpgrade.status !== 0) {
  die(
    `core-init on missing-shared volume failed:\n${prepUpgrade.stderr}${prepUpgrade.stdout}`,
  );
}
assertSharedOwned(upgradeVol, "missing-shared upgrade volume");
log("core-init created ~/shared on a 0750 upgrade volume");

// #551 — a missing host ./repos is created root-owned by Docker; core-init
// must chown the mount point so core can write.
log("verifying core-init repairs a missing root-owned repos bind mount …");
const reposScratch = fs.mkdtempSync(path.join(os.tmpdir(), "actana-core-repos-"));
const scratchHome = path.join(reposScratch, "home");
const scratchRepos = path.join(reposScratch, "repos");
fs.mkdirSync(scratchHome, { recursive: true });
// Deliberately do not create scratchRepos — Docker will create it as root.
const compose551 = path.join(reposScratch, "compose.yml");
fs.writeFileSync(
  compose551,
  [
    "services:",
    "  core-init:",
    `    image: ${image}`,
    '    user: "0:0"',
    '    entrypoint: ["/usr/local/libexec/core-fs-prep.sh"]',
    "    cap_drop: [ALL]",
    "    cap_add: [CHOWN, DAC_OVERRIDE]",
    "    security_opt: [no-new-privileges:true]",
    "    network_mode: none",
    "    volumes:",
    `      - ${scratchHome}:${CORE_HOME}`,
    `      - state:${CORE_STATE_DIR}`,
    `      - ${scratchRepos}:${CORE_HOME}/repos`,
    '    restart: "no"',
    "  core:",
    `    image: ${image}`,
    "    environment:",
    "      ACTANA_PUBLIC_HOST: core",
    // The shipped shape: root only for the entrypoint's switch, then the two capabilities.
    "    cap_drop: [ALL]",
    `    cap_add: [${CORE_DAEMON_CAPS.join(", ")}]`,
    "    volumes:",
    `      - ${scratchHome}:${CORE_HOME}`,
    `      - state:${CORE_STATE_DIR}`,
    `      - ${scratchRepos}:${CORE_HOME}/repos`,
    "    depends_on:",
    "      core-init:",
    "        condition: service_completed_successfully",
    "    security_opt: [no-new-privileges:true]",
    "volumes:",
    "  state:",
  ].join("\n") + "\n",
);
const up551 = spawnSync(
  "docker",
  ["compose", "-f", compose551, "up", "-d", "--wait", "--wait-timeout", "60", "core"],
  { encoding: "utf8" },
);
teardown.push(() => {
  spawnSync("docker", ["compose", "-f", compose551, "down", "-v", "--remove-orphans"], {
    encoding: "utf8",
  });
  // Core wrote as 1000; host rmSync would EACCES. Wipe via a root one-shot.
  const parent = path.dirname(reposScratch);
  const leaf = path.basename(reposScratch);
  spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-u",
      "0",
      "--entrypoint",
      "rm",
      "-v",
      `${parent}:/parent`,
      image,
      "-rf",
      `/parent/${leaf}`,
    ],
    { encoding: "utf8" },
  );
});
if (up551.status !== 0) {
  die(`compose up with missing repos failed:\n${up551.stderr}${up551.stdout}`);
}
if (!fs.existsSync(scratchRepos)) {
  die("Docker did not create the missing repos host dir");
}
const reposOwner = spawnSync("stat", ["-c", "%u:%g", scratchRepos], { encoding: "utf8" });
if (reposOwner.stdout.trim() !== "1000:1000") {
  die(`repos mount point is ${reposOwner.stdout.trim()}, expected 1000:1000 after core-init`);
}
const writeProbe = spawnSync(
  "docker",
  ["compose", "-f", compose551, "exec", "-T", "-u", CORE_SESSION_USER.name, "core", "touch", `${CORE_HOME}/repos/.actana-write-ok`],
  { encoding: "utf8" },
);
if (writeProbe.status !== 0) {
  die(`core could not write repos after core-init:\n${writeProbe.stderr}${writeProbe.stdout}`);
}
log("core-init repaired a missing root-owned repos bind mount; core can write");

// The same compose project, with the state volume core-init mounted and the
// shipped capability set, is a Core that really came up: its PID 1 (tini, as the
// daemon's user) and the daemon under it carry exactly the two capabilities.
const composeStatus = (pidExpr) =>
  spawnSync(
    "docker",
    ["compose", "-f", compose551, "exec", "-T", "-u", CORE_DAEMON_USER.name, "core", "sh", "-c", pidExpr],
    { encoding: "utf8" },
  );
const composeInit = composeStatus("cat /proc/1/status");
const composeInitProblems = checkProcessStatus(composeInit.stdout ?? "", "daemon");
if (composeInit.status !== 0 || composeInitProblems.length > 0) {
  die(`PID 1 of a compose-started Core is not exactly actana with the two capabilities:\n  ${composeInitProblems.join("\n  ")}\n${composeInit.stdout}${composeInit.stderr}`);
}
const composeDaemon = composeStatus(
  // By argv[0], as `processTable` does (the exe link of a process holding capabilities is not
  // readable here), and only the children of PID 1: the helper's node runs as core.
  'for p in /proc/[0-9]*; do a=$(tr "\\0" "\\n" < "$p/cmdline" 2>/dev/null | head -n 1); case "$a" in */node) echo "@@${p#/proc/}"; cat "$p/status";; esac; done',
);
const composeDaemonStatus = (composeDaemon.stdout ?? "")
  .split("@@")
  .filter(Boolean)
  .map((b) => b.split("\n").slice(1).join("\n"))
  .filter((status) => /^PPid:\s+1$/m.test(status));
if (composeDaemon.status !== 0 || composeDaemonStatus.length === 0) {
  die(`a compose-started Core has no node child of PID 1 to read:\n${composeDaemon.stdout}${composeDaemon.stderr}`);
}
for (const status of composeDaemonStatus) {
  const problems = checkProcessStatus(status, "daemon");
  if (problems.length > 0) die(`a compose-started Core's node process is not exactly actana with the two capabilities:\n  ${problems.join("\n  ")}\n${status}`);
}
log("a Core started by compose, with the shipped capability set, runs tini and the daemon as actana with the two ambient capabilities")

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

// The reference compose file, as Docker itself resolves it (no image needed): the
// Core service has exactly the capability set `COMPOSE_CORE_FLAGS` boots with,
// no `user:`, and the two state volumes — so the flags above are the shipped ones.
{
  const resolved = spawnSync(
    "docker",
    ["compose", "-f", path.join(repoRoot, "deploy", "docker-compose.yml"), "config", "--format", "json"],
    { encoding: "utf8", env: { ...process.env, AC_PANEL_DB_PASSWORD: "smoke-not-a-secret" } },
  );
  if (resolved.status !== 0) die(`docker compose config exited ${resolved.status}:\n${resolved.stderr}`);
  const service = JSON.parse(resolved.stdout).services?.core;
  const sorted = (list) => [...(list ?? [])].sort();
  if (!service) die("the reference compose file has no core service");
  if (service.user) die(`the compose Core sets user ${JSON.stringify(service.user)}; the entrypoint refuses any`);
  if (sorted(service.cap_drop).join() !== "ALL" || sorted(service.cap_add).join() !== [...CORE_DAEMON_CAPS].sort().join()) {
    die(`the compose Core has cap_drop ${JSON.stringify(service.cap_drop)} and cap_add ${JSON.stringify(service.cap_add)}`);
  }
  if (!(service.security_opt ?? []).includes("no-new-privileges:true")) {
    die(`the compose Core lost no-new-privileges: ${JSON.stringify(service.security_opt)}`);
  }
  const mounted = (service.volumes ?? []).map((v) => `${v.source}:${v.target}`);
  for (const want of [`core-home:${CORE_HOME}`, `core-state:${CORE_STATE_DIR}`]) {
    if (!mounted.includes(want)) die(`the compose Core does not mount ${want}: ${JSON.stringify(mounted)}`);
  }
  log("docker compose resolves the Core with cap_drop ALL, cap_add SETUID SETGID, no-new-privileges, no user, home and state volumes");
}

// ─── A Panel pairs with it ───────────────────────────────────────────────────

const panelEntry = path.resolve(
  stringFlag(args, "panel-entry", die) ??
    path.join(repoRoot, "packages", "panel", "dist", "server", "server.js"),
);
if (!fs.existsSync(panelEntry)) die(`no built Panel at ${panelEntry} — run \`pnpm build\` first`);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-core-image-panel-"));
teardown.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));

// The Panel refuses to start without a Postgres (#567), so one runs beside it.
teardown.push(await ensurePanelDatabase({ name: `ac-core-image-panel-pg-${process.pid}`, log }));

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
// A Session's user cannot pair: it would need the CA key (D7). It fails, and
// prints no code.
const pairAsCore = core.exec(["actana", "pair", "new", "--label", "smoke-as-core"], { allowFailure: true });
if (pairAsCore.status === 0 || /Pairing code/.test(pairAsCore.stdout)) {
  die(`\`actana pair new\` as core minted a code (exit ${pairAsCore.status}):\n${pairAsCore.stdout}${pairAsCore.stderr}`);
}
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

// The planted actana (home open to others, first on a Session's PATH) must not have
// run at any point of this smoke: not as the daemon at three starts, not as actana
// for \`pair new\` through the image PATH, not as root, not as core. Checked here, after
// the legs that look \`actana\` up by name, and the fake is removed.
const fakeActanaRan = core.exec(["sh", "-c", `cat ${fakeActanaLog} 2>/dev/null || true`], { allowFailure: true }).stdout;
if (fakeActanaRan.trim()) {
  die(`a Session's planted ~/.local/bin/actana ran (${fakeActanaRan.trim()}): \`actana\` was found through a directory a Session writes`);
}
// Put everything the legs above changed back: both fakes and their logs, and the modes.
core.exec(["rm", "-f", `${CORE_HOME}/.local/bin/actana`, `${CORE_HOME}/.local/bin/stat`, fakeActanaLog, marker]);
// Deepest first, so a directory is not closed before the ones under it are reached.
for (const [mode, dir] of [...homeModes].reverse()) core.exec(["chmod", mode, dir]);
const restored = core.exec(["stat", "-c", "%a %n", ...homeModePaths]).stdout.split("\n").filter(Boolean).map((line) => line.split(" "));
if (JSON.stringify(restored) !== JSON.stringify(homeModes)) die(`the home's modes were not restored: ${JSON.stringify(homeModes)} -> ${JSON.stringify(restored)}`);
log("the planted actana never ran, through three starts, pairing and every `actana` the smoke typed; both fakes removed and the home's modes restored");

// #559 — the pairing store is written beside the material, in the state
// directory, and not in the home.
if (core.exec(["test", "-f", `${CORE_STATE_DIR}/config/pairing.json`], { user: CORE_DAEMON_USER.name, allowFailure: true }).status !== 0) {
  die(`a pairing left no ${CORE_STATE_DIR}/config/pairing.json\n${core.logs()}`);
}
const strayAfterPairing = stateInHome(core);
if (strayAfterPairing) die(`pairing put state under the core home:\n${strayAfterPairing}`);
log("pairing.json is in the state directory; the home still holds no daemon state");

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
// The miss a Session appended to the drop box was read by the daemon's boot
// drain, and cleared.
const restartLogs = core.logs("all");
if (!restartLogs.includes("hook-delivery.missed") || !restartLogs.includes(dropMarker)) {
  die(`the daemon did not drain the Session's hook miss (${dropMarker}):\n${restartLogs}`);
}
const dropLeft = core.exec(["stat", "-c", "%s", `${CORE_HOOK_DROP_DIR}/hook-misses.log`]).stdout.trim();
if (dropLeft !== "0") die(`the drop box was not cleared after the drain: ${dropLeft} bytes left`);

await assertConnects("after a restart");
log("restart is a no-op for pairing — same identity, nothing emitted, still connected");

// ─── `down -v` is the only thing that unpairs ────────────────────────────────

// The state volume is the pairing. Taking it away, with the home, is what
// `docker compose down -v` does, and the replacement Core is a different Core —
// which is the honest answer, not a bug: the CA, the bearer secret and the
// Panel's client certificate all lived in that volume.
log("destroying the volumes — the `down -v` motion …");
const staleEndpointPort = core.port;
docker(["rm", "-f", core.name]);

// The home alone is not the pairing (#559): a Core re-created on a new home
// volume and the old state volume is the same Core. Only when the state
// volume goes too — `down -v` removes both — is it a different one.
docker(["volume", "rm", "-f", core.volume]);
docker(["volume", "create", core.volume]);
// A new container has a new log: the sentinel count starts again.
core.boots = 0;
core.start();
await waitForCoreLink(core);
if (readIdentity(core).coreId !== first.coreId) {
  die("a Core on a new home volume and the old state volume lost its identity");
}
await assertConnects("on a new home volume");
log("a destroyed home volume did not unpair: the identity is in the state volume");
docker(["rm", "-f", core.name]);
docker(["volume", "rm", "-f", core.volume, core.stateVolume]);

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
  "PASS — the Core image runs its daemon as actana with exactly CAP_SETUID and CAP_SETGID, " +
    "Sessions as core with none, emits no credential, pairs a Panel by code, survives restart, " +
    "unpairs on down -v",
);
process.exit(0);
