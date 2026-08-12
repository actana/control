#!/usr/bin/env node
// Throwaway spike script for issue #151 — "Node-22 mTLS and fetch spike".
//
// NOT a published entry point. Nothing imports this, no package.json field
// points at it, and it adds no dependency to the workspace: `ws` and `undici`
// are resolved from a scratch rig outside the repo via SPIKE_MODULES (see
// below). Delete it once D12 is settled.
//
// It answers one question against a LIVE Core: can Node 22 speak mTLS in both
// directions with credentials read from a registration blob?
//
//   1. `ws` WebSocket to the core-link endpoint that reaches `ready`.
//   2. `fetch` (undici) that carries a client certificate and gets a response.
//
// Leg 2 is the whole reason the spike exists. `fetch` is undici, not
// `https.request`: it ignores `options.cert` / `options.key`, and a client
// certificate only reaches the socket through a custom Dispatcher.
//
// Usage:
//   SPIKE_MODULES=/path/to/rig/node_modules node experiment/spike-151-node22-mtls.mjs
//
// Env:
//   SPIKE_MODULES  dir holding `ws` and `undici` (required — kept out of the repo)
//   SPIKE_BLOB     registration blob path (default ~/.config/actana/registration-blob.txt)
//   SPIKE_MATERIAL Core cert material path (default ~/.config/actana/material.json)
//                  used only by leg 2c, which needs the Core's own server cert

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { pathToFileURL } from "node:url";

const MODULES = process.env.SPIKE_MODULES;
if (!MODULES) {
  console.error("SPIKE_MODULES is required — point it at a node_modules dir holding ws + undici.");
  process.exit(2);
}
// Both packages are CommonJS; `ws` sets `module.exports = WebSocket`, which
// the ESM interop surfaces as `default`, not as a named export.
const load = (name) => import(pathToFileURL(path.join(MODULES, name)).href);
const wsMod = await load("ws/index.js");
const WebSocket = wsMod.default ?? wsMod.WebSocket;
const undiciMod = await load("undici/index.js");
const undici = undiciMod.default ?? undiciMod;
const { Agent, buildConnector } = undici;

const BLOB_PATH =
  process.env.SPIKE_BLOB ?? path.join(os.homedir(), ".config/actana/registration-blob.txt");
const MATERIAL_PATH =
  process.env.SPIKE_MATERIAL ?? path.join(os.homedir(), ".config/actana/material.json");

// ─── The registration blob is the only credential source ────────────────────
// base64(JSON({endpoint, label, caCert, clientCert, clientKey, bearer})).
const blob = JSON.parse(
  Buffer.from(fs.readFileSync(BLOB_PATH, "utf8").trim(), "base64").toString("utf8"),
);
const { endpoint, caCert, clientCert, clientKey, bearer } = blob;
const url = new URL(endpoint); // wss://<host>:<port>
const HOST = url.hostname;
const PORT = Number(url.port);

const isIpLiteral = (h) => net.isIP(h) !== 0;

const results = [];
const record = (id, name, ok, detail) => {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}\n        ${detail}`);
};

const withTimeout = (ms) => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, done: () => clearTimeout(timer), timedOut: () => ac.signal.aborted };
};

// ─── Leg 1 — `ws` over mTLS, must reach `ready` ─────────────────────────────
// The cert/key/ca go straight into the `ws` options object: `ws` hands them to
// `https.request`, which is the classic Node TLS surface and takes them as-is.
// This is the leg that was never in doubt; it is here as the control.
async function legWsReady() {
  return new Promise((resolve) => {
    // No `servername`: the blob's host here is an IP literal, and RFC 6066
    // forbids an IP in SNI (Node warns, and will drop it outright later). The
    // Core's cert carries `IP Address:127.0.0.1` in its SAN, which Node matches
    // against the dialled address without SNI. Set `servername` only when the
    // blob's endpoint is a DNS name.
    const socket = new WebSocket(endpoint, {
      ca: caCert,
      cert: clientCert,
      key: clientKey,
      ...(isIpLiteral(HOST) ? {} : { servername: HOST }),
    });
    let sawReady = false;
    let sawAuth = false;
    // Whichever leg the socket died on is the one that has to land in
    // `results`. Recording leg 1 unconditionally would both contradict an
    // already-passed leg 1 and let a stall between `ready` and `authOk` drop
    // leg 1b entirely — and a dropped leg is an empty `failed`, i.e. exit 0.
    const recordUnfinished = (detail) => {
      if (!sawReady) record("1", "ws → ready", false, detail);
      else if (!sawAuth) record("1b", "ws → authOk", false, `after \`ready\`: ${detail}`);
    };

    const timer = setTimeout(() => {
      socket.terminate();
      recordUnfinished("timed out after 10000ms");
      resolve();
    }, 10_000);

    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "ready") {
        sawReady = true;
        record(
          "1",
          "ws → ready",
          true,
          `ready frame: version=${frame.version} multiConnection=${JSON.stringify(frame.multiConnection ?? null)}`,
        );
        // Bearer auth rides the same socket — proving it lands means the whole
        // core-link handshake (mTLS + bearer), not just the TLS half, works.
        socket.send(JSON.stringify({ type: "auth", reqId: "spike-1", bearer }));
        return;
      }
      if (frame.type === "authOk") {
        sawAuth = true;
        record("1b", "ws → authOk", true, `coreId=${frame.coreId} exp=${frame.exp}`);
        clearTimeout(timer);
        socket.close();
        resolve();
        return;
      }
      if (frame.type === "authError") {
        sawAuth = true;
        record("1b", "ws → authOk", false, `authError reason=${frame.reason}`);
        clearTimeout(timer);
        socket.close();
        resolve();
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      recordUnfinished(`${err.code ?? err.name}: ${err.message}`);
      resolve();
    });
  });
}

