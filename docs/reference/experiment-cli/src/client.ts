// The transport: an authenticated core-link connection with request/response
// correlation and the three unsolicited streams (pty data, pty exit, events).

import WebSocket from "ws";

import { PROTOCOL_VERSION, RESULT_OF } from "./protocol.ts";
import type { Frame, RegistrationBlob } from "./protocol.ts";

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `AC_DEBUG=1` traces every frame and step, with a millisecond clock.
 *
 * A command that stops producing output tells you nothing about *where* it
 * stopped. This does: the last line printed is the last thing that happened.
 */
const DEBUG = Boolean(process.env.AC_DEBUG);
const started = Date.now();

export function trace(message: string): void {
  if (!DEBUG) return;
  const ms = String(Date.now() - started).padStart(6);
  console.error(`[${ms}ms] ${message}`);
}

/** Frames carry whole terminal screens; log the shape, not the payload. */
function summarise(frame: Record<string, unknown>): string {
  const parts: string[] = [];
  if (frame.reqId) parts.push(String(frame.reqId));
  if (frame.ptyId) parts.push(String(frame.ptyId));
  if (typeof frame.data === "string") parts.push(`${frame.data.length}B`);
  if (frame.message) parts.push(String(frame.message).slice(0, 80));
  return parts.join(" ");
}

type Pending = {
  resolve: (frame: Frame) => void;
  reject: (error: Error) => void;
  want: string;
  timer: NodeJS.Timeout;
};

export class CoreClient {
  ws: WebSocket;
  blob: RegistrationBlob;
  seq = 0;
  pending = new Map<string, Pending>();
  onData: ((ptyId: string, data: string) => void) | null = null;
  onExit: ((ptyId: string, code: number) => void) | null = null;
  onEvent: ((event: Record<string, unknown>) => void) | null = null;
  /** Set once the socket is gone, so later requests fail fast rather than
   *  waiting out a timeout against a socket nobody is reading. */
  closed = false;

  constructor(blob: RegistrationBlob) {
    this.blob = blob;
    // mTLS: the blob's CA is the trust root for the Core's server certificate,
    // and clientCert/clientKey are our identity. The Core sets requestCert and
    // rejectUnauthorized, so all three are mandatory.
    this.ws = new WebSocket(blob.endpoint, {
      ca: blob.caCert,
      cert: blob.clientCert,
      key: blob.clientKey,
      rejectUnauthorized: true,
    });
  }

