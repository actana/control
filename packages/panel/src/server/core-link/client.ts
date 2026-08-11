// WebSocket client for one Core's core-link — the Panel service side.
//
// Connects to that Core's `wss://` server and exposes a `pty` API
// (spawn/write/resize/kill/replay/findByTask/onData/onExit) that the panel-link
// router forwards browser frames onto.
//
// Reconnection: the service holds one client per registered Core. If the
// WebSocket drops (Core restart, machine asleep), the client auto-reconnects
// with backoff. On reconnect `ready` fires and callers reattach via
// `findByTask` + `replay` — the Core's PTY buffer retains everything across
// the gap.

import {
  CORE_LINK_PROTOCOL_VERSION,
  coreLinkProtocolCompatible,
  readMultiConnectionCapability,
  type CoreLinkMultiConnectionCapability,
  type CoreLinkSessionTakenFrom,
  type CoreLinkHarnessAvailabilityMap,
  type CoreLinkEvent,
  type CoreLinkProjectMutation,
  type CoreLinkRequestFrame,
  type CoreLinkResponseFrame,
  type CoreLinkStreamFrame,
  type CoreLinkPtySpawnOptions,
  type CoreLinkProjectSnapshot,
  type CoreLinkSessionSnapshot,
  type CoreLinkTaskMutation,
  type CoreLinkTaskSnapshot,
  type CoreLinkLaunchProcessKillResult,
  type CoreLinkPtyReplay,
} from "../../../../shared/src/core-link-frames";

/**
 * Request frames that only mean anything against a Core announcing
 * `multiConnection` on `ready` (ADR 0024 D11) — the one list
 * {@link PtyCoreLinkClient.canSendMultiConnectionFrames} guards.
 *
 * `ptySubscribe` / `ptyUnsubscribe` (issue 142, D2) are the first entries: a
 * Core that fans a PTY out per subscription is exactly a multi-connection Core,
 * and one that never announced the capability has no subscription list to put a
 * PTY on. The Session lock's `claim` / `release` / `forceTakeover` (issue 144,
 * D3–D7) joined them for the same reason in its own key: a single-connection
 * Core has no lock table to address, because it evicts every client but one and
 * therefore has nothing for a lock to arbitrate between.
 *
 * Being in this set is not the whole story for a frame with a caller that has
 * something better to do than fail. A caller that can degrade consults
 * {@link PtyCoreLinkClient.canSendMultiConnectionFrames} and takes the
 * single-connection route itself — see {@link PtyCoreLinkClient.ptySubscribe}
 * and {@link PtyCoreLinkClient.claim}, which both do exactly that. The rejection
 * below is the backstop for callers that ask without checking, not the designed
 * path for the frames listed here.
 *
 * **The set gates only frames that flow through {@link PtyCoreLinkClient.request}
 * / `rpc()`**, which is where the check lives — `sendSubscribe()`, `sendAuth()`
 * and the reconnect queue drain build frames and write to the socket directly,
 * and no entry here would stop them. So "add the type to this set" is the whole
 * wiring step for an RPC frame, and only for an RPC frame.
 */
export const MULTI_CONNECTION_ONLY_FRAME_TYPES: ReadonlySet<CoreLinkRequestFrame["type"]> =
  new Set<CoreLinkRequestFrame["type"]>([
    "ptySubscribe",
    "ptyUnsubscribe",
    "claim",
    "release",
    "forceTakeover",
  ]);

export type PtyCoreLinkClientHandlers = {
  onData: (msg: { ptyId: string; data: string; seq: number }) => void;
  onExit: (msg: { ptyId: string; exitCode: number; signal?: number }) => void;
};

/** A localStorage-like store for persisting the per-Core lastEventId cursor. */
export interface CoreLinkCursorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type PtyCoreLinkClientOptions = {
  /** The WebSocket URL to dial (e.g. `ws://127.0.0.1:5174` or `wss://host:443`). */
  url: string;
  /** Injectable socket factory (tests). Default: the browser's native WebSocket. */
  createSocket?: (url: string) => WebSocketLike;
  /** Reconnect backoff (ms). Default: 500 initial, 5000 max. */
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  /**
   * Injectable storage for the per-Core `lastEventId` cursor. Default: the
   * global `localStorage` when available. When unavailable (the service's own
   * Node process, tests), a no-op store is used and the cursor is kept
   * in-memory for the session — replay still works across reconnects within
   * that process, just not across a restart.
   */
  storage?: CoreLinkCursorStorage;
  /** localStorage key under which the lastEventId cursor is persisted. */
  cursorStorageKey?: string;
  /**
   * Signed bearer `{coreId, exp, sig}` presented in the `auth` frame right
   * after every (re)connect (ADR 0002). Required for every Core — there is no
   * trusted transport left to omit it on (ADR 0010). When set, the client sends
   * `auth` BEFORE `subscribe` so the Core gates the event-cursor replay
   * behind authentication.
   */
  bearer?: string;
  /**
   * Overrides {@link MULTI_CONNECTION_ONLY_FRAME_TYPES}. Exists only so a test
   * can drive the rejection in {@link PtyCoreLinkClient.request} with a
   * stand-in frame type: the real entries both degrade at their call sites
   * rather than reach that backstop, so nothing in this build exercises it.
   * Production never passes it.
   */
  multiConnectionOnlyFrameTypes?: ReadonlySet<string>;
};

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "open", cb: () => void): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  /**
   * Pong frames (Node `ws` only). The browser transport ignores this
   * registration — its `on` adapter drops unknown events — which is correct:
   * the browser engine answers pings itself and never surfaces them.
   */
  on(event: "pong", cb: () => void): void;
  removeEventListener?: (event: string, cb: (...args: unknown[]) => void) => void;
  /**
   * Send a WS ping frame. Present on the Node (`ws`) transport the service
   * dials with; absent on a plain browser WebSocket. Its presence is what arms
   * the heartbeat — see {@link PtyCoreLinkClient}.
   */
  ping?: () => void;
  /**
   * Destroy the socket immediately without a close handshake. Used when the
   * heartbeat declares the peer dead: a half-open TCP connection will never
   * complete a graceful close, so waiting for one just extends the outage.
   */
  terminate?: () => void;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_RECONNECT_INITIAL_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 5_000;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
