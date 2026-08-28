// A real Core, in this process, on a real `wss://` port.
//
// Extracted from `in-process-core.test.ts` (#201) when a second suite needed
// one. The original comment still says why it exists and is worth restating:
// the alternative to a Core is a fake, and a fake cannot tell you whether the
// CLI's one socket-touching module works. `live-core.test.ts` covers the
// operator's own Core and is opt-in by necessity — it needs credentials for a
// machine only they have — so without this, the claims that matter most would
// be covered by a suite a default `pnpm test` skips.
//
// **#160 and #161 each extracted one of these, and this is the merge of the
// two** (review of #205). Four suites share it now: `core status` against a
// Core that answers no request frames, the `session` verbs against one holding
// tasks and a live PTY, `project`/`harness` against one with a disk and an
// installer, and `events tail` against one that is stopped and restarted under
// a running command. What each of them varies is a port or two; the handshake,
// the certificates and the blob an operator would be handed are the same
// object, which is the point of there being one of these rather than two.
//
// Two things that look like conveniences are load-bearing:
//
//   • **Stopping a Core and starting another on the same port with the same
//     log** (`opts.port`, `opts.material`, {@link InProcessCore.stop}).
//     `events tail` claims to survive a reconnect without duplicating or
//     dropping an event, and there is no way to observe that claim except by
//     dropping the connection under a running tail and reading what comes out.
//
//   • **A teardown that actually frees the port** — see
//     {@link recordingCreateServer}. Without it the restart above is an
//     `EADDRINUSE` rather than the reconnect the suite meant to stage.
//
//   • **Killing a live connection while the Core keeps running**
//     ({@link InProcessCore.dropConnections}). `session attach` claims a Session
//     write lock and the Core releases it when the holding connection goes (ADR
//     0024 D7) — the case #163 calls the one that gets missed and the one that
//     strands a Session unwritable. A client cannot stage that from its own side:
//     hanging up politely is not the same event, and stopping the whole Core
//     proves nothing about a lock table that died with it. This destroys the
//     socket the way a network does.
//
// **`@actana/core` and `@actana/shared` stay out of `package.json`** (ADR 0025
// D4) — both are private, one is a daemon, and a manifest entry would put them
// in the published CLI's dependency graph for the sake of a test. The module
// aliases in `tsconfig.json` and `vitest.config.ts` are what make this resolve,
// and `no-local-escape.test.ts` is what keeps a *shipped* module from doing the
// same.

import { Server } from "node:net";
import https from "node:https";
import { WebSocketServer } from "ws";
import {
  PtyCoreLinkServer,
  type CoreDirectoryPort,
  type CoreExecPort,
  type CoreMutationPort,
  type CoreQueryPort,
  type EventLogPort,
  type HarnessAvailabilityPort,
  type HarnessInstallPort,
  type WebSocketLike as ServerSocketLike,
  type WebSocketServerLike,
} from "@actana/core/pty-core-link-server";
import { generateCertMaterial } from "@actana/shared/core-cert-material";
import { signBearer, verifyBearer } from "@actana/shared/core-link-bearer";
import type { CoreLinkEvent } from "@actana/sdk/core-link-frames.ts";

export const CORE_SECRET = "cli-in-process-core-secret-at-least-32-bytes";
export const CORE_ID = "core_in_process";

export type CertMaterial = Awaited<ReturnType<typeof generateCertMaterial>>;

/**
 * A PTY manager that is never asked for anything — the default when a suite
 * passes no `ptyCore` of its own.
 *
 * Every method throws rather than returning an empty: none of the verbs those
 * suites drive spawns anything, so a call reaching here means a change has
 * started a process on somebody's machine, and this should fail loudly instead
 * of quietly proving less. A suite that *does* mean to reach the PTY manager —
 * `in-process-core-session.test.ts` drives `logs`, `send` and `kill` against a
 * live PTY — passes {@link InProcessCoreOptions.ptyCore} and gets its own.
 */
