// One core link, from the client's side of it: one socket, one Core.
//
// Extracted from the Panel's `PtyCoreLinkClient` (issue 153, #129 D1/D2/D6) —
// which was `packages/panel/src/server/core-link/client.ts`, deleted in #156 when
// the Panel moved onto this package, so this is where that code lives now.
// That class did four separable jobs at once — frame the wire, correlate
// requests, keep a link alive across drops, and expose a typed API. This module
// is the first of those two: **the machinery of one connection**, with no
// opinion about what happens when it ends.
//
// Everything that outlives a socket lives above it: `CoreClient` owns the typed
// methods and the outbound queue, and `DurableCoreClient` owns reconnection.
// One transport is one socket's whole life, which is what makes the difference
// between the two entry points a difference in *who re-opens*, rather than two
// implementations of a wire.
//
// Three things about this protocol shape the code below, and each has cost
// somebody a debugging session:
//
//   1. **The Core speaks first, unsolicited.** `ready` is frame one on every
//      connection and answers no request — a transport that treats the first
//      inbound message as a response to something it sent waits forever. It is
//      surfaced as {@link CoreLinkTransportHandlers.onReady}.
//   2. **`auth` must be the first frame sent**, or the Core answers
//      `not-authenticated` and closes the socket. So nothing else may go out on
//      open: a subscribe, a reclaim, a caller's RPC all queue behind it, and the
//      transport does not report itself {@link CoreLinkTransport.writable} until
//      `authOk` lands.
//   3. **`data` and `exit` arrive unsolicited too**, carrying a `ptyId` and no
//      `reqId`. They are surfaced as frames, parsed once, here — a caller that
//      re-parses a raw message is a caller that will disagree with this one.

import type {
  CoreLinkEvent,
  CoreLinkRequestFrame,
  CoreLinkResponseFrame,
  CoreLinkStreamFrame,
} from "./core-link-frames.ts";
import type { CoreLinkSocket, CoreLinkSocketFactory } from "./core-link-socket.ts";

/** The Core's opening frame on every connection — protocol version, capability. */
export type CoreLinkReadyFrame = Extract<CoreLinkResponseFrame, { type: "ready" }>;
/** One PTY's bytes. Unsolicited; keyed by `ptyId`; carries a `seq`. */
export type CoreLinkDataFrame = Extract<CoreLinkStreamFrame, { type: "data" }>;
/** A PTY's exit. Unsolicited; keyed by `ptyId`. */
export type CoreLinkExitFrame = Extract<CoreLinkStreamFrame, { type: "exit" }>;
/** The Core accepted this connection's bearer. */
export type CoreLinkAuthOkFrame = Extract<CoreLinkResponseFrame, { type: "authOk" }>;
/** The Core refused this connection's bearer, and is about to close the socket. */
export type CoreLinkAuthErrorFrame = Extract<CoreLinkResponseFrame, { type: "authError" }>;
/** Why the Core refused a bearer. */
export type CoreLinkAuthErrorReason = CoreLinkAuthErrorFrame["reason"];

/**
 * What a transport tells its owner. Every one is optional and none may throw
 * anything the transport is expected to survive — a listener's failure must not
 * take a connection down, so each is called inside a guard.
 */
export type CoreLinkTransportHandlers = {
  /** The socket is open. Nothing has been authenticated yet. */
  onOpen?: () => void;
  /**
   * The transport may now be written to: the socket is open and, when a bearer
   * was configured, the Core has accepted it. This is where an owner sends the
   * frames a fresh connection owes — `reclaim`, `subscribe`, a re-subscription
   * — and they go out ahead of whatever the owner had queued.
   */
  onWritable?: () => void;
  /** Frame one, on every connection (see this module's header). */
  onReady?: (frame: CoreLinkReadyFrame) => void;
  /** One PTY's bytes, parsed once, here. */
  onData?: (frame: CoreLinkDataFrame) => void;
  /** One PTY's exit, parsed once, here. */
  onExit?: (frame: CoreLinkExitFrame) => void;
  /** One event off the Core's monotonic log — replayed or live, same frame. */
  onEvent?: (event: CoreLinkEvent) => void;
  /** End of the `subscribe` replay tail; live push resumes after it. */
  onEventsReplayed?: (lastEventId: number) => void;
  onAuthOk?: (frame: CoreLinkAuthOkFrame) => void;
  onAuthError?: (reason: CoreLinkAuthErrorReason) => void;
  /**
   * The socket is gone, with the reason the `error` event carried if it carried
   * one. In-flight requests have already been rejected by the time this runs.
   */
  onClose?: (reason?: string) => void;
};

