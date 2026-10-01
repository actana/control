import { describe, expect, it, afterEach } from "vitest";
import {
  PtyCoreLinkServer,
  type PtyCoreLinkServerOptions,
  type WebSocketLike,
  type WebSocketServerLike,
} from "../pty-core-link-server";
import type { PtyCore } from "../pty-manager";
import { sharedCapability } from "../shared-capability";

// `ready.shared` (#561). Announced as `{ version: 1, backend }` when the Core keeps
// a Shared folder, and omitted entirely on a Core that does not. The type is the
// Core's own until client PR 33 reaches a published SDK (actana/client#4).

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
    const frames = this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>).filter((f) => f.type === "ready");
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

function mockCore(): PtyCore {
  return {
    setEmitTarget: () => {},
    killAll: () => {},
  } as unknown as PtyCore;
}

describe("the ready frame announces the Shared folder (#561)", () => {
  let wss: FakeWebSocketServer;
  let server: PtyCoreLinkServer;

  function start(opts: Partial<PtyCoreLinkServerOptions> = {}): FakeWebSocket {
    wss = new FakeWebSocketServer();
    server = new PtyCoreLinkServer(mockCore(), {
      port: 0,
      createServer: () => wss as unknown as WebSocketServerLike,
      liveEventPollMs: 5,
      ...opts,
    });
    const ws = new FakeWebSocket();
    wss.connect(ws);
    return ws;
  }

  afterEach(() => server.close());

  it("announces version 1 and backend local", () => {
    expect(start({ shared: sharedCapability() }).ready().shared).toEqual({ version: 1, backend: "local" });
  });

  it("announces backend s3 when told the folder is mounted from S3", () => {
    expect(start({ shared: sharedCapability("s3") }).ready().shared).toEqual({ version: 1, backend: "s3" });
  });

  it("defaults the announced backend to local, because nothing here configures S3", () => {
    expect(sharedCapability()).toEqual({ version: 1, backend: "local" });
  });

  it("omits the field on a Core that keeps no Shared folder, rather than sending null", () => {
    const frame = start().ready();
    expect("shared" in frame).toBe(false);
  });
});
