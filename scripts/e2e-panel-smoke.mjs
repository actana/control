#!/usr/bin/env node
// End-to-end test — the black-box Panel service seam (web-panel-extraction
// issue 10, the spec's primary testing seam).
//
// Boots the *built* Panel service as a plain Node process against a temp data
// directory, boots a real Core, and then drives the Panel exactly as a
// browser would — HTTP with a session cookie, and one panel-link WebSocket
// carrying `coreId`-tagged frames. Nothing here imports the Panel's own code:
// what it asserts is what a deployed artifact does.
//
// The legs, in order:
//
//   • first boot reports `needsSetup`, and BEFORE anyone logs in, an API call
//     and a panel-link upgrade are both refused;
//   • setup creates the Operator, logout/login round-trips the session cookie;
//   • a real pairing code, redeemed through "Add Core" against a Core whose
//     fingerprint was checked first, registers a Core — and its dial reaches
//     `connected` over the panel link;
//   • projects and tasks list, and a project created over the panel link shows
//     up in the next list — the write path is mutation frames, not HTTP;
//   • a PTY spawned over the panel link streams `coreId`-tagged output frames
//     carrying what was typed into it;
//   • the panel link is killed mid-flight, events happen on the Core while
//     no browser is attached, and a reconnected link replaying from its cursor
//     sees every one of them — no event loss;
//   • the credential the pairing issued is unreadable at rest: it appears
//     nowhere in panel.db in the clear, and a data directory restored without
//     its `secrets.key` cannot dial the Core it still lists;
//   • the `AC_SECRETS_KEY` path works: a Panel given the key by environment
//     pairs and dials without ever writing a key file;
//   • and a file dropped on a Project reaches that Core's disk — read back with
//     `fs`, not taken on the Panel's word — with the overwrite named in the
//     Core's own progress stream, and with a gigabyte crossing a Panel booted
//     with a 256 MB heap without its memory moving (#129 F6/F11, #169).
//
// The Core it pairs with comes from `scripts/lib/core-fixture.mjs` — a local
// Core process. The `--core-tarball` Core-in-a-box variant is gone with the
// fixture behind it (ADR 0016 D36); pairing against a *containerised* Core is
// now `scripts/smoke-core-image.mjs`, which does it against the image that
// ships rather than a privileged systemd fixture built for the test.
//
// Usage:
//   node scripts/e2e-panel-smoke.mjs [--panel-entry <file>] [--core-entry <file>]
//
// Build first (CI does both):
//   pnpm --filter @actana/core build && pnpm build:web
//
// Exit codes: 0 on pass, non-zero on any failed step. On failure the tail of
// the Panel's and the Core's output is printed so triage doesn't need a
// rerun.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { parseArgs, stringFlag } from "./lib/cli.mjs";
import { makeDie } from "./lib/core-smoke.mjs";
import { startLocalCore } from "./lib/core-fixture.mjs";
import {
  PANEL_SESSION_COOKIE,
  PanelLink,
  delay,
  pickFreePort,
  pollUntil,
  startPanelService,
} from "./lib/panel-e2e.mjs";

const die = makeDie("panel-e2e");
const log = (message) => console.log(`[panel-e2e] ${message}`);

const OPERATOR_NAME = "e2e-operator";
const OPERATOR_PASSWORD = "correct-horse-battery-staple";
const OTHER_PASSWORD = "definitely-not-the-password";

const DIAL_TIMEOUT_MS = 30_000;

// ─── The file-drop leg's numbers (#169) ──────────────────────────────────────
//
// The relationship between these three is the whole assertion, so they live
// together: the drop is several times the heap the Panel is allowed, and the
// resident-memory ceiling is a fraction of the drop. Move one and the leg stops
// meaning what it says.

/** The deployed Panel's heap limit for the file-drop phase, in MB. */
const PANEL_HEAP_CAP_MB = 256;
/**
 * How much is pushed through it — two gigabytes, because #169 says
 * *multi-gigabyte* and one is not that. `AC_E2E_FILE_DROP_BYTES` overrides it
 * for a machine that cannot spare the disk.
 */
const BIG_DROP_BYTES = Number(process.env.AC_E2E_FILE_DROP_BYTES ?? 2 * 1024 * 1024 * 1024);
/**
 * How much resident memory the Panel process may grow by while that crosses.
 *
 * The half of the assertion `--max-old-space-size` cannot make: `Buffer`s and
 * `ArrayBuffer`s are external memory and are not bounded by the heap cap at all,
 * so a Panel that buffered with `await request.arrayBuffer()` would sail past
 * the cap and be caught only here.
 */
const PANEL_RSS_CEILING_BYTES = 512 * 1024 * 1024;
/** Free space the phase needs on the Core's disk before it writes a gigabyte. */
const BIG_DROP_DISK_HEADROOM = BIG_DROP_BYTES * 3;
const PTY_OUTPUT_TIMEOUT_MS = 30_000;
const REPLAY_TIMEOUT_MS = 30_000;

/**
 * Everything to tear down, newest first, whatever happens.
 *
 * Every entry is synchronous on purpose: a failed assertion ends the run
 * through `die()` → `process.exit`, and an `exit` handler cannot await. Killing
 * a child and removing a temp directory are both sync operations, so nothing is
 * lost — the graceful `stop()` is used on the paths that can await it.
 */
