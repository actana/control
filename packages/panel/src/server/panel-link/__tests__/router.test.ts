import { beforeEach, describe, expect, it } from "vitest";
import type {
  CoreLinkEvent,
  CoreLinkRequestFrame,
  CoreLinkResponseFrame,
} from "@actana/shared/core-link-frames";
import type { CoreDialStatus } from "~/shared/cores";
import type { CoreLinkClientLike } from "../../services/core-link-manager";
import { PanelLinkRouter, type CoreLinkSource } from "../router";
import type { PanelLinkServerFrame } from "~/shared/panel-link";

/**
 * The router is driven exactly as the two things around it drive it: fake
 * browsers send client frames in, a fake set of core-links pushes frames out.
 * What is asserted is what a tab would actually observe on its socket.
 */

class FakeCoreLink implements CoreLinkClientLike {
  answers: (frame: CoreLinkRequestFrame) => CoreLinkResponseFrame | Promise<CoreLinkResponseFrame> =
    (frame) => ({ type: "tasksListResult", reqId: frameReqId(frame), tasks: [] });
  readonly sent: CoreLinkRequestFrame[] = [];
  private data?: (msg: { ptyId: string; data: string; seq: number }) => void;
  private exit?: (msg: { ptyId: string; exitCode: number; signal?: number }) => void;
  private event?: (msg: { event: CoreLinkEvent }) => void;

  onAuthOk() {
    return () => {};
  }
  onAuthError() {
    return () => {};
  }
  onDisconnected() {
    return () => {};
  }
  onProtocolVersion() {
    return () => {};
  }
  onData(cb: (msg: { ptyId: string; data: string; seq: number }) => void) {
    this.data = cb;
    return () => {};
  }
  onExit(cb: (msg: { ptyId: string; exitCode: number; signal?: number }) => void) {
    this.exit = cb;
    return () => {};
  }
  onEvent(cb: (msg: { event: CoreLinkEvent }) => void) {
    this.event = cb;
    return () => {};
  }
  request(frame: CoreLinkRequestFrame): Promise<CoreLinkResponseFrame> {
    this.sent.push(frame);
    return Promise.resolve(this.answers(frame));
  }
  close() {}

  pushData(msg: { ptyId: string; data: string; seq: number }) {
    this.data?.(msg);
  }
  pushExit(msg: { ptyId: string; exitCode: number; signal?: number }) {
    this.exit?.(msg);
  }
  pushEvent(event: CoreLinkEvent) {
    this.event?.({ event });
  }
}

function event(eventId: number, kind = "task:statusChanged"): CoreLinkEvent {
  return { eventId, ts: eventId * 10, kind, ptyId: null, taskId: "t1", payload: "{}" };
}

function frameReqId(frame: CoreLinkRequestFrame): string {
  return (frame as { reqId: string }).reqId;
}

/** A fake browser tab: collects everything the router writes to its socket. */
class FakeTab {
  readonly received: PanelLinkServerFrame[] = [];
  closed = false;

  send(frame: PanelLinkServerFrame) {
    this.received.push(frame);
  }
  close() {
    this.closed = true;
  }

  /** Core frames this tab saw for one Core, in order. */
  coreFrames(coreId: string) {
    return this.received.flatMap((f) => (f.t === "core" && f.coreId === coreId ? [f.frame] : []));
  }
  eventIds(coreId: string): number[] {
    return this.coreFrames(coreId).flatMap((f) => (f.type === "event" ? [f.event.eventId] : []));
  }
  dials(): CoreDialStatus[] {
    return this.received.flatMap((f) => (f.t === "dial" ? [f.status] : []));
  }
}

/** A stand-in for the CoreLinkManager: the two things the router asks of it. */
class FakeSource implements CoreLinkSource {
  readonly links = new Map<string, FakeCoreLink>();
  private onClientCb?: (coreId: string, client: CoreLinkClientLike) => void;
  private onStatusCb?: (status: CoreDialStatus) => void;

  client(coreId: string) {
    return this.links.get(coreId) ?? null;
  }
  onClient(cb: (coreId: string, client: CoreLinkClientLike) => void) {
    this.onClientCb = cb;
    for (const [coreId, link] of this.links) cb(coreId, link);
    return () => {};
  }
  onStatusChange(cb: (status: CoreDialStatus) => void) {
    this.onStatusCb = cb;
    return () => {};
  }
  statuses(): CoreDialStatus[] {
    return [...this.links.keys()].map((coreId) => ({ coreId, state: "connected", lastSeenAt: 1 }));
  }

