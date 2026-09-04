// `DurableCoreClient` — the entry point for a program that stays up.
//
// The second of the two entry points on one transport (#129 D6). It is
// {@link CoreClient} plus the four things a link that must survive a night of
// idleness needs and a one-shot dial has no use for:
//
//   - a **heartbeat**, because an idle core link is what a NAT reaps silently;
//   - **reconnection with backoff**, because a Core restarts, a machine sleeps,
//     and a laptop lid closes;
//   - an **event cursor** in an injected {@link CoreLinkCursorStorage}, because a
//     client that was away has to be told what it missed rather than guess;
//   - **subscribe-then-replay**, because that is the order in which a gap is
//     closed without a hole and without a double.
//
// This is what the Panel will use (#156). Nothing here is Panel-specific: there
// is no `Fleet` type, no Core registry, and no notion of a second Core — one
// client is one socket to one machine (#129 D5), and holding several of these is
// the Panel's business.
//
// Extracted from `PtyCoreLinkClient` (issue 153), whose reconnect loop, cursor
// handling and PTY re-subscription are the four sections below. That class was
// deleted in #156: this is the Panel's client now, not a copy of it.

import type { CoreLinkEvent } from "./core-link-frames.ts";
import { CoreClient, type CoreClientOptions } from "./core-client.ts";
import type { CoreRegistrationBlob } from "./core-registration-blob.ts";
import {
  coreLinkCursorStorageKey,
  InMemoryCoreLinkCursorStorage,
  type CoreLinkCursorStorage,
} from "./core-link-cursor-storage.ts";
import type { CoreLinkHeartbeatOptions } from "./core-link-transport.ts";

/** Reconnect backoff floor: the delay after the first unexpected drop. */
export const DEFAULT_RECONNECT_INITIAL_MS = 500;
/** Reconnect backoff ceiling. Doubling stops here and keeps trying at this rate. */
export const DEFAULT_RECONNECT_MAX_MS = 5_000;

export type DurableCoreClientOptions = CoreClientOptions & {
  /** Reconnect backoff floor in ms. Default 500. */
  reconnectInitialMs?: number;
  /** Reconnect backoff ceiling in ms. Default 5000. */
  reconnectMaxMs?: number;
  /**
   * Where the per-Core `lastEventId` cursor is kept. Default:
   * {@link InMemoryCoreLinkCursorStorage} — replay across every reconnect within
   * this process, but not across a restart. **Inject a durable store to get the
   * restart too; never let this package import one** (see
   * `core-link-cursor-storage.ts`).
   */
  storage?: CoreLinkCursorStorage;
  /** The key the cursor is stored under. Default: derived from the Core's URL. */
  cursorStorageKey?: string;
  /**
   * Arm the heartbeat. On by default here, which is the difference between this
   * entry point and {@link CoreClient}: a link nobody is watching is exactly the
   * one that has to notice it died.
   */
  heartbeat?: CoreLinkHeartbeatOptions | false;
};

/**
 * A Core client that keeps its link up.
 *
 * `await connect()` resolves when the first connection is established and does
 * not reject when a later one drops — a drop is what this class is for. From then
 * on the link re-establishes itself: `onDisconnected` fires on every failed or
 * lost connection, `onReady` on every one that comes back, and requests made in
 * between are queued rather than refused.
 */
export class DurableCoreClient extends CoreClient {
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly storage: CoreLinkCursorStorage;
  private readonly cursorStorageKey: string;

  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** In-memory mirror of the persisted cursor; advanced by every event and marker. */
  private lastEventId = 0;
  /** True between this connection's `eventsReplayed` and its drop. */
  private caughtUp = false;

  /**
   * The PTYs this client has asked the Core for (ADR 0024 D2). PTY output fans
   * out by subscription, so this set is the difference between a pane that
   * renders and one that sits blank — and it is connection state on the Core,
   * which means it does not survive a reconnect. This client re-sends it on every
   * connection; nothing above it has to know the socket ever dropped.
   *
   * It records what this client *wants*, not what the Core holds: every
   * connection re-derives its frames from this set against *that* connection's
   * announced capability. Drop the want when no frame goes out and a Core that
   * gains the capability across a restart comes back fanning out to subscribers
   * only, with nothing left anywhere that remembers to subscribe.
   */
  private readonly subscribedPtys = new Set<string>();