const teardown = [];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._.length > 0) die(`unexpected argument: ${args._[0]}`);

  const repoRoot = path.resolve(import.meta.dirname, "..");
  const panelBin = path.join(repoRoot, "packages", "panel", "bin", "panel.mjs");
  const panelEntry = path.resolve(
    stringFlag(args, "panel-entry", die) ??
      path.join(repoRoot, "packages", "panel", "dist", "server", "server.js"),
  );
  const coreEntry = path.resolve(
    stringFlag(args, "core-entry", die) ??
      path.join(repoRoot, "packages", "core", "dist", "core-entry.cjs"),
  );
  if (!fs.existsSync(panelEntry)) die(`no built Panel at ${panelEntry} — run \`pnpm build:web\` first`);
  if (!fs.existsSync(coreEntry)) {
    die(`no built Core at ${coreEntry} — run \`pnpm --filter @actana/core build\` first`);
  }

  log(`node=${process.execPath} (${process.version})`);
  log(`panel=${panelEntry}`);
  log(`core=${coreEntry}`);

  const core = await startLocalCore({ entry: coreEntry, log }).catch((err) =>
    die(`core fixture failed to boot: ${err.message}`, err.logLines),
  );
  teardown.push(() => core.stop());

  await keyFilePhase({ panelBin, panelEntry, core });
  await envKeyPhase({ panelBin, panelEntry, core });
  await fileDropPhase({ panelBin, panelEntry, core });

  log("OK — the Panel service seam holds end to end");
}

/**
 * The main flow, on a Panel that generates its own `secrets.key`.
 *
 * One data directory carries the whole phase, including two restarts: the
 * registry, the sealed secrets, and the key file are exactly the state a
 * deployment is supposed to survive on.
 */
async function keyFilePhase({ panelBin, panelEntry, core }) {
  const dataDir = tempDir("ac-e2e-panel-");
  const port = await pickFreePort();
  const boot = () =>
    startPanelService({ bin: panelBin, serverEntry: panelEntry, dataDir, port, log });

  let panel = await boot().catch((err) => die(`panel failed to boot: ${err.message}`, err.logLines));
  teardown.push(() => panel.kill());
  const fail = (message) => die(message, [...panel.logLines(), ...core.logLines()]);

  await assertUnauthenticatedIsRefused(panel, fail);
  await assertSetupAndLogin(panel, fail);

  const coreId = await assertCoreRegisters(panel, core, fail);
  const link = await openLink(panel, fail);
  await assertDialConnects(link, coreId, fail);

  await assertLinkSubscribes(link, coreId, fail);

  // From the fixture, not from `tempDir`: the fixture interface exists so
  // that a Core which cannot see this machine's filesystem still works here
  // (see scripts/lib/core-fixture.mjs).
  const projectPath = core.makeProjectDir("ac-e2e-project-");
  await assertProjectAndTaskLists(link, coreId, projectPath, fail);
  await assertPtyStreams(link, coreId, fail);
  await assertReconnectReplaysMissedEvents(panel, link, coreId, fail);

  await assertSecretsSealedAtRest(dataDir, core, fail);

  // …and a data directory whose key file is gone cannot read them back.
  await panel.stop();
  const keyPath = path.join(dataDir, "secrets.key");
  const keyBackup = `${keyPath}.moved`;
  fs.renameSync(keyPath, keyBackup);
  panel = await boot().catch((err) => die(`panel failed to reboot: ${err.message}`, err.logLines));
  await assertCoreCannotDialWithoutKey(panel, coreId, fail);

  // Put it back: the same data directory must come straight back to life,
  // which is what makes the failure above about the key and nothing else.
  await panel.stop();
  fs.renameSync(keyBackup, keyPath);
  panel = await boot().catch((err) => die(`panel failed to reboot: ${err.message}`, err.logLines));
  await assertLoginAndDial(panel, coreId, fail);
  log("secrets at rest: sealed in panel.db, dead without the key file, alive with it");

  // Hand the Core back before the next phase pairs with it. A Core serves
  // one core-link at a time, so two live Panels dialing it would spend the run
  // displacing each other's connection.
  await panel.stop();
}

/**
 * The `AC_SECRETS_KEY` path (ADR 0011): the operator holds the key outside the
 * data directory. A fresh Panel given one must pair and dial without ever
 * writing a key file beside the data.
 */
async function envKeyPhase({ panelBin, panelEntry, core }) {
  const dataDir = tempDir("ac-e2e-panel-envkey-");
  const port = await pickFreePort();
  const secretsKey = randomBytes(32).toString("hex");
  const panel = await startPanelService({
    bin: panelBin,
    serverEntry: panelEntry,
    dataDir,
    port,
    secretsKey,
    log,
  }).catch((err) => die(`panel (AC_SECRETS_KEY) failed to boot: ${err.message}`, err.logLines));
  teardown.push(() => panel.kill());
  const fail = (message) => die(message, [...panel.logLines(), ...core.logLines()]);

  await assertSetupAndLogin(panel, fail);
  const coreId = await assertCoreRegisters(panel, core, fail);
  const link = await openLink(panel, fail);
  await assertDialConnects(link, coreId, fail);
  link.close();

  if (fs.existsSync(path.join(dataDir, "secrets.key"))) {
    fail("AC_SECRETS_KEY was set but the Panel still wrote a secrets.key beside the data");
  }
  await assertSecretsSealedAtRest(dataDir, core, fail);
  log("AC_SECRETS_KEY: paired and dialed with the key held outside the data directory");
  // The Core takes one core-link at a time; hand it back before the next phase
  // pairs with it, or the two Panels spend the run displacing each other.
  await panel.stop();
}