  bring(coreId: string): FakeCoreLink {
    const link = new FakeCoreLink();
    this.links.set(coreId, link);
    this.onClientCb?.(coreId, link);
    return link;
  }
  announce(status: CoreDialStatus) {
    this.onStatusCb?.(status);
  }
}

let source: FakeSource;
let router: PanelLinkRouter;

beforeEach(() => {
  source = new FakeSource();
  router = new PanelLinkRouter(source);
});

/** Attach a tab and give back both halves of the conversation. */
function openTab(): { tab: FakeTab; session: ReturnType<PanelLinkRouter["attach"]> } {
  const tab = new FakeTab();
  const session = router.attach(tab);
  return { tab, session };
}

function subscribe(session: ReturnType<PanelLinkRouter["attach"]>, coreId: string, from: number) {
  session.receive({
    t: "core",
    coreId,
    frame: { type: "subscribe", reqId: "sub1", lastEventId: from },
  });
}

describe("panel-link router · fan-out", () => {
  it("forwards a query to the addressed Core and answers under the same reqId", async () => {
    const link = source.bring("core_a");
    link.answers = (frame) => ({
      type: "projectsListResult",
      reqId: frameReqId(frame),
      projects: [],
    });
    const { tab, session } = openTab();

    await session.receive({
      t: "core",
      coreId: "core_a",
      frame: { type: "projectsList", reqId: "q7" },
    });

    expect(link.sent.map((f) => f.type)).toEqual(["projectsList"]);
    expect(tab.coreFrames("core_a")).toEqual([
      { type: "projectsListResult", reqId: "q7", projects: [] },
    ]);
  });

  it("routes each query to its own Core, so one socket serves the whole fleet", async () => {
    source.bring("core_a");
    source.bring("core_b");
    const { session } = openTab();

    await session.receive({
      t: "core",
      coreId: "core_a",
      frame: { type: "tasksList", reqId: "q1" },
    });
    await session.receive({
      t: "core",
      coreId: "core_b",
      frame: { type: "projectsList", reqId: "q2" },
    });

    expect(source.links.get("core_a")!.sent.map((f) => f.type)).toEqual(["tasksList"]);
    expect(source.links.get("core_b")!.sent.map((f) => f.type)).toEqual(["projectsList"]);
  });

  it("answers for an unreachable Core with an error frame, not silence", async () => {
    const { tab, session } = openTab();

    await session.receive({
      t: "core",
      coreId: "core_gone",
      frame: { type: "tasksList", reqId: "q3" },
    });

    expect(tab.coreFrames("core_gone")).toEqual([
      { type: "error", reqId: "q3", message: expect.stringContaining("core_gone") },
    ]);
  });

  it("turns a core-link that throws into an error frame the caller can settle on", async () => {
    const link = source.bring("core_a");
    link.answers = () => {
      throw new Error("core-link connection lost");
    };
    const { tab, session } = openTab();

    await session.receive({
      t: "core",
      coreId: "core_a",
      frame: { type: "tasksList", reqId: "q4" },
    });

    expect(tab.coreFrames("core_a")).toEqual([
      { type: "error", reqId: "q4", message: "core-link connection lost" },
    ]);
  });
});

