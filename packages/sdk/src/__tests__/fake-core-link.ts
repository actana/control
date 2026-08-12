// Test rig for the Core client suites: a real Core server on one end of a
// socket, this package's client on the other.
//
// **The server here is the Core's own `PtyCoreLinkServer`, not a stand-in.** A
// hand-rolled fake would answer whatever the client expects, which is exactly
// the agreement worth testing — the auth gate that closes a connection on a
// pre-auth frame, the `ready` frame that arrives before anything is asked for,
// the fan-out that sends a PTY's bytes only to the connections that subscribed.
// The Panel's core-link suites are wired the same way, and the only thing faked
// below is the socket between the two and the PTY manager behind the server.

import { vi } from "vitest";
import type {
  CoreMutationPort,
  EventLogPort,
  WebSocketLike as ServerSocketLike,
  WebSocketServerLike,
} from "@actana/core/pty-core-link-server";
import { PtyCoreLinkServer } from "@actana/core/pty-core-link-server";
import type { PtyCore, PtyCoreEvent } from "@actana/core/pty-manager";
import type { CoreLinkEvent } from "../core-link-frames";
import type { CoreLinkSocket, CoreLinkSocketFactory } from "../core-link-socket";

type Listener = (...args: unknown[]) => void;

/**
 * One end of a connected pair. `send` delivers to the peer's message listeners;
 * `receive` injects an inbound message without recording it as sent, so a test
 * can tell "what I wrote" from "what I was told".
 */
export class FakeSocket {
  readyState = 0;
  sent: string[] = [];
  pings = 0;
  terminated = false;
  /** Set to arm the heartbeat: the transport only pings a socket that can. */
  pingable = false;
  peer: FakeSocket | null = null;
  private listeners: Record<string, Listener[]> = {};
  /**
   * Frames that arrived before anything was listening for them.
   *
   * A real socket holds bytes until the application reads them, and this rig
   * needs the same: the Core writes `ready` the instant it accepts a connection
   * — before the client on the other end has been constructed, in a test that
   * stands the server up first — and a frame dropped there would make the Core's
   * defining unsolicited-first behaviour untestable.
   */
  private buffered: unknown[] = [];

  send(data: string): void {
    this.sent.push(data);
    this.peer?.emit("message", data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
    if (this.peer && this.peer.readyState !== 3) {
      this.peer.readyState = 3;
      this.peer.emit("close");
    }
  }

  on(event: string, cb: Listener): void {
    (this.listeners[event] ??= []).push(cb);
    if (event === "message" && this.buffered.length > 0) {
      const held = this.buffered;
      this.buffered = [];
      for (const data of held) cb(data);
    }
  }

  removeAllListeners(): void {
    this.listeners = {};
  }

  emit(event: string, ...args: unknown[]): void {
    const listeners = this.listeners[event] ?? [];
    if (event === "message" && listeners.length === 0) {
      this.buffered.push(args[0]);
      return;
    }
    for (const cb of [...listeners]) cb(...args);
  }

  /** Simulate an inbound frame from the peer, unrecorded. */
  receive(obj: unknown): void {
    this.emit("message", typeof obj === "string" ? obj : JSON.stringify(obj));
  }

  /** Every frame this side wrote, parsed. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }

  /** Every frame of one type this side wrote, parsed. */
  framesOfType(type: string): Array<Record<string, unknown>> {
    return this.frames().filter((f) => f.type === type);
  }

  /** The last frame this side wrote, or null. */
  lastSent(): Record<string, unknown> | null {
    const raw = this.sent[this.sent.length - 1];
    return raw === undefined ? null : (JSON.parse(raw) as Record<string, unknown>);
  }

  /** The client-side view of this socket, as the SDK's transport wants it. */
  asClientSocket(): CoreLinkSocket {
    const socket = {
      send: (data: string) => this.send(data),
      close: () => this.close(),
      on: (event: string, cb: Listener) => this.on(event, cb),
    } as unknown as CoreLinkSocket;
    // A live getter rather than a number copied at wiring time: `readyState`
    // moves under the transport's feet as the socket opens and closes.
    Object.defineProperty(socket, "readyState", { get: () => this.readyState });
    if (this.pingable) {
      socket.ping = () => {
        this.pings++;
      };
      socket.terminate = () => {
        this.terminated = true;
        this.close();
      };
    }
    return socket;
  }

  /** Answer a ping, the way a live peer's engine would. */
  pong(): void {
    this.emit("pong");
  }
}

export class FakeSocketPair {
  readonly server = new FakeSocket();
  readonly client = new FakeSocket();

  constructor(opts: { pingable?: boolean } = {}) {
    this.server.peer = this.client;
    this.client.peer = this.server;
    this.client.pingable = opts.pingable === true;
  }

  /** Complete the handshake on both ends. */
  open(): void {
    this.client.readyState = 1;
    this.server.readyState = 1;
    this.client.emit("open");
    this.server.emit("open");
  }
}

/** A `WebSocketServer` that hands the Core server whichever socket a test says. */
export class FakeSocketServer {
  private connCb: ((ws: ServerSocketLike) => void) | null = null;

  accept(socket: FakeSocket): void {
    this.connCb?.(socket as unknown as ServerSocketLike);
  }

  close(cb?: () => void): void {
    cb?.();
  }

