import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelLinkClient, type PanelLinkSocketLike } from "../panel-link-client";
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
