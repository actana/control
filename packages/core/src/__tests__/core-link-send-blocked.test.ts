// A send into a `needs-input` Session is refused (#924).
//
// A send is a stamped `write` frame (#289 A, #404); an attached terminal's
// keystrokes are unstamped writes. When the target Session is `needs-input` the
// harness is parked on a dialog (an approval, a question), and text typed into
// it would answer that dialog by accident. The Core answers `blocked` and the
// PTY never sees the bytes. Terminal keystrokes are not a send and still pass.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PtyCoreLinkServer,
  type CoreQueryPort,
  type WebSocketLike,
  type WebSocketServerLike,
} from "../pty-core-link-server";
import type { PtyCore } from "../pty-manager";

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

/**
 * One live PTY belonging to `t1`, and a second belonging to nothing.
 *
 * The second is not an exotic case: a VM shell Session and a PTY whose Session row
 * has gone are both PTYs the Core can write to and cannot name a Session for.
 */
const writes: string[] = [];
function mockCore(): PtyCore {
  return {
    setEmitTarget: () => {},
    spawn: async () => ({ ptyId: "pty-1" }),
    write: (ptyId: string, data: string) => {
      if (ptyId === "pty-gone") return false;
      writes.push(data);
      return true;
    },
    resize: () => true,
    kill: () => true,
    killLaunchProcesses: async () => ({ ptyCount: 0, ports: [] }),
    findBySession: () => ({ ptyId: "pty-1" }),
    sessionIdForPty: (ptyId: string) => (ptyId === "pty-1" ? "t1" : null),
    replay: () => ({ data: "", nextSeq: 0 }),
    killAll: () => {},
  } as unknown as PtyCore;
}

const rows = new Map<string, { status: string }>();
const queryPort = {
  listSessionRows: () => [],
  listArchivedSessions: () => [],
  countArchivedSessions: () => 0,
  getSession: (id: string) => (rows.get(id) ?? null),
} as unknown as CoreQueryPort;

describe("a send into a needs-input Session is blocked (#924)", () => {
  let server: PtyCoreLinkServer;
  let ws: FakeWebSocket;

  beforeEach(() => {
    writes.length = 0;
    rows.clear();
    const wss = new FakeWebSocketServer();
    server = new PtyCoreLinkServer(mockCore(), {
      port: 0,
      createServer: () => wss as unknown as WebSocketServerLike,
      queryPort,
    });
    ws = new FakeWebSocket();
    wss.connect(ws);
  });

  afterEach(() => server.close());

  type Answer = { ok: boolean; blocked?: boolean; deliveryEventId?: number };
  async function write(
    reqId: string,
    frame: { ptyId: string; data: string; stamp?: boolean },
  ): Promise<Answer> {
    ws.receive({ type: "write", reqId, ...frame });
    let answer: Answer | undefined;
    await vi.waitFor(() => {
      answer = ws.sent
        .map((raw) => JSON.parse(raw) as Answer & { reqId?: string })
        .find((msg) => msg.reqId === reqId);
      expect(answer).toBeDefined();
    });
    return answer!;
  }

  it("answers blocked and types nothing when the Session is needs-input", async () => {
    rows.set("t1", { status: "needs-input" });
    const answer = await write("w1", { ptyId: "pty-1", data: "yes", stamp: true });
    expect(answer).toMatchObject({ ok: false, blocked: true });
    expect(answer.deliveryEventId).toBeUndefined();
    expect(writes).toEqual([]);
  });

  it("blocks the Enter half of a send as well", async () => {
    rows.set("t1", { status: "needs-input" });
    const answer = await write("w1", { ptyId: "pty-1", data: "\r", stamp: true });
    expect(answer).toMatchObject({ ok: false, blocked: true });
    expect(writes).toEqual([]);
  });

  it("still writes a send into a running Session", async () => {
    rows.set("t1", { status: "running" });
    const answer = await write("w1", { ptyId: "pty-1", data: "carry on", stamp: true });
    expect(answer.ok).toBe(true);
    expect(answer.blocked).toBeUndefined();
    expect(writes).toEqual(["carry on"]);
  });

  it("still writes a send into a finished Session", async () => {
    rows.set("t1", { status: "finished" });
    const answer = await write("w1", { ptyId: "pty-1", data: "again", stamp: true });
    expect(answer.ok).toBe(true);
    expect(writes).toEqual(["again"]);
  });

  it("does not touch terminal keystrokes into a needs-input Session", async () => {
    rows.set("t1", { status: "needs-input" });
    const answer = await write("w1", { ptyId: "pty-1", data: "y" });
    expect(answer.ok).toBe(true);
    expect(answer.blocked).toBeUndefined();
    expect(writes).toEqual(["y"]);
  });

  it("writes when the Session row is unknown to the query port", async () => {
    const answer = await write("w1", { ptyId: "pty-1", data: "hi", stamp: true });
    expect(answer.ok).toBe(true);
    expect(writes).toEqual(["hi"]);
  });
});
