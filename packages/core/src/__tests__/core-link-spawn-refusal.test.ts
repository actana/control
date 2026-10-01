import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PtyCoreLinkServer,
  type WebSocketLike,
  type WebSocketServerLike,
} from "../pty-core-link-server";
import type { PtyCore, PtyCoreEvent } from "../pty-manager";
import log from "@actana/shared/log";

// A `spawn` takes no start directory and no grouping field (ADR 0041 D2): every
// Session starts in the Core's home. A client from before 0.5.0 that still sends
// one is refused, by name, on the wire and in the Core's log, and nothing is
// spawned. It is not ignored: a spawn that quietly started somewhere other than
// where the client asked would be a worse answer than none.
//
// This file is the one place the old field names are spelled out in the Core:
// refusing a field means naming it.
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
    findBySession: () => ({ ptyId: null }),
    sessionIdForPty: () => null,
    replay: () => ({ data: "", nextSeq: 0 }),
    killAll: () => {},
  };
  return core as unknown as PtyCore;
}

describe("a spawn that names a start directory or a project is refused", () => {
  let wss: FakeWebSocketServer;
  let server: PtyCoreLinkServer;
  let spawned: unknown[];

  function mockSpawningCore(): PtyCore {
    const core = mockCore() as unknown as Record<string, unknown>;
    core.spawn = async (opts: unknown) => {
      spawned.push(opts);
      return { ptyId: "pty-1", hooksReportTurnStart: true };
    };
    return core as unknown as PtyCore;
  }

  function send(opts: Record<string, unknown>): FakeWebSocket {
    const ws = new FakeWebSocket();
    wss.connect(ws);
    ws.receive({ type: "spawn", reqId: "r1", opts });
    return ws;
  }

  beforeEach(() => {
    wss = new FakeWebSocketServer();
    spawned = [];
    server = new PtyCoreLinkServer(mockSpawningCore(), {
      port: 0,
      createServer: () => wss as unknown as WebSocketServerLike,
      liveEventPollMs: 10_000,
    });
  });

  afterEach(() => {
    server.close();
    vi.restoreAllMocks();
  });

  it("spawns a Session that names neither, and hands the Core nothing to start it anywhere else", async () => {
    const ws = send({ sessionId: "s-1", command: "claude", agent: "claude-code" });
    await vi.waitFor(() => expect(ws.ofType("spawned")).toHaveLength(1));
    expect(spawned).toEqual([{ sessionId: "s-1", command: "claude", agent: "claude-code" }]);
  });

  it.each([
    ["cwd", { cwd: "/srv/anywhere" }],
    ["an empty cwd", { cwd: "" }],
    ["projectId", { projectId: "p-1" }],
  ])("refuses a spawn carrying %s, by name, on the wire and in the log, and spawns nothing", async (_label, extra) => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const ws = send({ sessionId: "s-2", command: "claude", agent: "claude-code", ...extra });
    await vi.waitFor(() => expect(ws.ofType("spawnError")).toHaveLength(1));
    const [error] = ws.ofType("spawnError");
    const field = Object.keys(extra)[0]!;
    expect(error!.reqId).toBe("r1");
    expect(error!.message).toBe(`spawn does not take "${field}": a Session belongs to the Core and starts in its home directory`);
    expect(ws.ofType("spawned")).toEqual([]);
    expect(spawned).toEqual([]);
    expect(warn).toHaveBeenCalledWith("core-link.spawn.refused", { reason: error!.message });
  });

  it("refuses the shell variants the same way", async () => {
    for (const opts of [
      { sessionId: "s-3", command: "", shell: true, cwd: "/tmp" },
      { sessionId: "s-4", shellSession: true, cwd: "/tmp" },
    ]) {
      const ws = send(opts);
      await vi.waitFor(() => expect(ws.ofType("spawnError")).toHaveLength(1));
    }
    expect(spawned).toEqual([]);
  });
});

