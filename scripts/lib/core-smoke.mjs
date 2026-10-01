// Shared machinery for the Core boot smokes.
//
// Every smoke and e2e asks the same question — "does this Core boot clean and
// accept an authenticated core-link dial?" — and they differ only in what they
// spawn: a released tarball's own launcher and bundled Node
// (`smoke-core-tarball.mjs`), the shipped container image
// (`smoke-core-image.mjs`), or an installed machine (the `e2e-*-linux.mjs`
// scripts). The env the Core needs and the whole assertion sequence live here
// so those arrivals stay honestly comparable.
//
// There used to be one more: `smoke-standalone-core.mjs`, which ran the built
// bundle under the caller's own node. ADR 0016 D35 deleted it — it made this
// file's `assertBootsAndDials` assertion against a path nothing ships, one
// layer inside the tarball smoke that does ship.

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
// `ws` is loaded lazily, inside dialAndRequest — see the note there.

import { waitForSentinel } from "./child-sentinel.mjs";
import {
  CORE_DAEMON_CAP_MASK,
  CORE_DAEMON_USER,
  CORE_NO_CAP_MASK,
  CORE_SESSION_USER,
} from "./panel-image.mjs";

export const LISTENING_SENTINEL = "@@AC_CORE_LISTENING@@";

/**
 * Log tags that indicate a boot regression. The presence of ANY of these
 * (even a single throttled first-occurrence line) is a failure, because a
 * clean-boot Core with the schema migrated must never hit either path.
 */
export const BAD_LOG_TAGS = [
  "event-log.open-failed",
  "core-query.open-failed",
  "project-roots.open-failed",
  "event-log.db-missing",
  "core-query.db-missing",
  "project-roots.db-missing",
];

const LOG_TAIL_LINES = 200;

/** The live-event poll runs every 500 ms — long enough for a late failure to log. */
const LIVE_POLL_SETTLE_MS = 1_500;

const DIAL_TIMEOUT_MS = 15_000;

/** Build a `die(message, tailLines)` that prints the child's output and exits 1. */
export function makeDie(prefix) {
  return (msg, tailLines) => {
    console.error(`[${prefix}] FAIL: ${msg}`);
    if (tailLines && tailLines.length > 0) {
      console.error(`[${prefix}] --- last child output ---`);
      for (const line of tailLines.slice(-LOG_TAIL_LINES)) console.error(line);
      console.error(`[${prefix}] --- end child output ---`);
    }
    process.exit(1);
  };
}