/**
 * Project files, through a **memory-limited deployed Panel** (#129 F6/F11, #169).
 *
 * This phase exists for one claim that cannot be made anywhere else: *"a
 * multi-gigabyte drop does not put the upload through the Panel's memory."* The
 * unit suite pins the streaming structurally — the Core reads a byte while the
 * browser is still writing — but only here is the Panel a real deployed process
 * with a real limit on it, which is what the claim is actually about.
 *
 * So this Panel is booted with `--max-old-space-size` set small and then handed
 * a file several times that size. **Both halves of the memory assertion are
 * needed and neither is redundant:**
 *
 *   • the heap cap catches a Panel that buffered into JS objects — it dies, and
 *     the request fails, loudly;
 *   • the RSS ceiling catches a Panel that buffered into `Buffer`s or
 *     `ArrayBuffer`s, which live in *external* memory that `--max-old-space-size`
 *     does not bound at all. That is the likelier accident, since it is what
 *     `await request.arrayBuffer()` and every framework body helper produce.
 *
 * And the other done-means is checked with `fs`: the file the operator dropped
 * is read straight off the Core's Project directory, which is what "`cat`-able
 * by a harness on that Core" means when you stop paraphrasing it.
 */
async function fileDropPhase({ panelBin, panelEntry, core }) {
  const dataDir = tempDir("ac-e2e-panel-files-");
  const port = await pickFreePort();
  const panel = await startPanelService({
    bin: panelBin,
    serverEntry: panelEntry,
    dataDir,
    port,
    // The limit the whole phase is about. A Panel container is a small one; this
    // is smaller, so that "bigger than the Panel's memory" needs a file measured
    // in gigabytes rather than in tens of them.
    extra: { NODE_OPTIONS: `--max-old-space-size=${PANEL_HEAP_CAP_MB}` },
    log,
  }).catch((err) => die(`panel (file drop) failed to boot: ${err.message}`, err.logLines));
  teardown.push(() => panel.kill());
  const fail = (message) => die(message, [...panel.logLines(), ...core.logLines()]);

  await assertSetupAndLogin(panel, fail);
  const coreId = await assertCoreRegisters(panel, core, fail);
  const link = await openLink(panel, fail);
  await assertDialConnects(link, coreId, fail);

  const filesCapable = await pollUntil(
    "the Core to announce its `files` capability",
    DIAL_TIMEOUT_MS,
    async () => {
      const listed = await panel.client.get("/api/cores");
      const row = listed.body?.cores?.find((c) => c.id === coreId);
      return row?.dial?.files ? row.dial : null;
    },
  ).catch(() => null);
  if (!filesCapable) {
    fail("the Core never announced `files` on `ready` — the Panel would withhold the file view");
  }

  const projectPath = core.makeProjectDir("ac-e2e-files-");
  const projectId = await assertProjectCreated(link, coreId, projectPath, "e2e-files", fail);
  link.close();

  await assertDropIsOnTheCoresDisk(panel, coreId, projectId, projectPath, fail);
  await assertOverwriteIsNamed(panel, coreId, projectId, projectPath, fail);
  await assertFileViewLists(panel, coreId, projectId, fail);
  await assertBigDropDoesNotGoThroughPanelMemory(panel, coreId, projectId, projectPath, fail);

  await panel.stop();
}

// ─── Legs ────────────────────────────────────────────────────────────────────

/**
 * Criterion: pre-login API and WS-upgrade attempts are rejected.
 *
 * Asserted before setup rather than after logout, because first boot is the
 * one window where the Panel has no Operator at all — if anything is going to
 * be reachable unauthenticated, it is here.
 */
async function assertUnauthenticatedIsRefused(panel, fail) {
  const state = await panel.client.get("/api/auth/state");
  if (state.status !== 200) fail(`GET /api/auth/state: expected 200, got ${state.status}`);
  if (state.body?.needsSetup !== true) {
    fail(`a fresh data directory should report needsSetup — got ${JSON.stringify(state.body)}`);
  }

  for (const probe of [
    { method: "GET", pathname: "/api/cores" },
    { method: "GET", pathname: "/api/projects" },
    { method: "GET", pathname: "/api/settings" },
    // A write, too: the reads and the writes go through the same gate, and a
    // regression that opened only one of them would be missed by either alone.
    { method: "POST", pathname: "/api/cores/pairing/inspect", body: { address: "127.0.0.1:1" } },
  ]) {
    const response =
      probe.method === "GET"
        ? await panel.client.get(probe.pathname)
        : await panel.client.post(probe.pathname, probe.body);
    if (response.status !== 401) {
      fail(
        `${probe.method} ${probe.pathname} before login: expected 401, got ${response.status} ` +
          `(${response.text.slice(0, 200)})`,
      );
    }
  }

  const refused = await PanelLink.open(panel.origin, "").then(
    (link) => {
      link.close();
      return null;
    },
    (err) => err,
  );
  if (!refused) fail("panel-link upgrade succeeded with no session cookie");
  if (refused.statusCode !== 401) {
    fail(`panel-link upgrade without a cookie: expected 401, got ${refused.statusCode ?? refused.message}`);
  }
  log("pre-login: API calls and the panel-link upgrade are both refused");
}

