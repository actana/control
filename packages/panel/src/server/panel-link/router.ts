import {
  coreLinkError,
  decodeClientFrame,
  type CoreLinkPushFrame,
  type PanelLinkClientFrame,
  type PanelLinkServerFrame,
} from "~/shared/panel-link";
import type { CoreLinkEvent, CoreLinkResponseFrame } from "@actana/shared/core-link-frames";
import type { CoreDialStatus } from "~/shared/cores";
import type { CoreLinkClientLike } from "../services/core-link-manager";

/**
 * The panel-link router — the piece that makes one WebSocket per tab enough.
 *
 * Fan-out: a browser addresses any core-link request frame to a `coreId`; the
 * router hands it to that Core's link and posts the answer back under the reqId
 * the browser chose. Fan-in: everything a Core pushes — PTY output, exits,
 * domain events — goes to every tab watching that Core, tagged with its
 * `coreId`. Plus the one thing only the service knows: whether a Core is
 * reachable at all.
 *
 * The router translates nothing. A frame that goes down the core-link is the
 * frame the browser wrote, and a frame that comes back up is the frame the
 * Core wrote. The exceptions are the two subscription frames, and they are
 * exceptions for the same structural reason: the *service* holds the core-link,
 * and several tabs may be watching it at once.
 *
 * `subscribe` (the event cursor) — one tab reconnecting must not re-subscribe
 * the shared link and replay the Core's log at every other tab. So the router
 * answers it itself, out of a buffer of the recent tail it has been keeping
 * since the link came up.
 *
 * `ptySubscribe` / `ptyUnsubscribe` (issue 142) — a Core now sends a PTY's
 * output only to the connections that asked for it, and the connection is the
 * service's, shared by every tab. Forwarded verbatim, the second tab to close a
 * pane on a PTY would unsubscribe the first tab's still-open one and blank it.
 * So the router owns the link's subscription set: it refcounts per `ptyId`
 * across sessions, subscribes on the first claim, unsubscribes on the last, and
 * releases a tab's claims when its socket goes away.
 */

/** What the router needs from the thing that owns the core-links. */
export interface CoreLinkSource {
  client(coreId: string): CoreLinkClientLike | null;
  onClient(cb: (coreId: string, client: CoreLinkClientLike) => void): () => void;
  onStatusChange(cb: (status: CoreDialStatus) => void): () => void;
  statuses(): CoreDialStatus[];
}

/** The browser end of one panel link, as the router sees it. */
export interface PanelLinkSocket {
  send(frame: PanelLinkServerFrame): void;
  close(): void;
}

/**
 * How many recent events per Core the router keeps for browser replay.
 *
 * This bounds "a tab was away and came back": a reconnect after a dropped
 * network takes seconds and lands well inside it. A tab away for longer than
 * the buffer gets the tail plus the caught-up marker — and its views refetch on
 * reconnect anyway, so it converges on the truth rather than on a stale prefix
 * of it. The buffer is deliberately not persisted: the durable log lives on the
 * Core, and the service's own cursor (the registry's) is what replays it.
 */
const DEFAULT_EVENT_BUFFER_SIZE = 2048;

export type PanelLinkRouterOptions = {
  eventBufferSize?: number;
};

type CoreState = {
  /** The recent event tail, ascending by eventId. */
  buffer: CoreLinkEvent[];
  /** The highest eventId this Core has produced since its link came up. */
  head: number;
  /** Torn down when the router is disposed. */
  unsubscribes: Array<() => void>;
  /**
   * How many tabs are currently rendering each of this Core's PTYs. The link
   * carries one subscription per `ptyId` however many tabs want it; the count
   * is what decides when to open and close it (issue 142).
   */
  ptyClaims: Map<string, number>;
};

export class PanelLinkRouter {
  private readonly sessions = new Set<PanelLinkSession>();
  private readonly cores = new Map<string, CoreState>();
  private readonly eventBufferSize: number;
  private readonly unsubscribes: Array<() => void> = [];
  /**
   * Which Cores the service has marked "needs update". The link to such a Core
   * stays open — that is how the Panel finds out the moment it is updated — but
   * nothing of its data reaches a browser. The gate lives here because this is
   * the one place every frame in either direction passes through, and ADR 0005
   * wants exactly one answer to "can I use this Core", not a feature check per
   * call site.
   */
  private readonly gated = new Set<string>();