/** A free loopback port, released immediately before the caller binds it. */
export async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("could not read address from probe server"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * The environment a smoked Core runs under.
 *
 * Remote mode is forced so the Core owns DB bootstrap — the whole point of
 * these smokes. Loopback mode expects a sibling stateful server to own the
 * schema and skips the bootstrap; neither smoke runs one. `home` and
 * `userDataDir` point at fresh temp dirs so nothing leaks into the caller's
 * real state.
 */
export function coreSmokeEnv({ home, userDataDir, port, extra = {} }) {
  const env = {
    ...process.env,
    HOME: home,
    AC_CORE_REMOTE: "1",
    AC_CORE_LINK_PORT: String(port),
    AC_CORE_LINK_HOST: "127.0.0.1",
    AC_CORE_PUBLIC_HOST: "127.0.0.1",
    AC_USER_DATA_DIR: userDataDir,
    // Required in remote mode since #287: the material file is where a Core's
    // identity and its pairing sessions live, and a Core without one can issue
    // no credential to anybody. It also gives this smoke the one thing it needs
    // — see `materialFileFor` and `credentialFromMaterial`.
    AC_CORE_MATERIAL_FILE: materialFileFor(home),
    ...extra,
  };
  // The Core must boot as PLAIN node: nothing inherited from the caller may
  // point it at a dev tree.
  delete env.CORE_ENTRY;
  return env;
}

/**
 * Watch a spawned Core until it prints the listening sentinel.
 *
 * Every line is mirrored into `observer.logLines` for failure triage and bad log
 * tags are collected into `observer.badTags`. It used to also capture a printed
 * Registration blob; #287 removed that emission, and the credential now comes
 * off disk — see `credentialAfterBoot`.
 *
 * Exported because the Panel e2e's Core fixture
 * (`scripts/lib/core-fixture.mjs`) boots a Core for a different reason
 * and must recognise "ready" by the same marker the smokes do.
 */
export function waitForListening(child, timeoutMs, observer) {
  return waitForSentinel(child, {
    sentinel: LISTENING_SENTINEL,
    timeoutMs,
    observer,
    subject: "core",
    onLine: (raw) => {
      for (const tag of BAD_LOG_TAGS) {
        if (raw.includes(tag)) observer.badTags.push(tag);
      }
    },
  });
}

/** Where a smoked Core keeps its identity, under the throwaway home. */
export function materialFileFor(home) {
  return path.join(home, ".config", "actana", "material.json");
}

/**
 * A client credential, built from the identity the Core just persisted.
 *
 * **Why not pair for it.** #287 removed the printed blob these smokes used to
 * capture, and what replaced it is a short code redeemed over the Core's
 * pre-auth endpoint — a keypair, a CSR and a fingerprint-verified dial, which
 * is `@actana/sdk`'s job and is covered by its own suite and by the Panel e2e.
 * The question *this* file asks is narrower and older: does a Core boot clean
 * and accept an authenticated core-link dial? So it takes the client half of
 * the identity the daemon wrote — which is exactly what `actana setup` puts in
 * the machine's own registry — and signs itself a bearer.
 *
 * The bearer signer is a deliberate copy of `@actana/shared/core-link-bearer`,
 * for the same reason `core-fixture.mjs` copies its encoder: these scripts drive
 * a Core from outside, and importing the signer would let one bug in it cancel
 * itself out against the verifier on the other end.
 */
export function credentialFromMaterial(materialFile, endpoint, { bearerDays = 365 } = {}) {
  const material = JSON.parse(fs.readFileSync(materialFile, "utf8"));
  for (const field of ["caCert", "clientCert", "clientKey", "bearerSecret", "coreId"]) {
    if (typeof material[field] !== "string" || material[field] === "") {
      throw new Error(`${materialFile} has no usable ${field}`);
    }
  }
  const payload = Buffer.from(
    JSON.stringify({ coreId: material.coreId, exp: Date.now() + bearerDays * 86_400_000 }),
    "utf8",
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", material.bearerSecret)
    .update(payload)
    .digest()
    .toString("base64url");
  return {
    endpoint,
    label: "",
    caCert: material.caCert,
    clientCert: material.clientCert,
    clientKey: material.clientKey,
    bearer: `${payload}.${sig}`,
  };
}

/**
 * Wait for the material file to appear, then build a credential from it.
 *
 * A first boot mints and persists before it listens, so by the time the
 * listening sentinel lands the file is there — but the write and the sentinel
 * are two syscalls apart, and a poll is cheaper than a race.
 */
export async function credentialAfterBoot(home, endpoint, timeoutMs = 10_000) {
  const file = materialFileFor(home);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(file)) {
      try {
        return credentialFromMaterial(file, endpoint);
      } catch (err) {
        if (Date.now() >= deadline) throw err;
      }
    } else if (Date.now() >= deadline) {
      throw new Error(`the Core never wrote ${file}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Dial the core-link with the credential's mTLS material + bearer, send one
 * request frame, and resolve the field the matching result frame carries.
 *
 * Exported because the installer's container e2es make the same dial against a
 * Core they never spawned — "a test client dials the core-link with the
 * credential this machine holds" is an acceptance criterion, and it should be
 * the same client for every frame a test needs to ask about.
 *
 * `ws` is required here rather than imported at module scope so that importing
 * this module costs nothing but node builtins. smoke-panel-image.mjs pulls in
 * only `makeDie` and `pickFreePort`, and the train and release workflows run it
 * against a checkout with no `node_modules` — a top-level `import { WebSocket }
 * from "ws"` made that fail before the image was ever pushed.
 */
export async function dialAndRequest(blob, request, resultType, resultField, timeoutMs = DIAL_TIMEOUT_MS) {
  const { WebSocket } = await import("ws");
  const ws = new WebSocket(blob.endpoint, {
    ca: blob.caCert,
    cert: blob.clientCert,
    key: blob.clientKey,
    rejectUnauthorized: true,
  });

  const state = {
    authReqId: `auth-${Date.now()}`,
    reqId: `req-${Date.now()}`,
    result: null,
  };

  return new Promise((resolve, reject) => {
    const done = (err) => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(state.result);
    };
    const deadline = setTimeout(
      () => done(new Error(`core-link dial timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    ws.on("error", (err) => {
      clearTimeout(deadline);
      done(new Error(`ws error: ${err.message}`));
    });
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", reqId: state.authReqId, bearer: blob.bearer }));
    });
    ws.on("message", (raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch (err) {
        clearTimeout(deadline);
        done(new Error(`bad frame from server: ${err.message}`));
        return;
      }
      if (frame.type === "ready") return; // ignore
      if (frame.type === "authOk" && frame.reqId === state.authReqId) {
        ws.send(JSON.stringify({ ...request, reqId: state.reqId }));
        return;
      }
      if (frame.type === "authError") {
        clearTimeout(deadline);
        done(new Error(`authError: ${frame.reason}`));
        return;
      }
      if (frame.type === resultType && frame.reqId === state.reqId) {
        state.result = frame[resultField];
        clearTimeout(deadline);
        done();
        return;
      }
      if (frame.type === "error" && (frame.reqId === state.authReqId || frame.reqId === state.reqId)) {
        clearTimeout(deadline);
        done(new Error(`server error: ${frame.message}`));
        return;
      }
    });
  });
}

