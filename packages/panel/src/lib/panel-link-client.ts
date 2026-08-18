import {
  PANEL_LINK_CLIENT_PARAM,
  PANEL_LINK_PATH,
  PANEL_LINK_PROTOCOL_VERSION,
  PANEL_LINK_VERSION_PARAM,
  decodeServerFrame,
  encodePanelLinkFrame,
  readPanelLinkClientId,
} from "~/shared/panel-link";
import type {
  CoreLinkEvent,
  CoreLinkRequestFrame,
  CoreLinkResponseFrame,
} from "@actana/sdk/core-link-frames";
import type { CoreDialStatus } from "~/shared/cores";
import type { PanelSessionLock } from "~/shared/session-write-access";

/**
 * The browser end of the panel link: one WebSocket per tab, no matter how many
 * Cores are registered or how many terminals are open.
 *
 * One socket means one reconnect story. When it drops, every Core's stream
 * drops with it and comes back with it — the tab re-subscribes each Core from
 * the cursor it had reached, and the service replays what it missed. A design
 * with a socket per Core would have to get that right N times over, and would
 * be N times as likely to leave one of them quietly dead.
 *
 * Cursors live in memory, not storage. They mark "what this tab has seen", and
 * a tab that reloads has seen nothing — its views load current state through
 * queries. Persisting them would ask the service to replay history the fresh
 * page is already fetching.
 */

export interface PanelLinkSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", cb: () => void): void;
  addEventListener(type: "close", cb: () => void): void;
  addEventListener(type: "error", cb: () => void): void;
  addEventListener(type: "message", cb: (event: { data: unknown }) => void): void;
}

export type PanelLinkOptions = {
  /** Injectable socket factory (tests). Default: the browser's WebSocket. */
  createSocket?: (url: string) => PanelLinkSocketLike;
  /** Absolute or relative panel-link URL. Default: derived from the page origin. */
  url?: string;
  /**
   * This tab's panel-link client id (issue 242). Default: the id this tab
   * carries across its own reload — see {@link claimTabClientId}.
   *
   * Injectable for tests, which need two "tabs" in one process and cannot get
   * two `sessionStorage`s.
   */
  clientId?: string;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  requestTimeoutMs?: number;
  /** How long silence on an `OPEN` socket is tolerated at a wake signal. */
  staleAfterMs?: number;
};

const DEFAULT_RECONNECT_INITIAL_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long an `OPEN` socket may go without delivering a frame before a wake
 * signal treats it as a corpse.
 *
 * Generous on purpose, and deliberately not the server's 45s timeout. The
 * server's pings never reach page JavaScript — the browser answers them down in
 * the network layer and the `WebSocket` API surfaces no pong event — so this
 * clock advances only on *application* frames, and an idle Core legitimately
 * sends none for hours. A window near the server's would therefore redial a
 * perfectly healthy link on every focus of a quiet tab. The asymmetry is
 * deliberate: one false-positive redial is cheap and safe, because the
 * reconnect path is idempotent and replays from the cursor — a redial on every
 * focus is not.
 */
const DEFAULT_STALE_AFTER_MS = 15 * 60_000;

/**
 * A request frame minus the `reqId` the client assigns. Distributed over the
 * union so each member keeps its own fields — a plain `Omit` over the union
 * would collapse them to the ones every member shares, and `tasksList`'s
 * `projectId` would stop type-checking.
 */
type UnsentRequest = CoreLinkRequestFrame extends infer F
  ? F extends { reqId: string }
    ? Omit<F, "reqId">
    : never
  : never;

