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
//   • projects and sessions list, and a project created over the panel link shows
//     up in the next list — the write path is mutation frames, not HTTP;
//   • a PTY spawned over the panel link streams `coreId`-tagged output frames
//     carrying what was typed into it;
//   • the panel link is killed mid-flight, events happen on the Core while
//     no browser is attached, and a reconnected link replaying from its cursor
//     sees every one of them — no event loss;
//   • the credential the pairing issued is unreadable at rest: it appears
//     nowhere in core_secrets.sealed (or the rest of the Panel's Postgres rows)
//     in the clear, and a data directory restored without its `secrets.key`
//     cannot dial the Core it still lists;
//   • the `AC_SECRETS_KEY` path works: a Panel given the key by environment
//     pairs and dials without ever writing a key file;
//   • and the Panel's old per-Project Files route is gone from the deployed service: a request
//     to `/api/cores/:id/projects/:id/files` is the router's 404, the route a Core's files used to
//     cross the Panel on (#580; the byte-streaming and memory-ceiling leg that drove it went with it).
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

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
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
import { ensurePanelDatabase, allocatePanelDatabase, queryPanelDatabase } from "./lib/postgres-fixture.mjs";

const die = makeDie("panel-e2e");
const log = (message) => console.log(`[panel-e2e] ${message}`);

const OPERATOR_NAME = "e2e-operator";
const OPERATOR_PASSWORD = "correct-horse-battery-staple";
const OTHER_PASSWORD = "definitely-not-the-password";