/**
 * `projectsList` over a fresh dial, resolving the returned array.
 *
 * Reaching a real result proves the schema migrated: the `db-missing`
 * degradation path never gets this far.
 */
export function dialAndListProjects(blob, timeoutMs = DIAL_TIMEOUT_MS) {
  return dialAndRequest(
    blob,
    { type: "projectsList" },
    "projectsListResult",
    "projects",
    timeoutMs,
  );
}

/** `agentsAvailabilityList` over a fresh dial — what a Panel sees about CLIs. */
export function dialAndListHarnessAvailability(blob, timeoutMs = DIAL_TIMEOUT_MS) {
  return dialAndRequest(
    blob,
    { type: "agentsAvailabilityList" },
    "agentsAvailabilityListResult",
    "availability",
    timeoutMs,
  );
}

/**
 * The assertion both smokes make about an already-spawned Core: it reaches the
 * listening marker, logs nothing from the degradation paths, prints no
 * credential, and answers `projectsList` with `[]` against a real migrated
 * schema over an authenticated mTLS dial.
 *
 * `home` is the throwaway home the Core was given, which is where it persisted
 * the identity this dial borrows its client half from.
 *
 * `log` reports progress with the caller's own prefix; `die` ends the run with
 * the child's output attached.
 */
/**
 * Run a Core once with a hostile environment and prove it refuses to serve (#348).
 *
 * The behavioural half of `core-boot-refusals.ts`. Its unit tests state the
 * property over the whole `(remoteMode, host)` space, but the *ordering* — that
 * the refusal happens before anything binds — is asserted there by reading
 * `core-entry.ts` as text, which an awaited call inserted between the guard and
 * the server would sail straight through. This spawns the real daemon and
 * checks the only thing that actually matters: it exited, and nothing was
 * listening.
 *
 * Two environments, because they are two different refusals: the variables a
 * pre-rename LaunchAgent sets, and the plaintext-on-a-public-interface shape
 * that ignoring them used to produce.
 */
