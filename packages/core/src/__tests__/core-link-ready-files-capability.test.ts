import { afterEach, describe, expect, it } from "vitest";
import {
  PtyCoreLinkServer,
  type EventLogPort,
  type PtyCoreLinkServerOptions,
  type WebSocketLike,
  type WebSocketServerLike,
} from "../pty-core-link-server";
import type { PtyCore, PtyCoreEvent } from "../pty-manager";
import { CORE_LINK_PROTOCOL_VERSION, type CoreLinkEvent } from "@actana/sdk/core-link-frames";

// The `files` capability on `ready` (#165 F9, ADR 0024 D11).
//
// It is announced when — and only when — the routes are actually being served,
// and it is announced without moving `CORE_LINK_PROTOCOL_VERSION`. Announcing a
// capability whose routes are not answering would be worse than announcing
// nothing: a client that reads the field stops feature-detecting and starts
// calling.

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
  /** What the server factory was handed, so a test can assert the routes exist. */
  lastFactoryOptions: { httpRoutes?: unknown } = {};
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

describe("the ready frame announces files (#165 F9, ADR 0024 D11)", () => {
  let wss: FakeWebSocketServer;
  let server: PtyCoreLinkServer;

  function startServer(opts: Partial<PtyCoreLinkServerOptions> = {}): void {
    wss = new FakeWebSocketServer();
    server = new PtyCoreLinkServer(mockCore(), {
      port: 0,
      createServer: (factoryOpts) => {
        wss.lastFactoryOptions = factoryOpts as { httpRoutes?: unknown };
        return wss as unknown as WebSocketServerLike;
      },
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

  describe("a Core with a files port, which is a Core that serves the routes", () => {
    it("announces the capability at version 1", () => {
      startServer({ filesPort: { projectRoot: () => "/tmp/project" } });
      expect(connect().ready()).toEqual({
        type: "ready",
        version: CORE_LINK_PROTOCOL_VERSION,
        multiConnection: { version: 1 },
        files: { version: 1 },
      });
    });

    it("hands the server factory the routes it announced, so the claim is not a lie", () => {
      startServer({ filesPort: { projectRoot: () => "/tmp/project" } });
      expect(wss.lastFactoryOptions.httpRoutes).toBeTruthy();
    });

    it("announces the same protocol version it always did — the capability does not move it", () => {
      startServer({ filesPort: { projectRoot: () => "/tmp/project" } });
      expect(connect().ready().version).toBe(CORE_LINK_PROTOCOL_VERSION);
    });

    it("announces it to every connection, not just the first", () => {
      startServer({ filesPort: { projectRoot: () => "/tmp/project" } });
      for (const ws of [connect(), connect(), connect()]) {
        expect(ws.ready().files).toEqual({ version: 1 });
      }
    });

    it("announces it before auth — a client learns what the Core is on frame one", () => {
      startServer({ filesPort: { projectRoot: () => "/tmp/project" }, authVerifier: () => ({ ok: false, reason: "malformed" }) });
      expect(connect().ready().files).toEqual({ version: 1 });
    });
  });

  describe("a Core with no files port — every Core that shipped before this", () => {
    it("omits the field entirely rather than sending it null or false", () => {
      startServer();
      const frame = connect().ready();
      expect("files" in frame).toBe(false);
      expect(frame).toEqual({
        type: "ready",
        version: CORE_LINK_PROTOCOL_VERSION,
        multiConnection: { version: 1 },
      });
    });

    it("mounts no routes at all, so nothing is listening to be found", () => {
      startServer();
      expect(wss.lastFactoryOptions.httpRoutes).toBeUndefined();
    });

    it("still advertises the same protocol version, so it is not drift", () => {
      startServer();
      expect(connect().ready().version).toBe(CORE_LINK_PROTOCOL_VERSION);
    });
  });

  describe("the announcement can be forced apart from the routes, for a test", () => {
    it("stays silent when told to, even with a files port wired", () => {
      startServer({ filesPort: { projectRoot: () => "/tmp/project" }, announceFiles: false });
      expect("files" in connect().ready()).toBe(false);
    });

    it("speaks up when told to, even with no files port", () => {
      startServer({ announceFiles: true });
      expect(connect().ready().files).toEqual({ version: 1 });
    });
  });

  describe("the two capabilities are independent", () => {
    it("announces files on a Core that announces no multiConnection", () => {
      startServer({ filesPort: { projectRoot: () => "/tmp/project" }, announceMultiConnection: false });
      expect(connect().ready()).toEqual({
        type: "ready",
        version: CORE_LINK_PROTOCOL_VERSION,
        files: { version: 1 },
      });
    });
  });
});