const DIAL_TIMEOUT_MS = 30_000;

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

  // The Panel refuses to start without a Postgres (#567), so one runs beside it.
  // Each phase then gets a database of its own on that server: setup wants 200,
  // and a shared database already has the Operator from the phase before.
  teardown.push(await ensurePanelDatabase({ name: `ac-e2e-panel-pg-${process.pid}`, log }));

  await keyFilePhase({ panelBin, panelEntry, core });
  await envKeyPhase({ panelBin, panelEntry, core });
  await retiredFilesRoutePhase({ panelBin, panelEntry, core });

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
  const { url: databaseUrl } = await allocatePanelDatabase({ label: "keyfile", log });
  const dataDir = tempDir("ac-e2e-panel-");
  const port = await pickFreePort();
  const boot = () =>
    startPanelService({
      bin: panelBin,
      serverEntry: panelEntry,
      dataDir,
      port,
      extra: { AC_PANEL_DATABASE_URL: databaseUrl },
      log,
    });

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
  await assertSessionLists(link, coreId, fail);
  await assertPtyStreams(link, coreId, fail);
  await assertReconnectReplaysMissedEvents(panel, link, coreId, fail);

  await assertSecretsSealedAtRest(databaseUrl, core, fail);

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
  log("secrets at rest: sealed in Postgres, dead without the key file, alive with it");

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
  const { url: databaseUrl } = await allocatePanelDatabase({ label: "envkey", log });
  const dataDir = tempDir("ac-e2e-panel-envkey-");
  const port = await pickFreePort();
  const secretsKey = randomBytes(32).toString("hex");
  const panel = await startPanelService({
    bin: panelBin,
    serverEntry: panelEntry,
    dataDir,
    port,
    secretsKey,
    extra: { AC_PANEL_DATABASE_URL: databaseUrl },
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
  await assertSecretsSealedAtRest(databaseUrl, core, fail);
  log("AC_SECRETS_KEY: paired and dialed with the key held outside the data directory");
  // The Core takes one core-link at a time; hand it back before the next phase
  // pairs with it, or the two Panels spend the run displacing each other.
  await panel.stop();
}

/**
 * The Panel's Core-files route is retired (#580, ADR 0041 D27): a Core has no Projects and the Panel
 * no longer pipes a Core's file bytes. A request for the old address is refused by the deployed
 * service as an unknown route, after login and with a Core paired and connected, so the 404 is the
 * router's and not "no such Core".
 */
async function retiredFilesRoutePhase({ panelBin, panelEntry, core }) {
  const { url: databaseUrl } = await allocatePanelDatabase({ label: "files", log });
  const dataDir = tempDir("ac-e2e-panel-files-");
  const port = await pickFreePort();
  const panel = await startPanelService({
    bin: panelBin,
    serverEntry: panelEntry,
    dataDir,
    port,
    extra: { AC_PANEL_DATABASE_URL: databaseUrl },
    log,
  }).catch((err) => die(`panel (retired files route) failed to boot: ${err.message}`, err.logLines));
  teardown.push(() => panel.kill());
  const fail = (message) => die(message, [...panel.logLines(), ...core.logLines()]);

  await assertSetupAndLogin(panel, fail);
  const coreId = await assertCoreRegisters(panel, core, fail);
  const link = await openLink(panel, fail);
  await assertDialConnects(link, coreId, fail);
  link.close();

  await assertRetiredFilesRouteIsRefused(panel, coreId, fail);

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
    { method: "GET", pathname: "/api/home/user-terminals" },
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
 * Read and write across the router: list Sessions, create one over the panel
 * link (mutation frames are the only write path — ADR 0004), and list again.
 * A Core has no Projects (ADR 0041 D1), so a Session is created with no parent.
 */
async function assertSessionLists(link, coreId, fail) {
  const before = await link.request(coreId, { type: "sessionRowsList" });
  if (before.type !== "sessionRowsListResult") fail(`sessionRowsList answered ${before.type}`);
  if (!Array.isArray(before.sessions) || before.sessions.length !== 0) {
    fail(`a fresh Core should have no Sessions, got ${JSON.stringify(before.sessions)}`);
  }

  const created = await link.request(coreId, {
    type: "sessionsMutate",
    mutation: { op: "create", title: "e2e", agent: "claude-code" },
  });
  if (created.type !== "sessionsMutateResult" || !created.session?.sessionId) {
    fail(`creating a Session over the panel link answered ${JSON.stringify(created).slice(0, 300)}`);
  }
  const { sessionId } = created.session;

  const after = await link.request(coreId, { type: "sessionRowsList" });
  if (!after.sessions?.some((session) => session.sessionId === sessionId)) {
    fail(`the created Session is missing from sessionRowsList: ${JSON.stringify(after.sessions)}`);
  }
  log(`sessions list over the panel link (Session ${sessionId})`);
}

// ─── The retired Project files route (#580) ──────────────────────────────────

/** Criterion: the old Panel route for a Core's files is refused, for every method it had. */
async function assertRetiredFilesRouteIsRefused(panel, coreId, fail) {
  const base = `/api/cores/${encodeURIComponent(coreId)}/projects/workspace/files`;
  const answers = [
    ["GET", `${base}/list?path=`, await panel.client.get(`${base}/list?path=`)],
    ["GET", `${base}?path=a.txt`, await panel.client.get(`${base}?path=a.txt`)],
    [
      "PUT",
      `${base}?path=a.txt`,
      await panel.client.get(`${base}?path=a.txt`, { method: "PUT", body: "bytes" }),
    ],
  ];
  for (const [method, url, answer] of answers) {
    if (answer.status !== 404 || answer.body?.error !== "not found") {
      fail(
        `${method} ${url}: expected the router's 404 {"error":"not found"}, got ` +
          `${answer.status} ${JSON.stringify(answer.body ?? answer.text).slice(0, 300)}`,
      );
    }
  }
  log("the Panel's old per-Project Files route is refused as an unknown route");
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
    opts: { shellSession: true, sessionId: `e2e-${randomBytes(4).toString("hex")}`, cols: 80, rows: 24 },
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
      sessionId: `e2e-exit-${randomBytes(4).toString("hex")}`,
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
 * header in any Panel row means a credential was written unsealed, whichever
 * one it is. The Core's own material is checked by name on top of that.
 *
 * Reads `core_secrets.sealed` and every other Panel table row from the Postgres
 * the phase started — the sealed blob and the rest of the state live there now,
 * not in a SQLite file beside the data directory.
 */
async function assertSecretsSealedAtRest(databaseUrl, core, fail) {
  const pem = Buffer.from("-----BEGIN", "utf8");
  const secretBytes = Object.entries(core.secrets).map(([name, secret]) => [
    name,
    Buffer.from(secret, "utf8"),
  ]);

  const sealedRows = await queryPanelDatabase(databaseUrl, "select sealed from core_secrets").catch(
    (err) => fail(`could not read core_secrets from Postgres: ${err.message}`),
  );
  if (sealedRows.length === 0) fail("no core_secrets rows in Postgres after pairing");

  const otherRows = await queryPanelDatabase(
    databaseUrl,
    `select 'operator'::text as table_name, row_to_json(t)::text as payload from operator t
     union all
     select 'panel_sessions', row_to_json(t)::text from panel_sessions t
     union all
     select 'cores', row_to_json(t)::text from cores t
     union all
     select 'core_secrets', row_to_json(t)::text from core_secrets t`,
  ).catch((err) => fail(`could not read Panel rows from Postgres: ${err.message}`));

  const blobs = [
    ...sealedRows.map((row) => Buffer.from(row.sealed)),
    ...otherRows.map((row) => Buffer.from(String(row.payload), "utf8")),
  ];

  for (const raw of blobs) {
    if (raw.includes(pem)) {
      fail("a Panel Postgres row holds PEM material in the clear");
    }
    for (const [name, secret] of secretBytes) {
      if (raw.includes(secret)) {
        fail(`the Core's ${name} is stored in Postgres in the clear`);
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