type Pending = {
  resolve: (frame: CoreLinkResponseFrame) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Watch = {
  /** How many callers asked to watch this Core; the subscribe lives while > 0. */
  refs: number;
  /** The highest eventId this tab has seen from the Core. */
  cursor: number;
};

export class PanelLinkClient {
  private readonly createSocket: (url: string) => PanelLinkSocketLike;
  private readonly url: string;
  /**
   * What this tab calls itself on every socket it opens, including the one it
   * opens after a reload (issue 242).
   *
   * The service keys the **Session drive** by this, so a returning tab finds its
   * own entry rather than queueing behind the socket it just replaced. It is
   * deliberately not a *user* identity and not a Core client id: it names one
   * browser tab, it never reaches a Core, and the only thing it decides is which
   * of one Operator's own tabs holds a keyboard.
   */
  private readonly clientId: string;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly requestTimeoutMs: number;
  private readonly staleAfterMs: number;

  private socket: PanelLinkSocketLike | null = null;
  private open = false;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** When this tab last had evidence of life: an application frame, or an open. */
  private lastInboundAt = Date.now();
  private readonly detachWakeListeners: () => void;

  private reqSeq = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly queued: string[] = [];
  private readonly watching = new Map<string, Watch>();
  /**
   * The PTYs this tab is rendering, as `coreId` → `ptyId`s. It lives here for
   * the same reason the watch set does: this is the layer that sees the link
   * come back. The service gives every claim back when a tab's socket dies, so
   * a reconnect that re-sent only `subscribe` would leave the Core with no
   * reason to send those PTYs and every pane on this tab quietly dead.
   */
  private readonly claimedPtys = new Map<string, Set<string>>();

  private readonly eventListeners = new Set<(msg: { coreId: string; event: CoreLinkEvent }) => void>();
  private readonly dataListeners = new Set<
    (msg: { coreId: string; ptyId: string; data: string; seq: number }) => void
  >();
  private readonly exitListeners = new Set<
    (msg: { coreId: string; ptyId: string; exitCode: number; signal?: number }) => void
  >();
  private readonly dialListeners = new Set<(status: CoreDialStatus) => void>();
  private readonly connectionListeners = new Set<(connected: boolean) => void>();
  private readonly lockListeners = new Set<
    (msg: { coreId: string; taskId: string; lock: PanelSessionLock }) => void
  >();
  private readonly driveListeners = new Set<
    (msg: {
      coreId: string;
      taskId: string;
      driving: boolean;
      reason: "watch" | "handover";
    }) => void
  >();
  /**
   * The Sessions this tab has a pane open on, as `coreId` → `taskId`s.
   *
   * Held for the same reason the PTY claims above are: the service gives a
   * tab's drives back when its socket dies, so a reconnect that re-sent only
   * the subscriptions would come back with every pane on this tab following a
   * Session nobody drives. The set is the tab's, and it is re-announced on
   * every open.
   */
  private readonly drivenSessions = new Map<string, Set<string>>();

  constructor(opts: PanelLinkOptions = {}) {
    this.createSocket = opts.createSocket ?? defaultCreateSocket;
    this.url = opts.url ?? defaultUrl();
    this.clientId = opts.clientId ?? claimTabClientId();
    this.reconnectInitialMs = opts.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.detachWakeListeners = this.listenForWake();
    this.connect();
  }

  /** True while the link is up. Drives "reconnecting…" affordances. */
  isConnected(): boolean {
    return this.open;
  }

  /**
   * Send a core-link request frame to one Core and await its answer frame.
   * Rejects when the Panel answers with an `error` frame, so callers await a
   * value or catch a failure — never inspect a frame to find out which.
   */
  async request<T extends CoreLinkResponseFrame = CoreLinkResponseFrame>(
    coreId: string,
    frame: UnsentRequest,
  ): Promise<T> {
    if (this.closed) throw new Error("panel link closed");
    const reqId = `p${++this.reqSeq}`;
    const outgoing = { ...frame, reqId } as CoreLinkRequestFrame;
    const response = await new Promise<CoreLinkResponseFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`panel-link ${outgoing.type} timed out`));
      }, this.requestTimeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      this.write({ t: "core", coreId, frame: outgoing });
    });
    if (response.type === "error" || response.type === "spawnError") {
      throw new Error(response.message);
    }
    return response as T;
  }

  /**
   * Watch a Core's live stream. Reference-counted, so several hooks in one tab
   * share the single subscribe. The returned function releases this caller's
   * hold; the tab keeps watching while anyone else still is.
   */
  watch(coreId: string): () => void {
    const watch = this.watching.get(coreId) ?? { refs: 0, cursor: 0 };
    watch.refs++;
    this.watching.set(coreId, watch);
    if (watch.refs === 1) this.sendSubscribe(coreId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.watching.get(coreId);
      if (!current) return;
      current.refs--;
      // The cursor stays even at zero refs: a view remounting a moment later
      // should resume where it left off rather than skip the gap.
      if (current.refs <= 0) current.refs = 0;
    };
  }

  /**
   * Render one Core's PTY in this tab, and stop (issue 142). A Core sends a
   * PTY's stream only to the connections that asked for it, so this is what
   * `onPtyData` / `onPtyExit` are gated on — not a filter over everything the
   * far machine happens to be producing.
   *
   * `catchUp` says a `replay` for this PTY follows, so the Core holds the live
   * stream until it has been served and the pane never paints live bytes in
   * front of its own scrollback. The claim path always sets it; see
   * `pty-stream-router`.
   *
   * The set is remembered and re-sent on every open, exactly as the watch set
   * is — see {@link resendPtySubscriptions}. Idempotent: a second claim on a
   * PTY this tab already renders is a no-op here and an ack from the service,
   * which is what keeps a pane rebuilding on the same PTY from counting twice.
   */
  async ptySubscribe(
    coreId: string,
    ptyId: string,
    opts: { catchUp?: boolean } = {},
  ): Promise<void> {
    let claimed = this.claimedPtys.get(coreId);
    if (!claimed) {
      claimed = new Set();
      this.claimedPtys.set(coreId, claimed);
    }
    if (claimed.has(ptyId)) return;
    // Recorded before the ask, and kept even if the ask fails: a claim made
    // while the link is down is exactly what the next open has to re-send.
    claimed.add(ptyId);
    await this.request(coreId, {
      type: "ptySubscribe",
      ptyId,
      catchUp: opts.catchUp === true,
    });
  }

  /** Stop rendering it. Idempotent; see {@link ptySubscribe}. */
  async ptyUnsubscribe(coreId: string, ptyId: string): Promise<void> {
    const claimed = this.claimedPtys.get(coreId);
    if (!claimed?.delete(ptyId)) return;
    if (claimed.size === 0) this.claimedPtys.delete(coreId);
    await this.request(coreId, { type: "ptyUnsubscribe", ptyId });
  }

  onEvent(cb: (msg: { coreId: string; event: CoreLinkEvent }) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  onPtyData(
    cb: (msg: { coreId: string; ptyId: string; data: string; seq: number }) => void,
  ): () => void {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }

  onPtyExit(
    cb: (msg: { coreId: string; ptyId: string; exitCode: number; signal?: number }) => void,
  ): () => void {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  /**
   * Announce that this tab has a pane open on a Session, or give it back
   * (issue 147, ADR 0024 D3).
   *
   * This is the **Session drive** — arbitration between this Panel's own tabs,
   * settled inside the Panel and never sent to any Core. It is not the Session
   * lock: that is claimed with core-link frames through {@link request}, and it
   * is held by the Panel once for all of its tabs.
   *
   * `take: true` is the operator asking for the keyboard here, which moves it
   * off whichever tab of this Panel had it. Without it a pane takes the drive
   * only if no other tab is driving that Session.
   */
  driveSession(coreId: string, taskId: string, opts: { take?: boolean } = {}): void {
    let driven = this.drivenSessions.get(coreId);
    if (!driven) {
      driven = new Set();
      this.drivenSessions.set(coreId, driven);
    }
    driven.add(taskId);
    this.write({ t: "drive", coreId, taskId, want: opts.take === true ? "take" : "watch" });
  }

  /** This tab's pane on a Session is gone; it drives nothing there. Idempotent. */
  releaseSessionDrive(coreId: string, taskId: string): void {
    const driven = this.drivenSessions.get(coreId);
    if (!driven?.delete(taskId)) return;
    if (driven.size === 0) this.drivenSessions.delete(coreId);
    this.write({ t: "drive", coreId, taskId, want: "drop" });
  }

  /**
   * The Session lock, as the service's connection to that Core sees it — one
   * answer for the whole Panel, pushed on every change (ADR 0024 D8).
   */
  onSessionLock(
    cb: (msg: { coreId: string; taskId: string; lock: PanelSessionLock }) => void,
  ): () => void {
    this.lockListeners.add(cb);
    return () => this.lockListeners.delete(cb);
  }

  /**
   * Whether *this tab* drives a Session among this Panel's tabs. `handover`
   * says it changed under an open pane, which is the only case worth telling
   * the operator about — and it is a different event from losing the lock to
   * another Core client, with different copy.
   */
  onSessionDrive(
    cb: (msg: {
      coreId: string;
      taskId: string;
      driving: boolean;
      reason: "watch" | "handover";
    }) => void,
  ): () => void {
    this.driveListeners.add(cb);
    return () => this.driveListeners.delete(cb);
  }

  /** Dial-status changes, pushed by the service — no polling for reachability. */
  onDialStatus(cb: (status: CoreDialStatus) => void): () => void {
    this.dialListeners.add(cb);
    return () => this.dialListeners.delete(cb);
  }

  /** Link up / link down, so a view can refetch after a gap. */
  onConnectionChange(cb: (connected: boolean) => void): () => void {
    this.connectionListeners.add(cb);
    return () => this.connectionListeners.delete(cb);
  }

  close(): void {
    this.closed = true;
    this.detachWakeListeners();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failPending("panel link closed");
    this.socket?.close();
    this.socket = null;
    this.open = false;
  }

  // ─── liveness ─────────────────────────────────────────────────────────────

  /**
   * The wake signals, and the reason this recovery is hung on them rather than
   * on a clock.
   *
   * A socket can die without a TCP FIN — the overnight fate of a flow carrying
   * zero bytes across a NAT, a firewall or a reverse proxy. Nothing about that
   * is observable from the page: `readyState` stays `OPEN`, no `close` event
   * fires, a `send` into it buffers rather than throwing, and the request
   * timeout fails one caller without touching the link. The one moment the tab
   * can act on is the moment it becomes usable again — and a timer is precisely
   * what cannot be trusted to notice it, because a hidden tab's timers are
   * throttled to roughly once a minute and a frozen page's do not run at all.
   */
  private listenForWake(): () => void {
    if (typeof window === "undefined" || typeof document === "undefined") return () => {};
    const onWake = () => this.wake();
    const onVisibility = () => {
      if (document.visibilityState === "visible") this.wake();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onWake);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onWake);
    };
  }

  /**
   * A wake signal fired. Redial unless there is positive evidence the link is
   * alive — a frame that arrived recently enough. `isConnected()` is no such
   * evidence: it reads `true` on a corpse for as long as the corpse lasts.
   */
  private wake(): void {
    if (this.closed) return;
    if (this.open && Date.now() - this.lastInboundAt <= this.staleAfterMs) return;
    this.redialNow();
  }

  /**
   * Drop whatever socket we have and dial again immediately, off the backoff.
   * A tab hidden for hours has usually walked the backoff up to its cap, and
   * the first frame of visibility is exactly the wrong moment to make its
   * operator wait out the capped delay.
   */
  private redialNow(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    const dying = this.socket;
    const wasOpen = this.open;
    // Forgotten before the close, so the socket's own close handler — which
    // checks identity — bails rather than racing this path into a second
    // reconnect.
    this.socket = null;
    this.open = false;
    if (dying) {
      try {
        dying.close();
      } catch {
        // A half-open socket may refuse; we are done with it either way.
      }
    }
    this.failPending("panel link connection lost");
    if (wasOpen) for (const cb of this.connectionListeners) cb(false);
    this.connect();
  }

  /** Fail every in-flight request: nothing on the old socket can be answered. */
  private failPending(message: string): void {
    for (const [reqId, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(reqId);
      pending.reject(new Error(message));
    }
  }

  // ─── transport ────────────────────────────────────────────────────────────

  /**
   * The URL for one dial: the configured link plus this tab's client id.
   *
   * Appended here rather than folded into {@link defaultUrl} so an injected url
   * — a test's, a deployment's — carries the id too. A socket that dialled
   * without it would be a stranger to the service, and the tab would silently
   * lose its drive on the next reconnect with nothing to show why.
   */
  private dialUrl(): string {
    const separator = this.url.includes("?") ? "&" : "?";
    return `${this.url}${separator}${PANEL_LINK_CLIENT_PARAM}=${encodeURIComponent(this.clientId)}`;
  }

  private connect(): void {
    if (this.closed) return;
    let socket: PanelLinkSocketLike;
    try {
      socket = this.createSocket(this.dialUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.open = true;
      this.reconnectAttempt = 0;
      this.lastInboundAt = Date.now();
      // Re-subscribe every watched Core from where this tab got to, re-ask for
      // every PTY it is rendering, and re-announce every Session it has a pane
      // on. This is the whole of the replay contract on the browser side.
      //
      // It is also the whole of it for a *wake* redial: `wake()` drops the dead
      // socket and calls `connect()`, so a tab that comes back from hours
      // hidden lands here and re-announces exactly as a close-driven reconnect
      // does. Neither re-announce may move above this handler for that reason —
      // the wake path has no other place that runs on a fresh link.
      for (const coreId of this.watching.keys()) this.sendSubscribe(coreId);
      this.resendPtySubscriptions();
      this.resendSessionDrives();
      for (const frame of this.queued.splice(0)) this.rawSend(frame);
      for (const cb of this.connectionListeners) cb(true);
    });

    socket.addEventListener("message", (event) => {
      // A socket this client has already given up on may still deliver what it
      // had buffered. Its frames are not this link's frames, and above all they
      // are not evidence that the *current* link is alive.
      if (this.socket !== socket) return;
      this.onMessage(event.data);
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      const wasOpen = this.open;
      this.open = false;
      // Requests written to a socket that died can never be answered; failing
      // them now lets the caller retry on the new link instead of waiting out
      // the timeout.
      this.failPending("panel link connection lost");
      if (wasOpen) for (const cb of this.connectionListeners) cb(false);
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      // The close handler owns reconnection; an error on its own tells us
      // nothing actionable here.
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
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

  /**
   * Never queued: a subscribe written while the link is down would be sent on
   * open right beside the one the open handler sends for every watched Core,
   * and the Core would replay its tail twice.
   */
  private sendSubscribe(coreId: string): void {
    if (!this.socket || !this.open) return;
    const cursor = this.watching.get(coreId)?.cursor ?? 0;
    this.rawSend(
      encodePanelLinkFrame({
        t: "core",
        coreId,
        frame: { type: "subscribe", reqId: `sub${++this.reqSeq}`, lastEventId: cursor },
      }),
    );
  }

  /**
   * Re-ask for every PTY this tab is rendering, on a link that has just come
   * up. The service handed this tab's claims back when the old socket died and
   * the panes never noticed — nothing above this layer re-claims, so without
   * this the Core stops sending and every pane on the tab goes dead.
   *
   * `catchUp` is deliberately not set, for the same reason the core-link client
   * leaves it off when it re-subscribes: a hold is released by a `replay`, and
   * this is not the layer that sends one. The panes replay off their own
   * reconnect one layer up and buffer whatever lands live while that replay is
   * in flight (`pty-stream-router`), so going live immediately loses nothing —
   * whereas a hold nobody releases is a pane that never paints again.
   */
  private resendPtySubscriptions(): void {
    for (const [coreId, ptyIds] of this.claimedPtys) {
      for (const ptyId of ptyIds) {
        this.rawSend(
          encodePanelLinkFrame({
            t: "core",
            coreId,
            frame: {
              type: "ptySubscribe",
              reqId: `psub${++this.reqSeq}`,
              ptyId,
              catchUp: false,
            },
          }),
        );
      }
    }
  }

  /**
   * Re-announce every Session this tab has a pane open on, on a link that has
   * just come up (issue 147).
   *
   * `take` is deliberately not set, and the difference matters: a reconnect is
   * not the operator asking for the keyboard. Re-asserting a drive would have
   * two tabs of one Panel trade it back and forth on every flap, each reconnect
   * silently pulling it off the other. Announcing interest and accepting the
   * first-come answer is what makes a reconnect converge — the tab that was
   * driving is still watching, so it keeps it.
   */
  private resendSessionDrives(): void {
    for (const [coreId, taskIds] of this.drivenSessions) {
      for (const taskId of taskIds) {
        this.rawSend(encodePanelLinkFrame({ t: "drive", coreId, taskId, want: "watch" }));
      }
    }
  }

  private write(frame: Parameters<typeof encodePanelLinkFrame>[0]): void {
    this.rawSend(encodePanelLinkFrame(frame));
  }

  private rawSend(payload: string): void {
    if (!this.socket || !this.open) {
      // Not up yet (first paint, or mid-reconnect). Queue rather than fail:
      // pending requests already carry their own timeout.
      this.queued.push(payload);
      return;
    }
    try {
      this.socket.send(payload);
    } catch {
      // The close handler will reconnect and the caller's request will time out
      // or be rejected there.
    }
  }

  private onMessage(raw: unknown): void {
    // Anything arriving is evidence of life, decodable or not — and an
    // application frame is the only evidence this end ever gets, since the
    // server's pings are answered below the API and surface no event here.
    this.lastInboundAt = Date.now();
    const frame = decodeServerFrame(raw);
    if (!frame) return;
    if (frame.t === "dial") {
      for (const cb of this.dialListeners) cb(frame.status);
      return;
    }
    // Session write access, in its two separate halves (issue 147). Neither is
    // a request/response: both are pushed, because both have to be true on
    // screen *before* a keystroke rather than discovered by one.
    if (frame.t === "lock") {
      for (const cb of this.lockListeners) {
        cb({ coreId: frame.coreId, taskId: frame.taskId, lock: frame.lock });
      }
      return;
    }
    if (frame.t === "drive") {
      for (const cb of this.driveListeners) {
        cb({
          coreId: frame.coreId,
          taskId: frame.taskId,
          driving: frame.driving,
          reason: frame.reason,
        });
      }
      return;
    }
    const { coreId, frame: inner } = frame;
    switch (inner.type) {
      case "event": {
        const watch = this.watching.get(coreId);
        // Dedupe on the cursor: a replay overlapping what we already saw must
        // not re-fire listeners that drive refetches.
        if (watch && inner.event.eventId <= watch.cursor) return;
        if (watch) watch.cursor = inner.event.eventId;
        for (const cb of this.eventListeners) cb({ coreId, event: inner.event });
        return;
      }
      case "eventsReplayed": {
        const watch = this.watching.get(coreId);
        if (watch && inner.lastEventId > watch.cursor) watch.cursor = inner.lastEventId;
        return;
      }
      case "data":
        for (const cb of this.dataListeners) {
          cb({ coreId, ptyId: inner.ptyId, data: inner.data, seq: inner.seq });
        }
        return;
      case "exit":
        for (const cb of this.exitListeners) {
          cb({ coreId, ptyId: inner.ptyId, exitCode: inner.exitCode, signal: inner.signal });
        }
        return;
      default: {
        const reqId = (inner as { reqId?: string }).reqId;
        if (!reqId) return;
        const pending = this.pending.get(reqId);
        if (!pending) return;
        this.pending.delete(reqId);
        clearTimeout(pending.timer);
        pending.resolve(inner as CoreLinkResponseFrame);
      }
    }
  }
}

/**
 * Where this tab's client id is parked while the page is being replaced.
 *
 * `sessionStorage`, because it is the only web storage scoped to exactly what
 * this id names: one tab. It survives a reload and a same-tab navigation, and it
 * dies with the tab — a closed tab has no drive to reclaim, and `localStorage`
 * would make every tab in the browser one tab.
 */
const TAB_CLIENT_ID_KEY = "actana.panel-link.tab";

/**
 * This tab's client id: minted once, parked as the page goes away, and claimed
 * back by the page that replaces it (issue 242).
 *
 * **Claimed, not merely read** — the key is removed the instant it is taken, and
 * written back only on `pagehide`. That is what makes the id unforgeably
 * per-tab: a browser's "Duplicate tab" copies `sessionStorage` wholesale, and a
 * copy taken while the key is absent — which is every moment a page is actually
 * running — carries no id, so the duplicate mints its own. Two live tabs
 * therefore cannot present the same string, which matters because they would
 * then reap each other's sockets on every reconnect and neither would settle.
 * That is ADR 0024 D9's argument against a durable Core client id, applied to
 * the layer above: an id per live tab makes the collision unrepresentable rather
 * than something to detect.
 *
 * `pageshow` re-claims it after a back/forward-cache restore, where the page
 * comes back with its JavaScript state — and so its id — intact, but the key it
 * parked on the way out still sitting there for a duplicate to copy.
 *
 * A tab that crashes without running `pagehide` loses its id and mints a fresh
 * one on the way back. That is the pre-242 behaviour, which is the right thing
 * to fall back to: it costs a keyboard that first-come will hand back, never a
 * wrong answer.
 */
function claimTabClientId(): string {
  const store = tabStore();
  let id: string | null = null;
  if (store) {
    try {
      id = readPanelLinkClientId(store.getItem(TAB_CLIENT_ID_KEY));
      store.removeItem(TAB_CLIENT_ID_KEY);
    } catch {
      // Storage disabled or full. The mint below is the whole fallback.
      id = null;
    }
  }
  const clientId = id ?? mintTabClientId();
  if (store && typeof window !== "undefined") {
    const park = () => {
      try {
        store.setItem(TAB_CLIENT_ID_KEY, clientId);
      } catch {
        // Nothing to do: the next page mints its own.
      }
    };
    const reclaim = () => {
      try {
        store.removeItem(TAB_CLIENT_ID_KEY);
      } catch {
        // See above.
      }
    };
    // `pagehide` rather than `unload`: it is the one that fires for a page going
    // into the back/forward cache as well as one being torn down, and `unload`
    // disables that cache outright.
    window.addEventListener("pagehide", park);
    window.addEventListener("pageshow", reclaim);
  }
  return clientId;
}

/** `sessionStorage`, or null where there is none (SSR, or a locked-down browser). */
function tabStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : (window.sessionStorage ?? null);
  } catch {
    // Reading the property itself throws when storage is blocked by policy.
    return null;
  }
}

/**
 * Mint a fresh tab client id.
 *
 * Random rather than derived from anything about the page, for the reason ADR
 * 0024 D9 gives for the Core client id: every input that would make it stable
 * across tabs — the origin, the operator, the deployment — is shared by all of
 * them, which is the one shape that must not happen. Unguessability buys nothing
 * and is not claimed: nothing verifies this string, and the authority it moves
 * is a keyboard between two tabs the same person already has open.
 *
 * The `tab-` prefix matches the id the service mints for a socket that presented
 * none, so the two read alike wherever they are logged.
 */
function mintTabClientId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `tab-${random}`;
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}${PANEL_LINK_PATH}?${PANEL_LINK_VERSION_PARAM}=${PANEL_LINK_PROTOCOL_VERSION}`;
}

function defaultCreateSocket(url: string): PanelLinkSocketLike {
  return new WebSocket(url) as unknown as PanelLinkSocketLike;
}