export type CoreLinkHeartbeatOptions = {
  /** Ping cadence. Default {@link DEFAULT_HEARTBEAT_INTERVAL_MS}. */
  intervalMs?: number;
  /** Declare the peer dead after this long with no frame. Default {@link DEFAULT_HEARTBEAT_TIMEOUT_MS}. */
  timeoutMs?: number;
};

export type CoreLinkTransportOptions = {
  /** The URL to dial. Reported back on errors; the factory is what opens it. */
  url: string;
  /** How to open the socket. See {@link CoreLinkSocketFactory}. */
  createSocket: CoreLinkSocketFactory;
  /**
   * The signed bearer `{coreId, exp, sig}` from the registration blob (ADR
   * 0002), presented in the `auth` frame the instant the socket opens. Every
   * real Core requires one — there is no trusted transport left to omit it on
   * (ADR 0010). Omitted, the transport is writable as soon as the socket opens,
   * which is the loopback rig and the test.
   */
  bearer?: string | null;
  /**
   * Arm the heartbeat on this connection. Off by default, and deliberately so:
   * a one-shot client that connects, asks and exits has nothing to keep alive,
   * and the durable entry point turns it on because a link that must survive an
   * idle hour is the case it exists for (#129 D6).
   *
   * Only a socket that can actually send a ping participates — see
   * {@link CoreLinkSocket.ping}.
   */
  heartbeat?: CoreLinkHeartbeatOptions | false;
  handlers?: CoreLinkTransportHandlers;
};

/**
 * Heartbeat cadence. A remote Core's core link runs over the open internet, so
 * it crosses NATs and stateful firewalls that silently drop idle flows — an
 * agent sitting at its prompt sends nothing for minutes, which is exactly the
 * traffic pattern those boxes reap. Without a heartbeat the drop is invisible:
 * TCP has no keepalive here, so the client keeps believing it is connected,
 * keystrokes are written into a dead socket, and requests hang for their full
 * timeout while the Core happily streams output nobody receives. Pinging every
 * 15s keeps the flow alive AND detects death within one window.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
/** Declare the peer dead after this long with no frame of any kind (3 pings). */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;

/** The message a request rejects with when its socket died before the answer. */
export const CONNECTION_LOST_MESSAGE = "core-link connection lost";

type Pending = {
  resolve: (frame: CoreLinkResponseFrame) => void;
  reject: (err: Error) => void;
};

/**
 * One core-link connection. Constructed open-ended: the socket is dialed
 * immediately, and the handlers passed in are the only way anything gets out of
 * it. Not reusable — a transport is one socket, and a client that wants another
 * builds another.
 */
export class CoreLinkTransport {
  private readonly handlers: CoreLinkTransportHandlers;
  private readonly bearer: string | null;
  private readonly heartbeatOpts: CoreLinkHeartbeatOptions | null;
  private socket: CoreLinkSocket | null = null;
  private reqSeq = 0;
  private readonly pending = new Map<string, Pending>();
  private opened = false;
  private authenticated = false;
  private disposed = false;
  /** The reason the socket died, off the `error` event, for the close report. */
  private lastError: string | undefined;
  private ready: CoreLinkReadyFrame | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Epoch ms of the last frame received (message OR pong) on this connection. */
  private lastInboundAt = 0;
  /** Injectable clock so a fake-timer test can drive the heartbeat. */
  private readonly now: () => number = () => Date.now();