/** Setup creates the Operator; logout/login round-trips the session cookie. */
async function assertSetupAndLogin(panel, fail) {
  const setup = await panel.client.post("/api/auth/setup", {
    name: OPERATOR_NAME,
    password: OPERATOR_PASSWORD,
  });
  if (setup.status !== 200) fail(`setup: expected 200, got ${setup.status} (${setup.text.slice(0, 200)})`);
  if (!panel.client.jar.get(PANEL_SESSION_COOKIE)) fail("setup issued no session cookie");

  const second = await panel.client.post("/api/auth/setup", { name: "other", password: OPERATOR_PASSWORD });
  if (second.status !== 409) fail(`a second setup: expected 409, got ${second.status}`);

  const cores = await panel.client.get("/api/cores");
  if (cores.status !== 200) fail(`GET /api/cores after setup: expected 200, got ${cores.status}`);

  const loggedOut = await panel.client.post("/api/auth/logout");
  if (loggedOut.status !== 200) fail(`logout: expected 200, got ${loggedOut.status}`);
  if (panel.client.jar.get(PANEL_SESSION_COOKIE)) fail("logout left the session cookie behind");

  const afterLogout = await panel.client.get("/api/cores");
  if (afterLogout.status !== 401) {
    fail(`GET /api/cores after logout: expected 401, got ${afterLogout.status}`);
  }

  const wrong = await panel.client.post("/api/auth/login", { password: OTHER_PASSWORD });
  if (wrong.status !== 401) fail(`login with the wrong password: expected 401, got ${wrong.status}`);
  if (panel.client.jar.get(PANEL_SESSION_COOKIE)) fail("a failed login issued a session cookie");

  const login = await panel.client.post("/api/auth/login", { password: OPERATOR_PASSWORD });
  if (login.status !== 200) fail(`login: expected 200, got ${login.status} (${login.text.slice(0, 200)})`);
  if (!panel.client.jar.get(PANEL_SESSION_COOKIE)) fail("login issued no session cookie");
  log("setup → logout → login: the session cookie is the whole gate");
}

/**
 * Redeeming a pairing code registers a Core — the whole of "Add Core" (#286),
 * and since #287 the only way in.
 *
 * Three assertions in the order the operator meets them: the paste door is
 * *gone*, the fingerprint is answered before any code moves, and the code is
 * spent by its one successful redemption.
 */
async function assertCoreRegisters(panel, core, fail) {
  // #287: no add route at all. Not a 400 on a bad blob — a 404 on the route.
  const pasted = await panel.client.post("/api/cores", { registrationBlob: "not-a-blob" });
  if (pasted.status !== 404) {
    fail(`POST /api/cores should be gone: expected 404, got ${pasted.status}`);
  }

  // Step one: what CA does that address present? No code in the request, so
  // nothing is spent by asking.
  const inspected = await panel.client.post("/api/cores/pairing/inspect", {
    address: core.address,
  });
  if (inspected.status !== 200) {
    fail(`pairing inspect: expected 200, got ${inspected.status} (${inspected.text.slice(0, 200)})`);
  }
  const presented = inspected.body?.identity?.fingerprint;
  if (presented !== core.caFingerprint) {
    fail(`the Panel was presented ${presented}, expected ${core.caFingerprint}`);
  }

  // One `actana pair new` per phase: a code is single-use, and a phase that
  // reused the last one's would be asserting the wrong thing.
  const { code, sessionId } = core.newPairing();

  // A wrong code is refused, and the Core is not registered on the strength of
  // one — the attempt cap is what stops this being a guessing game.
  const wrong = await panel.client.post("/api/cores/pairing", {
    address: core.address,
    code: "ZZZZ-ZZZZ",
    sessionId,
    expectedFingerprint: core.caFingerprint,
    label: "e2e",
  });
  if (wrong.status !== 400) fail(`a wrong pairing code: expected 400, got ${wrong.status}`);

  const added = await panel.client.post("/api/cores/pairing", {
    address: core.address,
    code,
    sessionId,
    expectedFingerprint: core.caFingerprint,
    label: "e2e",
  });
  if (added.status !== 201) {
    fail(`pair Core: expected 201, got ${added.status} (${added.text.slice(0, 200)})`);
  }
  const coreId = added.body?.core?.id;
  if (typeof coreId !== "string" || !coreId) fail(`pairing returned no id: ${added.text.slice(0, 200)}`);

  // Single-use: the same code cannot register a second Core.
  const replay = await panel.client.post("/api/cores/pairing", {
    address: core.address,
    code,
    sessionId,
    expectedFingerprint: core.caFingerprint,
    label: "e2e-again",
  });
  if (replay.status !== 400) fail(`a spent pairing code: expected 400, got ${replay.status}`);

  const listed = await panel.client.get("/api/cores");
  if (!listed.body?.cores?.some((row) => row.id === coreId)) {
    fail(`the registered Core is not in GET /api/cores: ${listed.text.slice(0, 300)}`);
  }
  // The credential the redemption produced must not come back out of any API,
  // and neither may anything of the Core's own identity.
  for (const [name, secret] of Object.entries(core.secrets)) {
    if (listed.text.includes(secret)) fail(`GET /api/cores leaked the Core's ${name}`);
  }
  if (/BEGIN (CERTIFICATE|PRIVATE KEY)/.test(listed.text)) {
    fail("GET /api/cores returned certificate material");
  }
  log(`paired Core ${coreId} with a one-time code, fingerprint checked first`);
  return coreId;
}

