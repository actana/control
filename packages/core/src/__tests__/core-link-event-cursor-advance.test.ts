import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import log from "../log";
import {
  PtyCoreLinkServer,
  type EventLogPort,
  type WebSocketLike,
  type WebSocketServerLike,
} from "../pty-core-link-server";
import type { PtyCore, PtyCoreEvent } from "../pty-manager";
import type { CoreLinkEvent } from "@actana/sdk/core-link-frames";

// The live-event cursor advances only behind a send that landed (issue 244).
//
// The bug these tests pin is an ordering: `pushLiveEvents` moved
// `conn.lastSentEventId` past every event it *attempted*, and a send that fails
// on this transport is silent — Node's `ws` does not throw on a `CLOSING`
// socket, it emits an `error` event the server logs as a benign socket error.
// Because the client's own cursor is driven by the events it *receives*, one
// skipped frame plus one delivered frame behind it is a hole no reconnect
// replay can close: the client asks for "everything after the later one" and
// the server obliges.
//
// So the assertions here are about what the *client* ends up holding across a
// failure and a reconnect, not about a server field. Each one fails on the old
// ordering.

type Listener = (...args: unknown[]) => void;

/**
 * A socket that fails the way a real one does: it never throws.
 *
 * Two failure modes, because the server has to survive both. `readyState`
 * leaving `OPEN` is the reported remote-Core case — a link that went unwritable
 * between the poll's tail read and its send, with the close handshake not yet
 * run. `failEventOnce` is `ws`'s other one: the socket takes the frame,
 * synchronously reports nothing, and reports the failure a tick later through
 * the delivery callback (or, with no callback supplied, as an `error` event
 * nobody can attribute to a frame).
 */
class FakeWebSocket {
  readyState = 1;
  sent: string[] = [];
  closed = false;
  /** eventId whose first send attempt fails asynchronously; null once spent. */
  failEventOnce: number | null = null;
  /** eventId whose first send attempt throws — the one failure `ws` reports synchronously. */
  throwEventOnce: number | null = null;
  /** Every frame the transport refused, in order — the loss the client cannot see. */
  dropped: string[] = [];
  private listeners: Record<string, Listener[]> = {};

  send(data: string, cb?: (err?: Error) => void): void {
    if (this.throwEventOnce !== null && this.eventIdOf(data) === this.throwEventOnce) {
      this.throwEventOnce = null;
      this.dropped.push(data);
      throw new Error("send failed");
    }
    const err = this.refusalFor(data);
    if (err) {
      this.dropped.push(data);
      // Exactly what `ws` does: a callback gets the error on a later tick, and
      // with no callback the socket emits `error` and the frame is gone.
      if (cb) queueMicrotask(() => cb(err));
      else queueMicrotask(() => this.emit("error", err));
      return;
    }
    this.sent.push(data);
    if (cb) queueMicrotask(() => cb());
  }

  /** Why this frame will not be delivered, or null if it will be. */
  private refusalFor(data: string): Error | null {
    if (this.readyState !== 1) return new Error("WebSocket is not open");
    if (this.failEventOnce === null || this.eventIdOf(data) !== this.failEventOnce) return null;
    this.failEventOnce = null;
    return new Error("WebSocket is not open: readyState 2 (CLOSING)");
  }

  /** The eventId this frame carries, or null for anything that is not an `event`. */
  private eventIdOf(data: string): number | null {
    const frame = JSON.parse(data) as { type?: string; event?: { eventId?: number } };
    return frame.type === "event" ? (frame.event?.eventId ?? null) : null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }
  /** The socket drops without a close handshake — `readyState` moves, no `close` fires. */
  goUnwritable(): void {
    this.readyState = 2;
  }
  becomeWritable(): void {
    this.readyState = 1;
  }
  ping(): void {}
  on(event: string, cb: Listener): void {
    (this.listeners[event] ??= []).push(cb);
  }
  removeAllListeners(): void {
    this.listeners = {};
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners[event] ?? []) cb(...args);
  }
  receive(frame: unknown): void {
    this.emit("message", JSON.stringify(frame));
  }
  ofType<T extends Record<string, unknown>>(type: string): T[] {
    return this.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((frame) => frame.type === type) as T[];
  }
  /** The eventIds this client actually received, in arrival order. */
  eventIds(): number[] {
    return this.ofType<{ event: CoreLinkEvent }>("event").map((frame) => frame.event.eventId);
  }
}

