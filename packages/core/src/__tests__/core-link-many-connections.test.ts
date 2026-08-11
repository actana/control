import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PtyCoreLinkServer,
  type EventLogPort,
  type WebSocketLike,
  type WebSocketServerLike,
} from "../pty-core-link-server";
import type { PtyCore, PtyCoreEvent } from "../pty-manager";
import type { CoreLinkEvent } from "@actana/shared/core-link-frames";

// Many core-link connections on one Core (issue 141, ADR 0024 D1).
//
// The property under test is what a second connection does NOT do: it does not
// close the first, does not authenticate on its behalf, does not move its event
// cursor, and does not take its PTY output away. Before this ticket the server
// held one `activeWs` and one `ActiveConnection`, so every one of those was a
// shared field and a second client silently overwrote it.

type Listener = (...args: unknown[]) => void;

class FakeWebSocket {
  readyState = 1;
  sent: string[] = [];
  closed = false;
  terminated = false;
  pings = 0;
  private listeners: Record<string, Listener[]> = {};

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }
  /** The real `ws.terminate()` destroys the socket; the close handler still runs. */
  terminate(): void {
    this.terminated = true;
    this.close();
  }
  ping(): void {
    this.pings += 1;
  }
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
  pong(): void {
    this.emit("pong");
  }
  ofType<T extends Record<string, unknown>>(type: string): T[] {
    return this.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((frame) => frame.type === type) as T[];
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

/** A `PtyCore` that records what the server does to it, and can emit. */
function mockCore() {
  const emitTargets: (((event: PtyCoreEvent) => void) | null)[] = [];
  const spawned: unknown[] = [];
  const killed: string[] = [];
  let target: ((event: PtyCoreEvent) => void) | null = null;
  const core = {
    setEmitTarget: (fn: ((event: PtyCoreEvent) => void) | null) => {
      emitTargets.push(fn);
      target = fn;
    },
    spawn: async (opts: unknown) => {
      spawned.push(opts);
      return { ptyId: "pty-1", hooksReportTurnStart: true };
    },
    write: () => true,
    resize: () => true,
    kill: (ptyId: string) => {
      killed.push(ptyId);
      return true;
    },
    killLaunchProcesses: async () => ({ ptyCount: 0, ports: [] }),
    findByTask: () => ({ ptyId: null }),
    replay: () => ({ data: "", nextSeq: 0, from: 0 }),
    killAll: () => {},
  } as unknown as PtyCore;
  return {
    core,
    emitTargets,
    spawned,
    killed,
    emit: (event: PtyCoreEvent) => target?.(event),
    hasTarget: () => target !== null,
  };
}

describe("a Core accepts many concurrent core-link connections (issue 141)", () => {
  let wss: FakeWebSocketServer;
  let server: PtyCoreLinkServer;
  let core: ReturnType<typeof mockCore>;
  let log: ReturnType<typeof fakeEventLog>;

  function startServer(
    opts: { authVerifier?: ConstructorParameters<typeof PtyCoreLinkServer>[1]["authVerifier"] } = {},
    liveEventPollMs = 5,
  ): void {
    wss = new FakeWebSocketServer();
    core = mockCore();
    log = fakeEventLog();
    server = new PtyCoreLinkServer(core.core, {
      port: 0,
      createServer: () => wss as unknown as WebSocketServerLike,
      eventLog: log.port,
      liveEventPollMs,
      ...opts,
    });
  }

  function connect(): FakeWebSocket {
    const ws = new FakeWebSocket();
    wss.connect(ws);
    return ws;
  }

  beforeEach(() => {
    startServer();
  });

  afterEach(() => {
    server.close();
    vi.useRealTimers();
  });

  it("does not close the first connection when a second arrives", () => {
    const first = connect();
    const second = connect();

    expect(first.closed).toBe(false);
    expect(first.terminated).toBe(false);
    // Both were greeted; neither greeting cost the other anything.
    expect(first.ofType("ready")).toHaveLength(1);
    expect(second.ofType("ready")).toHaveLength(1);
  });

  it("keeps answering the first connection's frames after the second connects", () => {
    const first = connect();
    const second = connect();

    first.receive({ type: "findByTask", reqId: "a1", taskId: "t1" });
    second.receive({ type: "findByTask", reqId: "b1", taskId: "t1" });

    expect(first.ofType<{ reqId: string }>("findByTaskResult").map((f) => f.reqId)).toEqual(["a1"]);
    expect(second.ofType<{ reqId: string }>("findByTaskResult").map((f) => f.reqId)).toEqual(["b1"]);
  });

  it("authenticates each connection independently", () => {
    server.close();
    startServer({ authVerifier: () => ({ ok: true, coreId: "core-1", exp: 9_999 }) });
    const authed = connect();
    const anonymous = connect();

    authed.receive({ type: "auth", reqId: "a1", bearer: "good" });
    expect(authed.ofType("authOk")).toHaveLength(1);

    // The other connection is still a stranger — one client's bearer is not
    // the Core's door held open for everybody behind it.
    anonymous.receive({ type: "findByTask", reqId: "b1", taskId: "t1" });
    expect(anonymous.ofType<{ message: string }>("error")[0]?.message).toBe("not-authenticated");
    expect(anonymous.closed).toBe(true);
    expect(authed.closed).toBe(false);
  });

  it("gives each connection its own event cursor", () => {
    log.port.appendEvent("pty:spawn", "{}", { ptyId: "pty-1" });
    log.port.appendEvent("pty:spawn", "{}", { ptyId: "pty-2" });

    const fromScratch = connect();
    const caughtUp = connect();
    fromScratch.receive({ type: "subscribe", reqId: "a1", lastEventId: 0 });
    caughtUp.receive({ type: "subscribe", reqId: "b1", lastEventId: 2 });

    // The replay each asked for, not the replay the other asked for.
    expect(fromScratch.ofType("event")).toHaveLength(2);
    expect(caughtUp.ofType("event")).toHaveLength(0);
    expect(fromScratch.ofType<{ lastEventId: number }>("eventsReplayed")[0]?.lastEventId).toBe(2);
    expect(caughtUp.ofType<{ lastEventId: number }>("eventsReplayed")[0]?.lastEventId).toBe(2);
  });

  it("leaves the other connection's poll timer running when one closes", async () => {
    const leaving = connect();
    const staying = connect();
    leaving.receive({ type: "subscribe", reqId: "a1", lastEventId: 0 });
    staying.receive({ type: "subscribe", reqId: "b1", lastEventId: 0 });

    leaving.close();
    const sentBefore = staying.sent.length;
    log.port.appendEvent("pty:exit", "{}", { ptyId: "pty-1" });

    // The live push is the survivor's own timer; it was never the departing
    // connection's to cancel.
    await vi.waitFor(() => expect(staying.ofType("event")).toHaveLength(1));
    expect(staying.sent.length).toBeGreaterThan(sentBefore);
    expect(leaving.ofType("event")).toHaveLength(0);
  });

  it("holds the Core's emit target until the last connection goes", () => {
    const first = connect();
    const second = connect();
    expect(core.hasTarget()).toBe(true);

    first.close();
    // Still one client here: the Core keeps emitting.
    expect(core.hasTarget()).toBe(true);

    second.close();
    expect(core.hasTarget()).toBe(false);
    // Installed once for the server, released once — not re-pointed per client.
    expect(core.emitTargets.filter((fn) => fn !== null)).toHaveLength(1);
  });

  it("fans PTY output out to every connection subscribed to that PTY", () => {
    const first = connect();
    const second = connect();
    first.receive({ type: "ptySubscribe", reqId: "a1", ptyId: "pty-1" });
    second.receive({ type: "ptySubscribe", reqId: "b1", ptyId: "pty-1" });

    core.emit({ type: "data", ptyId: "pty-1", data: "hello", seq: 7 });

    for (const ws of [first, second]) {
      expect(ws.ofType<{ ptyId: string; data: string; seq: number }>("data")).toEqual([
        { type: "data", ptyId: "pty-1", data: "hello", seq: 7 },
      ]);
    }
  });

  it("does not fan PTY output out to a connection that has not authenticated", () => {
    server.close();
    startServer({ authVerifier: () => ({ ok: true, coreId: "core-1", exp: 9_999 }) });
    const authed = connect();
    const stranger = connect();
    authed.receive({ type: "auth", reqId: "a1", bearer: "good" });
    expect(authed.ofType("authOk")).toHaveLength(1);
    authed.receive({ type: "ptySubscribe", reqId: "a2", ptyId: "pty-1" });

    core.emit({ type: "data", ptyId: "pty-1", data: "secret", seq: 1 });
    core.emit({ type: "exit", ptyId: "pty-1", exitCode: 0 });

    expect(authed.ofType("data")).toHaveLength(1);
    expect(authed.ofType("exit")).toHaveLength(1);
    // The stranger presents no bearer and sends no frame, so the message gate
    // never fires; it answers pings, so the heartbeat never reaps it. Since
    // issue 142 it has no subscription either, and both gates are checked — the
    // auth one is kept in front of the subscription one deliberately, so that
    // whatever a later ticket does to how a subscription is acquired, PTY bytes
    // still cannot reach a connection that has not proved who it is.
    expect(stranger.ofType("data")).toHaveLength(0);
    expect(stranger.ofType("exit")).toHaveLength(0);
    // Skipping a connection is not allowed to cost the log its row: the exit is
    // recorded once, off the single sink, outside the fan-out loop.
    expect(log.events.filter((event) => event.kind === "pty:exit")).toHaveLength(1);
  });

  it("records one pty:exit per exit, not one per connection", () => {
    const first = connect();
    const second = connect();
    const third = connect();
    for (const [i, ws] of [first, second, third].entries()) {
      ws.receive({ type: "ptySubscribe", reqId: `s${i}`, ptyId: "pty-1" });
    }

    core.emit({ type: "exit", ptyId: "pty-1", exitCode: 0 });

    expect(log.events.filter((event) => event.kind === "pty:exit")).toHaveLength(1);
    // …while every client still learns the PTY died.
    expect(first.ofType("exit")).toHaveLength(1);
    expect(second.ofType("exit")).toHaveLength(1);
  });

  it("reaps only the connection that went quiet", () => {
    vi.useFakeTimers();
    server.close();
    startServer({}, 100_000);
    const quiet = connect();
    const alive = connect();

    vi.advanceTimersByTime(20_000);
    alive.pong();
    vi.advanceTimersByTime(20_000);
    alive.pong();
    vi.advanceTimersByTime(20_000);

    // 60s of silence from one client, none from the other. The old heartbeat
    // asked "am I the active socket?" — with a registry that question reaps
    // whichever connection is not the newest, however healthy it is.
    expect(quiet.terminated).toBe(true);
    expect(alive.terminated).toBe(false);
    expect(alive.closed).toBe(false);
    expect(alive.pings).toBeGreaterThan(0);
  });

  it("leaves a single connection behaving exactly as before", async () => {
    const only = connect();
    only.receive({ type: "subscribe", reqId: "r1", lastEventId: 0 });

    expect(only.ofType<{ fromEventId: number }>("subscribeAck")).toEqual([
      { type: "subscribeAck", reqId: "r1", fromEventId: 0 },
    ]);
    log.port.appendEvent("pty:spawn", "{}", { ptyId: "pty-1" });
    await vi.waitFor(() => expect(only.ofType("event")).toHaveLength(1));

    only.receive({ type: "ptySubscribe", reqId: "r2", ptyId: "pty-1" });
    core.emit({ type: "data", ptyId: "pty-1", data: "out", seq: 1 });
    expect(only.ofType("data")).toHaveLength(1);

    only.close();
    expect(core.hasTarget()).toBe(false);
  });

  it("does not dispatch a frame that arrives after close()", async () => {
    server.close();
    startServer({ authVerifier: () => ({ ok: true, coreId: "core-1", exp: 9_999 }) });
    const ws = connect();
    ws.receive({ type: "auth", reqId: "a1", bearer: "good" });
    expect(ws.ofType("authOk")).toHaveLength(1);

    server.close();
    const sentBefore = ws.sent.length;

    // The `message` handler closes over the connection, not the registry, so
    // clearing the registry alone would leave `authenticated` true and these
    // two frames fully served by a Core that has already shut down.
    ws.receive({
      type: "spawn",
      reqId: "s1",
      opts: { taskId: "t1", cwd: "/tmp", command: "sh", agent: "claude-code" },
    });
    ws.receive({ type: "kill", reqId: "k1", ptyId: "pty-1" });
    await Promise.resolve();

    expect(core.spawned).toHaveLength(0);
    expect(core.killed).toHaveLength(0);
    expect(ws.sent).toHaveLength(sentBefore);
    expect(log.events).toHaveLength(0);
    // …and the client is told the Core is gone rather than left holding a
    // socket that answers nothing.
    expect(ws.closed).toBe(true);
  });
});
