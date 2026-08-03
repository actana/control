// Shared machinery for the black-box Panel e2e.
//
// The e2e drives a *built* Panel service the way a browser does — HTTP with a
// session cookie, then one panel-link WebSocket carrying `coreId`-tagged
// frames — so everything here is a browser's half of those two protocols and
// nothing is an import of the Panel's own code. That is the point of the seam:
// a test that reached inside `packages/panel/src` would stop being evidence
// that the deployed artifact works.
//
// `scripts/lib/harness-smoke.mjs` stays the home for the Harness side (env,
// boot sentinel, registration blob, the mTLS core-link dial); this module
// spawns and drives the Panel, and the e2e composes the two.

import { spawn } from "node:child_process";
import { WebSocket } from "ws";

import { waitForSentinel } from "./child-sentinel.mjs";

// Re-exported so a caller driving the Panel has one import for the whole
// browser side; the implementation stays with the Harness smoke that grew it.
export { pickFreePort } from "./harness-smoke.mjs";

/** What `bin/panel.mjs` prints once the HTTP server is accepting. */
export const PANEL_LISTENING_SENTINEL = "@@AC_LISTENING@@";

/** Where the Panel accepts panel-link upgrades (packages/panel/src/shared/panel-link.ts). */
export const PANEL_LINK_PATH = "/panel-link";

/** The panel-link protocol version this test speaks — a browser sends it as `?v=`. */
export const PANEL_LINK_PROTOCOL_VERSION = 1;

/** The Operator's session cookie (packages/panel/src/server/panel-auth.ts). */
export const PANEL_SESSION_COOKIE = "ac_panel_session";

const DEFAULT_FRAME_TIMEOUT_MS = 15_000;

/**
 * A browser's cookie store, as far as this test needs one: names to values,
 * last write wins, cleared cookies forgotten.
 *
 * Written out rather than folded into the HTTP client because logout and
 * password-change are assertions *about* the cookie — a jar that silently kept
 * a cleared session would make the negative-auth legs pass for the wrong
 * reason.
 */
export class CookieJar {
  #cookies = new Map();

  /** Absorb a response's `set-cookie` values. */
  capture(setCookieValues) {
    for (const raw of setCookieValues ?? []) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;
      // An empty value is how a server says "forget this" (with Max-Age=0).
      if (!value) this.#cookies.delete(name);
      else this.#cookies.set(name, decodeURIComponent(value));
    }
  }

  get(name) {
    return this.#cookies.get(name) ?? null;
  }

  /** The `cookie` request header, or "" when there is nothing to send. */
  header() {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

/**
 * The environment a black-box Panel runs under.
 *
 * Every ambient variable that could point the service at the developer's real
 * state — or hand it a secrets key it was supposed to generate — is stripped,
 * so what the test asserts about a fresh data directory is actually about a
 * fresh data directory.
 */
export function panelServiceEnv(
  { dataDir, port, serverEntry, host = "127.0.0.1", secretsKey, extra = {} },
  baseEnv = process.env,
) {
  const env = {
    ...baseEnv,
    AC_PANEL_DATA_DIR: dataDir,
    AC_PANEL_PORT: String(port),
    AC_PANEL_HOST: host,
    AC_PANEL_SERVER_ENTRY: serverEntry,
    ...extra,
  };
  // The data-dir fallbacks bin/panel.mjs and panel-data-dir.ts honour.
  delete env.AC_USER_DATA_DIR;
  delete env.PORT;
  delete env.HOST;
  if (secretsKey) env.AC_SECRETS_KEY = secretsKey;
  else delete env.AC_SECRETS_KEY;
  return env;
}

/**
 * Watch a spawned Panel until it prints the readiness sentinel, mirroring
 * every line into `observer.logLines` so a failure comes with the service's
 * own output instead of a rerun.
 */
export function waitForPanelListening(child, timeoutMs, observer) {
  return waitForSentinel(child, {
    sentinel: PANEL_LISTENING_SENTINEL,
    timeoutMs,
    observer,
    subject: "panel",
  });
}

/**
 * The browser's HTTP half: JSON in, JSON out, cookies remembered.
 *
 * `post`/`get` never throw on a non-2xx — every status this test cares about
 * (401 before login, 409 on a second setup, 400 on a bad blob) is an assertion,
 * not an accident.
 */
export class PanelHttpClient {
  constructor(origin, jar = new CookieJar()) {
    this.origin = origin.replace(/\/$/, "");
    this.jar = jar;
  }

  get(pathname, init) {
    return this.#send(pathname, { method: "GET", ...init });
  }

  post(pathname, body, init) {
    return this.#send(pathname, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      ...init,
    });
  }

  async #send(pathname, init) {
    const headers = new Headers(init.headers ?? {});
    const cookie = this.jar.header();
    // `sendCookie: false` is how the negative-auth legs ask for an anonymous
    // request from an already-logged-in client.
    if (cookie && init.sendCookie !== false) headers.set("cookie", cookie);
    const response = await fetch(`${this.origin}${pathname}`, { ...init, headers });
    this.jar.capture(response.headers.getSetCookie?.() ?? []);
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body, text, headers: response.headers };
  }
}