  constructor(opts: DurableCoreClientOptions) {
    super({ ...opts, heartbeat: opts.heartbeat ?? {} });
    this.reconnectInitialMs = opts.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.storage = opts.storage ?? new InMemoryCoreLinkCursorStorage();
    this.cursorStorageKey = opts.cursorStorageKey ?? coreLinkCursorStorageKey(this.url);
    this.lastEventId = this.readPersistedCursor();
  }

  /** Build a durable client straight off a registration blob (#129 D1). */
  static override fromRegistrationBlob(
    blob: CoreRegistrationBlob,
    opts: Omit<DurableCoreClientOptions, "blob" | "url" | "tls" | "bearer"> = {},
  ): DurableCoreClient {
    return new DurableCoreClient({ ...opts, blob });
  }

  /**
   * The connect promise a durable client hands back does not fail on a lost
   * socket: the supervisor is already dialing again, so rejecting would report a
   * connection as unrecoverable at the exact moment it is being recovered. What
   * still rejects it is a refused bearer (retrying an expired one is futile until
   * a fresh blob is pasted — ADR 0003) and the connect deadline.
   */
  protected override onConnectionClosed(): void {
    this.caughtUp = false;
    this.scheduleReconnect();
  }

  /**
   * The supervisor is the only thing that dials here once the first connection
   * has been asked for, so a `connect()` made during the backoff waits for the
   * dial that is already coming rather than racing one of its own.
   */
  protected override reconnectScheduled(): boolean {
    return this.reconnectTimer !== null;
  }

  /**
   * Yes — surviving a drop is what this class is for (#396).
   *
   * Not the same question as {@link reconnectScheduled}, which is about the
   * timer that happens to be armed right now. This is about the client: a caller
   * deciding how long to keep waiting after a drop is asking whether a
   * reconnect is coming at all, and the honest answer stops being yes only once
   * this client has been hung up on.
   */
  override willReconnect(): boolean {
    return !this.closed;
  }

  /**
   * What this client owes the Core on every connection, in the one order that
   * works.
   *
   * `reclaim` first (via `super`): it is the only frame on this path with a clock
   * on it (ADR 0024 D9). Until it lands, the socket this connection replaces is
   * still holding this client's Sessions and the Core cannot tell it from a live
   * one. `subscribe` and the PTY re-subscription are catching up on what happened
   * while we were away and lose nothing by going second.
   *
   * Then `subscribe`, carrying the cursor — the Core streams the tail past it and
   * ends with `eventsReplayed`. Then the PTY subscriptions, which died with the
   * previous socket.
   *
   * Everything here runs after `auth` has been accepted, because the Core refuses
   * all three before authentication, and after `ready`, because all three are
   * gated on the capability that frame announces. That ordering is load-bearing
   * rather than incidental, and the transport is what guarantees it: it does not
   * call this until the connection is both open and authenticated.
   */
  protected override onConnectionEstablished(): void {
    this.reconnectAttempt = 0;
    super.onConnectionEstablished();
    this.sendSubscribe();
    this.resendPtySubscriptions();
  }

  /**
   * Ask the Core for the event-log tail past this client's cursor.
   *
   * Fire-and-forget: the answer is the `event` stream and the `eventsReplayed`
   * marker, not a reqId-correlated response, so there is nothing here to await.
   * A send that fails is a socket that just died, and the next connection sends
   * this again with the same cursor.
   */
  private sendSubscribe(): void {
    this.caughtUp = false;
    this.subscribeEvents(this.lastEventId);
  }

  /**
   * Re-ask for every PTY this client had, on a connection that has just come up.
   *
   * `catchUp` is deliberately not set. A hold is released by a `replay` from the
   * same client, and nothing here is going to send one — the surfaces that replay
   * do it off their own reconnect, one layer up, and a hold nobody releases is a
   * pane that stays blank forever. Going live immediately is also exactly what
   * this path did before subscriptions existed.
   */
  private resendPtySubscriptions(): void {
    // The same deliberate single-connection fallback `ptySubscribe` takes: a Core
    // without the capability is already sending these PTYs to every connection.
    if (!this.canSendMultiConnectionFrames()) return;
    for (const ptyId of this.subscribedPtys) {
      void this.rpc({ type: "ptySubscribe", reqId: "", ptyId, catchUp: false }).catch(() => {
        /* the socket died again; the next connection re-sends the whole set */
      });
    }
  }