export async function assertRefusesUnsafeEnv({ launcher, argv, env, port, timeoutMs, die, log }) {
  const cases = [
    {
      name: "a pre-rename environment",
      // The variable the old plist sets. Everything else is a working config,
      // so a daemon that booted here would be one that ignored it.
      env: { ...env, AC_HARNESS_REMOTE: "1" },
      expect: /AC_HARNESS_REMOTE/,
    },
    {
      name: "plaintext on a public interface",
      // Remote mode dropped and a wildcard bind left behind — exactly what the
      // old plist produced once its `AC_HARNESS_REMOTE` stopped being read.
      env: { ...env, AC_CORE_REMOTE: "", AC_CORE_LINK_HOST: "0.0.0.0" },
      expect: /AC_CORE_LINK_HOST is 0\.0\.0\.0/,
    },
  ];

  for (const testCase of cases) {
    const child = spawn(launcher, argv, {
      env: testCase.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(String(chunk)));
    child.stderr.on("data", (chunk) => output.push(String(chunk)));

    const exit = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        resolve({ code: null, timedOut: true });
      }, timeoutMs);
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code: code ?? (signal ? 1 : 0), timedOut: false });
      });
    });

    const printed = output.join("");
    if (exit.timedOut) {
      die(`the Core kept running under ${testCase.name} — it must refuse and exit`, [printed]);
    }
    if (exit.code === 0) {
      die(`the Core exited 0 under ${testCase.name} — a refusal is not a clean boot`, [printed]);
    }
    if (printed.includes(LISTENING_SENTINEL)) {
      die(`the Core announced it was listening under ${testCase.name}`, [printed]);
    }
    if (!testCase.expect.test(printed)) {
      die(`the refusal under ${testCase.name} did not say why`, [printed]);
    }
    if (await somethingListensOn(port)) {
      die(`something is listening on ${port} after the Core refused ${testCase.name}`, [printed]);
    }
    log(`refused ${testCase.name}: exit ${exit.code}, nothing bound on ${port}`);
  }
}

/** Whether anything accepts a TCP connection on a loopback port right now. */
function somethingListensOn(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1_000);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

export async function assertBootsAndDials(child, { home, port, timeoutMs, die, log }) {
  const observer = { logLines: [], badTags: [] };

  try {
    await waitForListening(child, timeoutMs, observer);
  } catch (err) {
    die(err.message, observer.logLines);
  }
  log("core emitted listening marker");

  if (observer.badTags.length > 0) {
    die(`saw ${observer.badTags.length} bad log line(s): ${observer.badTags.join(", ")}`, observer.logLines);
  }

  // #287: a Core emits no credential, on any boot. A PEM header on stdout means
  // the hand-carry came back, and it is a failure here rather than a review
  // comment somebody might miss.
  const printed = observer.logLines.join("\n");
  if (/BEGIN (CERTIFICATE|PRIVATE KEY|RSA PRIVATE KEY)/.test(printed)) {
    die("the Core printed certificate material on stdout", observer.logLines);
  }
  if (printed.includes("@@AC_CORE_REGISTRATION_BLOB@@")) {
    die("the Core printed a registration blob — the hand-carry is meant to be gone", observer.logLines);
  }

  // The Core bound to 127.0.0.1 regardless of the SAN host — dial there
  // directly so hostname verification lands on the cert's `127.0.0.1` SAN.
  let blob;
  try {
    blob = await credentialAfterBoot(home, `wss://127.0.0.1:${port}`);
  } catch (err) {
    die(`could not build a client credential from the Core's material: ${err.message}`, observer.logLines);
  }

  let projects;
  try {
    projects = await dialAndListProjects(blob, DIAL_TIMEOUT_MS);
  } catch (err) {
    die(`core-link dial failed: ${err.message}`, observer.logLines);
  }
  if (!Array.isArray(projects) || projects.length !== 0) {
    die(`projectsList did not return []: got ${JSON.stringify(projects)}`, observer.logLines);
  }
  log("projectsList returned [] against a real schema");

  // Give a schema regression (absent → open-failed on the first poll) a chance
  // to log before declaring the boot clean.
  await new Promise((resolve) => setTimeout(resolve, LIVE_POLL_SETTLE_MS));
  if (observer.badTags.length > 0) {
    die(`bad log line(s) after live-event poll settled: ${observer.badTags.join(", ")}`, observer.logLines);
  }
}

