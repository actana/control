import {
  coreLinkError,
  decodeClientFrame,
  type CoreLinkPushFrame,
  type PanelLinkClientFrame,
  type PanelLinkServerFrame,
} from "~/shared/panel-link";
import type {
  CoreLinkEvent,
  CoreLinkRequestFrame,
  CoreLinkResponseFrame,
} from "@actana/sdk/core-link-frames";
import type { CoreDialStatus } from "~/shared/cores";
import type { CoreLinkClientLike } from "../services/core-link-manager";
import { SessionLockRegister } from "./session-lock-register";
import { SessionDriveRegister } from "./session-drive-register";

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
 *
 * Session write access (issue 147) lands here for the same structural reason,
 * and it is **two things with two names**:
 *
 * The **Session lock** is Core-scoped. It is held by the connection, the
 * connection is the service's, so its state is one answer for the whole Panel —
 * kept by a {@link SessionLockRegister} per Core and relayed to every tab
 * watching that Core. The claim / release / forceTakeover frames themselves are
 * ordinary core-link frames and are *forwarded*, not answered here; the router
 * only watches their answers go past, because it is the one place that can
 * turn one connection's answer into every tab's view.
 *
 * The **Session drive** is Panel-scoped and never crosses a core-link at all.
 * The Panel holds one Session lock for all its tabs, so which tab drives is the
 * Panel's own business (ADR 0024 D3) — arbitrated by a
 * {@link SessionDriveRegister} per Core, per tab, over the panel link's own
 * `drive` frame. Reporting it as a lock, anywhere, is the thing issue 147 says
 * not to do.
 *
 * Both are gated on the Core's `multiConnection` capability. Against a Core
 * without it there is no lock table to be a Reader of and every client but one
 * is evicted, so a Panel that arbitrated anyway would be inventing a constraint
 * its Core does not have — and the promise for such a Core is exactly today's
 * behaviour, not a near-miss of it.
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
  /**
   * The **Session lock** as this Core's link sees it — one answer for the whole
   * Panel, because one connection holds it (issue 147, ADR 0024 D8).
   *
   * Outlives the link it was built for only in identity: {@link bind} resets it
   * when a new client arrives, because a dropped connection releases every lock
   * it held and a register that carried holds across a reconnect would tell
   * every tab it may write Sessions the Core has already given back.
   */
  locks: SessionLockRegister;
  /**
   * Which tab drives each of this Core's Sessions — the **Session drive**,
   * Panel-scoped, nothing to do with the lock above (issue 147, ADR 0024 D3).
   *
   * Survives the link, unlike the lock register: the tabs holding these panes
   * are still open and still on screen, and a Core going away for ten seconds
   * is no reason to re-arbitrate a keyboard the operator has already placed.
   */
  drives: SessionDriveRegister<PanelLinkSession>;
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

  /**
   * @internal — this Core's state, created on first need.
   *
   * Lazy because a tab can reach for a Core's drive arbitration before its link
   * has ever come up, and being unable to say which of two tabs drives a pane
   * just because a machine is briefly unreachable would be an arbitrary answer
   * to a question that has nothing to do with the machine.
   */
  private stateFor(coreId: string): CoreState {
    const existing = this.cores.get(coreId);
    if (existing) return existing;
    const state: CoreState = {
      buffer: [],
      head: 0,
      unsubscribes: [],
      ptyClaims: new Map(),
      locks: new SessionLockRegister(
        () => this.source.client(coreId)?.canSendMultiConnectionFrames() === true,
      ),
      drives: new SessionDriveRegister<PanelLinkSession>(),
    };
    state.locks.onChange(({ taskId, lock }) => {
      for (const session of this.sessions) {
        if (session.watches(coreId)) session.send({ t: "lock", coreId, taskId, lock });
      }
    });
    this.cores.set(coreId, state);
    return state;
  }

  /** @internal — the Session lock this Core's link currently reports for a Session. */
  lockFor(coreId: string, taskId: string) {
    return this.stateFor(coreId).locks.lockFor(taskId);
  }

  /** @internal — a tab's answer for one Session's drive, as it should be told it. */
  driveFor(coreId: string, taskId: string, session: PanelLinkSession): boolean {
    return this.stateFor(coreId).drives.driverOf(taskId) === session;
  }

  /**
   * @internal — a tab wants (or gives back) the keyboard for one Session, among
   * this Panel's own tabs. Never the Session lock; see the module comment.
   *
   * Gated on `multiConnection` like everything else in issue 147: against a
   * Core that evicts every client but one, two tabs both writing is what the
   * Panel does today, and the promise for such a Core is today's behaviour
   * exactly. The tab is answered `driving: true` regardless, because that is
   * true — nothing is arbitrating it, so nothing is stopping it typing.
   */
  wantDrive(
    coreId: string,
    taskId: string,
    session: PanelLinkSession,
    want: "watch" | "take" | "drop",
  ): void {
    const state = this.stateFor(coreId);
    // A pane announcing itself is also how a tab learns where the Session lock
    // stands, and it has to be: the register publishes changes, and a tab that
    // opened after the last one would otherwise hold a pane with no answer at
    // all until something moved. One gesture, both facts, before a keystroke.
    if (want !== "drop") {
      session.send({ t: "lock", coreId, taskId, lock: state.locks.lockFor(taskId) });
    }
    if (this.source.client(coreId)?.canSendMultiConnectionFrames() !== true) {
      if (want !== "drop") {
        session.send({ t: "drive", coreId, taskId, driving: true, reason: "watch" });
      }
      return;
    }
    const change =
      want === "drop"
        ? state.drives.release(taskId, session)
        : state.drives.want(taskId, session, { take: want === "take" });
    // The loser of an intra-Panel handover is told, and told in its own
    // vocabulary: `handover`, never a takeover. Nothing was taken from this
    // operator — they moved their own keyboard between their own tabs, and this
    // tab keeps rendering every byte of the Session either way.
    for (const loser of change.lost) {
      if (loser === session) continue;
      loser.send({ t: "drive", coreId, taskId, driving: false, reason: "handover" });
    }
    // The winner is never told a story. `handover` is the *loser's* word, for
    // the one case worth a sentence — the keyboard left an open pane. A tab
    // that gains the drive because another tab closed gained nothing from
    // anybody, and telling it "you took this in another tab" would be a
    // sentence about something that did not happen.
    for (const winner of change.gained) {
      winner.send({ t: "drive", coreId, taskId, driving: true, reason: "watch" });
    }
    // The asking tab always gets an answer, even when nothing moved: it asked a
    // question ("may I drive this?") and a pane with no answer would have to
    // guess, which is the read-only-discovered-by-a-keystroke failure again.
    if (want !== "drop" && !change.gained.includes(session)) {
      session.send({ t: "drive", coreId, taskId, driving: false, reason: "watch" });
    }
  }

  /**
   * @internal — a tab's socket went away; it drives nothing any more, and every
   * Session it was driving falls to the next tab still watching.
   *
   * A tab that comes *back* — a reload, a dropped network — re-announces its
   * panes and joins the back of the queue, so on a Panel with two tabs open on
   * one Session a flap can move the keyboard to the other one. That is the
   * first-come rule applied evenly rather than a special case: the tab that has
   * it says so on screen, taking it back is one click, and the alternative is a
   * grace period holding a keyboard for a tab that may never return.
   */
  releaseDrives(session: PanelLinkSession): void {
    for (const [coreId, state] of this.cores) {
      for (const change of state.drives.releaseAll(session)) {
        for (const winner of change.gained) {
          winner.send({
            t: "drive",
            coreId,
            taskId: change.taskId,
            driving: true,
            reason: "watch",
          });
        }
      }
    }
  }

  /**
   * @internal — the answers this Core's link gave one tab, read on their way
   * past for what they say about the Session lock (issue 147, ADR 0024 D8).
   *
   * Read here rather than answered here: these are core-link frames and the
   * router forwards them untouched, which is the whole point of a router. What
   * it does do is notice, because one tab's `claimResult` is every tab's news —
   * the lock is held by the connection they all share, so an answer to one of
   * them has already changed what is true for the rest.
   */
  observeAnswer(coreId: string, answer: CoreLinkResponseFrame): void {
    const locks = this.stateFor(coreId).locks;
    switch (answer.type) {
      case "tasksListResult":
      case "archivedTasksListResult":
        locks.applySnapshots(answer.tasks);
        return;
      case "sessionsListResult":
        locks.applySnapshots(answer.sessions);
        return;
      case "tasksMutateResult":
        if (answer.task) locks.applySnapshots([answer.task]);
        return;
      case "claimResult":
        locks.applyClaimResult(answer.taskId, answer.granted);
        return;
      case "releaseResult":
        locks.applyReleaseResult(answer.taskId, answer.released);
        return;
      case "forceTakeoverResult":
        locks.applyForceTakeoverResult(answer.taskId, answer.takenFrom);
        return;
      default:
        return;
    }
  }

  private bind(coreId: string, client: CoreLinkClientLike): void {
    const state = this.stateFor(coreId);
    for (const off of state.unsubscribes) off();
    state.unsubscribes = [];
    // A fresh Core-side connection: no subscriptions on it, and — because a
    // dropped connection releases every lock it held (ADR 0024 D7) — no locks
    // either. The claims below are re-asked for; the locks are re-learned from
    // the `reclaim` this link sends on connect and from the first list a tab
    // makes. Claims outlive the link because the tabs holding them are still
    // open with their panes on screen; holds cannot, because the Core has
    // already given them back.
    state.buffer = [];
    state.locks.reset();
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
        // Before the tabs see it, so a tab that refetches on the event reads a
        // register that already agrees with what it is about to be told.
        state.locks.applyEvent(event);
        this.push(coreId, { type: "event", event });
      }),
      client.onData((msg) => this.push(coreId, { type: "data", ...msg })),
      client.onExit((msg) => this.push(coreId, { type: "exit", ...msg })),
      // The Sessions whose locks came across from the socket this connection
      // replaced (issue 146, ADR 0024 D9). The one thing that says so: the
      // transfer is a rewrite in place and appends no event, so without this a
      // reconnected Panel would render Sessions it is holding as read-only
      // until something refetched them.
      client.onReclaimed(({ taskIds }) => state.locks.applyReclaimed(taskIds)),
      // `ready` is where the `multiConnection` answer lands, and it is also the
      // first frame of a *new* connection — one that holds nothing yet. Both
      // readings say the same thing: empty the register and let it be re-learned
      // from the reclaim that follows and from the first list a view makes on
      // reconnect. Between the two, a Session another client took while this
      // Panel was away reads as unlocked for as long as it takes a view to
      // refetch — briefly optimistic, never silently wrong, and the write it
      // would allow in that window is refused by the Core with `session-locked`
      // exactly as it is for any client that never claimed.
      client.onProtocolVersion(() => state.locks.reset()),
      client.onDisconnected(() => state.locks.reset()),
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
    // The intra-Panel drive (issue 147, ADR 0024 D3). Answered here and never
    // forwarded: there is nothing on a core-link to forward it to, and that is
    // the point — the Panel holds one Session lock for all its tabs, so which
    // of them drives is settled between Panel sessions, here.
    if (frame.t === "drive") {
      this.router.wantDrive(frame.coreId, frame.taskId, this, frame.want);
      return;
    }
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

  private async forward(coreId: string, inner: CoreLinkRequestFrame): Promise<void> {
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
      // Read for what it says about the Session lock before it is handed back
      // (issue 147). One tab's answer is every tab's news — they share the
      // connection that holds the lock — and this is the only place all of it
      // passes through. Reading it changes nothing about the frame.
      this.router.observeAnswer(coreId, response);
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
    // Give back the keyboard too (issue 147). A closed tab that kept driving
    // would leave the tab still on screen read-only with nothing to take the
    // drive from — the Session drive is arbitration between live tabs, and a
    // tab that has gone is not one of them. The Session *lock* is untouched:
    // the Panel is still that Core's client and still holds what it holds.
    this.router.releaseDrives(this);
    this.router.forget(this);
  }
}