  /**
   * Ask for one PTY's stream and remember the want, so a reconnect restores it.
   *
   * Idempotent on both sides: a second call for a PTY already held is a no-op
   * here and an ack there. The capability fallback is
   * {@link CoreClient.ptySubscribe}'s, unchanged — and the want is recorded
   * either way, for the reason given on {@link subscribedPtys}.
   */
  override ptySubscribe(ptyId: string, opts: { catchUp?: boolean } = {}): Promise<void> {
    if (this.subscribedPtys.has(ptyId)) return Promise.resolve();
    this.subscribedPtys.add(ptyId);
    return super.ptySubscribe(ptyId, opts);
  }

  /** Stop receiving one PTY's stream, and stop re-asking for it on reconnect. */
  override ptyUnsubscribe(ptyId: string): Promise<void> {
    if (!this.subscribedPtys.delete(ptyId)) return Promise.resolve();
    return super.ptyUnsubscribe(ptyId);
  }

  // ─── The event cursor ──────────────────────────────────────────────────────

  /**
   * One event off the log — replayed or live, the same frame either way.
   *
   * Deduped against the cursor before anything above sees it: a replay overlaps
   * by design (the Core streams everything *past* a cursor, and a re-delivery
   * after a reconnect is ordinary), so a listener that received the same event
   * twice would double-count a status change or paint a question menu twice. The
   * cursor advances and is persisted on every event that gets through, which is
   * what makes the *next* reconnect's tail start in the right place.
   */
  protected override deliverEvent(event: CoreLinkEvent): void {
    if (event.eventId <= this.lastEventId) return;
    this.lastEventId = event.eventId;
    this.persistCursor();
    super.deliverEvent(event);
  }

  /**
   * End of the replay tail. The marker is authoritative for the caught-up cursor
   * — it advances even when no `event` frame preceded it, which is the empty-tail
   * case and the common one for a client that dropped and came straight back.
   */
  protected override deliverEventsReplayed(lastEventId: number): void {
    if (lastEventId > this.lastEventId) {
      this.lastEventId = lastEventId;
      this.persistCursor();
    }
    this.caughtUp = true;
    super.deliverEventsReplayed(this.lastEventId);
  }

  /** The highest eventId this client has seen. Mirrors the persisted cursor. */
  getLastEventId(): number {
    return this.lastEventId;
  }

  /** True once this connection's replay tail has been fully delivered. */
  isCaughtUp(): boolean {
    return this.caughtUp;
  }

  private readPersistedCursor(): number {
    try {
      const raw = this.storage.getItem(this.cursorStorageKey);
      const n = raw == null ? NaN : Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch {
      // A store that throws on read is a store this client can still run without
      // — it replays from 0 once, which is correct, if slower.
      return 0;
    }
  }

  private persistCursor(): void {
    try {
      this.storage.setItem(this.cursorStorageKey, String(this.lastEventId));
    } catch {
      /* storage unavailable — the in-memory cursor still carries the reconnect */
    }
  }

  // ─── Reconnection ──────────────────────────────────────────────────────────

  /**
   * Exponential backoff from {@link DEFAULT_RECONNECT_INITIAL_MS} up to
   * {@link DEFAULT_RECONNECT_MAX_MS}, reset by a connection that comes up.
   *
   * The ceiling is low on purpose: a Core is a machine an operator restarts, so
   * the common case is a gap of a few seconds and the right behaviour is to keep
   * knocking at a steady rate rather than to back off into minutes and leave a
   * pane blank long after the Core came back.
   */
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
      if (this.closed) return;
      this.openTransport();
    }, delay);
  }

  /** Hang up for good: stop the backoff, then everything {@link CoreClient.close} does. */
  override close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    super.close();
  }
}
