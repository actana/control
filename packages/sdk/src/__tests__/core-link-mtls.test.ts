// The Core client over a real `wss://` socket, with a real mTLS handshake
// (issue 153, #129 D1 — "mTLS + bearer from a registration blob").
//
// The rest of this package's suites run the real Core server over an in-memory
// socket pair, which proves the frames and their ordering. This one proves the
// part an in-memory pair cannot: that a registration blob's PEM material, the
// Node `ws` dial the SDK ships, and a Core requiring a pinned client cert
// actually interoperate over a TCP port — and that a client without the client
// cert never gets past the handshake, which is the control that makes the
// positive result mean anything.
//
// Both certificates come from the Core's own `generateCertMaterial`, so the
// material under test is the material `actana setup` writes.

import { describe, it, expect, afterEach } from "vitest";
import { Server } from "node:net";
import https from "node:https";
import { WebSocketServer } from "ws";
import {
  PtyCoreLinkServer,
  type WebSocketLike as ServerSocketLike,
  type WebSocketServerLike,
} from "@actana/core/pty-core-link-server";
import { generateCertMaterial } from "@actana/core/core-cert-material";
import { signBearer, verifyBearer } from "@actana/shared/core-link-bearer";
import { CoreClient } from "../core-client";
import type { CoreRegistrationBlob } from "../core-registration-blob";
import { makeMockPtyCore } from "./fake-core-link";

const SECRET = "mtls-suite-secret-at-least-32-bytes";

/**
 * What a refusal *at the TLS layer* looks like by the time it reaches a caller:
 * the peer resetting the connection, or an SSL alert naming the reason. Node
 * words it differently across OpenSSL versions — a missing client cert is an
 * `alert certificate required` on this one and a bare `socket hang up` on
 * others — hence the alternation.
 *
 * What is *not* in it matters as much as what is. No `closed`, no `ECONNREFUSED`,
 * no `timed out`: every one of those is how the client reports a Core it never
 * reached, and a control that accepted them would pass with no Core at all.
 */
const TLS_REFUSAL = /ECONNRESET|EPIPE|socket hang up|ERR_SSL|SSL routines|alert|handshake/i;

/** A free TCP port on 127.0.0.1, found by briefly binding port 0. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = new Server();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        s.close(() => resolve(port));
      } else {
        s.close();
        reject(new Error("no port"));
      }
    });
  });
}

/**
 * The real `wss://` server the Core builds, with the bound port recorded so the
 * test can dial it. Mirrors the Core's default factory — `requestCert` plus
 * `rejectUnauthorized` are what make this a mutual handshake.
 */
function recordingCreateServer(
  bound: { port: number },
): (opts: { port: number; host: string; tls?: unknown }) => WebSocketServerLike {
  return (opts) => {
    const tls = opts.tls as { caCert: string; serverCert: string; serverKey: string };
    const tlsServer = https.createServer({
      cert: tls.serverCert,
      key: tls.serverKey,
      ca: tls.caCert,
      requestCert: true,
      rejectUnauthorized: true,
    });
    tlsServer.listen(opts.port, opts.host, () => {
      const addr = tlsServer.address();
      if (addr && typeof addr === "object") bound.port = addr.port;
    });
    const wss = new WebSocketServer({ server: tlsServer });
    return {
      close: (cb) => wss.close(() => tlsServer.close(cb)),
      on: (event, cb) => {
        if (event === "connection") {
          wss.on("connection", (ws) => (cb as (s: ServerSocketLike) => void)(adapt(ws)));
        } else if (event === "error") {
          wss.on("error", (err: Error) => (cb as (e: Error) => void)(err));
        }
      },
    };
  };
}

function adapt(ws: import("ws").WebSocket): ServerSocketLike {
  return {
    get readyState() {
      return ws.readyState;
    },
    send: (data: string) => ws.send(data),
    close: () => ws.close(),
    on: (event, cb) => {
      if (event === "message") ws.on("message", (d: unknown) => (cb as (d: unknown) => void)(d));
      else if (event === "close") ws.on("close", () => (cb as () => void)());
      else if (event === "error") ws.on("error", (e: Error) => (cb as (e: Error) => void)(e));
    },
    removeAllListeners: () => ws.removeAllListeners(),
  } as ServerSocketLike;
}

