import {
  PANEL_LINK_PATH,
  PANEL_LINK_PROTOCOL_VERSION,
  PANEL_LINK_VERSION_PARAM,
  decodeServerFrame,
  encodePanelLinkFrame,
} from "~/shared/panel-link";
import type {
  CoreLinkEvent,
  CoreLinkRequestFrame,
  CoreLinkResponseFrame,
} from "@actana/shared/core-link-frames";
import type { CoreDialStatus } from "~/shared/cores";

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
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  requestTimeoutMs?: number;
};

const DEFAULT_RECONNECT_INITIAL_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

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
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly requestTimeoutMs: number;

  private socket: PanelLinkSocketLike | null = null;
  private open = false;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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

  constructor(opts: PanelLinkOptions = {}) {
    this.createSocket = opts.createSocket ?? defaultCreateSocket;
    this.url = opts.url ?? defaultUrl();
    this.reconnectInitialMs = opts.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("panel link closed"));
    }
    this.pending.clear();
    this.socket?.close();
    this.socket = null;
    this.open = false;
  }

  // ─── transport ────────────────────────────────────────────────────────────

  private connect(): void {
    if (this.closed) return;
    let socket: PanelLinkSocketLike;
    try {
      socket = this.createSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.open = true;
      this.reconnectAttempt = 0;
      // Re-subscribe every watched Core from where this tab got to, and re-ask
      // for every PTY it is rendering. This is the whole of the replay contract
      // on the browser side.
      for (const coreId of this.watching.keys()) this.sendSubscribe(coreId);
      this.resendPtySubscriptions();
      for (const frame of this.queued.splice(0)) this.rawSend(frame);
      for (const cb of this.connectionListeners) cb(true);
    });

    socket.addEventListener("message", (event) => this.onMessage(event.data));

    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      const wasOpen = this.open;
      this.open = false;
      // Requests written to a socket that died can never be answered; failing
      // them now lets the caller retry on the new link instead of waiting out
      // the timeout.
      for (const [reqId, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("panel link connection lost"));
        this.pending.delete(reqId);
      }
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
    const frame = decodeServerFrame(raw);
    if (!frame) return;
    if (frame.t === "dial") {
      for (const cb of this.dialListeners) cb(frame.status);
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

function defaultUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}${PANEL_LINK_PATH}?${PANEL_LINK_VERSION_PARAM}=${PANEL_LINK_PROTOCOL_VERSION}`;
}

function defaultCreateSocket(url: string): PanelLinkSocketLike {
  return new WebSocket(url) as unknown as PanelLinkSocketLike;
}