/**
 * Heartbeat cadence. A remote Core's core-link runs over the open internet, so
 * it crosses NATs and stateful firewalls that silently drop idle flows — an
 * agent sitting at its prompt sends nothing for minutes, which is exactly the
 * traffic pattern those boxes reap. Without a heartbeat the drop is invisible:
 * TCP has no keepalive here, so the Panel keeps `ready = true`, keystrokes are
 * written into a dead socket, and RPCs hang for the full 30s timeout while the
 * Core happily streams output nobody receives. Pinging every 15s keeps the
 * flow alive AND detects death within one window.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;
/** Declare the peer dead after this long with no frame of any kind (3 pings). */
const HEARTBEAT_TIMEOUT_MS = 45_000;
const DEFAULT_CURSOR_STORAGE_KEY = "mc.coreLink.lastEventId";

/**
 * A no-op cursor store used when `localStorage` is unavailable (the service's
 * own Node process, tests). The cursor still advances in-memory for the
 * session, so replay works across reconnects within one process — just not
 * across a restart.
 */
class NullCursorStorage implements CoreLinkCursorStorage {
  getItem(): string | null {
    return null;
  }
  setItem(): void {
    /* no-op */
  }
}

function resolveStorage(opts: PtyCoreLinkClientOptions): CoreLinkCursorStorage {
  if (opts.storage) return opts.storage;
  // `localStorage` exists only where this client runs in a browser. It is
  // absent in the service's Node process and in tests — degrade to a null store
  // instead of throwing on construction.
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch {
    /* access throws in some sandbox contexts */
  }
  return new NullCursorStorage();
}

/**
 * Panel-side core-link client. One instance per Core the service holds a link
 * to. Auto-reconnects; exposes a promise-based + callback API.
 *
 * On every (re)connect it sends a `subscribe` frame carrying the persisted
 * `lastEventId` cursor so the Core can stream the event-log tail; live
 * `event` frames resume once `eventsReplayed` is received. The cursor is
 * persisted to the injected storage so killing the Panel and reopening it
 * restores the full event/task timeline from the gap.
 */
export class PtyCoreLinkClient {
  private readonly url: string;
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly storage: CoreLinkCursorStorage;
  private readonly cursorStorageKey: string;
  private readonly bearer: string | null;
  private socket: WebSocketLike | null = null;
  private reqSeq = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly dataListeners = new Set<(msg: { ptyId: string; data: string; seq: number }) => void>();
  private readonly exitListeners = new Set<(msg: { ptyId: string; exitCode: number; signal?: number }) => void>();
  private readonly eventListeners = new Set<(msg: { event: CoreLinkEvent }) => void>();
  private readonly eventsReplayedListeners = new Set<(msg: { lastEventId: number }) => void>();
  private readonly authOkListeners = new Set<(msg: { coreId: string; exp: number }) => void>();
  private readonly authErrorListeners = new Set<(msg: { reason: "expired" | "bad-signature" | "malformed" }) => void>();
  private readonly disconnectedListeners = new Set<(msg: { error?: string }) => void>();
  private readonly protocolVersionListeners = new Set<
    (msg: { version: string | null; compatible: boolean }) => void
  >();
  /** The protocol version from this connection's `ready` frame; null before it. */
  private protocolVersion: string | null = null;
  /**
   * This Core's `multiConnection` capability, as announced on the current
   * connection's `ready` frame; null when absent and before `ready` lands.
   *
   * Per Core because there is one client per registered Core, and re-read on
   * every `ready` rather than remembered across connections: a Core can be
   * downgraded, and a stale `true` here would send frames the Core no longer
   * understands. Null until the frame arrives, so the gate below is closed
   * during the window where the answer is genuinely unknown.
   */
  private multiConnection: CoreLinkMultiConnectionCapability | null = null;
  private readonly multiConnectionOnlyFrameTypes: ReadonlySet<string>;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private ready = false;
  private readonly queuedFrames: CoreLinkRequestFrame[] = [];
  /** In-memory mirror of the persisted cursor; updated on every event/replay. */
  private lastEventId = 0;
  private subscribed = false;
  /**
   * The PTYs this link has asked the Core for (issue 142). PTY output fans out
   * by subscription now, so this set is the difference between a pane that
   * renders and one that sits blank — and it is connection state on the Core,
   * which means it does not survive a reconnect. The client re-sends it on
   * every open; nothing above it has to know the socket ever dropped.
   */
  private readonly subscribedPtys = new Set<string>();
  /** True once the server has accepted this connection's `auth` frame. */
  private authenticated = false;
  /** Heartbeat timer; non-null only while a ping-capable socket is open. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Epoch ms of the last frame received (message OR pong) on this connection. */
  private lastInboundAt = 0;
  /**
   * reqIds actually written to the current socket. A frame still sitting in
   * `queuedFrames` has not been sent and stays queued across a reconnect; one
   * that went out on a connection that then died will never be answered, so it
   * is rejected the moment the socket closes rather than hanging for 30s.
   */
  private readonly inFlight = new Set<string>();

  constructor(opts: PtyCoreLinkClientOptions) {
    this.url = opts.url;
    this.createSocket = opts.createSocket ?? defaultCreateSocket;
    this.reconnectInitialMs = opts.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.storage = resolveStorage(opts);
    this.bearer = opts.bearer ?? null;
    this.multiConnectionOnlyFrameTypes =
      opts.multiConnectionOnlyFrameTypes ?? MULTI_CONNECTION_ONLY_FRAME_TYPES;
    // The cursor is per-Core (CONTEXT.md "Event cursor": "the single number
    // the Panel stores per Core"). Derive the storage key from the core-link
    // URL so each registered Core gets its own cursor — a second Core on a
    // different endpoint never shares or corrupts this Core's replay position.
    // An explicit `cursorStorageKey` (tests) overrides the derivation.
    this.cursorStorageKey =
      opts.cursorStorageKey ?? `${DEFAULT_CURSOR_STORAGE_KEY}.${deriveCoreKey(this.url)}`;
    this.lastEventId = this.readPersistedCursor();
    this.connect();
  }