class FakeWebSocketServer {
  private connCb: ((ws: WebSocketLike) => void) | null = null;
  connect(ws: FakeWebSocket): void {
    this.connCb?.(ws as unknown as WebSocketLike);
  }
  close(): void {}
  on(event: string, cb: Listener): void {
    if (event === "connection") this.connCb = cb as (ws: WebSocketLike) => void;
  }
}

/** An in-memory event log — the same seam `event-log-store.ts` fills for real. */
function fakeEventLog() {
  const events: CoreLinkEvent[] = [];
  const port: EventLogPort = {
    appendEvent: (kind, payload, opts) => {
      const eventId = events.length + 1;
      events.push({
        eventId,
        ts: eventId,
        kind,
        payload,
        ptyId: opts?.ptyId ?? null,
        taskId: opts?.taskId ?? null,
      });
      return eventId;
    },
    readEventTail: (afterEventId, limit = 1_000) =>
      events.filter((event) => event.eventId > afterEventId).slice(0, limit),
    getLastEventId: () => events.length,
  };
  return { port, events };
}

function mockCore(): PtyCore {
  return {
    setEmitTarget: (_fn: ((event: PtyCoreEvent) => void) | null) => {},
    spawn: async () => ({ ptyId: "pty-1", hooksReportTurnStart: true }),
    write: () => true,
    resize: () => true,
    kill: () => true,
    killLaunchProcesses: async () => ({ ptyCount: 0, ports: [] }),
    findByTask: () => ({ ptyId: null }),
    replay: () => ({ data: "", nextSeq: 0, from: 0 }),
    killAll: () => {},
  } as unknown as PtyCore;
}

/**
 * How a client's own cursor moves: it persists the highest eventId it applied,
 * and that is the number it presents on the next `subscribe`. This is the whole
 * mechanism by which a server-side skip becomes permanent.
 */
function clientCursor(...sockets: FakeWebSocket[]): number {
  return sockets.flatMap((ws) => ws.eventIds()).reduce((max, id) => Math.max(max, id), 0);
}