// ─── The privilege model, read off /proc (#559) ──────────────────────────────
//
// What the kernel prints in `/proc/<pid>/status` is the only witness to the
// privilege model that does not depend on the code that set it up, so the image
// smoke compares those lines *exactly*. Not "no capability looks wrong": a
// daemon with a third capability, a Session that kept one, or a bounding set that
// grew all have to fail, and a regex that matches "some hex" would pass them.
//
// Each expected line is the whole line, trailing whitespace trimmed (the kernel
// pads an empty `Groups:` with a tab). `Groups` is empty on purpose: the entrypoint
// and `asCore` both run `setpriv --clear-groups`, so neither the daemon nor a Session
// holds a supplementary group, and in particular not root's.

/** `Name -> whole line` for every `Name:` line of a `/proc/<pid>/status`, first one wins. */
export function statusLines(text) {
  const lines = new Map();
  for (const line of String(text).split("\n")) {
    const match = line.match(/^([A-Za-z_]+):/);
    if (match && !lines.has(match[1])) lines.set(match[1], line.replace(/\s+$/, ""));
  }
  return lines;
}

const ids = (field, id) => `${field}:\t${id}\t${id}\t${id}\t${id}`;

/**
 * The lines a process must carry. `daemon`: the `actana` user with exactly
 * CAP_SETUID and CAP_SETGID as inheritable, permitted, effective, ambient and
 * bounding, and no-new-privs. `session`: the `core` user with no capability in any
 * set but the bounding set, which is the container's and is inert under
 * no-new-privs with no file capabilities (decision D1 of the plan).
 */
export function expectedStatusLines(kind) {
  if (kind === "daemon") {
    return [
      ids("Uid", CORE_DAEMON_USER.uid),
      ids("Gid", CORE_DAEMON_USER.gid),
      "Groups:",
      `CapInh:\t${CORE_DAEMON_CAP_MASK}`,
      `CapPrm:\t${CORE_DAEMON_CAP_MASK}`,
      `CapEff:\t${CORE_DAEMON_CAP_MASK}`,
      `CapBnd:\t${CORE_DAEMON_CAP_MASK}`,
      `CapAmb:\t${CORE_DAEMON_CAP_MASK}`,
      "NoNewPrivs:\t1",
    ];
  }
  if (kind === "session") {
    return [
      ids("Uid", CORE_SESSION_USER.uid),
      ids("Gid", CORE_SESSION_USER.gid),
      "Groups:",
      `CapInh:\t${CORE_NO_CAP_MASK}`,
      `CapPrm:\t${CORE_NO_CAP_MASK}`,
      `CapEff:\t${CORE_NO_CAP_MASK}`,
      `CapBnd:\t${CORE_DAEMON_CAP_MASK}`,
      `CapAmb:\t${CORE_NO_CAP_MASK}`,
      "NoNewPrivs:\t1",
    ];
  }
  throw new Error(`unknown process kind ${JSON.stringify(kind)}`);
}