describe("panel-link router · fan-in", () => {
  it("streams a Core's events to every subscribed tab", () => {
    const link = source.bring("core_a");
    const a = openTab();
    const b = openTab();
    subscribe(a.session, "core_a", 0);
    subscribe(b.session, "core_a", 0);

    link.pushEvent(event(1));

    expect(a.tab.eventIds("core_a")).toEqual([1]);
    expect(b.tab.eventIds("core_a")).toEqual([1]);
  });

  it("does not stream a Core's events to a tab that never subscribed", () => {
    const link = source.bring("core_a");
    const { tab } = openTab();

    link.pushEvent(event(1));

    expect(tab.eventIds("core_a")).toEqual([]);
  });

  it("tags each frame with the Core it came from, so a tab can demux", () => {
    const a = source.bring("core_a");
    const b = source.bring("core_b");
    const { tab, session } = openTab();
    subscribe(session, "core_a", 0);
    subscribe(session, "core_b", 0);

    a.pushEvent(event(4));
    b.pushEvent(event(9));

    expect(tab.eventIds("core_a")).toEqual([4]);
    expect(tab.eventIds("core_b")).toEqual([9]);
  });

  it("forwards PTY output and exit under the Core's envelope", () => {
    const link = source.bring("core_a");
    const { tab, session } = openTab();
    subscribe(session, "core_a", 0);

    link.pushData({ ptyId: "p1", data: "hello", seq: 3 });
    link.pushExit({ ptyId: "p1", exitCode: 0 });

    expect(tab.coreFrames("core_a")).toEqual([
      { type: "eventsReplayed", lastEventId: 0 },
      { type: "data", ptyId: "p1", data: "hello", seq: 3 },
      { type: "exit", ptyId: "p1", exitCode: 0, signal: undefined },
    ]);
  });

  it("streams a Core that comes up after the tab did", () => {
    const { tab, session } = openTab();
    subscribe(session, "core_late", 0);

    source.bring("core_late").pushEvent(event(2));

    expect(tab.eventIds("core_late")).toEqual([2]);
  });

  it("pushes dial-status changes so a tab sees a Core go away", () => {
    const { tab } = openTab();

    source.announce({ coreId: "core_a", state: "unreachable", lastSeenAt: 111 });

    expect(tab.dials()).toEqual([{ coreId: "core_a", state: "unreachable", lastSeenAt: 111 }]);
  });

  it("stops writing to a tab once it detaches", () => {
    const link = source.bring("core_a");
    const { tab, session } = openTab();
    subscribe(session, "core_a", 0);
    const before = tab.received.length;

    session.detach();
    link.pushEvent(event(1));
    source.announce({ coreId: "core_a", state: "unreachable", lastSeenAt: 1 });

    expect(tab.received.length).toBe(before);
  });
});

describe("panel-link router · replay from a tab's cursor", () => {
  it("replays the events a reconnecting tab missed, then marks it caught up", () => {
    const link = source.bring("core_a");
    const first = openTab();
    subscribe(first.session, "core_a", 0);
    link.pushEvent(event(1));
    link.pushEvent(event(2));
    link.pushEvent(event(3));
    first.session.detach();

    // The tab comes back having seen up to event 1.
    const again = openTab();
    subscribe(again.session, "core_a", 1);

    expect(again.tab.eventIds("core_a")).toEqual([2, 3]);
    expect(again.tab.coreFrames("core_a").at(-1)).toEqual({
      type: "eventsReplayed",
      lastEventId: 3,
    });
  });

  it("gives a brand-new tab the head, not the whole buffer", () => {
    const link = source.bring("core_a");
    const seeded = openTab();
    subscribe(seeded.session, "core_a", 0);
    link.pushEvent(event(1));
    link.pushEvent(event(2));

    const fresh = openTab();
    subscribe(fresh.session, "core_a", 0);

    expect(fresh.tab.eventIds("core_a")).toEqual([]);
    expect(fresh.tab.coreFrames("core_a")).toEqual([{ type: "eventsReplayed", lastEventId: 2 }]);
  });

  it("keeps live events flowing after the replay, in order and without repeats", () => {
    const link = source.bring("core_a");
    const { tab, session } = openTab();
    subscribe(session, "core_a", 0);
    link.pushEvent(event(1));
    link.pushEvent(event(2));

    // A second subscribe on the same session — what a reconnect looks like when
    // the tab kept its cursor.
    subscribe(session, "core_a", 1);
    link.pushEvent(event(3));

    expect(tab.eventIds("core_a")).toEqual([1, 2, 2, 3]);
  });

  it("holds each Core's replay separately", () => {
    const a = source.bring("core_a");
    const b = source.bring("core_b");
    const seed = openTab();
    subscribe(seed.session, "core_a", 0);
    subscribe(seed.session, "core_b", 0);
    a.pushEvent(event(5));
    b.pushEvent(event(6));

    const { tab, session } = openTab();
    subscribe(session, "core_a", 4);
    subscribe(session, "core_b", 5);

    expect(tab.eventIds("core_a")).toEqual([5]);
    expect(tab.eventIds("core_b")).toEqual([6]);
  });

  it("never forwards a subscribe down the core-link — the service owns that", () => {
    const link = source.bring("core_a");
    const { session } = openTab();

    subscribe(session, "core_a", 0);

    expect(link.sent).toEqual([]);
  });

  it("replays from a buffer bounded to the recent tail", () => {
    const bounded = new PanelLinkRouter(source, { eventBufferSize: 3 });
    const link = source.bring("core_a");
    const seed = new FakeTab();
    const seedSession = bounded.attach(seed);
    seedSession.receive({
      t: "core",
      coreId: "core_a",
      frame: { type: "subscribe", reqId: "s", lastEventId: 0 },
    });
    for (const id of [1, 2, 3, 4, 5]) link.pushEvent(event(id));

    const tab = new FakeTab();
    const session = bounded.attach(tab);
    session.receive({
      t: "core",
      coreId: "core_a",
      frame: { type: "subscribe", reqId: "s", lastEventId: 1 },
    });

    // Events 2 has aged out of a 3-deep buffer; the tail is what survives.
    expect(tab.eventIds("core_a")).toEqual([3, 4, 5]);
  });
});

