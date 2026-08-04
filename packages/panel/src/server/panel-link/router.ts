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
 * Core wrote. The single exception is `subscribe`, and it is an exception
 * for a structural reason: the *service* holds the core-link, and several tabs
 * may be watching it at once with different cursors. One tab reconnecting must
 * not re-subscribe the shared link and replay the Core's log at every other
 * tab. So the router answers `subscribe` itself, out of a buffer of the recent
 * tail it has been keeping since the link came up.
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

  private bind(coreId: string, client: CoreLinkClientLike): void {
    const existing = this.cores.get(coreId);
    if (existing) for (const off of existing.unsubscribes) off();
    const state: CoreState = { buffer: [], head: existing?.head ?? 0, unsubscribes: [] };
    this.cores.set(coreId, state);

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
 * has subscribed to. Cursors are the tab's own — it tells us where it is on
 * every subscribe — so a second tab, or a reload, costs the service nothing.
 */
export class PanelLinkSession {
  private readonly watching = new Set<string>();
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
    return this.forward(coreId, inner);
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
    this.watching.clear();
    this.router.forget(this);
  }
}