describe("the live-event cursor advances only behind a send that landed (issue 244)", () => {
  let wss: FakeWebSocketServer;
  let server: PtyCoreLinkServer;
  let logi: ReturnType<typeof fakeEventLog>;

  function connect(): FakeWebSocket {
    const ws = new FakeWebSocket();
    wss.connect(ws);
    return ws;
  }

  beforeEach(() => {
    wss = new FakeWebSocketServer();
    logi = fakeEventLog();
    server = new PtyCoreLinkServer(mockCore(), {
      port: 0,
      createServer: () => wss as unknown as WebSocketServerLike,
      eventLog: logi.port,
      liveEventPollMs: 5,
    });
  });

  afterEach(() => {
    server.close();
    vi.restoreAllMocks();
  });

  it("replays an event whose send failed, instead of skipping it forever", async () => {
    const first = connect();
    first.receive({ type: "subscribe", reqId: "s1", lastEventId: 0 });

    // The event in the middle is the one the socket will refuse — the shape
    // from the ticket: 1 and 3 land, 2 does not.
    first.failEventOnce = 2;
    logi.port.appendEvent("task:created", JSON.stringify({ taskId: "t1" }), { taskId: "t1" });
    logi.port.appendEvent("session:finished", JSON.stringify({ taskId: "t1" }), { taskId: "t1" });
    logi.port.appendEvent("task:updated", JSON.stringify({ taskId: "t1" }), { taskId: "t1" });

    await vi.waitFor(() => expect(first.eventIds()).toContain(3));

    // The client reconnects off its own cursor, exactly as it would after any
    // drop, and the Core owes it whatever it has not seen.
    const cursor = clientCursor(first);
    first.close();
    const second = connect();
    second.receive({ type: "subscribe", reqId: "s2", lastEventId: cursor });
    await vi.waitFor(() => expect(second.ofType("eventsReplayed")).toHaveLength(1));

    // The property: every appended event reached the client by some path. On
    // the old ordering the cursor moved past 2 on the failed send, the client's
    // own cursor moved to 3 behind it, and `session:finished` — a one-shot
    // notification no snapshot re-hydration carries — was gone for good.
    const delivered = new Set([...first.eventIds(), ...second.eventIds()]);
    expect([...delivered].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("keeps the cursor put while the socket is unwritable, and delivers on recovery", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const ws = connect();
    ws.receive({ type: "subscribe", reqId: "s1", lastEventId: 0 });
    logi.port.appendEvent("task:created", "{}", { taskId: "t1" });
    await vi.waitFor(() => expect(ws.eventIds()).toEqual([1]));

    // The link goes unwritable with no close handshake — the remote-Core case.
    // `ws.send` does not throw here; it never has.
    ws.goUnwritable();
    logi.port.appendEvent("session:lockChanged", "{}", { taskId: "t1" });
    logi.port.appendEvent("session:finished", "{}", { taskId: "t1" });
    // Nothing is even attempted at an unwritable socket — the poll notices
    // before it writes, and says which event it is holding.
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("core-link.event.undelivered", expect.objectContaining({ eventId: 2 })));
    expect(ws.sent.filter((raw) => raw.includes("\"event\""))).toHaveLength(1);
    expect(ws.eventIds()).toEqual([1]);

    // Nothing was consumed by the refusal: the cursor is still below event 2,
    // so the very next tick that finds a writable socket carries both.
    ws.becomeWritable();
    await vi.waitFor(() => expect(ws.eventIds()).toEqual([1, 2, 3]));
  });

  it("stops the subscribe replay at the last event the socket took", async () => {
    logi.port.appendEvent("task:created", "{}", { taskId: "t1" });
    logi.port.appendEvent("session:finished", "{}", { taskId: "t1" });
    logi.port.appendEvent("task:updated", "{}", { taskId: "t1" });

    const ws = connect();
    // A send that throws is the one failure the old `try/catch` did see — and
    // it still advanced the cursor past the frame it had just caught.
    ws.throwEventOnce = 2;
    ws.receive({ type: "subscribe", reqId: "s1", lastEventId: 0 });

    // The replay is a cursor advance like any other: it stops where delivery
    // stopped and reports that, rather than a tail it only partly wrote. A
    // client told `lastEventId: 3` here would never ask for event 2 again.
    expect(ws.eventIds()).toEqual([1]);
    expect(ws.ofType<{ lastEventId: number }>("eventsReplayed")[0]?.lastEventId).toBe(1);

    // And the live loop picks up from there — the refused event included.
    await vi.waitFor(() => expect(ws.eventIds()).toEqual([1, 2, 3]));
  });

  it("names the undeliverable event in a log line", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const ws = connect();
    ws.receive({ type: "subscribe", reqId: "s1", lastEventId: 0 });
    ws.goUnwritable();
    logi.port.appendEvent("session:finished", "{}", { taskId: "t1" });

    // The absence of any line naming a lost eventId is why this class of bug
    // was invisible: `core-link.connection.error` names a socket, never a frame.
    await vi.waitFor(() =>
      expect(
        warn.mock.calls.some(
          ([tag, payload]) =>
            tag === "core-link.event.undelivered" &&
            (payload as { eventId?: number } | undefined)?.eventId === 1,
        ),
      ).toBe(true),
    );
  });
});