// ─── Leg 2a — fetch carries a client cert through an undici Agent ───────────
// The point of the spike. `fetch(url, {dispatcher})` is the only seam: there is
// no `options.cert`. The connector below wraps undici's real one purely to read
// the finished TLSSocket back out, so "the handshake was mutual and verified"
// is an assertion about the actual socket rather than an inference from a
// status code.
async function legFetchHandshake() {
  let observed = null;
  const base = buildConnector({ ca: caCert, cert: clientCert, key: clientKey });
  const connector = (opts, cb) =>
    base(opts, (err, socket) => {
      // First connect only. undici caches TLS sessions, and a resumed session
      // reports no peer certificate — a later observation would blank the
      // evidence without meaning the handshake got weaker.
      if (socket instanceof tls.TLSSocket && !observed) {
        observed = {
          authorized: socket.authorized,
          authorizationError: socket.authorizationError?.message ?? null,
          peer: socket.getPeerX509Certificate()?.subject ?? null,
          protocol: socket.getProtocol(),
          sessionReused: socket.isSessionReused(),
          // The Core sets `requestCert: true, rejectUnauthorized: true`. A
          // socket that is still open here is one whose client cert the Core
          // accepted — it tears down the connection otherwise.
          sentClientCert: Boolean(socket.getX509Certificate()),
          clientCn: socket.getX509Certificate()?.subject ?? null,
        };
      }
      cb(err, socket);
    });

  const agent = new Agent({ connect: connector });
  const t = withTimeout(6000);
  let httpOutcome;
  try {
    const res = await fetch(endpoint.replace(/^wss:/, "https:") + "/", {
      dispatcher: agent,
      signal: t.signal,
    });
    httpOutcome = `HTTP ${res.status}`;
  } catch (err) {
    // The Core's mTLS port has no HTTP request listener (WS upgrade only), so
    // the expected outcome here is a timeout AFTER a completed handshake.
    httpOutcome = t.timedOut()
      ? "no response — Core serves no HTTP route on this port (see 2c)"
      : `${err.cause?.code ?? err.name}`;
  } finally {
    t.done();
    await agent.close().catch(() => {});
  }

  if (!observed) {
    record("2a", "fetch → mutual TLS", false, "connector never produced a TLSSocket");
    return;
  }
  const ok = observed.authorized === true && observed.sentClientCert === true;
  record(
    "2a",
    "fetch → mutual TLS",
    ok,
    `authorized=${observed.authorized} authorizationError=${observed.authorizationError} ${observed.protocol}\n` +
      `        server=[${observed.peer}] client=[${observed.clientCn}]\n` +
      `        HTTP layer: ${httpOutcome}`,
  );
}

// ─── Leg 2b — negative control: same fetch, no client cert ──────────────────
// Without this, leg 2a proves nothing: a server that never asked for a client
// cert would look identical. The Core must reject this one at the TLS layer.
async function legFetchNoCert() {
  const agent = new Agent({ connect: { ca: caCert } });
  const t = withTimeout(6000);
  try {
    const res = await fetch(endpoint.replace(/^wss:/, "https:") + "/", {
      dispatcher: agent,
      signal: t.signal,
    });
    record("2b", "fetch without client cert is refused", false, `unexpectedly got HTTP ${res.status}`);
  } catch (err) {
    const code = String(err.cause?.code ?? err.name);
    // A TLS-layer refusal is the pass, and it has to be asserted on its shape.
    // `!t.timedOut()` alone passes on *any* non-slow failure: ECONNREFUSED
    // against a Core that is not running, or a wrong port, would read as a
    // clean negative control and make leg 2a look meaningful when nothing was
    // listening. The Core tears the connection down after asking for a client
    // cert it did not get (undici surfaces that as UND_ERR_SOCKET/ECONNRESET),
    // or OpenSSL raises an explicit alert. Anything else is a broken rig.
    const REFUSALS = new Set(["UND_ERR_SOCKET", "ECONNRESET", "EPIPE"]);
    const isTlsRefusal = REFUSALS.has(code) || code.startsWith("ERR_SSL_");
    const ok = !t.timedOut() && isTlsRefusal;
    record(
      "2b",
      "fetch without client cert is refused",
      ok,
      `${code}: ${err.cause?.message ?? err.message}` +
        (ok ? "" : " — not a TLS-layer refusal (is the Core up on this port?)"),
    );
  } finally {
    t.done();
    await agent.close().catch(() => {});
  }
}