  private readPersistedCursor(): number {
    try {
      const raw = this.storage.getItem(this.cursorStorageKey);
      const n = raw == null ? NaN : Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  private persistCursor(): void {
    try {
      this.storage.setItem(this.cursorStorageKey, String(this.lastEventId));
    } catch {
      /* storage unavailable — keep the in-memory value */
    }
  }

  private connect(): void {
    if (this.closed) return;
    let socket: WebSocketLike;
    try {
      socket = this.createSocket(this.url);
    } catch (err) {
      this.emitDisconnected(err instanceof Error ? err.message : String(err));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    // The reason the socket died, captured from the `error` event so the close
    // handler can report something better than "it closed" (TLS handshake
    // rejections and ECONNREFUSED both arrive here, then close silently).
    let lastError: string | undefined;

    socket.on("open", () => {
      this.reconnectAttempt = 0;
      this.ready = true;
      this.startHeartbeat(socket);
      // Reset per-connection auth state — every (re)connect must re-present
      // the bearer after the mTLS handshake (ADR 0002). The server gates the
      // event-cursor replay behind authentication, so `subscribe` is sent
      // AFTER `auth` (or immediately when no bearer is configured, which only
      // happens in tests — a real Core always presents one).
      this.authenticated = false;
      this.subscribed = false;
      // Forget the previous connection's capability: this one re-announces it
      // on its own `ready`, and the Core on the other end may have been
      // downgraded while we were away.
      this.multiConnection = null;
      if (this.bearer) {
        this.sendAuth();
      } else {
        // No bearer configured (tests) — go straight to the event-cursor
        // subscribe so the Core streams the replay tail. The PTY resend does
        // NOT go here: the capability is not known until this connection's
        // `ready` lands, and a resend that reads "unknown" takes the
        // single-connection fallback and unsubscribes every held pane. It is
        // driven from the `ready` handler instead, which is the earliest point
        // the answer exists.
        this.sendSubscribe();
      }
      // Flush any RPCs that were queued while the WS wasn't open (e.g. the
      // first pty.* call after a reconnect, before the WS handshake
      // completed). Sent after `auth`/`subscribe` so the replay tail is
      // delivered before the RPC responses.
      const queued = this.queuedFrames.splice(0);
      for (const frame of queued) {
        try {
          this.socket!.send(JSON.stringify(frame));
        } catch {
          /* will be handled by the close handler */
        }
      }
    });

    socket.on("message", (raw) => {
      this.lastInboundAt = Date.now();
      this.onMessage(raw);
    });

    // Pong frames prove the peer is alive during an idle stretch (an agent
    // waiting at its prompt emits nothing for minutes). Only the Node `ws`
    // transport surfaces them; a browser WebSocket answers pings in the engine
    // and never tells us, which is why the heartbeat only arms on `ws`.
    socket.on("pong", () => {
      this.lastInboundAt = Date.now();
    });

    socket.on("close", () => {
      this.ready = false;
      this.subscribed = false;
      this.authenticated = false;
      // Forget the capability the moment the link drops, not when the next one
      // opens. Between those two points the answer is unknown, and a stale
      // `true` would let a gated frame past `canSendMultiConnectionFrames()`
      // onto `queuedFrames`, which the reopen drain writes to the socket
      // unconditionally — before the new `ready` says whether it is allowed.
      this.multiConnection = null;
      this.stopHeartbeat();
      this.rejectInFlight("core-link connection lost");
      if (this.closed) return;
      this.emitDisconnected(lastError);
      this.scheduleReconnect();
    });

    socket.on("error", (err) => {
      // The close handler will trigger reconnect. Errors are expected during
      // a Core restart — we only keep the reason for the status report.
      lastError = err instanceof Error ? err.message : String(err);
    });
  }

  /**
   * Arm the heartbeat for a freshly opened socket. Only transports that can
   * actually send a ping participate (the Node `ws` client the service dials
   * with); a browser WebSocket has no ping API.
   */
  private startHeartbeat(socket: WebSocketLike): void {
    this.stopHeartbeat();
    if (!socket.ping) return;
    this.lastInboundAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket) {
        this.stopHeartbeat();
        return;
      }
      if (Date.now() - this.lastInboundAt > HEARTBEAT_TIMEOUT_MS) {
        // Half-open: the peer stopped answering. A graceful close would wait
        // for a FIN that is never coming, so destroy the socket and let the
        // close handler run the normal reconnect path.
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
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Fail every RPC that was written to the socket that just died. Their replies
   * can never arrive, so leaving them pending only makes the UI wait out the
   * full RPC timeout before it can retry on the new connection.
   */
  private rejectInFlight(reason: string): void {
    if (this.inFlight.size === 0) return;
    for (const reqId of this.inFlight) {
      const pending = this.pending.get(reqId);
      if (!pending) continue;
      this.pending.delete(reqId);
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.inFlight.clear();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(
      this.reconnectInitialMs * Math.pow(2, this.reconnectAttempt),
      this.reconnectMaxMs,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private onMessage(raw: unknown): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;
    const type = msg.type;

    // Stream frames (no reqId — pushed to listeners).
    if (type === "data") {
      const ptyId = typeof msg.ptyId === "string" ? msg.ptyId : "";
      const data = typeof msg.data === "string" ? msg.data : "";
      const seq = typeof msg.seq === "number" ? msg.seq : 0;
      if (ptyId) {
        const payload = { ptyId, data, seq };
        for (const cb of this.dataListeners) cb(payload);
      }
      return;
    }
    if (type === "exit") {
      const ptyId = typeof msg.ptyId === "string" ? msg.ptyId : "";
      const exitCode = typeof msg.exitCode === "number" ? msg.exitCode : 0;
      const signal = typeof msg.signal === "number" ? msg.signal : undefined;
      if (ptyId) {
        const payload = { ptyId, exitCode, signal };
        for (const cb of this.exitListeners) cb(payload);
      }
      return;
    }

    // Event-cursor frames (issue 02). `event` carries a CoreLinkEvent from the
    // Core's monotonic event log; `eventsReplayed` marks end-of-tail. Both
    // advance the persisted lastEventId cursor so a kill+reopen restores the
    // missed timeline.
    if (type === "event") {
      const event = this.parseEvent(msg);
      if (!event) return;
      // Dedupe: skip events at or below the cursor (a late duplicate from a
      // replay overlap, or a re-delivery after reconnect).
      if (event.eventId <= this.lastEventId) return;
      this.lastEventId = event.eventId;
      this.persistCursor();
      for (const cb of this.eventListeners) cb({ event });
      return;
    }
    if (type === "eventsReplayed") {
      const lastEventId = typeof msg.lastEventId === "number" ? msg.lastEventId : this.lastEventId;
      // The marker is authoritative for the caught-up cursor: advance even if
      // no individual event frames preceded it (empty tail).
      if (lastEventId > this.lastEventId) {
        this.lastEventId = lastEventId;
        this.persistCursor();
      }
      this.subscribed = true;
      for (const cb of this.eventsReplayedListeners) cb({ lastEventId: this.lastEventId });
      return;
    }
    // The Core's first frame on every connection: which core-link it
    // speaks. The version gate (issue 07) hangs off this — a Core whose
    // vocabulary this build doesn't share is a chore to report, not a
    // connection to half-use (ADR 0005). Emitted on every `ready`, so a Core
    // that reconnects after an update flips back to compatible with no extra
    // plumbing.
    if (type === "ready") {
      this.protocolVersion = typeof msg.version === "string" ? msg.version : null;
      // Record the capability for this connection (ADR 0024 D11). Absent is a
      // Core like any other — it does not touch `compatible` below, so nothing
      // downstream can turn a missing capability into "needs update".
      this.multiConnection = readMultiConnectionCapability(msg.multiConnection);
      // With a bearer, the PTY resend waits for `authOk` — the Core refuses a
      // pre-auth `ptySubscribe`. Without one there is no `authOk` coming, and
      // this frame is the first moment the capability is known, so the resend
      // belongs here. Either way it runs after the capability, never before.
      if (!this.bearer) this.resendPtySubscriptions();
      const payload = {
        version: this.protocolVersion,
        compatible: coreLinkProtocolCompatible(this.protocolVersion),
      };
      for (const cb of this.protocolVersionListeners) cb(payload);
      return;
    }
    if (type === "subscribeAck") {
      // Informational — the event stream + eventsReplayed follow. Nothing to do.
      return;
    }

    // ─── Bearer auth frames (issue 04) ───
    if (type === "authOk") {
      const coreId = typeof msg.coreId === "string" ? msg.coreId : "";
      const exp = typeof msg.exp === "number" ? msg.exp : 0;
      this.authenticated = true;
      // Now that the Core has accepted the bearer, send the event-cursor
      // `subscribe` so the replay tail + live events flow. Auth came first, so
      // the server's auth gate lets the subscribe through.
      this.subscribed = false;
      this.sendSubscribe();
      // PTY subscriptions die with the Core-side connection, so they are
      // re-established here — after `auth`, for the same reason `subscribe` is:
      // the Core refuses a pre-auth `ptySubscribe`. This is also after `ready`,
      // which the Core sends as frame one on every connection, so the
      // capability the resend is gated on is already recorded. That ordering is
      // load-bearing rather than incidental — see the test that pins it.
      this.resendPtySubscriptions();
      for (const cb of this.authOkListeners) cb({ coreId, exp });
      return;
    }
    if (type === "authError") {
      const reason =
        msg.reason === "expired" || msg.reason === "bad-signature" || msg.reason === "malformed"
          ? msg.reason
          : "malformed";
      this.authenticated = false;
      for (const cb of this.authErrorListeners) cb({ reason });
      // The server closes on auth failure; the close handler triggers the
      // reconnect path. If the bearer is expired it will keep failing until a
      // reissued blob is pasted — that's the designed "reissuing is a VM-side
      // operation" property (ADR 0003).
      return;
    }

    // Response frames (correlated by reqId).
    const reqId = typeof msg.reqId === "string" ? msg.reqId : null;
    if (reqId) {
      const pending = this.pending.get(reqId);
      if (pending) {
        this.pending.delete(reqId);
        this.inFlight.delete(reqId);
        clearTimeout(pending.timer);
        pending.resolve(msg as CoreLinkResponseFrame);
        return;
      }
    }
  }

  private rpc(frame: CoreLinkRequestFrame, timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<unknown> {
    return this.request(frame, timeoutMs).then((response) => unwrapResponse(response));
  }

  /**
   * Send any core-link request frame and resolve with the Core's raw
   * response frame — errors included, as frames rather than rejections.
   *
   * This is the seam the panel-link router forwards through. A router that had
   * to go through the typed methods above would have to unwrap each response
   * only to re-wrap it, and would have to invent a shape for the failures the
   * typed methods turn into rejections. Handing it the frame keeps the Panel a
   * router rather than a translator.
   *
   * The `reqId` on the frame passed in is ignored — this client owns request
   * correlation on its own socket, and the returned frame carries the reqId it
   * assigned. Callers who need to match an answer to a caller (the router does,
   * across many browsers) key on their own id and rewrite it on the way back.
   */
  request(
    frame: CoreLinkRequestFrame,
    timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  ): Promise<CoreLinkResponseFrame> {
    if (this.closed) return Promise.reject(new Error("core-link client closed"));
    // The gate (ADR 0024 D11). A multi-connection-only frame aimed at a Core
    // that never announced the capability is refused here, before a reqId is
    // allocated and before anything reaches the socket — the Core never sees
    // it, so there is no error frame to tolerate. The rejection is for the
    // caller that asked without checking; the supported path is to consult
    // `canSendMultiConnectionFrames()` and take the single-connection route.
    if (this.multiConnectionOnlyFrameTypes.has(frame.type) && !this.canSendMultiConnectionFrames()) {
      return Promise.reject(
        new Error(
          `core-link frame ${frame.type} needs the multiConnection capability, which this Core does not announce`,
        ),
      );
    }
    const reqId = `r${++this.reqSeq}`;
    const framed = { ...frame, reqId } as CoreLinkRequestFrame;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        this.inFlight.delete(reqId);
        reject(new Error(`core-link rpc ${framed.type} timed out`));
      }, timeoutMs);
      this.pending.set(reqId, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.trySend(framed);
    });
  }

  private trySend(frame: CoreLinkRequestFrame): void {
    if (this.closed) {
      const reqId = (frame as { reqId?: string }).reqId;
      if (reqId) {
        const pending = this.pending.get(reqId);
        if (pending) {
          this.pending.delete(reqId);
          clearTimeout(pending.timer);
          pending.reject(new Error("core-link client closed"));
        }
      }
      return;
    }
    if (!this.socket || !this.ready) {
      // The WS isn't open yet (Core still booting, or reconnecting after a
      // drop). The frame is already registered in `pending` with a timeout —
      // it will be sent once `on("open")` fires and flushes the queue, or it
      // will time out. This avoids a hard rejection on the first call after a
      // reconnect, which used to break ptyReplay.
      this.queuedFrames.push(frame);
      return;
    }
    try {
      this.socket.send(JSON.stringify(frame));
      const reqId = (frame as { reqId?: string }).reqId;
      if (reqId) this.inFlight.add(reqId);
    } catch {
      // The close handler will trigger reconnect.
    }
  }

  /**
   * Send the `subscribe` frame carrying the persisted `lastEventId` cursor.
   * Called on every (re)connect so the Core streams the event-log tail the
   * Panel missed while away. Fire-and-forget — the response is the `event`
   * stream + `eventsReplayed` marker (handled in {@link onMessage}), not a
   * reqId-correlated RPC.
   */
  private sendSubscribe(): void {
    const reqId = `sub-${++this.reqSeq}`;
    const frame: CoreLinkRequestFrame = {
      type: "subscribe",
      reqId,
      lastEventId: this.lastEventId,
    };
    if (!this.socket || !this.ready) {
      this.queuedFrames.unshift(frame);
      return;
    }
    try {
      this.socket.send(JSON.stringify(frame));
    } catch {
      // The close handler will reconnect; the next open re-sends subscribe.
    }
  }

  /**
   * Send the `auth` frame carrying the bearer. Called on every (re)connect
   * after the mTLS handshake. Fire-and-forget — the response is `authOk` /
   * `authError` (handled in {@link onMessage}), not a reqId-correlated RPC.
   * The `subscribe` frame follows only after `authOk`, so the Core's auth
   * gate lets the event-cursor replay through.
   */
  private sendAuth(): void {
    if (!this.bearer) return;
    const reqId = `auth-${++this.reqSeq}`;
    const frame: CoreLinkRequestFrame = { type: "auth", reqId, bearer: this.bearer };
    if (!this.socket || !this.ready) {
      this.queuedFrames.unshift(frame);
      return;
    }
    try {
      this.socket.send(JSON.stringify(frame));
    } catch {
      // The close handler will reconnect; the next open re-sends auth.
    }
  }

  /**
   * Notified once per (re)connect when the Core accepts the bearer. `{ exp }`
   * is the session expiry — the Panel can hint "session expires at". The event
   * replay (`subscribe`) is sent automatically right after.
   */
  onAuthOk(cb: (msg: { coreId: string; exp: number }) => void): () => void {
    this.authOkListeners.add(cb);
    return () => this.authOkListeners.delete(cb);
  }

  /**
   * Notified when the Core rejects the bearer (expired / bad signature).
   * The server closes on rejection; the reconnect path takes over. An expired
   * bearer will keep failing until a reissued blob is pasted (ADR 0003).
   */
  onAuthError(
    cb: (msg: { reason: "expired" | "bad-signature" | "malformed" }) => void,
  ): () => void {
    this.authErrorListeners.add(cb);
    return () => this.authErrorListeners.delete(cb);
  }

  /**
   * Notified whenever the socket goes down — a dropped connection, a Core
   * restart, a dial that never completed. Fires on every attempt, so a Core
   * that is simply off shows as unreachable rather than sitting at
   * "connecting" for as long as the backoff runs. `close()` does not fire it:
   * that is the Panel hanging up, not the Core going away.
   */
  onDisconnected(cb: (msg: { error?: string }) => void): () => void {
    this.disconnectedListeners.add(cb);
    return () => this.disconnectedListeners.delete(cb);
  }

  /**
   * Notified on every connection's `ready` frame with the protocol version the
   * Core advertises and whether this build can speak it. The manager turns
   * an incompatible answer into the Core's "needs update" dial state.
   */
  onProtocolVersion(
    cb: (msg: { version: string | null; compatible: boolean }) => void,
  ): () => void {
    this.protocolVersionListeners.add(cb);
    return () => this.protocolVersionListeners.delete(cb);
  }

  /**
   * May this Core be sent frames that only a multi-connection Core understands
   * — the Session lock's `claim`, the per-connection PTY subscription, and
   * whatever else lands under ADR 0024?
   *
   * **The one predicate to consult before sending any such frame.** False means
   * do not send it: not send-and-handle-the-error, not send-and-hope. The Core
   * on the other end is a single-connection build that would answer an unknown
   * frame with an error frame at best, and the caller is expected to have a
   * single-connection path already — that path is what shipped before this
   * capability existed.
   *
   * False before `ready` lands and after a drop, for as long as the answer is
   * unknown. A caller that needs the capability at startup waits for
   * {@link onProtocolVersion} rather than reading this on the first tick.
   */
  canSendMultiConnectionFrames(): boolean {
    return this.multiConnection !== null;
  }

  /**
   * This connection's `multiConnection` capability, or null. For callers that
   * need the version rather than the yes/no — the gate is
   * {@link canSendMultiConnectionFrames}.
   */
  multiConnectionCapability(): CoreLinkMultiConnectionCapability | null {
    return this.multiConnection;
  }

  private emitDisconnected(error?: string): void {
    for (const cb of this.disconnectedListeners) cb({ error });
  }

  /** True once the server has accepted this connection's `auth` frame. */
  isAuthenticated(): boolean {
    return this.authenticated;
  }

  /** Parse and validate an `event` frame's `event` field into a CoreLinkEvent. */
  private parseEvent(msg: Record<string, unknown>): CoreLinkEvent | null {
    const raw = msg.event;
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

  // ─── Public API ─────────────────────────────────────────────────────────

  spawn(opts: CoreLinkPtySpawnOptions): Promise<{ ptyId: string }> {
    return this.rpc({ type: "spawn", reqId: "", opts }) as Promise<{ ptyId: string }>;
  }

  write(ptyId: string, data: string): Promise<boolean> {
    return this.rpc({ type: "write", reqId: "", ptyId, data }) as Promise<boolean>;
  }

  resize(ptyId: string, cols: number, rows: number): Promise<boolean> {
    return this.rpc({ type: "resize", reqId: "", ptyId, cols, rows }) as Promise<boolean>;
  }

  kill(ptyId: string): Promise<boolean> {
    return this.rpc({ type: "kill", reqId: "", ptyId }) as Promise<boolean>;
  }

  killLaunchProcesses(opts: {
    cwd: string;
    commands: string[];
    ports?: number[];
  }): Promise<CoreLinkLaunchProcessKillResult> {
    return this.rpc({
      type: "killLaunchProcesses",
      reqId: "",
      cwd: opts.cwd,
      commands: opts.commands,
      ports: opts.ports,
    }) as Promise<CoreLinkLaunchProcessKillResult>;
  }

  findByTask(taskId: string): Promise<{ ptyId: string | null }> {
    return this.rpc({ type: "findByTask", reqId: "", taskId }) as Promise<{ ptyId: string | null }>;
  }

  /** See {@link CoreLinkRequestFrame} `replay` — `sinceSeq` asks for the tail
   *  past a cursor (a reattach); omitting it asks for the whole scrollback. */
  replay(ptyId: string, sinceSeq?: number): Promise<CoreLinkPtyReplay> {
    return this.rpc({ type: "replay", reqId: "", ptyId, sinceSeq }) as Promise<CoreLinkPtyReplay>;
  }

  /**
   * Ask this Core for one PTY's byte stream (issue 142, ADR 0024 D2). Until a
   * link subscribes, `onData`/`onExit` never fire for that `ptyId` — a Core
   * fans output out to the connections that asked and to no others.
   *
   * `catchUp` says a `replay` for this PTY follows and the Core must hold the
   * live stream until it has been served, so the caller never paints live bytes
   * in front of its own scrollback. A caller that sets it owes that replay;
   * nothing else releases the hold.
   *
   * The set is remembered and re-sent on every reconnect, because the Core
   * hangs subscriptions off the connection. Idempotent on both sides: a second
   * call for a PTY already subscribed is a no-op here and an ack there.
   *
   * **Against a Core that does not announce `multiConnection`, this sends
   * nothing and resolves** (ADR 0024 D11). That is the deliberate
   * single-connection fallback, not a swallowed failure: such a Core fans every
   * PTY out to every connection, so the caller is already receiving the bytes
   * it just asked for and the subscription it would send is a frame that Core
   * has no vocabulary for. Resolving says what is true — this link renders that
   * PTY — which is the only thing the caller acts on.
   *
   * The want is recorded either way, because this set is not a record of what
   * the Core holds: it is what this link wants, and every connection re-derives
   * its frames from it against *that* connection's announced capability. Drop
   * the want when no frame goes out and a Core that gains the capability across
   * a restart comes back fanning out to subscribers only, with nothing left
   * anywhere that remembers to subscribe — the router binds a Core once, not
   * once per reconnect, so this set is the only memory there is.
   */
  ptySubscribe(ptyId: string, opts: { catchUp?: boolean } = {}): Promise<void> {
    if (this.subscribedPtys.has(ptyId)) return Promise.resolve();
    this.subscribedPtys.add(ptyId);
    if (!this.canSendMultiConnectionFrames()) return Promise.resolve();
    return this.rpc({
      type: "ptySubscribe",
      reqId: "",
      ptyId,
      catchUp: opts.catchUp === true,
    }).then(() => undefined);
  }

  /**
   * Stop receiving one PTY's stream. Idempotent; see {@link ptySubscribe}.
   *
   * Same fallback, for the same reason: against a capability-less Core there is
   * no subscription to drop — its fan-out is unconditional and cannot be
   * narrowed by a frame it does not know. Forgetting the want here is the whole
   * of what this call can honestly do.
   */
  ptyUnsubscribe(ptyId: string): Promise<void> {
    if (!this.subscribedPtys.delete(ptyId)) return Promise.resolve();
    if (!this.canSendMultiConnectionFrames()) return Promise.resolve();
    return this.rpc({ type: "ptyUnsubscribe", reqId: "", ptyId }).then(() => undefined);
  }

  /**
   * Re-ask for every PTY this link had, on a connection that has just come up.
   *
   * `catchUp` is deliberately not set. A hold is released by a `replay` from
   * the same client, and nothing here is going to send one — the surfaces that
   * replay do it off their own reconnect, one layer up, and a hold nobody
   * releases is a pane that stays blank forever. Going live immediately is also
   * exactly what this path did before subscriptions existed.
   *
   * Callers must have the capability answer in hand before calling this, which
   * is why it hangs off `authOk` (the Core's `ready` is frame one, so the
   * capability is recorded before any auth answer can arrive) and off `ready`
   * itself when no bearer is configured. Called any earlier it would read an
   * unknown capability as absent and take the fallback below against a Core
   * that does announce it — every held pane silently unsubscribed.
   */
  private resendPtySubscriptions(): void {
    // The same deliberate single-connection fallback {@link ptySubscribe}
    // takes: a Core without the capability is already sending these PTYs.
    if (!this.canSendMultiConnectionFrames()) return;
    for (const ptyId of this.subscribedPtys) {
      void this.rpc({ type: "ptySubscribe", reqId: "", ptyId, catchUp: false }).catch(() => {
        /* the socket died again; the next open re-sends the whole set */
      });
    }
  }

  /**
   * Take this Session's write lock (issue 144, ADR 0024 D6).
   *
   * `granted: false` means another Core client holds it — an answer, not a
   * failure, and the only way past it is {@link forceTakeover}. Idempotent for a
   * link that already holds the Session.
   *
   * **Against a Core that does not announce `multiConnection`, this sends
   * nothing and answers `{ supported: false, granted: false }`** — the same
   * consult-the-gate-and-degrade shape {@link ptySubscribe} takes, and for the
   * same kind of reason. Such a Core evicts every client but one, so there is
   * nothing for a lock to arbitrate between and no table to put a claim in.
   *
   * `supported: false` must never be rendered as read-only. It says this Core
   * has no Session lock at all, so every mutation this link makes will be
   * served — the opposite of what `granted: false` says. A caller that treats
   * the two the same makes a single-connection Core look permanently locked to
   * an operator who is in fact its only client.
   */
  claim(taskId: string): Promise<{ supported: boolean; granted: boolean }> {
    if (!this.canSendMultiConnectionFrames()) {
      return Promise.resolve({ supported: false, granted: false });
    }
    return this.rpc({ type: "claim", reqId: "", taskId }).then((granted) => ({
      supported: true,
      granted: granted === true,
    }));
  }

  /**
   * Give this Session's write lock back (issue 144, ADR 0024 D7).
   *
   * `released: false` means this link did not hold it — idempotent, not an
   * error, so a caller releasing on teardown does not have to know whether it
   * had already lost the lock to a takeover. Same capability fallback as
   * {@link claim}: nothing goes on the wire to a Core with no lock table, and
   * `supported: false` says there was never a lock to give back.
   */
  release(taskId: string): Promise<{ supported: boolean; released: boolean }> {
    if (!this.canSendMultiConnectionFrames()) {
      return Promise.resolve({ supported: false, released: false });
    }
    return this.rpc({ type: "release", reqId: "", taskId }).then((released) => ({
      supported: true,
      released: released === true,
    }));
  }

  /**
   * Take this Session's write lock whoever holds it (issue 144, ADR 0024 D7).
   *
   * The answer to a hung client, and the reason the lock needs no idle timeout.
   * Unrecoverable by design: the previous holder's in-flight keystrokes are gone
   * and its next mutation is refused. `takenFrom` names who lost it so a caller
   * can say so rather than infer it — taking an unheld Session is an ordinary
   * claim by another name.
   *
   * Same capability fallback as {@link claim}, answering
   * `takenFrom: "nobody"`: there was nobody to take it from, because there is no
   * lock on such a Core to take.
   */
  forceTakeover(
    taskId: string,
  ): Promise<{ supported: boolean; takenFrom: CoreLinkSessionTakenFrom }> {
    if (!this.canSendMultiConnectionFrames()) {
      return Promise.resolve({ supported: false, takenFrom: "nobody" });
    }
    return this.rpc({ type: "forceTakeover", reqId: "", taskId }).then((takenFrom) => ({
      supported: true,
      takenFrom: (takenFrom ?? "nobody") as CoreLinkSessionTakenFrom,
    }));
  }

  /**
   * List every project on this Core as a live snapshot (issue 07 — per-Core
   * navigation). The Core is the source of truth; the Panel holds none. The
   * returned `path` is a VM path — only the Core can validate it.
   */
  projectsList(): Promise<CoreLinkProjectSnapshot[]> {
    return this.rpc({ type: "projectsList", reqId: "" }) as Promise<CoreLinkProjectSnapshot[]>;
  }

  /**
   * List every active (non-archived) task on this Core, optionally filtered to
   * one project (issue 07 — per-Core navigation + Fleet view fan-out). The
   * Core omits archived tasks; the Panel caches nothing.
   *
   * `archivedCount` is how many archived rows the same scope holds — a scalar,
   * never the rows (issue 62, ADR 0019). Use {@link archivedTasksList} for
   * those.
   */
  tasksList(
    projectId?: string,
  ): Promise<{ tasks: CoreLinkTaskSnapshot[]; archivedCount: number }> {
    return this.rpc({ type: "tasksList", reqId: "", projectId }) as Promise<{
      tasks: CoreLinkTaskSnapshot[];
      archivedCount: number;
    }>;
  }

  /**
   * List every archived task on this Core, optionally filtered to one project
   * (issue 62, ADR 0019) — the Archived view's own read path. A separate frame
   * from `tasksList`, so the active answer stays free of archived rows by
   * construction rather than by what a caller remembers to pass.
   */
  archivedTasksList(projectId?: string): Promise<CoreLinkTaskSnapshot[]> {
    return this.rpc({ type: "archivedTasksList", reqId: "", projectId }) as Promise<
      CoreLinkTaskSnapshot[]
    >;
  }

  /**
   * Create / rename / archive a project on this Core (issue 04 write path).
   * The Core validates the VM path server-side; an invalid path comes back
   * as an `error` frame that rejects this promise. Returns `null` when a
   * `rename`/`archive` targets a missing row.
   */
  projectsMutate(
    mutation: CoreLinkProjectMutation,
  ): Promise<CoreLinkProjectSnapshot | null> {
    return this.rpc({ type: "projectsMutate", reqId: "", mutation }) as Promise<
      CoreLinkProjectSnapshot | null
    >;
  }

  /**
   * Create / update a task on this Core (issue 04 write path). Returns `null`
   * when an `update` targets a missing row.
   */
  tasksMutate(mutation: CoreLinkTaskMutation): Promise<CoreLinkTaskSnapshot | null> {
    return this.rpc({ type: "tasksMutate", reqId: "", mutation }) as Promise<
      CoreLinkTaskSnapshot | null
    >;
  }

  /**
   * List every active session on this Core (optionally filtered to one
   * project). A session's `ptyId` is set when the Core has a live PTY for
   * that task — the Panel uses this to know which sessions it can reattach to.
   */
  sessionsList(projectId?: string): Promise<CoreLinkSessionSnapshot[]> {
    return this.rpc({ type: "sessionsList", reqId: "", projectId }) as Promise<
      CoreLinkSessionSnapshot[]
    >;
  }

  /**
   * Snapshot of this Core's CLI availability (issue 11). Called on Panel mount
   * to hydrate the per-Core availability store without waiting for the next
   * `agents:availabilityChanged` event. Live updates arrive via `onEvent`.
   */
  agentsAvailabilityList(): Promise<CoreLinkHarnessAvailabilityMap> {
    return this.rpc({ type: "agentsAvailabilityList", reqId: "" }) as Promise<
      CoreLinkHarnessAvailabilityMap
    >;
  }

  onData(cb: (msg: { ptyId: string; data: string; seq: number }) => void): () => void {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }

  onExit(cb: (msg: { ptyId: string; exitCode: number; signal?: number }) => void): () => void {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  /**
   * Subscribe to domain events from the Core's monotonic event log (task
   * status, hook, session finish, PTY spawn/exit lifecycle). The callback
   * receives one `{ event: CoreLinkEvent }` per replayed or live event. The
   * client dedupes by eventId and persists the cursor, so on a kill+reopen the
   * Panel restores the missed timeline via the subscribe replay.
   */
  onEvent(cb: (msg: { event: CoreLinkEvent }) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  /**
   * Notified once after each (re)connect when the Core finishes streaming
   * the replay tail and live event push resumes. `{ lastEventId }` is the new
   * caught-up cursor.
   */
  onEventsReplayed(cb: (msg: { lastEventId: number }) => void): () => void {
    this.eventsReplayedListeners.add(cb);
    return () => this.eventsReplayedListeners.delete(cb);
  }

  /** The highest eventId the client has seen (mirrors the persisted cursor). */
  getLastEventId(): number {
    return this.lastEventId;
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("core-link client closed"));
    }
    this.pending.clear();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* best effort */
      }
      this.socket = null;
    }
  }
}

/**
 * Turn a response frame into the value the typed methods promise, or throw the
 * failure it carries. The two failure frames (`spawnError`, `error`) become
 * rejections here so a caller of `spawn()` sees an exception rather than a
 * frame it has to inspect; the router bypasses this and forwards the frame.
 */
function unwrapResponse(msg: CoreLinkResponseFrame): unknown {
  switch (msg.type) {
    case "spawned":
      return { ptyId: msg.ptyId };
    case "spawnError":
      throw new Error(msg.message);
    case "writeResult":
    case "resizeResult":
    case "killResult":
      return msg.ok;
    case "killLaunchProcessesResult":
      return msg.result;
    case "findByTaskResult":
      return { ptyId: msg.ptyId };
    case "replayResult":
      return { data: msg.data, nextSeq: msg.nextSeq, from: msg.from };
    // The active list answers with rows *and* the archived count (ADR 0019),
    // so unwrapping to `msg.tasks` alone would drop a required field of the
    // frame. The archived list carries rows only.
    case "tasksListResult":
      return { tasks: msg.tasks, archivedCount: msg.archivedCount };
    case "archivedTasksListResult":
      return msg.tasks;
    case "projectsListResult":
      return msg.projects;
    case "tasksMutateResult":
      return msg.task;
    case "projectsMutateResult":
      return msg.project;
    case "sessionsListResult":
      return msg.sessions;
    case "agentsAvailabilityListResult":
      return msg.availability;
    case "ptySubscribeAck":
    case "ptyUnsubscribeAck":
      return { ptyId: msg.ptyId, subscribed: msg.subscribed };
    // The Session lock's three answers unwrap to the one field each carries
    // beyond the taskId the caller already passed in (issue 144). A denied
    // claim comes back here as `false` rather than as a rejection — it is an
    // answer, not a failure, and only a *mutation* refused for the lock throws
    // (that is an `error` frame, below, carrying `session-locked`).
    case "claimResult":
      return msg.granted;
    case "releaseResult":
      return msg.released;
    case "forceTakeoverResult":
      return msg.takenFrom;
    case "error":
      throw new Error(msg.message);
    default:
      // `ready`, `subscribeAck`, the auth frames — not request/response answers
      // any typed method awaits. Resolving undefined matches the old behaviour
      // of leaving such a frame unhandled rather than rejecting on it.
      return undefined;
  }
}

/**
 * Derive a stable, filesystem-safe key suffix from the core-link URL so each
 * Core gets its own `lastEventId` cursor in storage. The URL carries the host
 * + port that uniquely identify a Core; we strip the scheme and replace
 * non-alphanumerics so the result is a safe storage key segment. Two Cores on
 * different ports get different cursors.
 */
function deriveCoreKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}-${u.port}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  } catch {
    // Malformed URL — fall back to a sanitized full string so callers still
    // get key isolation between distinct (if odd) URLs.
    return url.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-64);
  }
}

/**
 * Default socket factory — uses the platform's global WebSocket, which both
 * Node and the browser provide.
 */
function defaultCreateSocket(url: string): WebSocketLike {
  const ws = new WebSocket(url);
  return {
    get readyState() {
      return ws.readyState;
    },
    send: (data: string) => ws.send(data),
    close: () => ws.close(),
    on: (event, cb) => {
      if (event === "open") {
        ws.addEventListener("open", () => (cb as () => void)());
      } else if (event === "message") {
        ws.addEventListener("message", (e: MessageEvent) =>
          (cb as (data: unknown) => void)(e.data),
        );
      } else if (event === "close") {
        ws.addEventListener("close", () => (cb as () => void)());
      } else if (event === "error") {
        ws.addEventListener("error", () =>
          (cb as (err: Error) => void)(new Error("WebSocket error")),
        );
      }
    },
    removeEventListener: (event, cb) => {
      ws.removeEventListener(event, cb as EventListener);
    },
  };
}