describe("panel-link router · malformed traffic", () => {
  it("ignores a frame it cannot read rather than dropping the tab", async () => {
    const { tab, session } = openTab();

    await session.receiveRaw("not json at all");
    await session.receiveRaw(JSON.stringify({ t: "nonsense" }));

    expect(tab.closed).toBe(false);
    expect(tab.received).toEqual([]);
  });
});

// The version gate (issue 07). A Core the service has marked "needs update"
// keeps its link — that is how the Panel learns the moment it is updated — but
// nothing of its data crosses to a browser. No degraded mode (ADR 0005): the
// tab sees the dial status and nothing else.
describe("panel-link router · a Core that needs updating", () => {
  function needsUpdate(coreId: string): CoreDialStatus {
    return {
      coreId,
      state: "needs-update",
      lastSeenAt: 1,
      coreVersion: "0.1.0",
      panelVersion: "0.8.0",
    };
  }

  it("refuses a query with an actionable error instead of forwarding it", async () => {
    const link = source.bring("core_a");
    const { tab, session } = openTab();
    source.announce(needsUpdate("core_a"));

    await session.receive({
      t: "core",
      coreId: "core_a",
      frame: { type: "tasksList", reqId: "q1" },
    });

    expect(link.sent).toEqual([]);
    const answer = tab.coreFrames("core_a").at(-1);
    expect(answer).toMatchObject({ type: "error", reqId: "q1" });
    expect((answer as { message: string }).message).toMatch(/needs.*update/i);
  });

  it("does not push its events, PTY output or exits to a watching tab", () => {
    const link = source.bring("core_a");
    const { tab, session } = openTab();
    subscribe(session, "core_a", 0);
    source.announce(needsUpdate("core_a"));

    link.pushEvent(event(1));
    link.pushData({ ptyId: "p1", data: "hello", seq: 1 });
    link.pushExit({ ptyId: "p1", exitCode: 0 });

    expect(tab.coreFrames("core_a").filter((f) => f.type !== "eventsReplayed")).toEqual([]);
  });

  it("still tells every tab about the state itself", () => {
    source.bring("core_a");
    const { tab } = openTab();
    source.announce(needsUpdate("core_a"));

    expect(tab.dials().at(-1)).toMatchObject({ coreId: "core_a", state: "needs-update" });
  });

  it("leaves the rest of the fleet alone", async () => {
    source.bring("core_a");
    const link = source.bring("core_b");
    const { session } = openTab();
    source.announce(needsUpdate("core_a"));

    await session.receive({
      t: "core",
      coreId: "core_b",
      frame: { type: "tasksList", reqId: "q2" },
    });

    expect(link.sent.map((f) => f.type)).toEqual(["tasksList"]);
  });

  it("stays gated while its link flaps — a drop is not news about its protocol", async () => {
    const link = source.bring("core_a");
    const { session } = openTab();
    source.announce(needsUpdate("core_a"));
    source.announce({ coreId: "core_a", state: "unreachable", lastSeenAt: 1 });
    source.announce({ coreId: "core_a", state: "connecting", lastSeenAt: 1 });

    await session.receive({
      t: "core",
      coreId: "core_a",
      frame: { type: "tasksList", reqId: "q5" },
    });

    expect(link.sent).toEqual([]);
  });

  it("resumes routing once the updated Core reconnects", async () => {
    const link = source.bring("core_a");
    const { session } = openTab();
    source.announce(needsUpdate("core_a"));
    source.announce({ coreId: "core_a", state: "connected", lastSeenAt: 2 });

    await session.receive({
      t: "core",
      coreId: "core_a",
      frame: { type: "tasksList", reqId: "q3" },
    });

    expect(link.sent.map((f) => f.type)).toEqual(["tasksList"]);
  });

  it("suppresses a Core already needing an update when a tab attaches", async () => {
    const link = source.bring("core_a");
    source.announce(needsUpdate("core_a"));
    const { tab, session } = openTab();

    await session.receive({
      t: "core",
      coreId: "core_a",
      frame: { type: "tasksList", reqId: "q4" },
    });

    expect(link.sent).toEqual([]);
    expect(tab.coreFrames("core_a").at(-1)).toMatchObject({ type: "error", reqId: "q4" });
  });
});
