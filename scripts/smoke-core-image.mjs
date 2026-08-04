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
//   • a plain `docker run` — no privileges, no host mounts — boots the daemon,
//     mints an identity on the empty volume and prints its pairing token;
//   • tini is PID 1 and the daemon is PID 2 (D14), read out of /proc;
//   • the lifecycle verbs the image owns refuse, and each names its Docker
//     equivalent rather than just saying no (D16);
//   • a real Panel, booted as the deployable it is, pastes that token into
//     "Add Core" and the panel link reports the Core connected;
//   • `docker restart` is a no-op for pairing: same identity, no second token,
//     and the same Panel reconnects without being touched (D17);
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
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { parseArgs, stringFlag } from "./lib/cli.mjs";
import { decodeBlob, makeDie, pickFreePort } from "./lib/core-smoke.mjs";
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

/** The blob file the daemon writes beside its material on first boot. */
const BLOB_FILE = `${CORE_HOME}/.config/actana/registration-blob.txt`;

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
 * port inside agree — the endpoint in the pairing token is the Core's own
 * `publicHost:port`, and a token the test then rewrote would stop being the
 * token an operator pastes.
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
    /**
     * The container's output. `tail: "all"` is not a nicety — the
     * "a restart prints no second token" assertion counts notices across the
     * whole life of the container, and a truncated tail would let a second
     * token scroll out of sight and the count pass.
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

/** Wait until the core-link port accepts a TCP connection. */
async function waitForCoreLink(container) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port: container.port });
      const settle = (value) => {
        socket.destroy();
        resolve(value);
      };
      socket.once("connect", () => settle(true));
      socket.once("error", () => settle(false));
      socket.setTimeout(2_000, () => settle(false));
    });
    if (open) return;
    if (Date.now() >= deadline) {
      die(
        `${container.name} never accepted a core-link connection within ${timeoutMs}ms. ` +
          `Container logs:\n${container.logs()}`,
      );
    }
    await delay(500);
  }
}

/** The pairing token this Core minted, as an operator would copy it. */
function readBlob(container) {
  const read = container.exec(["cat", BLOB_FILE], { allowFailure: true });
  if (read.status !== 0) {
    die(`no pairing token at ${BLOB_FILE} in ${container.name}:\n${container.logs()}`);
  }
  const registrationBlob = read.stdout.trim();
  if (!registrationBlob) die(`${BLOB_FILE} is empty in ${container.name}`);
  const blob = decodeBlob(registrationBlob);
  return { registrationBlob, blob, coreId: coreIdFromBearer(blob.bearer) };
}

/**
 * The Core this token authorizes, read out of the bearer's payload.
 *
 * The blob carries no `coreId` field of its own — it is inside the signed
 * bearer (`base64url({coreId, exp}).base64url(sig)`, ADR 0002), which is where
 * the Panel reads it from too. Decoded rather than verified: what this asserts
 * is which Core the token names, not that the signature is good, and the
 * pairing legs below prove the signature by actually connecting.
 */
function coreIdFromBearer(bearer) {
  const [payload] = String(bearer).split(".");
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).coreId;
  } catch {
    return die(`the pairing token's bearer does not decode: ${String(bearer).slice(0, 40)}…`);
  }
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
const first = readBlob(core);
log(`the Core minted ${first.coreId} and printed its pairing token`);

if (first.blob.endpoint !== core.endpoint) {
  die(
    `the token's endpoint is ${first.blob.endpoint}, expected ${core.endpoint} — ` +
      `ACTANA_PUBLIC_HOST/ACTANA_PORT did not reach the certificate and the token`,
  );
}
// What the operator is told to do is `docker compose logs core`, so the token
// has to be in the log and not only in the volume.
if (!core.logs("all").includes('paste this into your Panel\'s "Add Core"')) {
  die(`the first boot printed no pairing-token notice:\n${core.logs()}`);
}

// D12 — the identity is pinned by number, because a uid that exists nowhere on
// the host makes every bind-mounted repo unreadable to the operator who owns it.
const identity = core.exec(["id", "-u"]).stdout.trim() + ":" + core.exec(["id", "-g"]).stdout.trim();
if (identity !== "1000:1000") die(`the Core runs as ${identity}, expected 1000:1000`);

// D14 — node-pty forks a shell and the shell forks a Harness, so a Harness
// whose shell exited first reparents to PID 1. libuv only reaps children Node
// spawned itself, so a Core at PID 1 accumulates zombies until the PID table
// fills. `comm` rather than the full cmdline: bin/actana is a shell wrapper
// that `exec`s the bundled Node, so PID 2 is that Node and not a second shell.
const pid1 = core.exec(["cat", "/proc/1/comm"]).stdout.trim();
const pid2 = core.exec(["cat", "/proc/2/comm"]).stdout.trim();
if (pid1 !== "tini") die(`PID 1 is ${JSON.stringify(pid1)}, expected tini`);
if (pid2 !== "node") die(`PID 2 is ${JSON.stringify(pid2)}, expected the daemon's node`);
log("tini is PID 1 and the daemon is PID 2");

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

const added = await panel.client.post("/api/cores", {
  registrationBlob: first.registrationBlob,
});
if (added.status !== 201) die(`add Core → ${added.status}: ${added.text.slice(0, 200)}`);
const coreId = added.body?.core?.id;
if (coreId !== first.coreId) {
  die(`the Panel registered ${coreId}, but the token names ${first.coreId}`);
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
// one, so a restart re-enters the load branch: same identity, and no second
// token in the log — a second token would read to an operator as "this Core
// moved" and send them re-pairing for nothing.
log("restarting the container — pairing must survive it untouched …");
docker(["restart", core.name]);
await waitForCoreLink(core);

const afterRestart = readBlob(core);
if (afterRestart.coreId !== first.coreId) {
  die(`restart re-minted the identity: ${first.coreId} → ${afterRestart.coreId}`);
}
if (afterRestart.registrationBlob !== first.registrationBlob) {
  die("restart rewrote the pairing token, so every paired Panel would be holding a stale one");
}
// One over the container's whole life: the first boot's. A restart that
// printed another would read to an operator as "this Core moved" and send them
// re-pairing for nothing.
const notices = core.logs("all").split('paste this into your Panel\'s "Add Core"').length - 1;
if (notices !== 1) {
  die(`the Core has printed ${notices} pairing tokens across its life; expected exactly 1`);
}

await assertConnects("after a restart");
log("restart is a no-op for pairing — same identity, no new token, still connected");

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
const second = readBlob(replacement);
if (second.coreId === first.coreId) {
  die("a Core booted on a destroyed volume kept its identity — `down -v` did not unpair");
}
if (second.blob.bearer === first.blob.bearer || second.blob.caCert === first.blob.caCert) {
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

log("PASS — the Core image boots unprivileged, pairs a Panel, survives restart, unpairs on down -v");
process.exit(0);