  constructor(
    private readonly source: CoreLinkSource,
    opts: PanelLinkRouterOptions = {},
  ) {
    this.eventBufferSize = opts.eventBufferSize ?? DEFAULT_EVENT_BUFFER_SIZE;
    for (const status of this.source.statuses()) this.applyGate(status);
    this.unsubscribes.push(
      this.source.onClient((coreId, client) => this.bind(coreId, client)),
      this.source.onStatusChange((status) => {
        this.applyGate(status);
        this.broadcast({ t: "dial", status });
      }),
    );
  }

  /** @internal — is this Core's data path suppressed right now? */
  gatedForUpdate(coreId: string): boolean {
    return this.gated.has(coreId);
  }

  /**
   * The gate is sticky, and only one state lifts it. `needs-update` closes it;
   * `connected` opens it, because the manager reaches `connected` only after a
   * `ready` frame this build could speak. Every other state — a flap to
   * `connecting`, an `unreachable` stretch, an auth failure — says nothing
   * about which protocol the Core speaks, and treating it as an answer would
   * re-open the gate on a Core that has not changed at all.
   */
  private applyGate(status: CoreDialStatus): void {
    if (status.state === "needs-update") this.gated.add(status.coreId);
    else if (status.state === "connected") this.gated.delete(status.coreId);
  }

  /** Take over a freshly upgraded socket. One call per browser tab. */
  attach(socket: PanelLinkSocket): PanelLinkSession {
    const session = new PanelLinkSession(this, socket);
    this.sessions.add(session);
    // What the service already knows about the fleet, so the tab paints live
    // status without waiting for something to change.
    for (const status of this.source.statuses()) socket.send({ t: "dial", status });
    return session;
  }

  /** @internal — called by a session when its socket goes away. */
  forget(session: PanelLinkSession): void {
    this.sessions.delete(session);
  }

  /** Drop every session and stop watching the links. */
  dispose(): void {
    for (const session of [...this.sessions]) session.detach();
    for (const state of this.cores.values()) {
      for (const off of state.unsubscribes) off();
    }
    this.cores.clear();
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
  }

  /** @internal — the live link for a Core, or null while it is down. */
  link(coreId: string): CoreLinkClientLike | null {
    return this.source.client(coreId);
  }

  /**
   * @internal — everything a tab asking to `subscribe` from `lastEventId` is
   * owed: the events it missed, then the marker saying where it now stands.
   *
   * `lastEventId: 0` means "I have seen nothing" — a tab that just opened. It
   * gets the head rather than the buffer: its views load current state through
   * queries, and replaying thousands of historical events at it would only make
   * it refetch what it is already fetching.
   */
  replayFor(coreId: string, lastEventId: number): { events: CoreLinkEvent[]; head: number } {
    const state = this.cores.get(coreId);
    if (!state) return { events: [], head: 0 };
    if (lastEventId <= 0) return { events: [], head: state.head };
    return {
      events: state.buffer.filter((e) => e.eventId > lastEventId),
      head: state.head,
    };
  }

  /**
   * @internal — one tab now renders this Core's `ptyId`. The link is asked for
   * it on the first claim only; every later claim rides the same subscription.
   *
   * `catchUp` is honoured on that first claim, because it is the only one that
   * creates a hold on the Core. A later claim arriving while the stream is
   * already live gets no hold — and needs none: it is a tab that will replay
   * for itself, and the browser buffers its own live bytes while that replay is
   * in flight (see `pty-stream-router`).
   *
   * A Core that does not announce `multiConnection` is not an error path here:
   * the client resolves this call without sending anything, because such a Core
   * already fans that PTY out to every connection (ADR 0024 D11). The `catch`
   * below is for a link that is genuinely down, not for that fallback.
   */
  claimPty(coreId: string, ptyId: string, catchUp: boolean): void {
    const state = this.cores.get(coreId);
    if (!state) return;
    const held = state.ptyClaims.get(ptyId) ?? 0;
    state.ptyClaims.set(ptyId, held + 1);
    if (held > 0) return;
    void this.source.client(coreId)?.ptySubscribe(ptyId, { catchUp })?.catch(() => {
      /* the link is down; `bind` re-subscribes when it comes back */
    });
  }

