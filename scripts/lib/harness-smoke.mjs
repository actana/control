// Shared machinery for the Harness boot smokes.
//
// Both smokes ask the same question — "does this Harness boot clean and accept
// an authenticated core-link dial?" — and differ only in what they spawn:
// `smoke-standalone-harness.mjs` runs the built bundle under the caller's
// node, `smoke-harness-tarball.mjs` runs a released tarball's own launcher and
// its bundled Node. The env the Harness needs and the whole assertion sequence
// live here so the two scripts stay honestly comparable.

import * as net from "node:net";
import { WebSocket } from "ws";

import { waitForSentinel } from "./child-sentinel.mjs";

export const LISTENING_SENTINEL = "@@AC_HARNESS_LISTENING@@";
export const REGISTRATION_BLOB_SENTINEL = "@@AC_HARNESS_REGISTRATION_BLOB@@";

/**
 * Log tags that indicate a boot regression. The presence of ANY of these
 * (even a single throttled first-occurrence line) is a failure, because a
 * clean-boot Harness with the schema migrated must never hit either path.
 */
export const BAD_LOG_TAGS = [
  "event-log.open-failed",
  "harness-query.open-failed",
  "project-roots.open-failed",
  "event-log.db-missing",
  "harness-query.db-missing",
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
 * The environment a smoked Harness runs under.
 *
 * Remote mode is forced so the Harness owns DB bootstrap — the whole point of
 * these smokes. Loopback mode expects a sibling stateful server to own the
 * schema and skips the bootstrap; neither smoke runs one. `home` and
 * `userDataDir` point at fresh temp dirs so nothing leaks into the caller's
 * real state.
 */
export function harnessSmokeEnv({ home, userDataDir, port, extra = {} }) {
  const env = {
    ...process.env,
    HOME: home,
    AC_HARNESS_REMOTE: "1",
    AC_CORE_LINK_PORT: String(port),
    AC_CORE_LINK_HOST: "127.0.0.1",
    AC_HARNESS_PUBLIC_HOST: "127.0.0.1",
    AC_USER_DATA_DIR: userDataDir,
    ...extra,
  };
  // The Harness must boot as PLAIN node: nothing inherited from the caller may
  // point it at a dev tree.
  delete env.HARNESS_ENTRY;
  return env;
}

/**
 * Watch a spawned Harness until it prints the listening sentinel.
 *
 * Every line is mirrored into `observer.logLines` for failure triage, bad log
 * tags are collected into `observer.badTags`, and the Registration blob is
 * captured so the caller can dial the mTLS core-link.
 *
 * Exported because the Panel e2e's Harness fixture
 * (`scripts/lib/harness-fixture.mjs`) boots a Harness for a different reason
 * and must recognise "ready" by the same marker the smokes do.
 */
export function waitForListening(child, timeoutMs, observer) {
  return waitForSentinel(child, {
    sentinel: LISTENING_SENTINEL,
    timeoutMs,
    observer,
    subject: "harness",
    onLine: (raw) => {
      const blobIdx = raw.indexOf(REGISTRATION_BLOB_SENTINEL);
      if (blobIdx >= 0) {
        observer.blob = raw.slice(blobIdx + REGISTRATION_BLOB_SENTINEL.length).trim();
      }
      for (const tag of BAD_LOG_TAGS) {
        if (raw.includes(tag)) observer.badTags.push(tag);
      }
    },
  });
}

/** Decode the base64 Registration blob the Harness prints in remote mode. */
export function decodeBlob(blob) {
  const json = Buffer.from(blob.trim(), "base64").toString("utf8");
  const parsed = JSON.parse(json);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.endpoint !== "string" ||
    typeof parsed.caCert !== "string" ||
    typeof parsed.clientCert !== "string" ||
    typeof parsed.clientKey !== "string" ||
    typeof parsed.bearer !== "string"
  ) {
    throw new Error("registration blob missing expected fields");
  }
  return parsed;
}

/**
 * The one line of an installer's output that decodes as a Registration blob.
 *
 * Deliberately structural rather than positional: the installer e2es assert
 * that a *usable* pairing token was printed, not that it appeared on a line
 * the output formatting could move.
 */
export function extractToken(stdout, context, die) {
  for (const line of stdout.split("\n").map((l) => l.trim())) {
    if (line.length < 100) continue;
    try {
      return { raw: line, blob: decodeBlob(line) };
    } catch {
      /* not the token line */
    }
  }
  die(`no pairing token in the output of ${context}`, stdout.split("\n"));
}

/**
 * Dial the core-link with the blob's mTLS material + bearer, send one request
 * frame, and resolve the field the matching result frame carries.
 *
 * Exported because the installer's container e2es make the same dial against a
 * Harness they never spawned — "a test client dials the core-link with the
 * pairing token" is an acceptance criterion, and it should be the same client
 * for every frame a test needs to ask about.
 */
export function dialAndRequest(blob, request, resultType, resultField, timeoutMs = DIAL_TIMEOUT_MS) {
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
export function dialAndListAgentAvailability(blob, timeoutMs = DIAL_TIMEOUT_MS) {
  return dialAndRequest(
    blob,
    { type: "agentsAvailabilityList" },
    "agentsAvailabilityListResult",
    "availability",
    timeoutMs,
  );
}

/**
 * The assertion both smokes make about an already-spawned Harness: it reaches
 * the listening marker, logs nothing from the degradation paths, hands over a
 * decodable Registration blob, and answers `projectsList` with `[]` against a
 * real migrated schema.
 *
 * `log` reports progress with the caller's own prefix; `die` ends the run with
 * the child's output attached.
 */
export async function assertBootsAndDials(child, { port, timeoutMs, die, log }) {
  const observer = { logLines: [], badTags: [], blob: null };

  try {
    await waitForListening(child, timeoutMs, observer);
  } catch (err) {
    die(err.message, observer.logLines);
  }
  log("harness emitted listening marker");

  if (observer.badTags.length > 0) {
    die(`saw ${observer.badTags.length} bad log line(s): ${observer.badTags.join(", ")}`, observer.logLines);
  }
  if (!observer.blob) {
    die("no registration blob captured — cannot dial mTLS core-link", observer.logLines);
  }

  let blob;
  try {
    blob = decodeBlob(observer.blob);
  } catch (err) {
    die(`failed to decode registration blob: ${err.message}`, observer.logLines);
  }
  // The Harness bound to 127.0.0.1 regardless of the SAN host — dial there
  // directly so hostname verification lands on the cert's `127.0.0.1` SAN.
  blob.endpoint = `wss://127.0.0.1:${port}`;

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