  /**
   * Connect, then authenticate.
   *
   * `auth` MUST be the first frame sent: the Core answers anything else with
   * `not-authenticated` and closes the socket.
   */
  static async connect(blob: RegistrationBlob): Promise<CoreClient> {
    const client = new CoreClient(blob);
    const ws = client.ws;

    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", (err: Error) => reject(new Error(`connect failed: ${err.message}`)));
    });

    ws.on("message", (raw: Buffer) => client.dispatch(raw));

    // The Core keeps exactly one connection: `onConnection` closes the previous
    // socket when a new client connects. So a Panel pointed at the same Core
    // will evict this process the moment it reconnects, and anything sent after
    // that is discarded by a socket the server has already closed — silently,
    // because `ws.send()` on a closing socket does not throw. Without this the
    // symptom is a command that pauses and then dies on a request timeout with
    // no indication why.
    const failPending = (reason: string) => {
      client.closed = true;
      const err = new Error(reason);
      for (const [reqId, waiter] of client.pending) {
        clearTimeout(waiter.timer);
        client.pending.delete(reqId);
        waiter.reject(err);
      }
    };
    ws.on("close", (code: number) => {
      trace(`socket closed by the Core (code ${code})`);
      failPending(
        `the Core closed the connection (code ${code}). It accepts one client at a time, ` +
          `so a Panel or another core-client pointed at the same Core will have taken it over. ` +
          `Close the Panel on this Core, or use a different Core, and retry.`,
      );
    });
    ws.on("error", (err: Error) => {
      trace(`socket error: ${err.message}`);
      failPending(`connection lost: ${err.message}`);
    });

    const authReqId = `auth-${++client.seq}`;
    const authed = new Promise<Frame>((resolve, reject) => {
      client.pending.set(authReqId, {
        resolve,
        reject,
        want: "authOk",
        timer: setTimeout(() => reject(new Error("auth timed out")), 30_000),
      });
    });
    ws.send(JSON.stringify({ type: "auth", reqId: authReqId, bearer: blob.bearer }));
    await authed;
    return client;
  }

  dispatch(raw: Buffer): void {
    let frame: Frame;
    try {
      frame = JSON.parse(String(raw)) as Frame;
    } catch {
      trace(`<- unparseable frame, ${raw.length}B`);
      return;
    }
    trace(`<- ${frame.type} ${summarise(frame as Record<string, unknown>)}`);

    // Unsolicited frames: correlated by ptyId, or by nothing at all.
    switch (frame.type) {
      case "ready": {
        const version = String(frame.version);
        // major.minor equality is the compatibility rule; the Core never rejects.
        const theirs = version.split(".").slice(0, 2).join(".");
        const ours = PROTOCOL_VERSION.split(".").slice(0, 2).join(".");
        if (theirs !== ours) {
          console.error(`[warn] Core speaks core-link ${version}, this client targets ${PROTOCOL_VERSION}`);
        }
        return;
      }
      case "data":
        this.onData?.(String(frame.ptyId), String(frame.data));
        return;
      case "exit":
        this.onExit?.(String(frame.ptyId), Number(frame.exitCode));
        return;
      case "event":
        this.onEvent?.(frame.event as Record<string, unknown>);
        return;
      case "eventsReplayed":
        return;
    }

    const reqId = frame.reqId;
    if (!reqId) return;
    const waiter = this.pending.get(reqId);
    if (!waiter) return;

    if (frame.type === waiter.want) {
      clearTimeout(waiter.timer);
      this.pending.delete(reqId);
      waiter.resolve(frame);
      return;
    }
    // spawnError / authError / error all land on the same reqId.
    if (frame.type === "error" || frame.type === "spawnError" || frame.type === "authError") {
      clearTimeout(waiter.timer);
      this.pending.delete(reqId);
      waiter.reject(new Error(String(frame.message ?? frame.reason ?? frame.type)));
    }
  }

  /** Send a request and resolve with the whole answering frame. */
  request(type: string, body: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<Frame> {
    const spec = RESULT_OF[type];
    if (!spec) throw new Error(`unknown request type: ${type}`);
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(
        `cannot send ${type}: the connection to the Core is gone. It accepts one client at a time — ` +
          `a Panel on the same Core will have taken it over.`,
      );
    }
    const reqId = `r${++this.seq}`;
    const done = new Promise<Frame>((resolve, reject) => {
      this.pending.set(reqId, {
        resolve,
        reject,
        want: spec.type,
        timer: setTimeout(() => {
          this.pending.delete(reqId);
          reject(new Error(`${type} timed out after ${timeoutMs}ms`));
        }, timeoutMs),
      });
    });
    trace(`-> ${type} ${reqId} (want ${spec.type})`);
    this.ws.send(JSON.stringify({ ...body, type, reqId }));
    return done;
  }

  /** The request's payload field, for calls with one obvious answer. */
  async call<T>(type: string, body: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const frame = await this.request(type, body, timeoutMs);
    const field = RESULT_OF[type].field;
    return (field ? frame[field] : frame) as T;
  }

  /** Events only flow after this. */
  subscribe(lastEventId = 0): Promise<Frame> {
    return this.request("subscribe", { lastEventId });
  }

  close(): void {
    trace(`closing (${this.pending.size} request(s) still outstanding)`);
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
    // A socket the Core never finishes closing keeps Node's event loop alive,
    // so a command that has already done its work sits there looking hung.
    // Nothing is outstanding by this point — the connection is not worth
    // waiting on.
    const hard = setTimeout(() => {
      trace("close handshake did not complete — terminating the socket");
      this.ws.terminate();
    }, 1_000);
    hard.unref();
  }
}