async function openLink(panel, fail) {
  const link = await PanelLink.open(panel.origin, panel.client.jar).catch((err) =>
    fail(`panel-link upgrade with a session cookie failed: ${err.message}`),
  );
  teardown.push(() => link.close());
  return link;
}

/** The dial-status frame is the one fact the Core cannot report about itself. */
async function assertDialConnects(link, coreId, fail) {
  await link
    .waitFor((f) => f.t === "dial" && f.status.coreId === coreId && f.status.state === "connected", {
      timeoutMs: DIAL_TIMEOUT_MS,
      label: `core ${coreId} to reach connected`,
    })
    .catch((err) => fail(`${err.message} — last dial frames: ${dialFrames(link)}`));
  log("the panel link reports the Core connected");
}

/**
 * A tab's first act on a live link: subscribe to the Core.
 *
 * It is what makes this link a watcher — the router fans a Core's pushes out
 * only to sessions that have asked for them, so nothing else in this test would
 * see a PTY byte without it. A fresh tab sends `lastEventId: 0` ("I have seen
 * nothing") and is told where the Core currently stands rather than being
 * replayed its whole history.
 */
async function assertLinkSubscribes(link, coreId, fail) {
  const { events, lastEventId } = await link
    .subscribe(coreId, 0, { timeoutMs: REPLAY_TIMEOUT_MS })
    .catch((err) => fail(`subscribe failed: ${err.message}`));
  if (events.length > 0) {
    fail(`a first-time subscribe replayed ${events.length} event(s) instead of just the head`);
  }
  if (typeof lastEventId !== "number") fail(`eventsReplayed carried no cursor: ${lastEventId}`);
}

function dialFrames(link) {
  return JSON.stringify(link.frames.filter((f) => f.t === "dial").slice(-5));
}

/**
 * Read and write across the router: list projects, create one over the panel
 * link (mutation frames are the only write path — ADR 0004), list again, and
 * list that project's tasks.
 */
async function assertProjectAndTaskLists(link, coreId, projectPath, fail) {
  const before = await link.request(coreId, { type: "projectsList" });
  if (before.type !== "projectsListResult") fail(`projectsList answered ${before.type}`);
  if (!Array.isArray(before.projects) || before.projects.length !== 0) {
    fail(`a fresh Core should have no projects, got ${JSON.stringify(before.projects)}`);
  }

  const created = await link.request(coreId, {
    type: "projectsMutate",
    mutation: { op: "create", name: "e2e", path: projectPath },
  });
  if (created.type !== "projectsMutateResult" || !created.project?.projectId) {
    fail(`creating a project over the panel link answered ${JSON.stringify(created).slice(0, 300)}`);
  }
  const { projectId } = created.project;

  const after = await link.request(coreId, { type: "projectsList" });
  if (!after.projects?.some((project) => project.projectId === projectId)) {
    fail(`the created project is missing from projectsList: ${JSON.stringify(after.projects)}`);
  }

  const tasks = await link.request(coreId, { type: "tasksList", projectId });
  if (tasks.type !== "tasksListResult" || !Array.isArray(tasks.tasks)) {
    fail(`tasksList answered ${JSON.stringify(tasks).slice(0, 300)}`);
  }
  log(`projects and tasks list over the panel link (project ${projectId})`);
}

// ─── Project files (#129 F6/F11, #169) ───────────────────────────────────────

/** Create one Project on the Core over the panel link, and hand back its id. */
async function assertProjectCreated(link, coreId, projectPath, name, fail) {
  const created = await link.request(coreId, {
    type: "projectsMutate",
    mutation: { op: "create", name, path: projectPath },
  });
  if (created.type !== "projectsMutateResult" || !created.project?.projectId) {
    fail(`creating ${name} answered ${JSON.stringify(created).slice(0, 300)}`);
  }
  return created.project.projectId;
}

function filesPath(coreId, projectId, relative) {
  return (
    `/api/cores/${encodeURIComponent(coreId)}/projects/${encodeURIComponent(projectId)}` +
    `/files?path=${encodeURIComponent(relative)}`
  );
}

/**
 * PUT a body at the Panel **without ever holding it**, and read the NDJSON back.
 *
 * `write` is called with the request stream and paces itself against `drain`, so
 * a gigabyte is generated a chunk at a time on this side too — a test that
 * assembled the body first would be measuring its own memory, not the Panel's.
 */
function putStreamed(panel, pathname, write, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(panel.origin + pathname);
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        method: "PUT",
        path: url.pathname + url.search,
        headers: {
          "content-type": "application/octet-stream",
          cookie: panel.client.jar.header(),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            lines: text
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
              .map((line) => {
                try {
                  return JSON.parse(line);
                } catch {
                  return { unparsed: line };
                }
              }),
          }),
        );
      },
    );
    req.on("error", reject);
    Promise.resolve(write(req)).then(
      () => req.end(),
      (err) => {
        req.destroy();
        reject(err);
      },
    );
  });
}

/** One string body, written in a single chunk. */
function putText(panel, pathname, text) {
  return putStreamed(panel, pathname, (req) => {
    req.write(text);
  });
}

