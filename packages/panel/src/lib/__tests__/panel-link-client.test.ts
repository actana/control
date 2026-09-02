import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PanelLinkClient,
  type PanelLinkOptions,
  type PanelLinkSocketLike,
} from "../panel-link-client";
import type { PanelLinkClientFrame, PanelLinkServerFrame } from "~/shared/panel-link";
import type { CoreLinkEvent } from "@actana/sdk/core-link-frames";

/**
 * The client is driven the way the Panel service drives it: frames in, frames
 * out, sockets that die at inconvenient moments. What is asserted is what the
 * UI above it would observe — answers to its queries, events in order, and a
 * reconnect that asks for exactly what the tab missed.
 */

class FakeSocket implements PanelLinkSocketLike {
  static last: FakeSocket | null = null;
  static opened: FakeSocket[] = [];

  readyState = 0;
  readonly sent: PanelLinkClientFrame[] = [];
  private handlers = new Map<string, Array<(arg: never) => void>>();

  constructor(readonly url: string) {
    FakeSocket.last = this;
    FakeSocket.opened.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as PanelLinkClientFrame);
  }
  close() {
    this.fire("close");
  }
  addEventListener(type: string, cb: (arg: never) => void) {
    const list = this.handlers.get(type) ?? [];
    list.push(cb);
    this.handlers.set(type, list);
  }

  private fire(type: string, arg?: unknown) {
    for (const cb of this.handlers.get(type) ?? []) (cb as (a: unknown) => void)(arg);
  }

  /** The service accepted the upgrade. */
  accept() {
    this.readyState = 1;
    this.fire("open");
  }
  /** The service pushed a frame. */
  push(frame: PanelLinkServerFrame) {
    this.fire("message", { data: JSON.stringify(frame) });
  }
  /** The link dropped. */
  drop() {
    this.readyState = 3;
    this.fire("close");
  }

  /** Core frames this socket sent, for one Core. */
  outgoing(coreId: string) {
    return this.sent.flatMap((f) =>
      f.t === "core" && f.coreId === coreId ? [f.frame] : [],
    );
  }

  /** Session-drive frames this socket sent, for one Core (issue 147). */
  drives(coreId: string) {
    return this.sent.flatMap((f) =>
      f.t === "drive" && f.coreId === coreId ? [{ taskId: f.taskId, want: f.want }] : [],
    );
  }
}

function event(eventId: number): CoreLinkEvent {
  return { eventId, ts: eventId, kind: "task:statusChanged", ptyId: null, taskId: "t", payload: "{}" };
}

function client(): PanelLinkClient {
  return new PanelLinkClient({
    url: "ws://panel.test/panel-link?v=1",
    createSocket: (url) => new FakeSocket(url),
    reconnectInitialMs: 10,
    reconnectMaxMs: 10,
    requestTimeoutMs: 1_000,
  });
}

/** The socket the client is currently on, having accepted the handshake. */
function live(): FakeSocket {
  const socket = FakeSocket.last!;
  socket.accept();
  return socket;
}

