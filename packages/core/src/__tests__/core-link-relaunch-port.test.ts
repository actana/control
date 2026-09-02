import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PtyCoreLinkServer,
  type WebSocketLike,
  type WebSocketServerLike,
} from "../pty-core-link-server";
import type { PtyCore, PtyCoreEvent } from "../pty-manager";

// Which spawns ask the relaunch port (issue 387, review finding 2).
//
// The port is what puts a bare Session's card back on `ready` when a harness
// comes up for it again. The decision of WHETHER to reset is the port's
// (`core-session-relaunch.ts`, tested there against real rows); the decision
// of whether to ask it at all is here, and it is a narrow one: an agent spawn
// asks, and the two shell variants — which carry a `taskId` for routing and
// are not harness work — never do.

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
  ofType(type: string): Array<Record<string, unknown>> {
    return this.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((frame) => frame.type === type);
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

function mockCore() {
  let nextPty = 0;
  const core = {
    setEmitTarget: (_fn: ((event: PtyCoreEvent) => void) | null) => {},
    spawn: async () => ({ ptyId: `pty-${++nextPty}`, hooksReportTurnStart: true }),
    write: () => true,
    resize: () => true,
    kill: () => true,
    killLaunchProcesses: async () => ({ ptyCount: 0, ports: [] }),
    findByTask: () => ({ ptyId: null }),
    taskIdForPty: () => null,
    replay: () => ({ data: "", nextSeq: 0 }),
    killAll: () => {},
  };
  return core as unknown as PtyCore;
}

describe("which spawns ask the relaunch port (issue 387)", () => {
  let wss: FakeWebSocketServer;
  let server: PtyCoreLinkServer;
  let asked: string[];

  async function spawn(opts: Record<string, unknown>, reqId: string): Promise<void> {
    const ws = new FakeWebSocket();
    wss.connect(ws);
    ws.receive({ type: "spawn", reqId, opts });
    await vi.waitFor(() => expect(ws.ofType("spawned").length).toBeGreaterThan(0));
  }

  beforeEach(() => {
    wss = new FakeWebSocketServer();
    asked = [];
    server = new PtyCoreLinkServer(mockCore(), {
      port: 0,
      createServer: () => wss as unknown as WebSocketServerLike,
      relaunchPort: { agentSpawned: (taskId) => void asked.push(taskId) },
      liveEventPollMs: 10_000,
    });
  });

  afterEach(() => {
    server.close();
  });

  it("asks for an agent spawn — the relaunch a settled bare Session gets", async () => {
    await spawn({ taskId: "t-1", cwd: "/w", command: "claude", agent: "claude-code" }, "a1");
    expect(asked).toEqual(["t-1"]);
  });

  it("never asks for a plain shell, which is not harness work", async () => {
    await spawn({ taskId: "t-1", cwd: "/w", command: "bash", shell: true }, "s1");
    expect(asked).toEqual([]);
  });

  it("never asks for a VM Shell Session, for the same reason", async () => {
    await spawn({ taskId: "term_vm_1", command: "", shellSession: true }, "v1");
    expect(asked).toEqual([]);
  });

  it("is optional — a Core with no port spawns exactly as before", async () => {
    server.close();
    wss = new FakeWebSocketServer();
    server = new PtyCoreLinkServer(mockCore(), {
      port: 0,
      createServer: () => wss as unknown as WebSocketServerLike,
      liveEventPollMs: 10_000,
    });
    await spawn({ taskId: "t-1", cwd: "/w", command: "claude", agent: "claude-code" }, "n1");
    expect(asked).toEqual([]);
  });
});
