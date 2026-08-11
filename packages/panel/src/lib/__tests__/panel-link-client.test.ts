import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PanelLinkClient,
  type PanelLinkOptions,
  type PanelLinkSocketLike,
} from "../panel-link-client";
import type { PanelLinkClientFrame, PanelLinkServerFrame } from "~/shared/panel-link";
import type { CoreLinkEvent } from "@actana/shared/core-link-frames";

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
    return this.sent.flatMap((f) => (f.coreId === coreId ? [f.frame] : []));
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
