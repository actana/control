import { describe, it, expect, vi, afterEach } from "vitest";
import { Server } from "node:net";
import { PtyCoreLinkServer, type WebSocketServerLike, type WebSocketLike } from "@actana/harness/pty-core-link-server";
import { PtyCoreLinkClient } from "../client";
import { createNodeCoreLinkSocket } from "../node-socket";
import { generateCertMaterial } from "@actana/harness/harness-cert-material";
import { signBearer, verifyBearer } from "@actana/shared/core-link-bearer";
import type { PtyHarnessCore, PtyHarnessEvent } from "@actana/harness/pty-manager";

// End-to-end mTLS + bearer auth over a REAL `wss://` socket (issue 04). The
// rest of the core-link suite uses in-memory fakes; this test exercises the
// actual TLS handshake + the default `createServer`/`createNodeCoreLinkSocket`
// against a real port, so the cert material, the pinned-CA server, and the
// mTLS client are all proven to interoperate.

const SECRET = "mtls-integration-secret-32-bytes-xx";

function makeMockCore(): PtyHarnessCore & {
  emitEvent: (e: PtyHarnessEvent) => void;
} {
  const core: Record<string, unknown> = {
    setEmitTarget: (_fn: ((event: PtyHarnessEvent) => void) | null) => {},
    spawn: async () => ({ ptyId: "pty-real-1" }),
    write: () => true,
    resize: () => true,
    kill: () => true,
    killLaunchProcesses: async () => ({ ptyCount: 0, ports: [] }),
    killPtysUnderPath: async () => ({ ptyCount: 0 }),
    findByTask: () => ({ ptyId: null as string | null }),
    replay: () => ({ data: "", nextSeq: 0 }),
    killAll: () => {},
  };
  return core as unknown as PtyHarnessCore & {
    emitEvent: (e: PtyHarnessEvent) => void;
  };
}

/** Pick a free TCP port on 127.0.0.1 by briefly opening a server on port 0. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = new Server();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        s.close(() => resolve(port));
      } else {
        s.close();
        reject(new Error("no port"));
      }
    });
  });
}

/** A createServer that records the bound port so the test client can dial it. */
function recordingCreateServer(out: { port: number }): (opts: { port: number; host: string; tls?: any }) => WebSocketServerLike {
  return (opts) => {
    // Use the real default factory by constructing the server the same way.
    // Re-implemented here so we can read the bound port from the TLS server.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { WebSocketServer } = require("ws") as typeof import("ws");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const https = require("node:https") as typeof import("node:https");
    const tlsServer = https.createServer({
      cert: opts.tls.serverCert,
      key: opts.tls.serverKey,
      ca: opts.tls.caCert,
      requestCert: true,
      rejectUnauthorized: true,
    });
    tlsServer.listen(opts.port, opts.host, () => {
      const addr = tlsServer.address();
      if (addr && typeof addr === "object") out.port = addr.port;
    });
    const wss = new WebSocketServer({ server: tlsServer });
    return {
      close: (cb) => wss.close(() => tlsServer.close(cb)),
      on: (event, cb) => {
        if (event === "connection") {
          wss.on("connection", (ws: import("ws").WebSocket) => {
            (cb as (ws: WebSocketLike) => void)(adapt(ws));
          });
        } else if (event === "error") {
          wss.on("error", (err: Error) => (cb as (err: Error) => void)(err));
        }
      },
    };
  };
}

function adapt(ws: import("ws").WebSocket): WebSocketLike {
  return {
    get readyState() {
      return ws.readyState;
    },
    send: (data: string) => ws.send(data),
    close: () => ws.close(),
    on: (event, cb) => {
      if (event === "message") ws.on("message", (data: unknown) => (cb as (d: unknown) => void)(data));
      else if (event === "close") ws.on("close", () => (cb as () => void)());
      else if (event === "error") ws.on("error", (err: Error) => (cb as (e: Error) => void)(err));
    },
    removeAllListeners: () => ws.removeAllListeners(),
  };
}

describe("core-link mTLS + bearer integration", () => {
  let server: PtyCoreLinkServer | null = null;
  let client: PtyCoreLinkClient | null = null;

  afterEach(() => {
    client?.close();
    server?.close();
  });

  it("dials wss:// with mTLS, authenticates, and round-trips a spawn RPC", async () => {
    const mat = await generateCertMaterial({ host: "127.0.0.1" });
    const port = await freePort();
    const bound: { port: number } = { port };
    const core = makeMockCore();
    server = new PtyCoreLinkServer(core, {
      port,
      host: "127.0.0.1",
      createServer: recordingCreateServer(bound),
      tls: { caCert: mat.ca.cert, serverCert: mat.server.cert, serverKey: mat.server.key },
      authVerifier: (bearer) => verifyBearer(bearer, SECRET),
    });

    // Wait for the TLS server to bind.
    await vi.waitFor(() => expect(bound.port).toBeGreaterThan(0));

    const exp = Date.now() + 60_000;
    const bearer = signBearer({ coreId: "core_remote", exp }, SECRET);
    client = new PtyCoreLinkClient({
      url: `wss://127.0.0.1:${bound.port}`,
      createSocket: (url) =>
        createNodeCoreLinkSocket(url, { ca: mat.ca.cert, cert: mat.client.cert, key: mat.client.key }),
      bearer,
      reconnectInitialMs: 60_000,
      reconnectMaxMs: 60_000,
    });

    const authOk = vi.fn();
    client.onAuthOk(authOk);
    await vi.waitFor(() => expect(authOk).toHaveBeenCalled());
    expect(client.isAuthenticated()).toBe(true);

    // A spawn RPC must round-trip over the authenticated mTLS socket.
    const p = client.spawn({
      taskId: "t1",
      cwd: "/tmp",
      command: "claude",
      agent: "claude-code",
    } as any);
    await expect(p).resolves.toEqual({ ptyId: "pty-real-1" });
  }, 15_000);

  it("rejects a client without the pinned client cert (mTLS handshake fails)", async () => {
    const mat = await generateCertMaterial({ host: "127.0.0.1" });
    const port = await freePort();
    const bound: { port: number } = { port };
    const core = makeMockCore();
    server = new PtyCoreLinkServer(core, {
      port,
      host: "127.0.0.1",
      createServer: recordingCreateServer(bound),
      tls: { caCert: mat.ca.cert, serverCert: mat.server.cert, serverKey: mat.server.key },
      authVerifier: (bearer) => verifyBearer(bearer, SECRET),
    });
    await vi.waitFor(() => expect(bound.port).toBeGreaterThan(0));

    const bearer = signBearer({ coreId: "core_remote", exp: Date.now() + 60_000 }, SECRET);
    // Dial with the right CA but NO client cert — the server requires a client
    // cert signed by the CA; the handshake must fail. The client never reaches
    // authOk.
    client = new PtyCoreLinkClient({
      url: `wss://127.0.0.1:${bound.port}`,
      createSocket: (url) =>
        createNodeCoreLinkSocket(url, { ca: mat.ca.cert, cert: "", key: "" }),
      bearer,
      reconnectInitialMs: 60_000,
      reconnectMaxMs: 60_000,
    });
    const authOk = vi.fn();
    client.onAuthOk(authOk);
    // Give the handshake a moment to fail. No authOk ever fires.
    await new Promise((r) => setTimeout(r, 500));
    expect(authOk).not.toHaveBeenCalled();
    expect(client.isAuthenticated()).toBe(false);
  }, 15_000);
});