  /** @internal — one tab has stopped rendering this Core's `ptyId`. */
  releasePty(coreId: string, ptyId: string): void {
    const state = this.cores.get(coreId);
    if (!state) return;
    const held = state.ptyClaims.get(ptyId) ?? 0;
    if (held <= 1) {
      state.ptyClaims.delete(ptyId);
      void this.source.client(coreId)?.ptyUnsubscribe(ptyId)?.catch(() => {
        /* the link is down; its subscriptions died with it anyway */
      });
      return;
    }
    state.ptyClaims.set(ptyId, held - 1);
  }

  private bind(coreId: string, client: CoreLinkClientLike): void {
    const existing = this.cores.get(coreId);
    if (existing) for (const off of existing.unsubscribes) off();
    const state: CoreState = {
      buffer: [],
      head: existing?.head ?? 0,
      unsubscribes: [],
      // Claims outlive the link they were made through: the tabs holding them
      // are still open, and their panes are still on screen. A fresh client for
      // this Core is a fresh Core-side connection with no subscriptions on it,
      // so every claim is re-asked for below.
      ptyClaims: existing?.ptyClaims ?? new Map(),
    };
    this.cores.set(coreId, state);
    for (const ptyId of state.ptyClaims.keys()) {
      void client.ptySubscribe(ptyId)?.catch(() => {
        /* still down — the next client for this Core tries again */
      });
    }

    state.unsubscribes.push(
      client.onEvent(({ event }) => {
        if (event.eventId > state.head) state.head = event.eventId;
        state.buffer.push(event);
        if (state.buffer.length > this.eventBufferSize) {
          state.buffer.splice(0, state.buffer.length - this.eventBufferSize);
        }
        this.push(coreId, { type: "event", event });
      }),
      client.onData((msg) => this.push(coreId, { type: "data", ...msg })),
      client.onExit((msg) => this.push(coreId, { type: "exit", ...msg })),
    );
  }

  /** Send a Core's push frame to every tab watching that Core. */
  private push(coreId: string, frame: CoreLinkPushFrame): void {
    // A gated Core's frames stop here. Its vocabulary is one this build does
    // not share, so what it is saying is not something a browser should try to
    // render — it is evidence the operator has a machine to update.
    if (this.gated.has(coreId)) return;
    for (const session of this.sessions) {
      if (session.watches(coreId)) session.send({ t: "core", coreId, frame });
    }
  }

  private broadcast(frame: PanelLinkServerFrame): void {
    for (const session of this.sessions) session.send(frame);
  }
}

/**
 * One tab's link. Holds the only per-tab state there is: which Cores this tab
 * has subscribed to, and which of their PTYs it is rendering. Cursors are the
 * tab's own — it tells us where it is on every subscribe — so a second tab, or
 * a reload, costs the service nothing.
 */
export class PanelLinkSession {
  private readonly watching = new Set<string>();
  /**
   * The PTYs this tab has claimed, as `coreId` → `ptyId`s. Per session, not per
   * link: it is what the router refcounts, and what has to be given back when
   * this socket goes away — a tab that closes with panes open must not leave
   * the service subscribed to their output forever.
   *
   * A set per Core also makes a tab's own claims idempotent: a pane rebuilding
   * on the same `ptyId` re-sends `ptySubscribe`, and that must not count twice
   * and strand the subscription at refcount 1 after the tab is gone.
   */
  private readonly claimedPtys = new Map<string, Set<string>>();
  private detached = false;

  constructor(
    private readonly router: PanelLinkRouter,
    private readonly socket: PanelLinkSocket,
  ) {}

  /** Handle a frame straight off the wire, in whatever shape the socket gave it. */
  receiveRaw(raw: unknown): Promise<void> | void {
    const frame = decodeClientFrame(raw);
    // A tab that sends nonsense is a tab with a bug, not an attacker worth
    // disconnecting over — and dropping the socket would take its terminals
    // with it. Ignore the frame and keep the link.
    if (!frame) return;
    return this.receive(frame);
  }

