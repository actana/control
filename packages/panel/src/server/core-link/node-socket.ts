// Node-side core-link socket factory — dials a Harness's `wss://` core-link
// with mutual TLS (ADR 0002).
//
// A Core requires mTLS with a pinned client cert + CA, which the browser
// WebSocket API cannot provide (Chromium uses the OS cert store, not
// per-connection certs). That is why the SERVICE dials, not the browser: it
// uses Node's `ws` package, passing `ca`/`cert`/`key` straight to TLS, and
// forwards the frames to each tab over the panel link (ADR 0012).
//
// This factory returns the transport-agnostic `WebSocketLike` the
// `PtyCoreLinkClient` expects, so one client class drives both this and the
// plain WebSocket the tests use.
//
// Panel service only.

import type { WebSocket as WsWebSocket } from "ws";
import type { WebSocketLike } from "./client";

export type NodeTlsOptions = {
  /** PEM CA cert that signed the Harness server cert. Pinned by the client. */
  ca: string;
  /** PEM client cert presented to the Harness in the mTLS handshake. */
  cert: string;
  /** PEM private key for {@link NodeTlsOptions.cert}. */
  key: string;
};

/**
 * Dial a `ws://` or `wss://` core-link from the Panel service. When
 * `tls` is provided, the `wss://` handshake pins the Harness's CA and presents
 * the Panel's client cert (mTLS). `rejectUnauthorized: true` rejects unknown
 * CAs — a fake Harness presenting any other cert never gets past the handshake.
 */
export function createNodeCoreLinkSocket(url: string, tls?: NodeTlsOptions): WebSocketLike {
  // Lazy require so this module imports cleanly in tests without `ws`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { WebSocket } = require("ws") as typeof import("ws");
  // `noDelay` disables Nagle. A terminal is the pathological case for it:
  // keystrokes and agent output are tiny writes, and coalescing them behind
  // the peer's delayed ACK adds tens of ms of jitter to every character. `ws`
  // supports the option (and defaults it to true) but the shipped types don't
  // declare it yet, hence the widened local type — stating it explicitly keeps
  // the behaviour pinned if that default ever changes.
  type SocketOptions = import("ws").ClientOptions & { noDelay?: boolean };
  const options: SocketOptions = tls
    ? { ca: tls.ca, cert: tls.cert, key: tls.key, rejectUnauthorized: true, noDelay: true }
    : { noDelay: true };
  const ws: WsWebSocket = new WebSocket(url, options as import("ws").ClientOptions);
  return adaptNodeWs(ws);
}

function adaptNodeWs(ws: WsWebSocket): WebSocketLike {
  return {
    get readyState() {
      return ws.readyState;
    },
    send: (data: string) => ws.send(data),
    close: () => ws.close(),
    // Heartbeat surface (see PtyCoreLinkClient): a remote core-link crosses
    // NATs/firewalls that silently reap idle flows, and an agent parked at its
    // prompt is idle for minutes at a time. Ping keeps the flow warm; pong
    // proves liveness; terminate tears down a half-open socket that would
    // never complete a graceful close.
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