export function unusedPtyCore(): never[] & Record<string, unknown> {
  const unreachable = (name: string) => () => {
    throw new Error(`a client verb reached the PTY manager (${name}) — these suites spawn nothing`);
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
  bound: { port: number; dropAll: () => void },
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
    // `terminate`, not `close`: the socket is destroyed with no close frame and
    // no handshake, which is what a network drop looks like to the Core — and
    // the only way the release-on-drop path (D7) can be reached from a test.
    bound.dropAll = () => {
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          /* already gone */
        }
      }
    };
    return {
      // Torn down the way a Core process being killed tears down, and in an
      // order that actually releases the port. `wss.close()` stops the upgrade
      // handler but leaves established TLS sockets alive, and an HTTPS server
      // with a live socket on it never finishes closing — so the sockets go
      // first, explicitly, and only then the listener. Anything less and a
      // restart on the same port is an `EADDRINUSE` instead of the reconnect
      // the suite meant to stage.
      close: (cb?: () => void) => {
        for (const client of wss.clients) {
          try {
            client.terminate();
          } catch {
            /* already gone */
          }
        }
        try {
          wss.close();
        } catch {
          /* already closed */
        }
        tlsServer.close(() => cb?.());
        tlsServer.closeAllConnections?.();
      },
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

export type InProcessCoreOptions = {
  /** Reuse a port (and material) to restart a Core a client is reconnecting to. */
  port?: number;
  material?: CertMaterial;
  protocolVersion?: string;
  bearerExpiresInMs?: number;
  /**
   * The PTY manager this Core drives, for a suite that means to reach one.
   *
   * `unknown` rather than the Core's own type: the Core takes it as `never`
   * through an internal interface this package deliberately does not import
   * (ADR 0025 D4 keeps `@actana/core` out of the manifest), and a suite's fake
   * implements the handful of methods its own verbs touch rather than all of
   * it. Defaults to {@link unusedPtyCore}, which throws on every method.
   */
  ptyCore?: unknown;
  eventLog?: EventLogPort;
  queryPort?: CoreQueryPort;
  mutationPort?: CoreMutationPort;
  directoryPort?: CoreDirectoryPort;
  execPort?: CoreExecPort;
  availabilityPort?: HarnessAvailabilityPort;
  installPort?: HarnessInstallPort;
  liveEventPollMs?: number;
};

export type InProcessCore = {
  server: PtyCoreLinkServer;
  port: number;
  endpoint: string;
  /** The base64 blob an operator would be handed for this Core. */
  blobText: string;
  material: CertMaterial;
  close: () => void;
  /**
   * Destroy every live core-link connection, leaving the Core running.
   *
   * The abrupt disconnect: no close frame, no `release`, nothing the client
   * chose. What the Core does next — drop that connection's Session locks (ADR
   * 0024 D7) — is the claim `session-attach-live.test.ts` exists to check.
   */
  dropConnections: () => void;
  /**
   * Close, and resolve once the port is genuinely free again.
   *
   * `close()` is enough for teardown and not enough for a restart: the
   * WebSocket server closes, then the HTTPS server under it closes, and both
   * are asynchronous — starting the replacement Core in between is an
   * `EADDRINUSE` rather than the restart the suite meant to stage. This waits
   * for the condition that actually matters by testing it.
   */
  stop: () => Promise<void>;
};

/** Start a Core on a real port and return the credential that reaches it. */
export async function startInProcessCore(opts: InProcessCoreOptions = {}): Promise<InProcessCore> {
  const material = opts.material ?? (await generateCertMaterial({ hosts: ["127.0.0.1"] }));
  const port = opts.port ?? (await freePort());
  const bound = { port: 0, dropAll: () => {} };
  const server = new PtyCoreLinkServer((opts.ptyCore ?? unusedPtyCore()) as never, {
    port,
    host: "127.0.0.1",
    createServer: recordingCreateServer(bound),
    tls: {
      caCert: material.ca.cert,
      serverCert: material.server.cert,
      serverKey: material.server.key,
    },
    authVerifier: (bearer: string) => verifyBearer(bearer, CORE_SECRET),
    ...(opts.protocolVersion === undefined ? {} : { protocolVersion: opts.protocolVersion }),
    ...(opts.eventLog === undefined ? {} : { eventLog: opts.eventLog }),
    ...(opts.queryPort === undefined ? {} : { queryPort: opts.queryPort }),
    ...(opts.mutationPort === undefined ? {} : { mutationPort: opts.mutationPort }),
    ...(opts.directoryPort === undefined ? {} : { directoryPort: opts.directoryPort }),
    ...(opts.execPort === undefined ? {} : { execPort: opts.execPort }),
    ...(opts.availabilityPort === undefined ? {} : { availabilityPort: opts.availabilityPort }),
    ...(opts.installPort === undefined ? {} : { installPort: opts.installPort }),
    ...(opts.liveEventPollMs === undefined ? {} : { liveEventPollMs: opts.liveEventPollMs }),
  });

  await waitFor(() => bound.port > 0, "the TLS server never bound");

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
        CORE_SECRET,
      ),
    }),
    "utf8",
  ).toString("base64");

  return {
    server,
    port: bound.port,
    endpoint,
    blobText,
    material,
    close: () => server.close(),
    dropConnections: () => bound.dropAll(),
    stop: async () => {
      server.close();
      await waitForPortFree(bound.port);
    },
  };
}

/** Can this port be bound right now? */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new Server();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

/** Wait until a port a Core has just released can be bound again. */
export async function waitForPortFree(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await portFree(port))) {
    if (Date.now() > deadline) throw new Error(`port ${port} never came free`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Poll a predicate until it holds, or fail with a sentence rather than a timeout. */
export async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * An event log in an array, satisfying the port the Core writes through.
 *
 * In memory rather than the real SQLite store because the object outlives the
 * Core that holds it — which is the whole trick behind the reconnect suite: stop
 * a Core, append to the log, start another on the same port, and the client
 * reconnecting finds exactly the events it missed.
 *
 * `tailReads` counts `subscribe` handling. It is how a test knows a client has
 * finished subscribing without reaching into the client, which matters because
 * an event appended before that point arrives in the replay rather than live —
 * a different path than the one under test.
 */
export type ArrayEventLog = EventLogPort & {
  /** Append an event as the Core's own machinery would, and return its id. */
  push: (kind: string, payload?: string) => number;
  events: CoreLinkEvent[];
  tailReads: number;
};

export function arrayEventLog(): ArrayEventLog {
  const events: CoreLinkEvent[] = [];
  const log: ArrayEventLog = {
    events,
    tailReads: 0,
    appendEvent: (kind, payload, opts) => {
      const event: CoreLinkEvent = {
        eventId: events.length + 1,
        ts: Date.now(),
        kind,
        ptyId: opts?.ptyId ?? null,
        taskId: opts?.taskId ?? null,
        payload,
      };
      events.push(event);
      return event.eventId;
    },
    readEventTail: (afterEventId, limit = 1_000) => {
      log.tailReads += 1;
      return events.filter((event) => event.eventId > afterEventId).slice(0, limit);
    },
    getLastEventId: () => (events.length === 0 ? 0 : events[events.length - 1]!.eventId),
    push: (kind, payload = "{}") => log.appendEvent(kind, payload),
  };
  return log;
}