/**
 * Criterion (#129's done-means for the whole phase): a file dropped on a Project
 * in the Panel is on that Core's disk, readable, seconds later.
 *
 * Asserted with `fs` against the Core's own Project directory rather than
 * against anything the Panel said — the Panel answering `200` is what a
 * write-shaped bug looks like too.
 */
async function assertDropIsOnTheCoresDisk(panel, coreId, projectId, projectPath, fail) {
  const contents = `dropped-by-the-e2e-${Date.now()}`;
  const answer = await putText(panel, filesPath(coreId, projectId, "notes/dropped.txt"), contents);
  if (answer.status !== 200) {
    fail(`dropping a file: expected 200, got ${answer.status} (${JSON.stringify(answer.lines).slice(0, 300)})`);
  }
  const landed = path.join(projectPath, "notes", "dropped.txt");
  if (!fs.existsSync(landed)) fail(`the dropped file is not on the Core's disk at ${landed}`);
  const onDisk = fs.readFileSync(landed, "utf8");
  if (onDisk !== contents) fail(`the file on the Core reads ${onDisk.slice(0, 80)}, not what was dropped`);
  log("a file dropped on a Project is on that Core's disk, at the path the browser named");
}

/** Criterion (F5): the second drop of the same name is reported as an overwrite. */
async function assertOverwriteIsNamed(panel, coreId, projectId, projectPath, fail) {
  const pathname = filesPath(coreId, projectId, "notes/dropped.txt");
  const answer = await putText(panel, pathname, "second");
  const entry = answer.lines.find((line) => line.result);
  if (!entry || entry.result !== "overwritten") {
    fail(`a second drop should be named an overwrite, got ${JSON.stringify(answer.lines).slice(0, 300)}`);
  }
  if (fs.readFileSync(path.join(projectPath, "notes", "dropped.txt"), "utf8") !== "second") {
    fail("the overwrite did not reach the Core's disk");
  }
  log("progress comes from the Core's NDJSON stream, and names the overwrite");
}

/** Criterion: the file view lists what is actually there. */
async function assertFileViewLists(panel, coreId, projectId, fail) {
  const listed = await panel.client.get(
    `/api/cores/${coreId}/projects/${projectId}/files/list?path=`,
  );
  if (listed.status !== 200) fail(`listing files: expected 200, got ${listed.status}`);
  const paths = listed.text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line).path);
  if (!paths.includes("notes/dropped.txt")) {
    fail(`the listing is missing the dropped file: ${JSON.stringify(paths).slice(0, 300)}`);
  }
  log("the file view lists the Project's tree off the Core");
}

/** This process's resident memory, from the OS rather than from the process. */
function rssBytes(pid) {
  try {
    // Linux: field 2 of statm is resident pages.
    const statm = fs.readFileSync(`/proc/${pid}/statm`, "utf8").split(/\s+/);
    return Number(statm[1]) * 4096;
  } catch {
    try {
      const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
      return Number(out.trim()) * 1024;
    } catch {
      return 0;
    }
  }
}

/**
 * Criterion: a multi-gigabyte drop does not put the upload through the Panel's
 * memory.
 *
 * The Panel under this leg was booted with a heap cap of
 * {@link PANEL_HEAP_CAP_MB} MB and is handed {@link BIG_DROP_BYTES}. A Panel
 * that buffers dies of the cap or blows the RSS ceiling; a Panel that streams
 * finishes with its memory flat, whatever the file's size.
 */
async function assertBigDropDoesNotGoThroughPanelMemory(panel, coreId, projectId, projectPath, fail) {
  const free = freeBytesOn(projectPath);
  if (free !== null && free < BIG_DROP_DISK_HEADROOM) {
    fail(
      `the file-drop leg needs ~${mib(BIG_DROP_DISK_HEADROOM)} free on ${projectPath} and found ` +
        `${mib(free)}. Set AC_E2E_FILE_DROP_BYTES to a smaller size to run it on a smaller disk — ` +
        `it is not skipped silently, because the claim it makes is the point of the phase.`,
    );
  }

  const baseline = rssBytes(panel.pid);
  let peak = baseline;
  const sampler = setInterval(() => {
    peak = Math.max(peak, rssBytes(panel.pid));
  }, 50);

  // One buffer, reused: the generator must not be the thing under memory
  // pressure, or the leg would be measuring itself.
  const chunk = Buffer.alloc(4 * 1024 * 1024, 0xab);
  const started = Date.now();
  let answer;
  try {
    answer = await putStreamed(
      panel,
      filesPath(coreId, projectId, "big/blob.bin"),
      async (req) => {
        let written = 0;
        while (written < BIG_DROP_BYTES) {
          const size = Math.min(chunk.byteLength, BIG_DROP_BYTES - written);
          const slice = size === chunk.byteLength ? chunk : chunk.subarray(0, size);
          written += size;
          if (!req.write(slice)) {
            await new Promise((resolve) => req.once("drain", resolve));
          }
        }
      },
      { "content-length": String(BIG_DROP_BYTES) },
    );
  } finally {
    clearInterval(sampler);
  }

  if (answer.status !== 200) {
    fail(
      `a ${mib(BIG_DROP_BYTES)} drop: expected 200, got ${answer.status} ` +
        `(${JSON.stringify(answer.lines).slice(0, 300)}) — a Panel that died here buffered it`,
    );
  }

  const landed = path.join(projectPath, "big", "blob.bin");
  const size = fs.existsSync(landed) ? fs.statSync(landed).size : -1;
  if (size !== BIG_DROP_BYTES) {
    fail(`the big drop landed as ${size} bytes on the Core, not ${BIG_DROP_BYTES}`);
  }
  // Reclaimed straight away: a gigabyte left behind in a temp directory is the
  // kind of thing that fills a runner's disk two runs later.
  fs.rmSync(landed, { force: true });

  const growth = peak - baseline;
  log(
    `${mib(BIG_DROP_BYTES)} crossed a Panel capped at ${PANEL_HEAP_CAP_MB} MB heap in ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s; its RSS grew ${mib(growth)} ` +
      `(baseline ${mib(baseline)}, peak ${mib(peak)})`,
  );
  if (growth > PANEL_RSS_CEILING_BYTES) {
    fail(
      `the Panel's resident memory grew ${mib(growth)} while ${mib(BIG_DROP_BYTES)} crossed it — ` +
        `the ceiling is ${mib(PANEL_RSS_CEILING_BYTES)}. It is buffering the upload, not streaming it.`,
    );
  }
  log("a multi-gigabyte drop does not go through the Panel's memory");
}