let reqCounter = 0;

/** A reqId in the browser's own namespace — correlation is the caller's job. */
export function nextReqId(prefix = "e2e") {
  reqCounter += 1;
  return `${prefix}-${reqCounter}`;
}

/**
 * One panel link, as a browser holds it: a single WebSocket carrying every
 * Core's traffic under a `coreId` envelope.
 *
 * `request` is the fan-out half — address a core-link request frame to a Core
 * and await the answer bearing the same reqId. `waitFor` is the fan-in half,
 * for the frames nobody asked for: PTY output, events, dial status.
 */
export class PanelLink {
  #ws;
  #frames = [];
  #waiters = new Set();
  #closed = false;

  constructor(ws) {
    this.#ws = ws;
    ws.on("message", (raw) => this.#receive(raw));
    ws.on("close", () => {
      this.#closed = true;
    });
  }

  /**
   * Open a panel link with this jar's session cookie, resolving once the socket
   * is up. A refused upgrade rejects with the status the service wrote, which
   * is what the negative-auth leg asserts on.
   */
  static open(origin, jar, { version = PANEL_LINK_PROTOCOL_VERSION, timeoutMs = 10_000 } = {}) {
    const url = `${origin.replace(/^http/, "ws")}${PANEL_LINK_PATH}?v=${version}`;
    const cookie = jar instanceof CookieJar ? jar.header() : String(jar ?? "");
    const ws = new WebSocket(url, cookie ? { headers: { cookie } } : {});
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        ws.terminate();
        reject(new Error(`panel-link upgrade timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      ws.once("unexpected-response", (_req, res) => {
        clearTimeout(deadline);
        const err = new Error(`panel-link upgrade refused: ${res.statusCode}`);
        err.statusCode = res.statusCode;
        reject(err);
      });
      ws.once("error", (err) => {
        clearTimeout(deadline);
        reject(err);
      });
      ws.once("open", () => {
        clearTimeout(deadline);
        resolve(new PanelLink(ws));
      });
    });
  }

  /** Every frame seen so far, oldest first. */
  get frames() {
    return [...this.#frames];
  }

  send(frame) {
    this.#ws.send(JSON.stringify(frame));
  }

  /**
   * Send a core-link request frame to one Core and await its answer.
   *
   * The reqId is generated here and matched on the way back, which is exactly
   * the browser's contract: the Panel routes by reqId and never rewrites it.
   */
  async request(coreId, frame, { timeoutMs = DEFAULT_FRAME_TIMEOUT_MS } = {}) {
    const reqId = nextReqId(frame.type);
    const answer = this.waitFor(
      (f) => f.t === "core" && f.coreId === coreId && f.frame.reqId === reqId,
      { timeoutMs, label: `${frame.type} answer` },
    );
    this.send({ t: "core", coreId, frame: { ...frame, reqId } });
    return (await answer).frame;
  }

  /**
   * Resolve with the first frame — already seen or yet to arrive — that
   * `predicate` accepts. Checking the backlog first is what keeps the caller
   * free of races: a frame that landed while it was awaiting something else is
   * not lost.
   *
   * `fromIndex` bounds that backlog scan, and matters more than it looks:
   * without it a second `subscribe` settles on the FIRST one's `eventsReplayed`
   * and reports an empty replay no matter what the service sent.
   */
  waitFor(predicate, { timeoutMs = DEFAULT_FRAME_TIMEOUT_MS, label = "frame", fromIndex = 0 } = {}) {
    const seen = this.#frames.slice(fromIndex).find((f) => predicate(f));
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (frame) => {
          clearTimeout(deadline);
          this.#waiters.delete(waiter);
          resolve(frame);
        },
      };
      const deadline = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`));
      }, timeoutMs);
      this.#waiters.add(waiter);
    });
  }

  /**
   * Subscribe to a Core from a cursor and collect what the service replays,
   * up to and including the `eventsReplayed` marker that closes the window.
   */
  async subscribe(coreId, lastEventId, opts = {}) {
    const before = this.#frames.length;
    this.send({
      t: "core",
      coreId,
      frame: { type: "subscribe", reqId: nextReqId("subscribe"), lastEventId },
    });
    const marker = await this.waitFor(
      (f) => f.t === "core" && f.coreId === coreId && f.frame.type === "eventsReplayed",
      { label: "eventsReplayed", ...opts, fromIndex: before },
    );
    const events = this.#frames
      .slice(before)
      .filter((f) => f.t === "core" && f.coreId === coreId && f.frame.type === "event")
      .map((f) => f.frame.event);
    return { events, lastEventId: marker.frame.lastEventId };
  }

  /** Every event this link has been sent for one Core, in arrival order. */
  eventsFor(coreId) {
    return this.#frames
      .filter((f) => f.t === "core" && f.coreId === coreId && f.frame.type === "event")
      .map((f) => f.frame.event);
  }

  /** Every `data` frame seen for one PTY, in arrival order. */
  ptyOutput(coreId, ptyId) {
    return this.#frames
      .filter(
        (f) =>
          f.t === "core" && f.coreId === coreId && f.frame.type === "data" && f.frame.ptyId === ptyId,
      )
      .map((f) => f.frame.data);
  }

  /** Drop the link the way a lost network does — no close frame, no goodbye. */
  kill() {
    this.#ws.terminate();
  }

  close() {
    if (!this.#closed) this.#ws.close();
  }

  #receive(raw) {
    let frame;
    try {
      frame = JSON.parse(String(raw));
    } catch {
      return;
    }
    this.#frames.push(frame);
    for (const waiter of [...this.#waiters]) {
      if (waiter.predicate(frame)) waiter.resolve(frame);
    }
  }
}