  constructor(opts: CoreLinkTransportOptions) {
    this.handlers = opts.handlers ?? {};
    this.bearer = opts.bearer ?? null;
    this.heartbeatOpts = opts.heartbeat === false ? null : (opts.heartbeat ?? null);
    let socket: CoreLinkSocket;
    try {
      socket = opts.createSocket(opts.url);
    } catch (err) {
      // A factory that throws — a malformed URL, a TLS material the runtime
      // refuses — is a connection that closed before it opened, reported on the
      // one channel an owner is already listening to.
      this.disposed = true;
      const reason = err instanceof Error ? err.message : String(err);
      queueMicrotask(() => this.guard(() => this.handlers.onClose?.(reason)));
      return;
    }
    this.socket = socket;
    this.wire(socket);
  }

  private wire(socket: CoreLinkSocket): void {
    socket.on("open", () => {
      if (this.disposed) return;
      this.opened = true;
      this.authenticated = false;
      this.startHeartbeat(socket);
      this.guard(() => this.handlers.onOpen?.());
      // The auth frame, first, before anything else this transport or its owner
      // wants to say. See this module's header, trap 2.
      if (this.bearer) {
        this.write({ type: "auth", reqId: this.nextReqId("auth"), bearer: this.bearer });
      } else {
        this.guard(() => this.handlers.onWritable?.());
      }
    });

    socket.on("message", (raw) => {
      this.lastInboundAt = this.now();
      this.onMessage(raw);
    });

    // Pong frames prove the peer is alive during an idle stretch. Only the Node
    // `ws` transport surfaces them; a browser WebSocket answers pings in the
    // engine and never tells us, which is why the heartbeat only arms where
    // `ping` exists at all.
    socket.on("pong", () => {
      this.lastInboundAt = this.now();
    });

    socket.on("error", (err) => {
      // The close handler drives everything; errors are ordinary during a Core
      // restart. All that is kept is the reason, so the close report can say
      // something better than "it closed" — a TLS rejection and an
      // ECONNREFUSED both arrive here and then close silently.
      this.lastError = err instanceof Error ? err.message : String(err);
    });

    socket.on("close", () => {
      const wasDisposed = this.disposed;
      this.opened = false;
      this.authenticated = false;
      this.stopHeartbeat();
      // Every request written to this socket can never be answered now, so
      // failing them here is the difference between a caller retrying at once
      // and one waiting out its full timeout first.
      this.rejectAll(CONNECTION_LOST_MESSAGE);
      this.socket = null;
      if (wasDisposed) return;
      this.disposed = true;
      this.guard(() => this.handlers.onClose?.(this.lastError));
    });
  }

  /** True while this connection can carry a frame — open, and authenticated if it must be. */
  get writable(): boolean {
    return !this.disposed && this.opened && (this.bearer === null || this.authenticated);
  }

  /** True once the Core has accepted this connection's bearer. */
  get isAuthenticated(): boolean {
    return this.authenticated;
  }

  /** This connection's `ready` frame, or null before it lands. */
  get readyFrame(): CoreLinkReadyFrame | null {
    return this.ready;
  }

