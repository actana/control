// The socket under a core link, and the Node dial that opens one.
//
// Extracted from the Panel's `core-link/node-socket.ts` and the `WebSocketLike`
// interface that lived in its client (issue 153, #129 D1). The client is
// transport-agnostic on purpose: {@link CoreLinkSocket} is the whole of what
// {@link CoreLinkTransport} needs, so one transport drives the real `wss://`
// dial below, a loopback `ws://`, and an in-memory pair in a test.
//
// A Core requires mutual TLS with a pinned client cert + CA (ADR 0002), which
// no browser WebSocket can present — Chromium uses the OS cert store, not
// per-connection certs. That is why a Core client is a Node program: it dials
// with the `ws` package, handing `ca`/`cert`/`key` straight to TLS. The Panel
// terminates its links in its service for exactly this reason (ADR 0012), and
// the `actana` CLI is a Node process for the same one.
//
// This module is the only place in the SDK that imports `ws`, so a consumer
// that brings its own socket (a test, a runtime with a different WebSocket)
// never has to.

import { WebSocket as NodeWebSocket } from "ws";

/**
 * The socket surface a core link needs. A subset of both the `ws` client and
 * the platform `WebSocket`, plus the two Node-only affordances the heartbeat is
 * built on — see {@link CoreLinkSocket.ping} and
 * {@link CoreLinkSocket.terminate}.
 */
export interface CoreLinkSocket {
  /** `0` connecting, `1` open, `2` closing, `3` closed — the WebSocket values. */
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "open", cb: () => void): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  /**
   * Pong frames (Node `ws` only). A transport registers for them
   * unconditionally; an adapter that has no pongs to report simply drops the
   * registration, which is correct — a browser engine answers pings itself and
   * never surfaces them.
   */
  on(event: "pong", cb: () => void): void;
  /**
   * Send a WS ping frame. Present on the Node (`ws`) transport a Core client
   * dials with; absent on a plain browser WebSocket. **Its presence is what
   * arms the heartbeat** — see {@link CoreLinkTransport}.
   */
  ping?: () => void;
  /**
   * Destroy the socket immediately, with no close handshake. Used when the
   * heartbeat declares the peer dead: a half-open TCP connection will never
   * complete a graceful close, so waiting for one only extends the outage.
   */
  terminate?: () => void;
}

/** A socket factory. The seam every test and every exotic runtime goes through. */
export type CoreLinkSocketFactory = (url: string) => CoreLinkSocket;

/** The PEM material a `wss://` core link is dialed with (ADR 0002). */
export type CoreLinkTlsMaterial = {
  /** PEM CA cert that signed the Core's server cert. Pinned by the client. */
  ca: string;
  /** PEM client cert presented to the Core in the mTLS handshake. */
  cert: string;
  /** PEM private key for {@link CoreLinkTlsMaterial.cert}. */
  key: string;
};

/**
 * Dial a `ws://` or `wss://` core link from a Node process. With `tls` the
 * `wss://` handshake pins the Core's CA and presents the client cert (mTLS);
 * `rejectUnauthorized: true` refuses an unknown CA, so a fake Core presenting
 * any other cert never gets past the handshake.
 */
export function createNodeCoreLinkSocket(url: string, tls?: CoreLinkTlsMaterial): CoreLinkSocket {
  // `noDelay` disables Nagle. A terminal is the pathological case for it:
  // keystrokes and agent output are tiny writes, and coalescing them behind the
  // peer's delayed ACK adds tens of ms of jitter to every character. `ws`
  // supports the option (and defaults it to true) but the shipped types don't
  // declare it yet, hence the widened local type — stating it explicitly keeps
  // the behaviour pinned if that default ever changes.
  type SocketOptions = import("ws").ClientOptions & { noDelay?: boolean };
  const options: SocketOptions = tls
    ? { ca: tls.ca, cert: tls.cert, key: tls.key, rejectUnauthorized: true, noDelay: true }
    : { noDelay: true };
  const ws = new NodeWebSocket(url, options as import("ws").ClientOptions);
  return adaptNodeWs(ws);
}

function adaptNodeWs(ws: import("ws").WebSocket): CoreLinkSocket {
  return {
    get readyState() {
      return ws.readyState;
    },
    send: (data: string) => ws.send(data),
    close: () => ws.close(),
    // The heartbeat surface (see CoreLinkTransport): a remote core link crosses
    // NATs and firewalls that silently reap idle flows, and an agent parked at
    // its prompt is idle for minutes at a time. Ping keeps the flow warm; pong
    // proves liveness; terminate tears down a half-open socket that would never
    // complete a graceful close.
    ping: () => {
      try {
        ws.ping();
      } catch {
        /* socket already closing — the close handler covers it */
      }
    },
    terminate: () => ws.terminate(),
    on: (event, cb) => {
      if (event === "open") {
        ws.on("open", () => (cb as () => void)());
      } else if (event === "message") {
        ws.on("message", (data: unknown) => (cb as (data: unknown) => void)(data));
      } else if (event === "close") {
        ws.on("close", () => (cb as () => void)());
      } else if (event === "error") {
        ws.on("error", (err: Error) => (cb as (err: Error) => void)(err));
      } else if (event === "pong") {
        ws.on("pong", () => (cb as () => void)());
      }
    },
  };
}