describe("Core client over mTLS", () => {
  let server: PtyCoreLinkServer | null = null;
  let client: CoreClient | null = null;

  afterEach(() => {
    client?.close();
    client = null;
    server?.close();
    server = null;
  });

  /** A real Core on a real port, and the blob a client would be handed for it. */
  async function startCore(): Promise<{ blob: CoreRegistrationBlob; caCert: string }> {
    const material = await generateCertMaterial({ host: "127.0.0.1" });
    const port = await freePort();
    const bound = { port: 0 };
    server = new PtyCoreLinkServer(makeMockPtyCore(), {
      port,
      host: "127.0.0.1",
      createServer: recordingCreateServer(bound),
      tls: {
        caCert: material.ca.cert,
        serverCert: material.server.cert,
        serverKey: material.server.key,
      },
      authVerifier: (bearer) => verifyBearer(bearer, SECRET),
    });
    // Wait for the TLS server to bind before anything dials it.
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5_000;
      const tick = () => {
        if (bound.port > 0) return resolve();
        if (Date.now() > deadline) return reject(new Error("TLS server never bound"));
        setTimeout(tick, 10);
      };
      tick();
    });
    return {
      caCert: material.ca.cert,
      blob: {
        endpoint: `wss://127.0.0.1:${bound.port}`,
        label: "test-core",
        caCert: material.ca.cert,
        clientCert: material.client.cert,
        clientKey: material.client.key,
        bearer: signBearer({ coreId: "core_mtls", exp: Date.now() + 60_000 }, SECRET),
      },
    };
  }

  it("dials wss:// from a registration blob, authenticates, and round-trips a request", async () => {
    const { blob } = await startCore();

    client = CoreClient.fromRegistrationBlob(blob, { connectTimeoutMs: 10_000 });
    const info = await client.connect();

    expect(info.coreId).toBe("core_mtls");
    expect(info.compatible).toBe(true);
    expect(client.isAuthenticated()).toBe(true);
    await expect(
      client.spawn({ taskId: "t1", cwd: "/tmp", command: "claude", agent: "claude-code" }),
    ).resolves.toEqual({ ptyId: "pty-1" });
  }, 20_000);

  it("never authenticates without the pinned client cert — the handshake fails first", async () => {
    const { blob } = await startCore();

    // The right CA, no client certificate. The Core requires one signed by that
    // CA, so this never becomes a core link at all. Without this control, the
    // test above would pass against a server that never asked.
    client = CoreClient.fromRegistrationBlob(
      { ...blob, clientCert: "", clientKey: "" },
      { connectTimeoutMs: 5_000 },
    );

    const err = await client.connect().then(
      () => null,
      (e: unknown) => e,
    );
    // Assert on the *shape* of the refusal, not merely that something failed: a
    // control that passes on any error would pass against a Core that is not
    // running, and then the test above would be meaningful against nothing at
    // all. A TLS-layer refusal shows up as the peer closing the connection or as
    // an SSL alert, never as a `connect` deadline and never as a refused TCP
    // connection.
    //
    // `closed` is deliberately *not* in that alternation. Every transport
    // failure reaches a caller as `core-link closed: …` (`core-client.ts`), so
    // matching on it would accept the very thing this control exists to rule
    // out — which is what the test below pins.
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(TLS_REFUSAL);
    expect((err as Error).message).not.toMatch(/timed out|ECONNREFUSED/i);
    expect(client.isAuthenticated()).toBe(false);
  }, 20_000);

  it("tells a refused handshake from a Core that is not running", async () => {
    // The control above is only worth its runtime if its matcher can *fail*.
    // Here is the failure it has to catch: the same client, the same valid
    // material, aimed at a port with nothing behind it — a Core that is down, a
    // wrong port in a blob, a daemon that never started. That error is a
    // `core-link closed: connect ECONNREFUSED …`, so the alternation the control
    // uses must reject it. Put `closed|` back and this test goes red.
    const { blob } = await startCore();
    const nowhere = await freePort();

    client = CoreClient.fromRegistrationBlob(
      { ...blob, endpoint: `wss://127.0.0.1:${nowhere}` },
      { connectTimeoutMs: 5_000 },
    );

    const err = await client.connect().then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/ECONNREFUSED/i);
    expect((err as Error).message).not.toMatch(TLS_REFUSAL);
    expect(client.isAuthenticated()).toBe(false);
  }, 20_000);
});
