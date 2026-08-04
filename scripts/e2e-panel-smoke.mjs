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
//   • a real registration blob pasted into "Add Core" registers a Core, and its
//     dial reaches `connected` over the panel link;
//   • projects and tasks list, and a project created over the panel link shows
//     up in the next list — the write path is mutation frames, not HTTP;
//   • a PTY spawned over the panel link streams `coreId`-tagged output frames
//     carrying what was typed into it;
//   • the panel link is killed mid-flight, events happen on the Core while
//     no browser is attached, and a reconnected link replaying from its cursor
//     sees every one of them — no event loss;
//   • the Core's secrets are unreadable at rest: the bearer appears nowhere in
//     panel.db, and a data directory restored without its `secrets.key` cannot
//     dial the Core it still lists;
//   • and the `AC_SECRETS_KEY` path works: a Panel given the key by environment
//     pairs and dials without ever writing a key file.
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

  await keyFilePhase({ panelBin, panelEntry, core });
  await envKeyPhase({ panelBin, panelEntry, core });

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
    { method: "POST", pathname: "/api/cores", body: { registrationBlob: "x" } },
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

/** Pasting the Core's registration blob registers a Core. */
async function assertCoreRegisters(panel, core, fail) {
  const rejected = await panel.client.post("/api/cores", { registrationBlob: "not-a-blob" });
  if (rejected.status !== 400) fail(`a junk registration blob: expected 400, got ${rejected.status}`);

  const added = await panel.client.post("/api/cores", {
    registrationBlob: core.registrationBlob,
  });
  if (added.status !== 201) {
    fail(`add Core: expected 201, got ${added.status} (${added.text.slice(0, 200)})`);
  }
  const coreId = added.body?.core?.id;
  if (typeof coreId !== "string" || !coreId) fail(`add Core returned no id: ${added.text.slice(0, 200)}`);

  const listed = await panel.client.get("/api/cores");
  if (!listed.body?.cores?.some((core) => core.id === coreId)) {
    fail(`the registered Core is not in GET /api/cores: ${listed.text.slice(0, 300)}`);
  }
  // The secrets went in with the paste and must not come back out of any API.
  if (listed.text.includes(core.blob.bearer) || listed.text.includes(core.blob.clientKey)) {
    fail("GET /api/cores leaked the Core's credentials");
  }
  log(`registered Core ${coreId} from the Core's registration blob`);
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
 * The bearer and client key are nowhere in the database as plaintext.
 *
 * Every `panel.db*` file, not just `panel.db`: the Panel runs in WAL mode, so a
 * row written moments ago normally lives in `panel.db-wal` and a scan of the
 * main file alone would clear a Panel that had just written the bearer in the
 * clear.
 */
async function assertSecretsSealedAtRest(dataDir, core, fail) {
  if (!fs.existsSync(path.join(dataDir, "panel.db"))) fail(`no panel.db in ${dataDir}`);
  const dbFiles = fs.readdirSync(dataDir).filter((name) => name.startsWith("panel.db"));
  for (const file of dbFiles) {
    const raw = fs.readFileSync(path.join(dataDir, file));
    for (const [name, secret] of [
      ["bearer", core.blob.bearer],
      ["client key", core.blob.clientKey],
    ]) {
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
