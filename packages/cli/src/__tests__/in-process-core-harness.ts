// A real Core, in this process, on a real `wss://` port.
//
// Extracted from `in-process-core.test.ts` when #160 wanted the same Core for
// the `session` noun: `packages/core`'s real `PtyCoreLinkServer`, mTLS material
// from the Core's own `generateCertMaterial`, and a bearer its own verifier
// accepts. Two suites building that twice would be two chances to build it
// slightly differently, and the difference would look like a CLI bug.
//
// The ports are arguments because that is what the two suites differ in:
// `core status` reaches a Core that answers no request frames at all, and the
// `session` verbs reach one holding tasks, projects and a live PTY. Everything
// else — the handshake, the certificates, the blob an operator would be handed
// — is identical, which is the point.

import { Server } from "node:net";
import https from "node:https";
import { WebSocketServer } from "ws";
import {
  PtyCoreLinkServer,
  type CoreMutationPort,
  type CoreQueryPort,
  type WebSocketLike as ServerSocketLike,
  type WebSocketServerLike,
} from "@actana/core/pty-core-link-server";
import { generateCertMaterial } from "@actana/core/core-cert-material";
import { signBearer, verifyBearer } from "@actana/shared/core-link-bearer";

export const SECRET = "cli-in-process-core-secret-at-least-32-bytes";
export const CORE_ID = "core_in_process";

/**
 * A PTY manager that is never asked for anything.
 *
 * Every method throws rather than returning an empty: a verb that starts
 * reaching the PTY manager when it was not meant to should fail loudly instead
 * of quietly proving less. Suites that *do* mean to reach it pass their own.
 */
export function unusedPtyCore(): never[] & Record<string, unknown> {
  const unreachable = (name: string) => () => {
    throw new Error(`this suite reached the PTY manager (${name}) — it is meant to be read-only`);
  };
  return {
    setEmitTarget: () => {},
    spawn: unreachable("spawn"),
    write: unreachable("write"),
    resize: unreachable("resize"),
    kill: unreachable("kill"),
    killAll: unreachable("killAll"),
    killLaunchProcesses: unreachable("killLaunchProcesses"),
    killPtysUnderPath: unreachable("killPtysUnderPath"),
    findByTask: unreachable("findByTask"),
    taskIdForPty: () => null,
    replay: unreachable("replay"),
  } as unknown as never[] & Record<string, unknown>;
}

/** A free TCP port on 127.0.0.1, found by briefly binding port 0. */
export function freePort(): Promise<number> {
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
 * The real `wss://` server the Core builds, with the bound port recorded.
 * `requestCert` plus `rejectUnauthorized` are what make this a mutual
 * handshake — without them the blob's client cert would be decoration.
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
      close: (cb?: () => void) => wss.close(() => tlsServer.close(cb)),
      on: (event: string, cb: unknown) => {
        if (event === "connection") {
          wss.on("connection", (ws) => (cb as (s: ServerSocketLike) => void)(adapt(ws)));
        } else if (event === "error") {
          wss.on("error", (err: Error) => (cb as (e: Error) => void)(err));
        }
      },
    } as WebSocketServerLike;
  };
}

function adapt(ws: import("ws").WebSocket): ServerSocketLike {
  return {
    get readyState() {
      return ws.readyState;
    },
    send: (data: string) => ws.send(data),
    close: () => ws.close(),
    on: (event: string, cb: unknown) => {
      if (event === "message") ws.on("message", (d: unknown) => (cb as (d: unknown) => void)(d));
      else if (event === "close") ws.on("close", () => (cb as () => void)());
      else if (event === "error") ws.on("error", (e: Error) => (cb as (e: Error) => void)(e));
    },
    removeAllListeners: () => ws.removeAllListeners(),
  } as ServerSocketLike;
}

export type InProcessCore = {
  server: PtyCoreLinkServer;
  /** The base64 blob an operator would be handed for this Core. */
  blobText: string;
  endpoint: string;
};

/** Start a Core on a real port, and build the blob that reaches it. */
export async function startInProcessCore(
  opts: {
    protocolVersion?: string;
    bearerExpiresInMs?: number;
    ptyCore?: unknown;
    queryPort?: CoreQueryPort;
    mutationPort?: CoreMutationPort;
  } = {},
): Promise<InProcessCore> {
  const material = await generateCertMaterial({ host: "127.0.0.1" });
  const port = await freePort();
  const bound = { port: 0 };
  const server = new PtyCoreLinkServer((opts.ptyCore ?? unusedPtyCore()) as never, {
    port,
    host: "127.0.0.1",
    createServer: recordingCreateServer(bound),
    tls: {
      caCert: material.ca.cert,
      serverCert: material.server.cert,
      serverKey: material.server.key,
    },
    authVerifier: (bearer: string) => verifyBearer(bearer, SECRET),
    ...(opts.protocolVersion === undefined ? {} : { protocolVersion: opts.protocolVersion }),
    ...(opts.queryPort === undefined ? {} : { queryPort: opts.queryPort }),
    ...(opts.mutationPort === undefined ? {} : { mutationPort: opts.mutationPort }),
  });

  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const tick = () => {
      if (bound.port > 0) return resolve();
      if (Date.now() > deadline) return reject(new Error("TLS server never bound"));
      setTimeout(tick, 10);
    };
    tick();
  });

  const endpoint = `wss://127.0.0.1:${bound.port}`;
  const blobText = Buffer.from(
    JSON.stringify({
      endpoint,
      label: "in-process",
      caCert: material.ca.cert,
      clientCert: material.client.cert,
      clientKey: material.client.key,
      bearer: signBearer(
        { coreId: CORE_ID, exp: Date.now() + (opts.bearerExpiresInMs ?? 3_600_000) },
        SECRET,
      ),
    }),
    "utf8",
  ).toString("base64");

  return { server, blobText, endpoint };
}