beforeEach(() => {
  FakeSocket.last = null;
  FakeSocket.opened = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("panel link · one socket for the whole fleet", () => {
  it("opens exactly one socket however many Cores it talks to", async () => {
    const link = client();
    live();
    link.watch("core_a");
    link.watch("core_b");
    link.request("core_a", { type: "tasksList" }).catch(() => {});
    link.request("core_b", { type: "projectsList" }).catch(() => {});

    expect(FakeSocket.opened).toHaveLength(1);
    link.close();
  });

  it("answers a query with the Core's frame, matched to the caller's request", async () => {
    const link = client();
    const socket = live();
    const answer = link.request("core_a", { type: "tasksList" });
    const reqId = (socket.outgoing("core_a")[0] as { reqId: string }).reqId;

    socket.push({
      t: "core",
      coreId: "core_a",
      frame: { type: "tasksListResult", reqId, tasks: [], archivedCount: 0 },
    });

    await expect(answer).resolves.toMatchObject({ type: "tasksListResult" });
    link.close();
  });

  it("rejects when the Panel answers with an error frame", async () => {
    const link = client();
    const socket = live();
    const answer = link.request("core_gone", { type: "tasksList" });
    const reqId = (socket.outgoing("core_gone")[0] as { reqId: string }).reqId;

    socket.push({
      t: "core",
      coreId: "core_gone",
      frame: { type: "error", reqId, message: "core core_gone is not connected" },
    });

    await expect(answer).rejects.toThrow("not connected");
    link.close();
  });

  it("keeps each Core's stream apart", () => {
    const link = client();
    const socket = live();
    link.watch("core_a");
    link.watch("core_b");
    const seen: Array<[string, number]> = [];
    link.onEvent(({ coreId, event: e }) => seen.push([coreId, e.eventId]));

    socket.push({ t: "core", coreId: "core_a", frame: { type: "event", event: event(1) } });
    socket.push({ t: "core", coreId: "core_b", frame: { type: "event", event: event(1) } });

    expect(seen).toEqual([
      ["core_a", 1],
      ["core_b", 1],
    ]);
    link.close();
  });

  it("surfaces dial-status pushes without being asked", () => {
    const link = client();
    const socket = live();
    const seen: string[] = [];
    link.onDialStatus((s) => seen.push(`${s.coreId}:${s.state}`));

    socket.push({
      t: "core",
      coreId: "core_a",
      frame: { type: "event", event: event(1) },
    });
    socket.push({
      t: "dial",
      status: { coreId: "core_a", state: "unreachable", lastSeenAt: 5 },
    });

    expect(seen).toEqual(["core_a:unreachable"]);
    link.close();
  });
});

describe("panel link · reconnect and replay", () => {
  it("subscribes a watched Core as soon as the link is up", () => {
    const link = client();
    link.watch("core_a");
    const socket = live();

    expect(socket.outgoing("core_a")).toEqual([
      { type: "subscribe", reqId: expect.any(String), lastEventId: 0 },
    ]);
    link.close();
  });

  it("re-subscribes from the last event it saw, so the gap is replayed", () => {
    const link = client();
    link.watch("core_a");
    const first = live();
    first.push({ t: "core", coreId: "core_a", frame: { type: "event", event: event(7) } });

    first.drop();
    vi.advanceTimersByTime(20);
    const second = live();

    expect(second.outgoing("core_a")).toEqual([
      { type: "subscribe", reqId: expect.any(String), lastEventId: 7 },
    ]);
    link.close();
  });

  it("does not re-fire an event the replay repeats", () => {
    const link = client();
    link.watch("core_a");
    const socket = live();
    const seen: number[] = [];
    link.onEvent(({ event: e }) => seen.push(e.eventId));

    socket.push({ t: "core", coreId: "core_a", frame: { type: "event", event: event(3) } });
    socket.push({ t: "core", coreId: "core_a", frame: { type: "event", event: event(3) } });
    socket.push({ t: "core", coreId: "core_a", frame: { type: "event", event: event(4) } });

    expect(seen).toEqual([3, 4]);
    link.close();
  });

  it("takes the caught-up marker as its cursor when the tail was empty", () => {
    const link = client();
    link.watch("core_a");
    const first = live();
    first.push({ t: "core", coreId: "core_a", frame: { type: "eventsReplayed", lastEventId: 12 } });

    first.drop();
    vi.advanceTimersByTime(20);

    expect(live().outgoing("core_a")).toEqual([
      { type: "subscribe", reqId: expect.any(String), lastEventId: 12 },
    ]);
    link.close();
  });

  it("says which events answer a subscribe from a tab that had seen nothing", () => {
    const link = client();
    link.watch("core_a");
    const socket = live();
    const seen: Array<[number, boolean]> = [];
    link.onEvent(({ event: e, coldReplay }) => seen.push([e.eventId, coldReplay === true]));

    // Everything before the caught-up marker answers the subscribe.
    socket.push({ t: "core", coreId: "core_a", frame: { type: "event", event: event(4) } });
    socket.push({ t: "core", coreId: "core_a", frame: { type: "eventsReplayed", lastEventId: 4 } });
    socket.push({ t: "core", coreId: "core_a", frame: { type: "event", event: event(5) } });

    expect(seen).toEqual([
      [4, true],
      [5, false],
    ]);
    link.close();
  });

  it("does not call a reconnect catch-up a cold replay — this tab lived through it", () => {
    const link = client();
    link.watch("core_a");
    const first = live();
    const seen: Array<[number, boolean]> = [];
    link.onEvent(({ event: e, coldReplay }) => seen.push([e.eventId, coldReplay === true]));
    first.push({ t: "core", coreId: "core_a", frame: { type: "eventsReplayed", lastEventId: 4 } });
    first.push({ t: "core", coreId: "core_a", frame: { type: "event", event: event(5) } });

    first.drop();
    vi.advanceTimersByTime(20);
    const second = live();
    second.push({ t: "core", coreId: "core_a", frame: { type: "event", event: event(6) } });

    // The gap it was away for is a gap it was watching: the tab asked from a
    // cursor of 5, not from nothing.
    expect(seen).toEqual([
      [5, false],
      [6, false],
    ]);
    link.close();
  });

  it("fails in-flight requests on a drop rather than hanging until timeout", async () => {
    const link = client();
    const socket = live();
    const answer = link.request("core_a", { type: "tasksList" });

    socket.drop();

    await expect(answer).rejects.toThrow("connection lost");
    link.close();
  });

  it("reports the link going down and coming back", () => {
    const link = client();
    const states: boolean[] = [];
    link.onConnectionChange((up) => states.push(up));
    const socket = live();
    socket.drop();
    vi.advanceTimersByTime(20);
    live();

    expect(states).toEqual([true, false, true]);
    link.close();
  });

  it("sends a frame written while the link was down once it comes back", () => {
    const link = client();
    live().drop();
    link.request("core_a", { type: "tasksList" }).catch(() => {});
    vi.advanceTimersByTime(20);
    const second = live();

    expect(second.outgoing("core_a").map((f) => f.type)).toEqual(["tasksList"]);
    link.close();
  });
});

describe("panel link · the ptys a tab is rendering", () => {
  /** Answer whatever the tab last asked for, so its claim resolves. */
  function ack(socket: FakeSocket, coreId: string, ptyId: string): void {
    const asked = socket
      .outgoing(coreId)
      .filter((f) => f.type === "ptySubscribe" || f.type === "ptyUnsubscribe");
    const last = asked.at(-1) as { type: string; reqId: string };
    socket.push({
      t: "core",
      coreId,
      frame:
        last.type === "ptySubscribe"
          ? { type: "ptySubscribeAck", reqId: last.reqId, ptyId, subscribed: true, holding: false }
          : { type: "ptyUnsubscribeAck", reqId: last.reqId, ptyId, subscribed: false },
    });
  }

  function ptyFrames(socket: FakeSocket, coreId: string) {
    return socket
      .outgoing(coreId)
      .filter((f) => f.type === "ptySubscribe" || f.type === "ptyUnsubscribe")
      .map((f) => ({ ...f, reqId: undefined }));
  }

  it("asks for a pty the moment a pane claims it", async () => {
    const link = client();
    const socket = live();
    const claimed = link.ptySubscribe("core_a", "pty_1", { catchUp: true });
    ack(socket, "core_a", "pty_1");
    await claimed;

    expect(ptyFrames(socket, "core_a")).toEqual([
      { type: "ptySubscribe", ptyId: "pty_1", catchUp: true, reqId: undefined },
    ]);
    link.close();
  });

  it("re-asks for every pty a pane is still rendering when the link comes back", async () => {
    const link = client();
    const first = live();
    const claimed = link.ptySubscribe("core_a", "pty_1", { catchUp: true });
    ack(first, "core_a", "pty_1");
    await claimed;

    // The service gave this tab's claims back the moment the socket died, and
    // the panes never noticed — nothing above this layer re-claims.
    first.drop();
    vi.advanceTimersByTime(20);
    const second = live();

    expect(ptyFrames(second, "core_a")).toEqual([
      // No `catchUp`: the pane's own reattach sends the replay that would
      // release a hold, and a hold nobody releases is a pane that never paints.
      { type: "ptySubscribe", ptyId: "pty_1", catchUp: false, reqId: undefined },
    ]);
    link.close();
  });

  it("paints the pty again after the reconnect it re-asked on", async () => {
    const link = client();
    const first = live();
    const claimed = link.ptySubscribe("core_a", "pty_1", { catchUp: true });
    ack(first, "core_a", "pty_1");
    await claimed;
    const painted: string[] = [];
    link.onPtyData(({ ptyId, data }) => painted.push(`${ptyId}:${data}`));

    first.drop();
    vi.advanceTimersByTime(20);
    const second = live();
    // What the service sends once the Core has been re-subscribed underneath.
    second.push({
      t: "core",
      coreId: "core_a",
      frame: { type: "data", ptyId: "pty_1", data: "alive", seq: 4 },
    });

    expect(painted).toEqual(["pty_1:alive"]);
    link.close();
  });

  it("does not re-ask for a pty the pane let go of", async () => {
    const link = client();
    const first = live();
    const claimed = link.ptySubscribe("core_a", "pty_1");
    ack(first, "core_a", "pty_1");
    await claimed;
    const released = link.ptyUnsubscribe("core_a", "pty_1");
    ack(first, "core_a", "pty_1");
    await released;

    first.drop();
    vi.advanceTimersByTime(20);

    expect(ptyFrames(live(), "core_a")).toEqual([]);
    link.close();
  });

  it("asks once for a pty two panes in the same tab render", async () => {
    const link = client();
    const socket = live();
    const first = link.ptySubscribe("core_a", "pty_1", { catchUp: true });
    ack(socket, "core_a", "pty_1");
    await first;
    // A pane rebuilding on the same pty claims again; counting it twice would
    // strand the subscription when only one release follows.
    await link.ptySubscribe("core_a", "pty_1", { catchUp: true });

    expect(ptyFrames(socket, "core_a")).toHaveLength(1);
    link.close();
  });

  it("keeps a claim made while the link was down, and asks on the new one", async () => {
    const link = client();
    live().drop();
    link.ptySubscribe("core_a", "pty_1", { catchUp: true }).catch(() => {});
    vi.advanceTimersByTime(20);
    const second = live();

    expect(
      ptyFrames(second, "core_a").filter((f) => f.type === "ptySubscribe"),
    ).not.toHaveLength(0);
    link.close();
  });

  it("keeps each Core's claims apart", async () => {
    const link = client();
    const first = live();
    const a = link.ptySubscribe("core_a", "pty_1");
    ack(first, "core_a", "pty_1");
    await a;
    const b = link.ptySubscribe("core_b", "pty_2");
    ack(first, "core_b", "pty_2");
    await b;

    first.drop();
    vi.advanceTimersByTime(20);
    const second = live();

    expect(ptyFrames(second, "core_a")).toEqual([
      { type: "ptySubscribe", ptyId: "pty_1", catchUp: false, reqId: undefined },
    ]);
    expect(ptyFrames(second, "core_b")).toEqual([
      { type: "ptySubscribe", ptyId: "pty_2", catchUp: false, reqId: undefined },
    ]);
    link.close();
  });
});

/**
 * A stand-in for `window` / `document`, so the wake signals can be fired from a
 * test that runs in Node — and so "left no listener behind" is a number this
 * suite can read rather than a promise the code makes.
 */
class FakeWakeTarget {
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, cb: () => void) {
    const set = this.listeners.get(type) ?? new Set<() => void>();
    set.add(cb);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, cb: () => void) {
    this.listeners.get(type)?.delete(cb);
  }
  fire(type: string) {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb();
  }
  /** How many listeners are still installed, of any type. */
  registered() {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

class FakeDocument extends FakeWakeTarget {
  visibilityState: "visible" | "hidden" = "visible";

  /** The tab came back to the foreground. */
  reveal() {
    this.visibilityState = "visible";
    this.fire("visibilitychange");
  }
  /** The tab went away. */
  hide() {
    this.visibilityState = "hidden";
    this.fire("visibilitychange");
  }
}

describe("panel link · a socket that dies without saying so", () => {
  /**
   * The bug this covers has no event in it. The socket stops delivering frames,
   * `readyState` stays `OPEN`, `close` never fires, and a send into it does not
   * throw — so the fake socket here simply *does nothing*, which is exactly the
   * failure. What the tests drive is the only thing left: a wake signal.
   */
  let win: FakeWakeTarget;
  let doc: FakeDocument;

  beforeEach(() => {
    win = new FakeWakeTarget();
    doc = new FakeDocument();
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function staleClient(opts: PanelLinkOptions = {}) {
    return new PanelLinkClient({
      url: "ws://panel.test/panel-link?v=1",
      createSocket: (url) => new FakeSocket(url),
      reconnectInitialMs: 100,
      reconnectMaxMs: 10_000,
      requestTimeoutMs: 1_000,
      staleAfterMs: 60_000,
      ...opts,
    });
  }

  it("drops a silent socket on the next wake and re-subscribes from its cursor", () => {
    const link = staleClient();
    link.watch("core_a");
    const first = live();
    first.push({ t: "core", coreId: "core_a", frame: { type: "event", event: event(9) } });

    // Hours pass with the tab hidden. The socket says nothing and, crucially,
    // does nothing: no close event, no readyState change, no error.
    vi.advanceTimersByTime(4 * 60 * 60_000);
    expect(FakeSocket.opened).toHaveLength(1);
    expect(first.readyState).toBe(1);

    doc.reveal();
    const second = live();

    expect(FakeSocket.opened).toHaveLength(2);
    expect(second).not.toBe(first);
    expect(second.outgoing("core_a")).toEqual([
      { type: "subscribe", reqId: expect.any(String), lastEventId: 9 },
    ]);
    link.close();
  });

  it("re-announces the tab's ptys and session drives on a wake redial", () => {
    const link = staleClient();
    link.watch("core_a");
    const first = live();
    // Claimed on the live link; the ack never comes, because what this test is
    // about is what the *next* socket is told. The claim is recorded before the
    // ask, which is precisely what makes it survive a link that dies mid-flight.
    link.ptySubscribe("core_a", "pty_1", { catchUp: true }).catch(() => {});
    link.driveSession("core_a", "task_1");
    expect(first.readyState).toBe(1);

    // The socket dies in silence again: no close, no error, no readyState
    // change. A wake signal is the only thing left to act on.
    vi.advanceTimersByTime(4 * 60 * 60_000);
    doc.reveal();
    const second = live();

    // A wake redial reaches the link through `connect()` and the open handler
    // like any other reconnect, so it owes the new socket everything a
    // close-driven one does. The service handed this tab's claims and drives
    // back when the old socket died; re-subscribing the Core alone would leave
    // every pane on the tab dead and every Session it shows driven by nobody.
    expect(second).not.toBe(first);
    expect(second.outgoing("core_a")).toEqual([
      { type: "subscribe", reqId: expect.any(String), lastEventId: 0 },
      // No `catchUp`, for the same reason a close-driven reconnect omits it.
      { type: "ptySubscribe", reqId: expect.any(String), ptyId: "pty_1", catchUp: false },
    ]);
    // `watch`, not `take`: a tab coming back from hours hidden is not the
    // operator asking for the keyboard.
    expect(second.drives("core_a")).toEqual([{ taskId: "task_1", want: "watch" }]);
    link.close();
  });

  it("wakes on focus and on coming back online, not only on visibility", () => {
    for (const signal of ["focus", "online"] as const) {
      FakeSocket.opened = [];
      const link = staleClient();
      live();
      vi.advanceTimersByTime(90_000);

      win.fire(signal);

      expect(FakeSocket.opened, `${signal} should have redialled`).toHaveLength(2);
      link.close();
    }
  });

  it("leaves a healthy, recently-active link alone", () => {
    const link = staleClient();
    const socket = live();
    socket.push({ t: "core", coreId: "core_a", frame: { type: "event", event: event(1) } });
    vi.advanceTimersByTime(30_000);

    doc.reveal();
    win.fire("focus");
    win.fire("online");

    expect(FakeSocket.opened).toHaveLength(1);
    link.close();
  });

  it("does not redial on the visibilitychange that hides the tab", () => {
    const link = staleClient();
    live();
    vi.advanceTimersByTime(90_000);

    doc.hide();

    expect(FakeSocket.opened).toHaveLength(1);
    link.close();
  });

  it("redials at once on wake rather than waiting out the backoff", () => {
    const link = staleClient();
    live().drop();
    vi.advanceTimersByTime(100);
    // Second dial, never accepted — the backoff is now walking upward.
    FakeSocket.last!.drop();
    expect(FakeSocket.opened).toHaveLength(2);

    win.fire("focus");

    // No timer advanced: the wake redials immediately, not on the next delay.
    expect(FakeSocket.opened).toHaveLength(3);

    // And the attempt counter went back to zero with it: the next ordinary
    // drop retries on the initial delay, not on the doubled one it had reached.
    FakeSocket.last!.drop();
    vi.advanceTimersByTime(100);
    expect(FakeSocket.opened).toHaveLength(4);
    link.close();
  });

  it("fails in-flight requests when it drops a silent socket", async () => {
    // A request timeout long enough to stay out of the way: it is not a
    // liveness signal, and the point here is that the wake path fails the
    // caller rather than leaving it to expire.
    const link = staleClient({ requestTimeoutMs: 10 * 60_000 });
    live();
    const answer = link.request("core_a", { type: "tasksList" });
    vi.advanceTimersByTime(90_000);

    doc.reveal();

    await expect(answer).rejects.toThrow("connection lost");
    link.close();
  });

  it("leaves no wake listener behind when it is closed", () => {
    const link = staleClient();
    live();
    expect(win.registered() + doc.registered()).toBe(3);

    link.close();

    expect(win.registered()).toBe(0);
    expect(doc.registered()).toBe(0);
  });

  it("ignores a wake signal after close", () => {
    const link = staleClient();
    live();
    link.close();
    vi.advanceTimersByTime(90_000);

    doc.reveal();
    win.fire("focus");

    expect(FakeSocket.opened).toHaveLength(1);
  });
});

describe("panel link · watching", () => {
  it("subscribes a Core once however many views watch it", () => {
    const link = client();
    const socket = live();
    link.watch("core_a");
    link.watch("core_a");

    expect(socket.outgoing("core_a")).toHaveLength(1);
    link.close();
  });

  it("ignores a frame it cannot read", () => {
    const link = client();
    const socket = live();
    const seen: number[] = [];
    link.onEvent(({ event: e }) => seen.push(e.eventId));

    socket.push("not a frame" as unknown as PanelLinkServerFrame);

    expect(seen).toEqual([]);
    link.close();
  });
});

describe("panel link · a tab's panes on one Session", () => {
  // The service keys drive interest per tab and the browser opens panes, so
  // this is the seam where the two are reconciled (issue 186). One tab may hold
  // two panes on one Session — a split view, the same Session opened twice —
  // and what the service is told has to be the *tab's* standing, once.

  it("announces a Session once however many panes this tab opens on it", () => {
    const link = client();
    const socket = live();

    link.driveSession("core_a", "task_1");
    link.driveSession("core_a", "task_1");

    // Not a saving of bytes. A second `watch` re-asserts interest the service
    // already holds, and re-asserting moves this tab to the tail of that
    // Session's queue: the keyboard leaves the pane the operator is looking at,
    // with no gesture of theirs to explain it.
    expect(socket.drives("core_a")).toEqual([{ taskId: "task_1", want: "watch" }]);
    link.close();
  });

  it("announces each Session in its own right", () => {
    const link = client();
    const socket = live();

    link.driveSession("core_a", "task_1");
    link.driveSession("core_a", "task_2");

    expect(socket.drives("core_a")).toEqual([
      { taskId: "task_1", want: "watch" },
      { taskId: "task_2", want: "watch" },
    ]);
    link.close();
  });

  it("still asks for the keyboard in a pane on a Session it already watches", () => {
    const link = client();
    const socket = live();

    link.driveSession("core_a", "task_1");
    link.driveSession("core_a", "task_1", { take: true });

    // `take` is the operator's gesture, not a pane arriving. Deduping it would
    // be a button that does nothing in the one case it exists for.
    expect(socket.drives("core_a")).toEqual([
      { taskId: "task_1", want: "watch" },
      { taskId: "task_1", want: "take" },
    ]);
    link.close();
  });

  it("gives a Session back only when the last pane on it closes", () => {
    const link = client();
    const socket = live();

    link.driveSession("core_a", "task_1");
    link.driveSession("core_a", "task_1");

    expect(link.releaseSessionDrive("core_a", "task_1")).toBe(false);
    // The tab still has the Session on screen. A `drop` here would have the
    // service hand the drive to another tab while this one keeps a writable
    // pane and keeps typing — two writers, and nothing on screen to say so.
    expect(socket.drives("core_a")).toEqual([{ taskId: "task_1", want: "watch" }]);

    expect(link.releaseSessionDrive("core_a", "task_1")).toBe(true);
    expect(socket.drives("core_a")).toEqual([
      { taskId: "task_1", want: "watch" },
      { taskId: "task_1", want: "drop" },
    ]);
    link.close();
  });

  it("counts panes, not gestures: a take does not keep the Session held", () => {
    const link = client();
    const socket = live();

    link.driveSession("core_a", "task_1");
    link.driveSession("core_a", "task_1", { take: true });

    expect(link.releaseSessionDrive("core_a", "task_1")).toBe(true);
    expect(socket.drives("core_a").at(-1)).toEqual({ taskId: "task_1", want: "drop" });
    link.close();
  });

  it("says nothing for a Session this tab has no pane on", () => {
    const link = client();
    const socket = live();

    expect(link.releaseSessionDrive("core_a", "task_1")).toBe(false);

    expect(socket.drives("core_a")).toEqual([]);
    link.close();
  });

  it("re-announces a twice-held Session once on a reconnect", () => {
    const link = client();
    const first = live();
    link.driveSession("core_a", "task_1");
    link.driveSession("core_a", "task_1");

    first.drop();
    vi.advanceTimersByTime(20);
    const second = live();

    // What the new socket is owed is the tab's interest, which is one Session
    // whatever it is showing it in. Re-announcing it per pane on every flap is
    // the duplicate `watch` again, with a reconnect for a trigger.
    expect(second.drives("core_a")).toEqual([{ taskId: "task_1", want: "watch" }]);
    link.close();
  });

  it("re-announces nothing once every pane on the Session has gone", () => {
    const link = client();
    const first = live();
    link.driveSession("core_a", "task_1");
    link.driveSession("core_a", "task_1");
    link.releaseSessionDrive("core_a", "task_1");
    link.releaseSessionDrive("core_a", "task_1");

    first.drop();
    vi.advanceTimersByTime(20);
    const second = live();

    expect(second.drives("core_a")).toEqual([]);
    link.close();
  });
});