  on(event: string, cb: (...args: unknown[]) => void): void {
    if (event === "connection") this.connCb = cb as (ws: ServerSocketLike) => void;
  }
}

/** The PTY manager the Core server drives. Enough of it to answer the RPCs. */
export function makeMockPtyCore(): PtyCore & { emitEvent: (e: PtyCoreEvent) => void } {
  const core: Record<string, unknown> = {
    setEmitTarget: vi.fn((fn: ((event: PtyCoreEvent) => void) | null) => {
      core._emit = fn;
    }),
    spawn: vi.fn(async () => ({ ptyId: "pty-1" })),
    write: vi.fn(() => true),
    resize: vi.fn(() => true),
    kill: vi.fn(() => true),
    killLaunchProcesses: vi.fn(async () => ({ ptyCount: 0, ports: [] })),
    killPtysUnderPath: vi.fn(async () => ({ ptyCount: 0 })),
    findByTask: vi.fn(() => ({ ptyId: "pty-1" })),
    // Which Session a `write`/`kill` would touch — the lookup the Core's
    // Session-lock gate resolves a ptyId through. Null: nothing here claims a
    // Session, so every one it touches is unlocked and served.
    taskIdForPty: vi.fn(() => null),
    replay: vi.fn(() => ({ data: "scrollback", nextSeq: 7 })),
    killAll: vi.fn(),
    _emit: null,
    emitEvent: (e: PtyCoreEvent) => {
      (core._emit as ((e: PtyCoreEvent) => void) | null)?.(e);
    },
  };
  return core as unknown as PtyCore & { emitEvent: (e: PtyCoreEvent) => void };
}

/** An in-memory event log — the port the Core's SQLite implements for real. */
export class FakeEventLog implements EventLogPort {
  readonly events: CoreLinkEvent[] = [];
  private seq = 0;

  appendEvent(
    kind: string,
    payload: string,
    opts: { ptyId?: string | null; taskId?: string | null } = {},
  ): number {
    const eventId = ++this.seq;
    this.events.push({
      eventId,
      ts: 1_700_000_000_000 + eventId,
      kind,
      ptyId: opts.ptyId ?? null,
      taskId: opts.taskId ?? null,
      payload,
    });
    return eventId;
  }

  readEventTail(afterEventId: number, limit = 1000): CoreLinkEvent[] {
    return this.events.filter((e) => e.eventId > afterEventId).slice(0, limit);
  }

  getLastEventId(): number {
    return this.seq;
  }
}

export type CoreRig = {
  server: PtyCoreLinkServer;
  ptyCore: ReturnType<typeof makeMockPtyCore>;
  eventLog: FakeEventLog;
  wss: FakeSocketServer;
  /**
   * A socket factory to hand a client: every dial is a fresh connection this
   * Core accepts, so a reconnect is a real second connection with its own
   * `ready`, its own auth and its own subscription state — which is the whole of
   * what makes the durable client's reconnect worth testing.
   *
   * The pairs are kept in dial order, so a test can read what went over the wire
   * on connection one after connection two has replaced it.
   */
  dialer(opts?: { pingable?: boolean }): {
    createSocket: CoreLinkSocketFactory;
    pairs: FakeSocketPair[];
    last(): FakeSocketPair;
  };
  close(): void;
};

/**
 * Stand up a real Core server over fake sockets.
 *
 * `authVerifier` is what makes a rig behave like a *remote* Core — the auth gate
 * that refuses every frame before `auth` and closes the socket. Omit it for the
 * loopback shape, where `auth` is a no-op.
 */
export function startCoreRig(
  opts: {
    authVerifier?: (bearer: string) =>
      | { ok: true; coreId: string; exp: number }
      | { ok: false; reason: "expired" | "bad-signature" | "malformed" };
    announceMultiConnection?: boolean;
    protocolVersion?: string;
    liveEventPollMs?: number;
    /** Wire one to exercise the Core's own thrown-mutation → `error` frame path. */
    mutationPort?: CoreMutationPort;
  } = {},
): CoreRig {
  const ptyCore = makeMockPtyCore();
  const eventLog = new FakeEventLog();
  const wss = new FakeSocketServer();
  const server = new PtyCoreLinkServer(ptyCore, {
    port: 0,
    createServer: () => wss as unknown as WebSocketServerLike,
    eventLog,
    liveEventPollMs: opts.liveEventPollMs ?? 10,
    ...(opts.authVerifier ? { authVerifier: opts.authVerifier } : {}),
    ...(opts.mutationPort ? { mutationPort: opts.mutationPort } : {}),
    ...(opts.announceMultiConnection === undefined
      ? {}
      : { announceMultiConnection: opts.announceMultiConnection }),
    ...(opts.protocolVersion ? { protocolVersion: opts.protocolVersion } : {}),
  });
  return {
    server,
    ptyCore,
    eventLog,
    wss,
    dialer: ({ pingable = false } = {}) => {
      const pairs: FakeSocketPair[] = [];
      const createSocket: CoreLinkSocketFactory = () => {
        const pair = new FakeSocketPair({ pingable });
        pairs.push(pair);
        // The Core accepts and writes `ready` before the dialer has wired a
        // single listener — the client end buffers it, exactly as a real socket
        // holds bytes nobody has read yet.
        wss.accept(pair.server);
        // The handshake completes a tick later, so the transport is fully wired
        // before `open` fires and its `auth` frame goes out.
        queueMicrotask(() => pair.open());
        return pair.client.asClientSocket();
      };
      return {
        createSocket,
        pairs,
        last: () => {
          const pair = pairs[pairs.length - 1];
          if (!pair) throw new Error("nothing dialed yet");
          return pair;
        },
      };
    },
    close: () => server.close(),
  };
}