/** What is wrong with a status text, one sentence per line; empty when it is exactly right. */
export function checkProcessStatus(text, kind) {
  const found = statusLines(text);
  const problems = [];
  for (const expected of expectedStatusLines(kind)) {
    const name = expected.slice(0, expected.indexOf(":"));
    const actual = found.get(name);
    if (actual === undefined) problems.push(`no ${name} line`);
    else if (actual !== expected.replace(/\s+$/, "")) {
      problems.push(`${name}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
    }
  }
  return problems;
}

/**
 * Pids other than 1 that run as uid 0, from `{pid, status}` pairs. PID 1 is
 * tini and is root by design (decision D4); after the entrypoint's `exec` nothing
 * else may be: not a leftover entrypoint shell, not a helper.
 */
export function rootProcessesBesideInit(processes) {
  return processes
    .filter(({ pid, status }) => pid !== 1 && statusLines(status).get("Uid")?.split(/\s+/)[1] === "0")
    .map(({ pid }) => pid);
}

/**
 * Run in a throwaway container as root (`python3` is in the image): every file
 * in the image's own filesystem that carries a `security.capability` xattr, one
 * path per line. `getcap` is not in the image and a smoke may not install what
 * it asserts about. It first plants a file with a capability and refuses to
 * report an empty list unless it saw that one, so a scan that cannot see
 * anything (an unsupported filesystem) fails instead of passing.
 */
export const FILE_CAPABILITY_SCAN = [
  "import os, struct, sys",
  "probe = '/tmp/fscap-probe'",
  "open(probe, 'w').close()",
  "try:",
  "    os.setxattr(probe, 'security.capability', struct.pack('<IIIII', 0x02000000, 0, 0, 0, 0))",
  "except OSError as err:",
  "    print('PROBE-FAILED ' + str(err)); sys.exit(3)",
  "root_dev = os.stat('/').st_dev",
  "found = []",
  "for dirpath, dirnames, filenames in os.walk('/', followlinks=False):",
  "    dirnames[:] = [d for d in dirnames if not os.path.ismount(os.path.join(dirpath, d)) and os.lstat(os.path.join(dirpath, d)).st_dev == root_dev]",
  "    for name in filenames:",
  "        path = os.path.join(dirpath, name)",
  "        try:",
  "            if 'security.capability' in os.listxattr(path, follow_symlinks=False): found.append(path)",
  "        except OSError:",
  "            pass",
  "if probe not in found:",
  "    print('PROBE-NOT-SEEN'); sys.exit(4)",
  "for path in found:",
  "    if path != probe: print(path)",
].join("\n");

// ─── A Session, driven over the core-link ────────────────────────────────────

/**
 * Open a Session on a Core the way a client does — dial the core-link with the
 * credential, `spawn` a shell Session — and drive it as a terminal.
 *
 * A real Session and not `docker exec`: it is what the daemon starts through
 * `asCore` on a PTY, which is the process the privilege model is about. Frames
 * are the wire's own (`auth`, `spawn`, `write`, `kill`, and the pushed `data` and
 * `exit`), written out here for the reason `credentialFromMaterial` is: a bug in
 * the client library must not cancel itself out against the server.
 *
 * Returns `{ ptyId, output(), run(script), exited, kill(), close() }`. `run`
 * sends one script to the shell and resolves `{ output, status }`: it turns the
 * terminal's echo off first and brackets the script in markers that are never
 * spelt out in what is typed, so the echo of the command cannot be mistaken for
 * its output.
 */
export async function openCoreSession(credential, { command, timeoutMs = 30_000 } = {}) {
  const { WebSocket } = await import("ws");
  const ws = new WebSocket(credential.endpoint, {
    ca: credential.caCert,
    cert: credential.clientCert,
    key: credential.clientKey,
    rejectUnauthorized: true,
  });
  let buffer = "";
  let ptyId = null;
  let exit = null;
  const waiters = new Map();
  const listeners = new Set();
  const taskId = `smoke-session-${crypto.randomBytes(6).toString("hex")}`;

  const answer = (reqId) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(reqId);
        reject(new Error(`no answer to ${reqId} within ${timeoutMs}ms`));
      }, timeoutMs);
      waiters.set(reqId, (frame) => {
        clearTimeout(timer);
        waiters.delete(reqId);
        resolve(frame);
      });
    });
  ws.on("message", (raw) => {
    let frame;
    try {
      frame = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (frame.type === "data" && frame.ptyId === ptyId) {
      buffer += frame.data;
      for (const listener of listeners) listener();
    } else if (frame.type === "exit" && frame.ptyId === ptyId) {
      exit = { exitCode: frame.exitCode, signal: frame.signal };
      for (const listener of listeners) listener();
    } else if (frame.reqId && waiters.has(frame.reqId)) {
      waiters.get(frame.reqId)(frame);
    }
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", (err) => reject(new Error(`core-link dial failed: ${err.message}`)));
  });
  const rpc = async (frame) => {
    const reqId = `${frame.type}-${crypto.randomBytes(4).toString("hex")}`;
    const pending = answer(reqId);
    ws.send(JSON.stringify({ ...frame, reqId }));
    return pending;
  };

  const auth = await rpc({ type: "auth", bearer: credential.bearer });
  if (auth.type !== "authOk") throw new Error(`core-link auth answered ${JSON.stringify(auth)}`);
  // The pty id is only known from the answer, and the first bytes are pushed
  // before it: the server subscribes this connection before it answers.
  const spawned = await rpc({
    type: "spawn",
    opts: { shellSession: true, taskId, cols: 200, rows: 50, ...(command ? { command } : {}) },
  });
  if (spawned.type !== "spawned") {
    ws.close();
    throw new Error(`spawn answered ${JSON.stringify(spawned)}`);
  }
  ptyId = spawned.ptyId;

  const waitUntil = (predicate, label, limitMs = timeoutMs) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const value = predicate();
        if (value) {
          cleanup();
          resolve(value);
        } else if (exit && label !== "exit") {
          cleanup();
          reject(new Error(`the Session exited (${JSON.stringify(exit)}) while waiting for ${label}:\n${plain()}`));
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out after ${limitMs}ms waiting for ${label}; output so far:\n${plain()}`));
      }, limitMs);
      const cleanup = () => {
        clearTimeout(timer);
        listeners.delete(check);
      };
      listeners.add(check);
      check();
    });
  // The terminal's own noise (bracketed-paste switches, cursor moves) goes: it
  // lands at the start of the line a marker is on.
  const plain = () => buffer.replace(/\r/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

  const session = {
    ptyId,
    taskId,
    output: plain,
    /** Resolves with the exit frame when the Session's process exits. */
    exited: () => waitUntil(() => exit, "exit", timeoutMs),
    waitFor: (regex, label, limitMs) =>
      waitUntil(() => plain().match(regex), label ?? String(regex), limitMs),
    write: async (data) => {
      const sent = await rpc({ type: "write", ptyId, data });
      if (sent.ok !== true) throw new Error(`write was refused: ${JSON.stringify(sent)}`);
    },
    kill: async () => rpc({ type: "kill", ptyId }),
    close: () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
    /** One raw request frame; resolves the answering frame (an `error` frame is an answer). */
    request: (frame) => rpc(frame),
    _id: 0,
    /** Echo off, once, with a marker that proves it took effect. */
    prepare: async () => {
      await session.write("stty -echo; printf 'ACSMOKE_%s\\n' READY\n");
      await session.waitFor(/^ACSMOKE_READY$/m, "the shell to be ready");
    },
    run: async (script, limitMs) => {
      const n = ++session._id;
      // The markers are assembled by printf, so the text that is typed never contains them.
      const begin = `ACSMOKE_${n}_BEGIN`;
      const endPattern = new RegExp(`^ACSMOKE_${n}_END_(\\d+)$`, "m");
      await session.write(
        `printf 'ACSMOKE_%s_%s\\n' ${n} BEGIN; { ${script}\n} 2>&1; printf 'ACSMOKE_%s_END_%s\\n' ${n} $?\n`,
      );
      const end = await session.waitFor(endPattern, `the end of script ${n}`, limitMs);
      const text = plain();
      const from = text.indexOf(`${begin}\n`);
      if (from < 0) throw new Error(`script ${n} printed no begin marker:\n${text}`);
      return {
        output: text.slice(from + begin.length + 1, end.index).replace(/\n$/, ""),
        status: Number(end[1]),
      };
    },
  };
  return session;
}