/** Free bytes on the filesystem holding `target`, or null where it cannot be read. */
function freeBytesOn(target) {
  try {
    const stats = fs.statfsSync(target);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function mib(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
}

/**
 * A PTY spawned over the panel link streams its output back tagged with the
 * `coreId` it came from.
 *
 * The marker is split across a quote (`AC""E2E-…`) so the shell's echo of the
 * typed line cannot satisfy the assertion — only the command's own output,
 * which the Core read off the pty and the router forwarded, contains the
 * joined string.
 */
async function assertPtyStreams(link, coreId, fail) {
  const marker = `ACE2E-${randomBytes(6).toString("hex")}`;
  const typed = `echo "${marker.slice(0, 2)}""${marker.slice(2)}"`;

  const spawned = await link.request(coreId, {
    type: "spawn",
    opts: { shellSession: true, taskId: `e2e-${randomBytes(4).toString("hex")}`, cols: 80, rows: 24 },
  });
  if (spawned.type !== "spawned" || !spawned.ptyId) {
    fail(`spawn answered ${JSON.stringify(spawned).slice(0, 300)}`);
  }
  const { ptyId } = spawned;

  const written = await link.request(coreId, { type: "write", ptyId, data: `${typed}\r` });
  if (written.type !== "writeResult" || written.ok !== true) {
    fail(`write answered ${JSON.stringify(written).slice(0, 200)}`);
  }

  const frame = await link
    .waitFor(
      (f) =>
        f.t === "core" &&
        f.coreId === coreId &&
        f.frame.type === "data" &&
        f.frame.ptyId === ptyId &&
        f.frame.data.includes(marker),
      { timeoutMs: PTY_OUTPUT_TIMEOUT_MS, label: "PTY output carrying the marker" },
    )
    .catch((err) =>
      fail(`${err.message} — saw ${JSON.stringify(link.ptyOutput(coreId, ptyId)).slice(0, 400)}`),
    );
  if (frame.coreId !== coreId) fail(`PTY output arrived tagged ${frame.coreId}, not ${coreId}`);
  if (typeof frame.frame.seq !== "number") fail("PTY output arrived without a seq");

  const killed = await link.request(coreId, { type: "kill", ptyId });
  if (killed.type !== "killResult") fail(`kill answered ${killed.type}`);
  log(`PTY ${ptyId} streamed coreId-tagged output frames`);
}

/**
 * Criterion: no event loss across a killed panel link.
 *
 * The tab arms something that will happen on its own — a PTY running a command
 * that finishes in a couple of seconds — notes where its cursor stands, and
 * then dies without a goodbye. The wait that follows is what makes the leg mean
 * anything: the exit lands while *no panel link exists at all*, so the only way
 * a reconnecting tab can learn about it is replay from its cursor. The
 * core-link is the service's and keeps advancing while nobody is watching (spec
 * story 16).
 *
 * Every reconnect attempt opens a *fresh* link and subscribes as its first act,
 * so an event it reports was necessarily buffered before that link existed — a
 * live push cannot stand in for the replay this is asserting.
 *
 * Arming an event this way rather than causing one directly on the Core is
 * deliberate: the Core serves one core-link at a time, so a second dial
 * would displace the Panel's own — the test would be measuring its own
 * interference instead of the service.
 */
async function assertReconnectReplaysMissedEvents(panel, link, coreId, fail) {
  const ptyLifetimeMs = 2_000;
  const spawned = await link.request(coreId, {
    type: "spawn",
    opts: {
      shellSession: true,
      taskId: `e2e-exit-${randomBytes(4).toString("hex")}`,
      command: `sleep ${ptyLifetimeMs / 1000}`,
      cols: 80,
      rows: 24,
    },
  });
  if (spawned.type !== "spawned" || !spawned.ptyId) {
    fail(`spawning the short-lived PTY answered ${JSON.stringify(spawned).slice(0, 300)}`);
  }

  const { lastEventId: cursor } = await link
    .subscribe(coreId, 0, { timeoutMs: REPLAY_TIMEOUT_MS })
    .catch((err) => fail(`subscribe before the drop failed: ${err.message}`));
  if (typeof cursor !== "number" || cursor <= 0) {
    fail(`expected a non-zero event cursor after the project was created, got ${cursor}`);
  }
  const seenBefore = link.eventsFor(coreId);
  if (seenBefore.some((event) => event.ptyId === spawned.ptyId && event.kind === "pty:exit")) {
    fail("the PTY exited before the link was dropped — nothing was left to miss");
  }

  link.kill();

  // Nobody is attached for this stretch: the PTY runs out, the Core appends
  // the exit, and the service's core-link carries it up to a router with no
  // sessions on it.
  await delay(ptyLifetimeMs + 1_000);

  const replayed = await pollUntil(
    `the pty:exit for ${spawned.ptyId} to replay past cursor ${cursor}`,
    REPLAY_TIMEOUT_MS,
    async () => {
      const reconnected = await PanelLink.open(panel.origin, panel.client.jar);
      const { events } = await reconnected.subscribe(coreId, cursor, {
        timeoutMs: REPLAY_TIMEOUT_MS,
      });
      const exited = events.find(
        (event) => event.kind === "pty:exit" && event.ptyId === spawned.ptyId,
      );
      if (exited) return { events, reconnected };
      reconnected.close();
      return null;
    },
    { pollMs: 1_000 },
  ).catch((err) => fail(err.message));
  teardown.push(() => replayed.reconnected.close());

  for (const event of replayed.events) {
    if (event.eventId <= cursor) {
      fail(`replay resent event ${event.eventId}, which is at or before the cursor ${cursor}`);
    }
  }
  const ids = replayed.events.map((event) => event.eventId);
  if (ids.some((id, i) => i > 0 && id <= ids[i - 1])) {
    fail(`replayed events are not strictly ascending: ${JSON.stringify(ids)}`);
  }

  log(
    `reconnect replayed ${replayed.events.length} event(s) past cursor ${cursor}, ` +
      `including the pty:exit that happened with no panel link attached`,
  );
}

/**
 * Nothing the pairing produced is in the database as plaintext.
 *
 * The Panel's own client key never leaves it, so the fixture cannot hand this
 * a copy to search for — what it searches for instead is the shape: a PEM
 * header in the file at all means a credential was written unsealed, whichever
 * one it is. The Core's own material is checked by name on top of that.
 *
 * Every `panel.db*` file, not just `panel.db`: the Panel runs in WAL mode, so a
 * row written moments ago normally lives in `panel.db-wal` and a scan of the
 * main file alone would clear a Panel that had just written a key in the clear.
 */
async function assertSecretsSealedAtRest(dataDir, core, fail) {
  if (!fs.existsSync(path.join(dataDir, "panel.db"))) fail(`no panel.db in ${dataDir}`);
  const dbFiles = fs.readdirSync(dataDir).filter((name) => name.startsWith("panel.db"));
  for (const file of dbFiles) {
    const raw = fs.readFileSync(path.join(dataDir, file));
    if (raw.includes(Buffer.from("-----BEGIN", "utf8"))) {
      fail(`${file} holds PEM material in the clear`);
    }
    for (const [name, secret] of Object.entries(core.secrets)) {
      if (raw.includes(Buffer.from(secret, "utf8"))) {
        fail(`the Core's ${name} is stored in ${file} in the clear`);
      }
    }
  }
}

/** A data directory restored without its key file lists the Core but cannot dial it. */
async function assertCoreCannotDialWithoutKey(panel, coreId, fail) {
  const login = await panel.client.post("/api/auth/login", { password: OPERATOR_PASSWORD });
  if (login.status !== 200) fail(`login after restart: expected 200, got ${login.status}`);

  const status = await pollUntil(
    "the Core to report it cannot read its credentials",
    DIAL_TIMEOUT_MS,
    async () => {
      const listed = await panel.client.get("/api/cores");
      const core = listed.body?.cores?.find((c) => c.id === coreId);
      if (!core) fail("the Core vanished from the registry when its key file did");
      // Anything but auth-error is a failure once the deadline passes: a Core
      // whose sealed secrets cannot be opened must say so rather than sit in
      // `connecting` or, worse, reach `connected`.
      return core.dial?.state === "auth-error" ? core.dial : null;
    },
    { pollMs: 500 },
  ).catch((err) => fail(`${err.message} — the Core never reported an unreadable-credentials dial`));

  if (!status.detail) fail("the auth-error dial carried no operator-facing detail");
}

/** With the key file back, the same data directory dials the same Core again. */
async function assertLoginAndDial(panel, coreId, fail) {
  const login = await panel.client.post("/api/auth/login", { password: OPERATOR_PASSWORD });
  if (login.status !== 200) fail(`login after restoring the key: expected 200, got ${login.status}`);
  const link = await openLink(panel, fail);
  await assertDialConnects(link, coreId, fail);
  link.close();
}

// ─── Plumbing ────────────────────────────────────────────────────────────────

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  teardown.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runTeardown() {
  for (const fn of teardown.reverse()) {
    try {
      fn();
    } catch {
      /* a failed cleanup must not mask the result */
    }
  }
  teardown.length = 0;
}

process.on("exit", runTeardown);
process.on("SIGINT", () => {
  runTeardown();
  process.exit(130);
});

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error(`[panel-e2e] unexpected error: ${err?.stack || err?.message || err}`);
  process.exit(1);
}