// The same refusal for the frames that used to carry a project: the list frames'
// filter, the `create` of `sessionsMutate`, and the two frames that read and wrote
// the project rows, which the Core no longer handles at all.
describe("a frame that names a project reaches no port, and is refused", () => {
  let wss: FakeWebSocketServer;
  let server: PtyCoreLinkServer;
  let portCalls: string[];

  beforeEach(() => {
    wss = new FakeWebSocketServer();
    portCalls = [];
    const queryPort = {
      listSessionRows: () => (portCalls.push("listSessionRows"), []),
      listArchivedSessions: () => (portCalls.push("listArchivedSessions"), []),
      countArchivedSessions: () => (portCalls.push("countArchivedSessions"), 0),
      getSession: () => null,
    };
    const mutationPort = {
      mutateSession: () => (portCalls.push("mutateSession"), null),
      listSessions: () => (portCalls.push("listSessions"), []),
    };
    server = new PtyCoreLinkServer(mockCore(), {
      port: 0,
      createServer: () => wss as unknown as WebSocketServerLike,
      queryPort,
      mutationPort,
      liveEventPollMs: 10_000,
    });
  });

  afterEach(() => {
    server.close();
    vi.restoreAllMocks();
  });

  /** Send one frame on a fresh connection; `answers` is what came back after the hello. */
  function ask(frame: Record<string, unknown>): FakeWebSocket & { answers: string[] } {
    const ws = new FakeWebSocket();
    wss.connect(ws);
    const before = ws.sent.length;
    ws.receive(frame);
    return Object.assign(ws, { answers: ws.sent.slice(before) });
  }

  it.each([
    ["sessionRowsList", { type: "sessionRowsList", reqId: "r1", projectId: "p-1" }],
    ["archivedSessionRowsList", { type: "archivedSessionRowsList", reqId: "r1", projectId: "p-1" }],
    ["sessionsList", { type: "sessionsList", reqId: "r1", projectId: "p-1" }],
    [
      "sessionsMutate create",
      { type: "sessionsMutate", reqId: "r1", mutation: { op: "create", projectId: "p-1", title: "t", agent: "claude-code" } },
    ],
  ])("refuses %s carrying projectId: an error frame naming it, the log, and no port called", (what, frame) => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const ws = ask(frame);
    const answers = ws.ofType("error");
    expect(answers).toHaveLength(1);
    expect(answers[0]).toEqual({
      type: "error",
      reqId: "r1",
      message: `${what} does not take "projectId": a Session belongs to the Core and starts in its home directory`,
    });
    expect(ws.answers).toHaveLength(1);
    expect(portCalls).toEqual([]);
    expect(warn).toHaveBeenCalledWith("core-link.frame.refused", { type: frame.type, reason: answers[0]!.message });
  });

  it("still answers the same frames without it", () => {
    expect(ask({ type: "sessionRowsList", reqId: "a" }).ofType("sessionRowsListResult")).toHaveLength(1);
    expect(ask({ type: "archivedSessionRowsList", reqId: "b" }).ofType("archivedSessionRowsListResult")).toHaveLength(1);
    expect(ask({ type: "sessionsList", reqId: "c" }).ofType("sessionsListResult")).toHaveLength(1);
    expect(
      ask({ type: "sessionsMutate", reqId: "d", mutation: { op: "create", title: "t", agent: "claude-code" } }).ofType(
        "sessionsMutateResult",
      ),
    ).toHaveLength(1);
    expect(portCalls).toEqual(["listSessionRows", "countArchivedSessions", "listArchivedSessions", "listSessions", "mutateSession"]);
  });

  it.each([
    [{ type: "projectsList", reqId: "r1" }],
    [{ type: "projectsMutate", reqId: "r2", mutation: { op: "create", name: "x", path: "/x" } }],
  ])("answers the project frame %j as unhandled by name, with its reqId, and emits no Result frame", (frame) => {
    // ADR 0041 D27: a refusal that says why, not a silent ignore, so a 0.4.x
    // client learns the frame is retired. The SDK codec no longer parses these
    // frames, so the server names them from the refused text.
    const ws = ask(frame);
    expect(ws.answers).toHaveLength(1);
    expect(JSON.parse(ws.answers[0]!)).toEqual({
      type: "error",
      reqId: frame.reqId,
      message: `unhandled frame type: ${frame.type}`,
    });
    expect(portCalls).toEqual([]);
  });

  it("still names the retired frame when it carried no reqId, and names no request", () => {
    const ws = ask({ type: "projectsList" });
    expect(ws.answers).toHaveLength(1);
    expect(JSON.parse(ws.answers[0]!)).toEqual({ type: "error", message: "unhandled frame type: projectsList" });
  });

  it("answers a frame that was never a frame as invalid, naming only its reqId", () => {
    const ws = ask({ type: "noSuchFrame", reqId: "r9" });
    expect(ws.answers).toHaveLength(1);
    expect(JSON.parse(ws.answers[0]!)).toEqual({ type: "error", reqId: "r9", message: "invalid frame" });
  });
});