  /**
   * Send a request frame and resolve with the Core's answer — **frames both
   * ways**, errors included, because a router forwarding on behalf of somebody
   * else needs the frame rather than an exception (that is the Panel's shape,
   * and `CoreClient` is what turns a failure frame into a rejection).
   *
   * The `reqId` on the frame passed in is ignored: this transport owns
   * correlation on its own socket and returns the frame carrying the id it
   * assigned. Rejects if the socket dies before the answer arrives; never times
   * out on its own — a deadline is the caller's policy, and the caller above
   * this one has one.
   */
  request(frame: CoreLinkRequestFrame): Promise<CoreLinkResponseFrame> {
    if (!this.writable) return Promise.reject(new Error(CONNECTION_LOST_MESSAGE));
    const reqId = this.nextReqId("r");
    return new Promise<CoreLinkResponseFrame>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      if (!this.write({ ...frame, reqId } as CoreLinkRequestFrame)) {
        this.pending.delete(reqId);
        reject(new Error(CONNECTION_LOST_MESSAGE));
      }
    });
  }

  /**
   * Send a frame and forget it. For the frames whose answer is a *stream* rather
   * than a response — `subscribe`, whose reply is the replay tail and the
   * `eventsReplayed` marker — and for the ones nothing waits on by design.
   * Returns the assigned `reqId`, or null when the transport could not take it.
   */
  send(frame: CoreLinkRequestFrame, reqIdPrefix = "s"): string | null {
    if (!this.writable) return null;
    const reqId = this.nextReqId(reqIdPrefix);
    return this.write({ ...frame, reqId } as CoreLinkRequestFrame) ? reqId : null;
  }

  /** Hang up. Idempotent; fires no `onClose`, because this is not the Core going away. */
  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopHeartbeat();
    this.rejectAll("core-link client closed");
    const socket = this.socket;
    this.socket = null;
    this.opened = false;
    this.authenticated = false;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* best effort — the socket is going away either way */
      }
    }
  }

  private nextReqId(prefix: string): string {
    return `${prefix}${++this.reqSeq}`;
  }

  private write(frame: CoreLinkRequestFrame): boolean {
    const socket = this.socket;
    if (!socket || !this.opened) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      // The close handler takes it from here — it is the one place that fails
      // in-flight requests and tells the owner.
      return false;
    }
  }

  private onMessage(raw: unknown): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;

    switch (msg.type) {
      // ─── The three unsolicited streams ───
      case "ready": {
        // Kept as the frame rather than picked apart: the version gate and the
        // `multiConnection` capability are both read off it upstairs, and a
        // transport that pre-digested it would have to grow a field per
        // capability the `ready` frame ever gains.
        this.ready = {
          type: "ready",
          version: typeof msg.version === "string" ? msg.version : "",
          ...(msg.multiConnection !== undefined
            ? { multiConnection: msg.multiConnection as CoreLinkReadyFrame["multiConnection"] }
            : {}),
        };
        this.guard(() => this.handlers.onReady?.(this.ready!));
        return;
      }
      case "data": {
        const ptyId = typeof msg.ptyId === "string" ? msg.ptyId : "";
        if (!ptyId) return;
        const frame: CoreLinkDataFrame = {
          type: "data",
          ptyId,
          data: typeof msg.data === "string" ? msg.data : "",
          seq: typeof msg.seq === "number" ? msg.seq : 0,
        };
        this.guard(() => this.handlers.onData?.(frame));
        return;
      }
      case "exit": {
        const ptyId = typeof msg.ptyId === "string" ? msg.ptyId : "";
        if (!ptyId) return;
        const frame: CoreLinkExitFrame = {
          type: "exit",
          ptyId,
          exitCode: typeof msg.exitCode === "number" ? msg.exitCode : 0,
          ...(typeof msg.signal === "number" ? { signal: msg.signal } : {}),
        };
        this.guard(() => this.handlers.onExit?.(frame));
        return;
      }

      // ─── The event log ───
      case "event": {
        const event = parseEvent(msg.event);
        if (!event) return;
        this.guard(() => this.handlers.onEvent?.(event));
        return;
      }
      case "eventsReplayed": {
        const lastEventId = typeof msg.lastEventId === "number" ? msg.lastEventId : 0;
        this.guard(() => this.handlers.onEventsReplayed?.(lastEventId));
        return;
      }
      case "subscribeAck":
        // Informational — the event stream and its `eventsReplayed` marker
        // follow, and they are what a subscriber is waiting for.
        return;

      // ─── Bearer auth ───
      case "authOk": {
        this.authenticated = true;
        const frame: CoreLinkAuthOkFrame = {
          type: "authOk",
          reqId: typeof msg.reqId === "string" ? msg.reqId : "",
          coreId: typeof msg.coreId === "string" ? msg.coreId : "",
          exp: typeof msg.exp === "number" ? msg.exp : 0,
        };
        // The owner's turn first: a fresh connection owes the Core a `reclaim`
        // and a `subscribe`, and both must precede whatever requests were
        // waiting for this socket, so the replay tail arrives before the
        // answers to them.
        this.guard(() => this.handlers.onAuthOk?.(frame));
        this.guard(() => this.handlers.onWritable?.());
        return;
      }
      case "authError": {
        const reason: CoreLinkAuthErrorReason =
          msg.reason === "expired" || msg.reason === "bad-signature" || msg.reason === "malformed"
            ? msg.reason
            : "malformed";
        this.authenticated = false;
        this.guard(() => this.handlers.onAuthError?.(reason));
        // The Core closes the socket right after this frame; the close handler
        // is what reports the connection's end. An expired bearer keeps failing
        // until a reissued blob is pasted — that is the designed "reissuing is a
        // machine-side operation" property (ADR 0003).
        return;
      }
      default:
        break;
    }

    // ─── Everything else is an answer, correlated by reqId ───
    const reqId = typeof msg.reqId === "string" ? msg.reqId : null;
    if (!reqId) return;
    const pending = this.pending.get(reqId);
    if (!pending) return;
    this.pending.delete(reqId);
    pending.resolve(msg as unknown as CoreLinkResponseFrame);
  }

  private rejectAll(reason: string): void {
    if (this.pending.size === 0) return;
    const err = new Error(reason);
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(err);
  }

  /**
   * Arm the heartbeat for a freshly opened socket. Only a transport that can
   * actually send a ping participates; a socket without one is left alone
   * rather than being torn down for failing to answer pings nobody sent.
   */
  private startHeartbeat(socket: CoreLinkSocket): void {
    this.stopHeartbeat();
    if (!this.heartbeatOpts || !socket.ping) return;
    const intervalMs = this.heartbeatOpts.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const timeoutMs = this.heartbeatOpts.timeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.lastInboundAt = this.now();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket) {
        this.stopHeartbeat();
        return;
      }
      if (this.now() - this.lastInboundAt > timeoutMs) {
        // Half-open: the peer stopped answering. A graceful close would wait for
        // a FIN that is never coming, so destroy the socket and let the close
        // handler run the ordinary path.
        this.stopHeartbeat();
        try {
          socket.terminate ? socket.terminate() : socket.close();
        } catch {
          /* already gone — the close handler still fires */
        }
        return;
      }
      try {
        socket.ping?.();
      } catch {
        /* the close handler will take it from here */
      }
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Run an owner's callback. A listener that throws must not take the
   * connection with it — half the callbacks here run inside a socket event, and
   * an exception escaping one of those is an unhandled rejection at best and a
   * connection stuck half-established at worst.
   */
  private guard(fn: () => void): void {
    try {
      fn();
    } catch {
      /* a listener's failure is not this connection's failure */
    }
  }
}

/**
 * Read an `event` frame's payload into a {@link CoreLinkEvent}, or null.
 *
 * Field-by-field rather than a cast, because this is the one frame whose body
 * is a nested object from another process's database: an `eventId` that is
 * missing or zero would silently corrupt the cursor that decides what gets
 * replayed after the next reconnect, so it is the one field whose absence
 * rejects the frame outright.
 */
function parseEvent(raw: unknown): CoreLinkEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const eventId = typeof e.eventId === "number" ? e.eventId : NaN;
  if (!Number.isFinite(eventId) || eventId <= 0) return null;
  return {
    eventId,
    ts: typeof e.ts === "number" ? e.ts : 0,
    kind: typeof e.kind === "string" ? e.kind : "",
    ptyId: typeof e.ptyId === "string" ? e.ptyId : null,
    taskId: typeof e.taskId === "string" ? e.taskId : null,
    payload: typeof e.payload === "string" ? e.payload : "{}",
  };
}