// ─── Leg 2c — fetch gets a real HTTP response over mTLS ─────────────────────
// The live Core's mTLS port is WebSocket-upgrade only: `https.createServer` is
// constructed with no request listener, so a plain GET hangs forever (leg 2a's
// "no HTTP response"). To show that the undici Agent completes a full
// request/response cycle — not just a handshake — this stands up a throwaway
// listener on loopback using the Core's OWN server certificate and CA, with the
// same `requestCert: true, rejectUnauthorized: true` gate. Same credentials,
// same trust chain, an HTTP route to answer on.
async function legFetchResponse() {
  let material;
  try {
    material = JSON.parse(fs.readFileSync(MATERIAL_PATH, "utf8"));
  } catch (err) {
    record("2c", "fetch → HTTP response over mTLS", false, `cannot read ${MATERIAL_PATH}: ${err.message}`);
    return;
  }

  const server = https.createServer(
    {
      cert: material.serverCert,
      key: material.serverKey,
      ca: material.caCert,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      const cn = req.socket.getPeerCertificate()?.subject?.CN ?? "none";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, clientCn: cn, path: req.url }));
    },
  );
  await new Promise((r) => server.listen(0, HOST, r));
  const port = server.address().port;

  const agent = new Agent({ connect: { ca: caCert, cert: clientCert, key: clientKey } });
  const t = withTimeout(6000);
  try {
    const res = await fetch(`https://${HOST}:${port}/spike`, { dispatcher: agent, signal: t.signal });
    const body = await res.json();
    record(
      "2c",
      "fetch → HTTP response over mTLS",
      res.status === 200 && body.clientCn === "mission-control-panel",
      `HTTP ${res.status} ${JSON.stringify(body)} (loopback listener on the Core's own server cert, port ${port})`,
    );
  } catch (err) {
    record("2c", "fetch → HTTP response over mTLS", false, `${err.cause?.code ?? err.name}: ${err.message}`);
  } finally {
    t.done();
    await agent.close().catch(() => {});
    server.close();
  }
}

// ─── Leg 3 — the §5 trap, measured rather than assumed ──────────────────────
// The runbook says the Core's cert is issued for "the exact host and port" in
// the blob. Half of that is true and the half matters: X.509 binds hostnames
// and IPs, never ports. Dialling the same Core on a rewritten HOST fails
// validation; a rewritten PORT does not (leg 2c already proves that — it
// validates the Core's server cert on an ephemeral port). This leg pins down
// which half bites, so nobody debugs a port mapping looking for a Node bug.
async function legWrongHost() {
  const addrs = Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === "IPv4" && !n.internal)
    .map((n) => n.address);
  if (addrs.length === 0) {
    record("3", "wrong host fails SAN validation", false, "no non-loopback IPv4 address to dial");
    return;
  }
  const alt = addrs[0];
  const agent = new Agent({ connect: { ca: caCert, cert: clientCert, key: clientKey } });
  const t = withTimeout(6000);
  try {
    const res = await fetch(`https://${alt}:${PORT}/`, { dispatcher: agent, signal: t.signal });
    record("3", "wrong host fails SAN validation", false, `unexpectedly got HTTP ${res.status} from ${alt}`);
  } catch (err) {
    const code = err.cause?.code ?? err.name;
    record(
      "3",
      "wrong host fails SAN validation",
      code === "ERR_TLS_CERT_ALTNAME_INVALID",
      `dialled https://${alt}:${PORT} → ${code}`,
    );
  } finally {
    t.done();
    await agent.close().catch(() => {});
  }
}

console.log(`node ${process.version}  •  endpoint ${endpoint}  •  blob ${BLOB_PATH}\n`);
await legWsReady();
await legFetchHandshake();
await legFetchNoCert();
await legFetchResponse();
await legWrongHost();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} legs passed on ${process.version}`);
process.exit(failed.length === 0 ? 0 : 1);