  receive(frame: PanelLinkClientFrame): Promise<void> | void {
    if (this.detached) return;
    const { coreId, frame: inner } = frame;
    if (inner.type === "subscribe") {
      this.watching.add(coreId);
      const { events, head } = this.router.replayFor(coreId, inner.lastEventId);
      for (const event of events) this.send({ t: "core", coreId, frame: { type: "event", event } });
      this.send({ t: "core", coreId, frame: { type: "eventsReplayed", lastEventId: head } });
      return;
    }
    // The router owns the link's PTY subscriptions, so these two are answered
    // here rather than forwarded (issue 142). The ack a tab gets back says what
    // is true for *this tab* — it is rendering that PTY, or it is not — which is
    // the only thing it can act on; whether the shared link had to open or close
    // a subscription underneath is the router's business, not the browser's.
    if (inner.type === "ptySubscribe") {
      this.claimPty(coreId, inner.ptyId, inner.catchUp === true);
      this.send({
        t: "core",
        coreId,
        frame: {
          type: "ptySubscribeAck",
          reqId: inner.reqId,
          ptyId: inner.ptyId,
          subscribed: true,
          // Not a claim about the Core: the router answers before (or without)
          // asking it, so it cannot know whether a hold was armed on the shared
          // link. It is reported as `false` because it is nothing this tab can
          // act on — the tab's own `replay` releases whatever hold exists — and
          // nothing in the Panel reads it. A tab that needs the truth would
          // have to be told by the Core, which means not answering here.
          holding: false,
        },
      });
      return;
    }
    if (inner.type === "ptyUnsubscribe") {
      this.releasePty(coreId, inner.ptyId);
      this.send({
        t: "core",
        coreId,
        frame: {
          type: "ptyUnsubscribeAck",
          reqId: inner.reqId,
          ptyId: inner.ptyId,
          subscribed: false,
        },
      });
      return;
    }
    return this.forward(coreId, inner);
  }

  private claimPty(coreId: string, ptyId: string, catchUp: boolean): void {
    let held = this.claimedPtys.get(coreId);
    if (!held) {
      held = new Set();
      this.claimedPtys.set(coreId, held);
    }
    if (held.has(ptyId)) return;
    held.add(ptyId);
    this.router.claimPty(coreId, ptyId, catchUp);
  }

  private releasePty(coreId: string, ptyId: string): void {
    const held = this.claimedPtys.get(coreId);
    if (!held?.delete(ptyId)) return;
    if (held.size === 0) this.claimedPtys.delete(coreId);
    this.router.releasePty(coreId, ptyId);
  }

  private async forward(coreId: string, inner: PanelLinkClientFrame["frame"]): Promise<void> {
    const reqId = inner.reqId;
    if (this.router.gatedForUpdate(coreId)) {
      this.send({
        t: "core",
        coreId,
        frame: coreLinkError(
          reqId,
          `core ${coreId} needs an update — its Core speaks a different core-link protocol`,
        ),
      });
      return;
    }
    const link = this.router.link(coreId);
    if (!link) {
      this.send({
        t: "core",
        coreId,
        frame: coreLinkError(reqId, `core ${coreId} is not connected`),
      });
      return;
    }
    try {
      const response = await link.request(inner);
      // The link assigned its own reqId on its own socket; the tab is waiting on
      // the one it chose, so hand it back its own. The cast is the price of
      // rewriting one field across a discriminated union — the frame is
      // otherwise untouched, which is the whole point of a router.
      const answer = { ...response, reqId } as CoreLinkResponseFrame;
      this.send({ t: "core", coreId, frame: answer });
    } catch (err) {
      this.send({
        t: "core",
        coreId,
        frame: coreLinkError(reqId, err instanceof Error ? err.message : String(err)),
      });
    }
  }

  watches(coreId: string): boolean {
    return this.watching.has(coreId);
  }

  send(frame: PanelLinkServerFrame): void {
    if (this.detached) return;
    this.socket.send(frame);
  }

  /** The socket went away (or we are shutting down). Idempotent. */
  detach(): void {
    if (this.detached) return;
    this.detached = true;
    // Give back every PTY this tab was rendering. A closed tab is not a reason
    // to keep pulling a Core's output across the link, and the refcount is what
    // keeps the tabs that are still open unaffected by this one leaving.
    for (const [coreId, ptyIds] of this.claimedPtys) {
      for (const ptyId of ptyIds) this.router.releasePty(coreId, ptyId);
    }
    this.claimedPtys.clear();
    this.watching.clear();
    this.router.forget(this);
  }
}
