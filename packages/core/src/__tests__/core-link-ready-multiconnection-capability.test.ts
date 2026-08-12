import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PtyCoreLinkServer,
  type EventLogPort,
  type WebSocketLike,
  type WebSocketServerLike,
} from "../pty-core-link-server";
import type { PtyCore, PtyCoreEvent } from "../pty-manager";
import { CORE_LINK_PROTOCOL_VERSION, type CoreLinkEvent } from "@actana/sdk/core-link-frames";

// The `multiConnection` capability on `ready` (issue 143, ADR 0024 D11).
//
// This build serves many connections, so it announces the capability — and it
// announces it without moving `CORE_LINK_PROTOCOL_VERSION`, which is the whole
// point of D11. The other half of the property is what a Core that does NOT
// announce it looks like: a well-formed `ready` with the field simply absent,
// which every client before this ticket already handled by never looking.

type Listener = (...args: unknown[]) => void;

class FakeWebSocket {
  readyState = 1;
  sent: string[] = [];
  private listeners: Record<string, Listener[]> = {};

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  terminate(): void {
    this.close();
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
  /** The one `ready` frame this connection was sent, parsed. */
  ready(): Record<string, unknown> {
    const frames = this.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((frame) => frame.type === "ready");
    expect(frames).toHaveLength(1);
    return frames[0]!;
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

function fakeEventLog(): EventLogPort {
  const events: CoreLinkEvent[] = [];
  return {
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

describe("the ready frame announces multiConnection (issue 143, ADR 0024 D11)", () => {
  let wss: FakeWebSocketServer;
  let server: PtyCoreLinkServer;

  function startServer(opts: { announceMultiConnection?: boolean } = {}): void {
    wss = new FakeWebSocketServer();
    server = new PtyCoreLinkServer(mockCore(), {
      port: 0,
      createServer: () => wss as unknown as WebSocketServerLike,
      eventLog: fakeEventLog(),
      liveEventPollMs: 5,
      ...opts,
    });
  }

  function connect(): FakeWebSocket {
    const ws = new FakeWebSocket();
    wss.connect(ws);
    return ws;
  }

  afterEach(() => {
    server.close();
  });

  describe("this build, which accepts many connections", () => {
    beforeEach(() => {
      startServer();
    });

    it("announces the capability at version 1 on ready", () => {
      expect(connect().ready()).toEqual({
        type: "ready",
        version: CORE_LINK_PROTOCOL_VERSION,
        multiConnection: { version: 1 },
      });
    });

    it("announces the same protocol version it always did — the capability does not move it", () => {
      expect(connect().ready().version).toBe(CORE_LINK_PROTOCOL_VERSION);
    });

    it("announces it to every connection, not just the first", () => {
      const first = connect();
      const second = connect();
      const third = connect();
      for (const ws of [first, second, third]) {
        expect(ws.ready().multiConnection).toEqual({ version: 1 });
      }
    });

    it("announces it before auth — a client learns what the Core is on frame one", () => {
      const ws = connect();
      // Nothing has been received from the client at this point: no `auth`, no
      // `subscribe`. The capability is already on the wire.
      expect(ws.ready().multiConnection).toEqual({ version: 1 });
    });
  });

  describe("a Core that does not announce it (the single-connection build)", () => {
    beforeEach(() => {
      startServer({ announceMultiConnection: false });
    });

    it("omits the field entirely rather than sending it null or false", () => {
      const frame = connect().ready();
      expect("multiConnection" in frame).toBe(false);
      expect(frame).toEqual({ type: "ready", version: CORE_LINK_PROTOCOL_VERSION });
    });

    it("still advertises the same protocol version, so it is not drift", () => {
      expect(connect().ready().version).toBe(CORE_LINK_PROTOCOL_VERSION);
    });
  });
});
