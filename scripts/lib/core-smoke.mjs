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

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
// `ws` is loaded lazily, inside dialAndRequest — see the note there.

import { waitForSentinel } from "./child-sentinel.mjs";

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