/**
 * Boot the built Panel service as a plain Node process — the deployable, not a
 * dev server — and wait until it is accepting.
 *
 * Returns the running service plus an HTTP client already pointed at it. Each
 * call gets its own cookie jar: "restart the Panel and log in again" is a leg
 * of the test, not a detail to paper over.
 */
export async function startPanelService({
  bin,
  serverEntry,
  dataDir,
  port,
  secretsKey,
  timeoutMs = 60_000,
  log,
}) {
  const child = spawn(process.execPath, [bin], {
    env: panelServiceEnv({ dataDir, port, serverEntry, secretsKey }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const observer = { logLines: [] };
  const origin = `http://127.0.0.1:${port}`;

  /** Best-effort synchronous kill, for an `exit` handler that cannot await. */
  const kill = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  };

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    // The service closes its HTTP server on SIGTERM; if a socket keeps it
    // alive past the grace period, take it out — a leaked Panel would hold the
    // port the next phase wants.
    const grace = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(grace);
  };

  try {
    await waitForPanelListening(child, timeoutMs, observer);
  } catch (err) {
    await stop();
    err.logLines = observer.logLines;
    throw err;
  }
  log?.(`panel service up on ${origin} (data dir ${dataDir})`);

  return {
    origin,
    port,
    dataDir,
    client: new PanelHttpClient(origin),
    logLines: () => [...observer.logLines],
    stop,
    kill,
  };
}

/**
 * Poll `check` until it returns something truthy, and resolve with it.
 *
 * Named apart from the `until` in `scripts/lib/setup-e2e.mjs` on purpose: that
 * one ends the run through a `die` and resolves with nothing, this one hands
 * back the value and throws. Two contracts under one name would be a trap.
 */
export async function pollUntil(label, timeoutMs, check, { pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await delay(pollMs);
  }
}

/** Wait, for the legs that have to let wall-clock time pass. */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
