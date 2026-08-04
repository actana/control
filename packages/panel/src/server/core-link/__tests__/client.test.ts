import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PtyCoreLinkServer,
  type WebSocketLike,
  type WebSocketServerLike,
  type EventLogPort,
} from "@actana/core/pty-core-link-server";
import {
  PtyCoreLinkClient,
  type WebSocketLike as ClientWebSocketLike,
} from "../client";
import type { PtyCore, PtyCoreEvent } from "@actana/core/pty-manager";
import {
  CORE_LINK_PROTOCOL_VERSION,
  type CoreLinkEvent,
} from "@actana/shared/core-link-frames";
import { signBearer, verifyBearer, type BearerSecret } from "@actana/shared/core-link-bearer";

// ─── Fake WebSocket ───────────────────────────────────────────────────────────
//
// A pair of connected fakes: `server` is the WebSocket the PtyCoreLinkServer
// holds; `client` is the one the PtyCoreLinkClient holds. `send` on one side
// delivers to the other's "message" listeners. `receive` simulates an inbound
// message WITHOUT recording it in `sent` (so tests can distinguish "what I
// sent" from "what I received").

type Listener = (...args: unknown[]) => void;

class FakeWebSocketPair {
  server: FakeWebSocket;
  client: FakeWebSocket;

  constructor() {
    const server = new FakeWebSocket();
    const client = new FakeWebSocket();
    server.peer = client;
    client.peer = server;
    this.server = server;
    this.client = client;
  }

  openClient(): void {
    this.client.readyState = 1;
    this.server.readyState = 1;
    this.client.emit("open");
    this.server.emit("open");
  }

  closeClient(): void {
    this.client.readyState = 3;
    this.server.readyState = 3;
    this.client.emit("close");
    this.server.emit("close");
  }
}

class FakeWebSocket {
  readyState = 0;
  sent: string[] = [];
  protected listeners: Record<string, Listener[]> = {};
  peer: FakeWebSocket | null = null;

  send(data: string): void {
    this.sent.push(data);
    this.peer?.emit("message", data);
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

  /** Simulate receiving a message from the peer (without recording in `sent`). */
  receive(obj: unknown): void {
    this.emit("message", typeof obj === "string" ? obj : JSON.stringify(obj));
  }

  lastSent(): Record<string, unknown> | null {
    if (this.sent.length === 0) return null;
    return JSON.parse(this.sent[this.sent.length - 1]!);
  }
}

// ─── Mock PtyCore ───────────────────────────────────────────────────

function makeMockCore(): PtyCore & {
  emitEvent: (e: PtyCoreEvent) => void;
} {
  const core: Record<string, unknown> = {
    setEmitTarget: vi.fn((fn: ((event: PtyCoreEvent) => void) | null) => {
      (core as Record<string, unknown>)._emit = fn;
    }),
    spawn: vi.fn(async () => ({ ptyId: "pty-test-1" })),
    write: vi.fn(() => true),
    resize: vi.fn(() => true),
    kill: vi.fn(() => true),
    killLaunchProcesses: vi.fn(async () => ({
      ptyCount: 2,
      ports: [{ port: 3000, pids: [123], killed: [123], errors: [] }],
    })),
    killPtysUnderPath: vi.fn(async () => ({ ptyCount: 1 })),
    findByTask: vi.fn(() => ({ ptyId: "pty-test-1" })),
    replay: vi.fn(() => ({ data: "buffered", nextSeq: 42 })),
    killAll: vi.fn(),
    _emit: null,
    emitEvent: (e: PtyCoreEvent) => {
      (core._emit as ((e: PtyCoreEvent) => void) | null)?.(e);
    },
  };
  return core as unknown as PtyCore & {
    emitEvent: (e: PtyCoreEvent) => void;
  };
}

// ─── Fake server factory ────────────────────────────────────────────────────

class FakeWebSocketServer {
  private connCb: ((ws: WebSocketLike) => void) | null = null;

  simulateConnection(ws: FakeWebSocket): void {
    this.connCb?.(ws as unknown as WebSocketLike);
  }

  close(): void {}

  on(event: string, cb: (...args: unknown[]) => void): void {
    if (event === "connection") this.connCb = cb as (ws: WebSocketLike) => void;
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("PtyCoreLinkServer", () => {
  let core: ReturnType<typeof makeMockCore>;
  let server: PtyCoreLinkServer;
  let fakeWss: FakeWebSocketServer;
  let pair: FakeWebSocketPair;

  beforeEach(() => {
    core = makeMockCore();
    fakeWss = new FakeWebSocketServer();
    server = new PtyCoreLinkServer(core, {
      port: 0,
      createServer: () => fakeWss as unknown as WebSocketServerLike,
    });
    pair = new FakeWebSocketPair();
    fakeWss.simulateConnection(pair.server);
    pair.openClient();
  });

  afterEach(() => {
    server.close();
  });

  it("sends a ready frame on connection with the protocol version", () => {
    // The server sent "ready" via pair.server.send() → pair.server.sent.
    expect(pair.server.lastSent()).toEqual({
      type: "ready",
      version: CORE_LINK_PROTOCOL_VERSION,
    });
  });

  it("wires core events as data/exit frames", () => {
    core.emitEvent({ type: "data", ptyId: "p1", data: "hello", seq: 1 });
    expect(pair.server.lastSent()).toEqual({
      type: "data",
      ptyId: "p1",
      data: "hello",
      seq: 1,
    });

    core.emitEvent({ type: "exit", ptyId: "p1", exitCode: 0 });
    expect(pair.server.lastSent()).toEqual({
      type: "exit",
      ptyId: "p1",
      exitCode: 0,
      signal: undefined,
    });
  });

  it("dispatches a spawn request and sends the spawned response", async () => {
    // Simulate the client sending a spawn frame to the server.
    pair.server.receive({
      type: "spawn",
      reqId: "r1",
      opts: { taskId: "t1", cwd: "/tmp", command: "claude", agent: "claude-code" },
    });
    await vi.waitFor(() => expect(core.spawn).toHaveBeenCalled());
    expect(pair.server.lastSent()).toMatchObject({
      type: "spawned",
      reqId: "r1",
      ptyId: "pty-test-1",
    });
  });

  it("dispatches a write request and sends writeResult", async () => {
    pair.server.receive({ type: "write", reqId: "r2", ptyId: "p1", data: "ls\n" });
    await vi.waitFor(() => expect(core.write).toHaveBeenCalledWith("p1", "ls\n"));
    expect(pair.server.lastSent()).toEqual({ type: "writeResult", reqId: "r2", ok: true });
  });

  it("dispatches replay and sends replayResult", async () => {
    pair.server.receive({ type: "replay", reqId: "r3", ptyId: "p1" });
    await vi.waitFor(() => expect(core.replay).toHaveBeenCalledWith("p1", undefined));
    expect(pair.server.lastSent()).toEqual({
      type: "replayResult",
      reqId: "r3",
      data: "buffered",
      nextSeq: 42,
      from: undefined,
    });
  });

  it("passes a reattach cursor through to the Core", async () => {
    pair.server.receive({ type: "replay", reqId: "r3b", ptyId: "p1", sinceSeq: 40 });
    await vi.waitFor(() => expect(core.replay).toHaveBeenCalledWith("p1", 40));
  });

  it("dispatches findByTask and sends findByTaskResult", async () => {
    pair.server.receive({ type: "findByTask", reqId: "r4", taskId: "t1" });
    await vi.waitFor(() => expect(core.findByTask).toHaveBeenCalledWith("t1"));
    expect(pair.server.lastSent()).toEqual({
      type: "findByTaskResult",
      reqId: "r4",
      ptyId: "pty-test-1",
    });
  });

  it("dispatches killLaunchProcesses and sends the result", async () => {
    pair.server.receive({
      type: "killLaunchProcesses",
      reqId: "r5",
      cwd: "/tmp",
      commands: ["vite"],
      ports: [3000],
    });
    await vi.waitFor(() => expect(core.killLaunchProcesses).toHaveBeenCalled());
    expect(pair.server.lastSent()).toMatchObject({
      type: "killLaunchProcessesResult",
      reqId: "r5",
      result: { ptyCount: 2, ports: [{ port: 3000, pids: [123], killed: [123], errors: [] }] },
    });
  });

  it("returns an error frame for an invalid message", async () => {
    pair.server.receive("not json");
    await vi.waitFor(() => expect(pair.server.lastSent()?.type).toBe("error"));
    expect(pair.server.lastSent()).toMatchObject({ type: "error", message: "invalid frame" });
  });

  it("clears the emit target when the client disconnects", () => {
    expect(core.setEmitTarget).toHaveBeenCalledWith(expect.any(Function));
    pair.closeClient();
    expect(core.setEmitTarget).toHaveBeenCalledWith(null);
  });
});

// ─── projectsList / tasksList via CoreQueryPort (issue 07) ───────────────

import type { CoreQueryPort } from "@actana/core/pty-core-link-server";
import type {
  CoreLinkProjectSnapshot,
  CoreLinkTaskSnapshot,
} from "@actana/shared/core-link-frames";

/** In-memory CoreQueryPort for tests. */
class FakeQueryPort implements CoreQueryPort {
  projects: CoreLinkProjectSnapshot[] = [];
  tasks: CoreLinkTaskSnapshot[] = [];
  listProjectsCalls = 0;
  listTasksCalls: (string | undefined)[] = [];

  listProjects(): CoreLinkProjectSnapshot[] {
    this.listProjectsCalls++;
    return this.projects;
  }
  listTasks(projectId?: string): CoreLinkTaskSnapshot[] {
    this.listTasksCalls.push(projectId);
    if (projectId === undefined) return this.tasks;
    return this.tasks.filter((t) => t.projectId === projectId);
  }
}

describe("PtyCoreLinkServer projectsList / tasksList (issue 07)", () => {
  let core: ReturnType<typeof makeMockCore>;
  let server: PtyCoreLinkServer;
  let fakeWss: FakeWebSocketServer;
  let pair: FakeWebSocketPair;
  let queryPort: FakeQueryPort;

  beforeEach(() => {
    core = makeMockCore();
    fakeWss = new FakeWebSocketServer();
    queryPort = new FakeQueryPort();
    server = new PtyCoreLinkServer(core, {
      port: 0,
      createServer: () => fakeWss as unknown as WebSocketServerLike,
      queryPort,
    });
    pair = new FakeWebSocketPair();
    fakeWss.simulateConnection(pair.server);
    pair.openClient();
  });

  afterEach(() => {
    server.close();
  });

  it("answers projectsList with the query port's project snapshots", async () => {
    queryPort.projects = [
      {
        projectId: "p1",
        name: "mission-control",
        path: "/home/op/mission-control",
        icon: "MC",
        iconColor: "#7ce58a",
        pinned: true,
        updatedAt: 1,
      },
    ];
    pair.server.receive({ type: "projectsList", reqId: "r1" });
    await vi.waitFor(() => expect(queryPort.listProjectsCalls).toBe(1));
    expect(pair.server.lastSent()).toEqual({
      type: "projectsListResult",
      reqId: "r1",
      projects: queryPort.projects,
    });
  });

  it("answers tasksList (no projectId) with every task from the query port", async () => {
    queryPort.tasks = [
      {
        taskId: "t1",
        projectId: "p1",
        title: "fix bug",
        agent: "claude-code",
        status: "running",
        pinned: false,
        archived: false,
        icon: null,
        updatedAt: 2,
      },
      {
        taskId: "t2",
        projectId: "p2",
        title: "ship",
        agent: "codex",
        status: "needs-input",
        pinned: false,
        archived: false,
        icon: "bug",
        updatedAt: 3,
      },
    ];
    pair.server.receive({ type: "tasksList", reqId: "r2" });
    await vi.waitFor(() => expect(queryPort.listTasksCalls).toEqual([undefined]));
    expect(pair.server.lastSent()).toEqual({
      type: "tasksListResult",
      reqId: "r2",
      tasks: queryPort.tasks,
    });
  });

  it("forwards the projectId filter on tasksList to the query port", async () => {
    queryPort.tasks = [
      { taskId: "t1", projectId: "p1", title: "a", agent: "claude-code", status: "running", pinned: false, archived: false, icon: null, updatedAt: 1 },
      { taskId: "t2", projectId: "p2", title: "b", agent: "claude-code", status: "running", pinned: false, archived: false, icon: null, updatedAt: 1 },
    ];
    pair.server.receive({ type: "tasksList", reqId: "r3", projectId: "p1" });
    await vi.waitFor(() => expect(queryPort.listTasksCalls).toEqual(["p1"]));
    expect(pair.server.lastSent()).toEqual({
      type: "tasksListResult",
      reqId: "r3",
      tasks: [queryPort.tasks[0]],
    });
  });

  it("returns empty results when no queryPort is configured (backward compat)", async () => {
    // A server built without a queryPort (e.g. tests that only exercise PTY)
    // still answers the frames — with empty results — so the Panel can round-
    // trip them without errors.
    core = makeMockCore();
    const bareServer = new PtyCoreLinkServer(core, {
      port: 0,
      createServer: () => new FakeWebSocketServer() as unknown as WebSocketServerLike,
    });
    const bareWss = new FakeWebSocketServer();
    // Replace the server's factory-produced wss with our controllable one by
    // building through the same path: re-create with the bare wss.
    bareServer.close();
    const wss = new FakeWebSocketServer();
    const s = new PtyCoreLinkServer(core, {
      port: 0,
      createServer: () => wss as unknown as WebSocketServerLike,
    });
    const p = new FakeWebSocketPair();
    wss.simulateConnection(p.server);
    p.openClient();

    p.server.receive({ type: "projectsList", reqId: "r1" });
    await vi.waitFor(() => expect(p.server.lastSent()?.type).toBe("projectsListResult"));
    expect(p.server.lastSent()).toMatchObject({ type: "projectsListResult", reqId: "r1", projects: [] });

    p.server.receive({ type: "tasksList", reqId: "r2" });
    await vi.waitFor(() => expect(p.server.lastSent()?.type).toBe("tasksListResult"));
    expect(p.server.lastSent()).toMatchObject({ type: "tasksListResult", reqId: "r2", tasks: [] });
    s.close();
  });
});

// ─── Event log + reconnect replay ───────────────────────────────────────────

/** In-memory EventLogPort for tests. Appends return sequential ids; the tail
 *  read mirrors the real SQLite behavior. */
class FakeEventLog implements EventLogPort {
  private events: CoreLinkEvent[] = [];
  private nextId = 1;

  appendEvent(
    kind: string,
    payload: string,
    opts: { ptyId?: string | null; taskId?: string | null } = {},
  ): number {
    const event: CoreLinkEvent = {
      eventId: this.nextId++,
      ts: Date.now(),
      kind,
      ptyId: opts.ptyId ?? null,
      taskId: opts.taskId ?? null,
      payload,
    };
    this.events.push(event);
    return event.eventId;
  }

  readEventTail(afterEventId: number, limit = 1_000): CoreLinkEvent[] {
    return this.events
      .filter((e) => e.eventId > afterEventId)
      .slice(0, limit);
  }

  getLastEventId(): number {
    return this.events.length ? this.events[this.events.length - 1]!.eventId : 0;
  }

  /** Test helper: seed an event as if the server process recorded it. */
  seed(kind: string, payload: string, opts?: { ptyId?: string; taskId?: string }): number {
    return this.appendEvent(kind, payload, opts);
  }
}

describe("PtyCoreLinkServer event log", () => {
  let core: ReturnType<typeof makeMockCore>;
  let server: PtyCoreLinkServer;
  let fakeWss: FakeWebSocketServer;
  let pair: FakeWebSocketPair;
  let eventLog: FakeEventLog;

  beforeEach(() => {
    core = makeMockCore();
    fakeWss = new FakeWebSocketServer();
    eventLog = new FakeEventLog();
    server = new PtyCoreLinkServer(core, {
      port: 0,
      createServer: () => fakeWss as unknown as WebSocketServerLike,
      eventLog,
      // Fast poll so live-event tests don't need to wait 500ms.
      liveEventPollMs: 5,
    });
    pair = new FakeWebSocketPair();
    fakeWss.simulateConnection(pair.server);
    pair.openClient();
  });

  afterEach(() => {
    server.close();
  });

  function sentFrames(): Record<string, unknown>[] {
    return pair.server.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }

  it("records a pty:exit event when the core emits an exit", () => {
    core.emitEvent({ type: "exit", ptyId: "p1", exitCode: 0 });
    expect(eventLog.readEventTail(0)).toContainEqual(
      expect.objectContaining({ kind: "pty:exit", ptyId: "p1" }),
    );
  });

  it("records a pty:spawn event on a successful spawn", async () => {
    pair.server.receive({
      type: "spawn",
      reqId: "r1",
      opts: { taskId: "t1", cwd: "/tmp", command: "claude", agent: "claude-code" },
    });
    await vi.waitFor(() => expect(core.spawn).toHaveBeenCalled());
    expect(eventLog.readEventTail(0)).toContainEqual(
      expect.objectContaining({ kind: "pty:spawn", ptyId: "pty-test-1", taskId: "t1" }),
    );
  });

  it("records a pty:spawn event for a VM shell session carrying shellSession in the payload", async () => {
    // A `shellSession: true` spawn (issue 06) is a VM Shell Session, not an
    // agent spawn: no cwd, no agent. The pty:spawn event must carry
    // `shellSession: true` in its payload so a reconnecting Panel can render
    // the replayed spawn with the distinct "VM shell" surface.
    pair.server.receive({
      type: "spawn",
      reqId: "r2",
      opts: { shellSession: true, taskId: "vm1" },
    });
    await vi.waitFor(() => expect(core.spawn).toHaveBeenCalled());
    const spawns = eventLog.readEventTail(0).filter((e) => e.kind === "pty:spawn");
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.ptyId).toBe("pty-test-1");
    expect(spawns[0]!.taskId).toBe("vm1");
    expect(JSON.parse(spawns[0]!.payload).shellSession).toBe(true);
  });

  it("records a pty:spawn event for an agent spawn with shellSession false in the payload", async () => {
    // Backward compat: agent/shell spawns carry `shellSession: false` so the
    // payload shape is uniform across spawn modes.
    pair.server.receive({
      type: "spawn",
      reqId: "r3",
      opts: { taskId: "t1", cwd: "/tmp", command: "claude", agent: "claude-code" },
    });
    await vi.waitFor(() => expect(core.spawn).toHaveBeenCalled());
    const spawns = eventLog.readEventTail(0).filter((e) => e.kind === "pty:spawn");
    expect(spawns).toHaveLength(1);
    expect(JSON.parse(spawns[0]!.payload).shellSession).toBe(false);
  });

  it("replays the event tail on subscribe then sends eventsReplayed", () => {
    // Seed events from the "server process" (task lifecycle).
    eventLog.seed("task:created", '{"id":"t1"}', { taskId: "t1" });
    eventLog.seed("task:updated", '{"id":"t1","status":"running"}', { taskId: "t1" });

    // Drain the `ready` frame sent on connection so only the replay frames
    // are inspected.
    pair.server.sent.length = 0;
    pair.server.receive({ type: "subscribe", reqId: "sub1", lastEventId: 0 });

    const frames = sentFrames();
    // subscribeAck first
    expect(frames[0]).toMatchObject({ type: "subscribeAck", reqId: "sub1" });
    // Then two event frames
    const eventFrames = frames.filter((f) => f.type === "event");
    expect(eventFrames).toHaveLength(2);
    expect((eventFrames[0] as { event: CoreLinkEvent }).event.kind).toBe("task:created");
    expect((eventFrames[1] as { event: CoreLinkEvent }).event.kind).toBe("task:updated");
    // Then the eventsReplayed marker carrying the new cursor
    const replayed = frames.filter((f) => f.type === "eventsReplayed");
    expect(replayed).toHaveLength(1);
    expect((replayed[0] as { lastEventId: number }).lastEventId).toBe(2);
  });

  it("replays only events past the lastEventId cursor", () => {
    const first = eventLog.seed("task:created", "{}", { taskId: "t1" });
    eventLog.seed("task:updated", "{}", { taskId: "t1" });

    pair.server.sent.length = 0;
    pair.server.receive({ type: "subscribe", reqId: "sub1", lastEventId: first });

    const frames = sentFrames();
    const eventFrames = frames.filter((f) => f.type === "event");
    expect(eventFrames).toHaveLength(1);
    expect((eventFrames[0] as { event: CoreLinkEvent }).event.kind).toBe("task:updated");
    const replayed = frames.find((f) => f.type === "eventsReplayed") as
      | { lastEventId: number }
      | undefined;
    expect(replayed?.lastEventId).toBe(first + 1);
  });

  it("sends eventsReplayed with the cursor unchanged when the tail is empty", () => {
    pair.server.sent.length = 0;
    pair.server.receive({ type: "subscribe", reqId: "sub1", lastEventId: 0 });
    const frames = sentFrames();
    expect(frames.filter((f) => f.type === "event")).toHaveLength(0);
    const replayed = frames.find((f) => f.type === "eventsReplayed") as
      | { lastEventId: number }
      | undefined;
    expect(replayed?.lastEventId).toBe(0);
  });

  it("pushes new events live after subscribe via the poll loop", async () => {
    pair.server.receive({ type: "subscribe", reqId: "sub1", lastEventId: 0 });
    // Drain the immediate replay frames.
    pair.server.sent.length = 0;

    // A task event lands "after" the replay — the poll must push it live.
    eventLog.seed("task:updated", '{"status":"running"}', { taskId: "t1" });

    await vi.waitFor(() => {
      expect(sentFrames().some((f) => f.type === "event")).toBe(true);
    });
    const eventFrames = sentFrames().filter((f) => f.type === "event");
    expect((eventFrames[0] as { event: CoreLinkEvent }).event.kind).toBe("task:updated");
  });

  it("does not push live events before the connection subscribes", async () => {
    eventLog.seed("task:updated", "{}", { taskId: "t1" });
    // Give the poll a chance to run — it must stay silent (not subscribed).
    await new Promise((r) => setTimeout(r, 20));
    expect(sentFrames().some((f) => f.type === "event")).toBe(false);
  });
});

describe("PtyCoreLinkClient", () => {
  let pair: FakeWebSocketPair;

  beforeEach(() => {
    pair = new FakeWebSocketPair();
  });

  function makeClient(storage?: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void }): PtyCoreLinkClient {
    const client = new PtyCoreLinkClient({
      url: "ws://127.0.0.1:0",
      createSocket: () => pair.client as unknown as ClientWebSocketLike,
      reconnectInitialMs: 10_000, // prevent auto-reconnect during tests
      reconnectMaxMs: 10_000,
      storage,
    });
    pair.openClient();
    return client;
  }

  it("sends a spawn frame and resolves with { ptyId } on spawned", async () => {
    const client = makeClient();
    const p = client.spawn({
      taskId: "t1",
      cwd: "/tmp",
      command: "claude",
      agent: "claude-code",
    } as any);
    // The client sent a spawn frame — check pair.client.sent.
    expect(pair.client.lastSent()).toMatchObject({ type: "spawn" });
    const reqId = (pair.client.lastSent() as { reqId: string }).reqId;
    // Server responds — deliver to the client via pair.client.receive().
    pair.client.receive({ type: "spawned", reqId, ptyId: "pty-xyz" });
    await expect(p).resolves.toEqual({ ptyId: "pty-xyz" });
    client.close();
  });

  it("rejects spawn when the server sends spawnError", async () => {
    const client = makeClient();
    const p = client.spawn({
      taskId: "t1",
      cwd: "/tmp",
      command: "claude",
      agent: "claude-code",
    } as any);
    const reqId = (pair.client.lastSent() as { reqId: string }).reqId;
    pair.client.receive({ type: "spawnError", reqId, message: "spawn failed" });
    await expect(p).rejects.toThrow(/spawn failed/);
    client.close();
  });

  it("resolves replay with { data, nextSeq }", async () => {
    const client = makeClient();
    const p = client.replay("p1");
    const reqId = (pair.client.lastSent() as { reqId: string }).reqId;
    pair.client.receive({ type: "replayResult", reqId, data: "history", nextSeq: 10 });
    await expect(p).resolves.toEqual({ data: "history", nextSeq: 10, from: undefined });
    client.close();
  });

  it("asks for the ring tail past a cursor on a reattach, and reports where it starts", async () => {
    // A Panel coming back from a dropped link resumes at the seq after the one
    // it painted; `from` is how it learns whether the ring still covers it.
    const client = makeClient();
    const p = client.replay("p1", 41);
    const sent = pair.client.lastSent() as { reqId: string; sinceSeq?: number };
    expect(sent.sinceSeq).toBe(41);
    pair.client.receive({
      type: "replayResult",
      reqId: sent.reqId,
      data: "tail",
      nextSeq: 43,
      from: 41,
    });
    await expect(p).resolves.toEqual({ data: "tail", nextSeq: 43, from: 41 });
    client.close();
  });

  it("resolves findByTask with { ptyId }", async () => {
    const client = makeClient();
    const p = client.findByTask("t1");
    const reqId = (pair.client.lastSent() as { reqId: string }).reqId;
    pair.client.receive({ type: "findByTaskResult", reqId, ptyId: "p1" });
    await expect(p).resolves.toEqual({ ptyId: "p1" });
    client.close();
  });

  it("delivers data frames to onData listeners", () => {
    const client = makeClient();
    const cb = vi.fn();
    client.onData(cb);
    pair.client.receive({ type: "data", ptyId: "p1", data: "hello", seq: 1 });
    expect(cb).toHaveBeenCalledWith({ ptyId: "p1", data: "hello", seq: 1 });
    client.close();
  });

  it("delivers exit frames to onExit listeners", () => {
    const client = makeClient();
    const cb = vi.fn();
    client.onExit(cb);
    pair.client.receive({ type: "exit", ptyId: "p1", exitCode: 0 });
    expect(cb).toHaveBeenCalledWith({ ptyId: "p1", exitCode: 0, signal: undefined });
    client.close();
  });

  it("unsubscribes onData/onExit listeners", () => {
    const client = makeClient();
    const cb = vi.fn();
    const unsub = client.onData(cb);
    unsub();
    pair.client.receive({ type: "data", ptyId: "p1", data: "x", seq: 1 });
    expect(cb).not.toHaveBeenCalled();
    client.close();
  });

  it("rejects pending RPCs on close", async () => {
    const client = makeClient();
    const p = client.replay("p1");
    client.close();
    await expect(p).rejects.toThrow(/closed/);
  });

  // ─── Issue 05: mutation + session RPCs ────────────────────────────────────
  // The client sends discriminant-typed mutation frames and resolves with the
  // result snapshot (or `null` when the mutation targeted a missing row). A
  // Core-side validation error comes back as an `error` frame and rejects.

  it("resolves projectsMutate with the returned project snapshot", async () => {
    const client = makeClient();
    const p = client.projectsMutate({ op: "create", name: "mc", path: "/home/op/mc" });
    const frame = pair.client.lastSent() as { type: string; reqId: string };
    expect(frame.type).toBe("projectsMutate");
    const project = {
      projectId: "p1",
      name: "mc",
      path: "/home/op/mc",
      icon: "MC",
      iconColor: "#7ce58a",
      pinned: false,
      updatedAt: 1,
    };
    pair.client.receive({ type: "projectsMutateResult", reqId: frame.reqId, project });
    await expect(p).resolves.toEqual(project);
    client.close();
  });

  it("resolves projectsMutate with null when the Core returned no row", async () => {
    const client = makeClient();
    const p = client.projectsMutate({ op: "archive", projectId: "unknown" });
    const frame = pair.client.lastSent() as { type: string; reqId: string };
    pair.client.receive({ type: "projectsMutateResult", reqId: frame.reqId, project: null });
    await expect(p).resolves.toBeNull();
    client.close();
  });

  it("rejects projectsMutate when the server sends an error frame", async () => {
    const client = makeClient();
    const p = client.projectsMutate({ op: "create", name: "mc", path: "relative/x" });
    const frame = pair.client.lastSent() as { type: string; reqId: string };
    pair.client.receive({ type: "error", reqId: frame.reqId, message: "invalid path" });
    await expect(p).rejects.toThrow(/invalid path/);
    client.close();
  });

  it("resolves tasksMutate with the returned task snapshot", async () => {
    const client = makeClient();
    const p = client.tasksMutate({
      op: "create",
      projectId: "p1",
      title: "hello",
      agent: "claude-code",
    });
    const frame = pair.client.lastSent() as { type: string; reqId: string };
    expect(frame.type).toBe("tasksMutate");
    const task = {
      taskId: "t1",
      projectId: "p1",
      title: "hello",
      agent: "claude-code",
      status: "ready",
      pinned: false,
      archived: false,
      icon: null,
      updatedAt: 1,
    };
    pair.client.receive({ type: "tasksMutateResult", reqId: frame.reqId, task });
    await expect(p).resolves.toEqual(task);
    client.close();
  });

  it("resolves sessionsList with the returned session snapshots", async () => {
    const client = makeClient();
    const p = client.sessionsList("p1");
    const frame = pair.client.lastSent() as { type: string; reqId: string; projectId?: string };
    expect(frame.type).toBe("sessionsList");
    expect(frame.projectId).toBe("p1");
    const sessions = [{ taskId: "t1", ptyId: "pty_1", status: "ready", updatedAt: 1 }];
    pair.client.receive({ type: "sessionsListResult", reqId: frame.reqId, sessions });
    await expect(p).resolves.toEqual(sessions);
    client.close();
  });

  // ─── Protocol version (issue 07) ───

  it("reports the version from the ready frame as compatible when it matches", () => {
    const client = makeClient();
    const cb = vi.fn();
    client.onProtocolVersion(cb);
    pair.client.receive({ type: "ready", version: CORE_LINK_PROTOCOL_VERSION });
    expect(cb).toHaveBeenCalledWith({
      version: CORE_LINK_PROTOCOL_VERSION,
      compatible: true,
    });
    client.close();
  });

  it("reports a Core on an older protocol as incompatible", () => {
    const client = makeClient();
    const cb = vi.fn();
    client.onProtocolVersion(cb);
    pair.client.receive({ type: "ready", version: "0.1.0" });
    expect(cb).toHaveBeenCalledWith({ version: "0.1.0", compatible: false });
    client.close();
  });

  it("reports a ready frame with no version as incompatible", () => {
    const client = makeClient();
    const cb = vi.fn();
    client.onProtocolVersion(cb);
    pair.client.receive({ type: "ready" });
    expect(cb).toHaveBeenCalledWith({ version: null, compatible: false });
    client.close();
  });

  it("replaces the reported version on the next connection's ready frame", () => {
    const client = makeClient();
    const cb = vi.fn();
    client.onProtocolVersion(cb);
    pair.client.receive({ type: "ready", version: "0.1.0" });
    // The Core was updated and came back speaking this build's protocol.
    pair.client.receive({ type: "ready", version: CORE_LINK_PROTOCOL_VERSION });
    expect(cb).toHaveBeenLastCalledWith({
      version: CORE_LINK_PROTOCOL_VERSION,
      compatible: true,
    });
    client.close();
  });
});

// ─── Client event-cursor replay ────────────────────────────────────────────

function makeMemoryStorage(): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void } & Record<string, string> {
  const map: Record<string, string> = {};
  return {
    ...map,
    getItem: (k: string) => (k in map ? map[k] : null),
    setItem: (k: string, v: string) => {
      map[k] = v;
    },
  } as { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void } & Record<string, string>;
}

describe("PtyCoreLinkClient event cursor", () => {
  let pair: FakeWebSocketPair;
  let storage: ReturnType<typeof makeMemoryStorage>;

  beforeEach(() => {
    pair = new FakeWebSocketPair();
    storage = makeMemoryStorage();
  });

  function makeClient(url = "ws://127.0.0.1:0"): PtyCoreLinkClient {
    const client = new PtyCoreLinkClient({
      url,
      createSocket: () => pair.client as unknown as ClientWebSocketLike,
      reconnectInitialMs: 10_000,
      reconnectMaxMs: 10_000,
      storage,
      // Explicit key so the tests can read/write the cursor without computing
      // the per-Core suffix. Per-Core isolation is covered by its own test.
      cursorStorageKey: "mc.coreLink.lastEventId",
    });
    pair.openClient();
    return client;
  }

  it("sends a subscribe frame on connect with the persisted lastEventId", () => {
    storage.setItem("mc.coreLink.lastEventId", "7");
    const client = makeClient();
    const sent = pair.client.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    const subscribe = sent.find((f) => f.type === "subscribe");
    expect(subscribe).toBeDefined();
    expect(subscribe).toMatchObject({ type: "subscribe", lastEventId: 7 });
    client.close();
  });

  it("sends lastEventId 0 on first connect (no persisted cursor)", () => {
    const client = makeClient();
    const sent = pair.client.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    const subscribe = sent.find((f) => f.type === "subscribe");
    expect(subscribe).toMatchObject({ type: "subscribe", lastEventId: 0 });
    client.close();
  });

  it("delivers event frames to onEvent listeners and advances lastEventId", () => {
    const client = makeClient();
    const cb = vi.fn();
    client.onEvent(cb);
    pair.client.receive({
      type: "event",
      event: {
        eventId: 5,
        ts: 1,
        kind: "task:updated",
        ptyId: null,
        taskId: "t1",
        payload: '{"status":"running"}',
      },
    });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0].event.kind).toBe("task:updated");
    // Cursor persisted.
    expect(storage.getItem("mc.coreLink.lastEventId")).toBe("5");
    client.close();
  });

  it("ignores event frames with eventId <= lastEventId (dedupe)", () => {
    storage.setItem("mc.coreLink.lastEventId", "10");
    const client = makeClient();
    const cb = vi.fn();
    client.onEvent(cb);
    // An event with an older id (e.g. a duplicate from a late replay) — skipped.
    pair.client.receive({
      type: "event",
      event: { eventId: 9, ts: 1, kind: "task:updated", ptyId: null, taskId: null, payload: "{}" },
    });
    expect(cb).not.toHaveBeenCalled();
    // Cursor unchanged.
    expect(storage.getItem("mc.coreLink.lastEventId")).toBe("10");
    client.close();
  });

  it("eventsReplayed marker advances the cursor without calling onEvent", () => {
    const client = makeClient();
    const cb = vi.fn();
    client.onEvent(cb);
    pair.client.receive({ type: "eventsReplayed", lastEventId: 42 });
    expect(cb).not.toHaveBeenCalled();
    expect(storage.getItem("mc.coreLink.lastEventId")).toBe("42");
    client.close();
  });

  it("notifies onEventsReplayed listeners when caught up", () => {
    const client = makeClient();
    const cb = vi.fn();
    client.onEventsReplayed(cb);
    pair.client.receive({ type: "eventsReplayed", lastEventId: 42 });
    expect(cb).toHaveBeenCalledWith({ lastEventId: 42 });
    client.close();
  });

  it("unsubscribes onEvent listeners", () => {
    const client = makeClient();
    const cb = vi.fn();
    const unsub = client.onEvent(cb);
    unsub();
    pair.client.receive({
      type: "event",
      event: { eventId: 1, ts: 1, kind: "task:created", ptyId: null, taskId: null, payload: "{}" },
    });
    expect(cb).not.toHaveBeenCalled();
    client.close();
  });

  it("restores a missed event/task timeline on reconnect", () => {
    // The Panel saw up to eventId 3 before it was killed. On reopen it sends
    // lastEventId=3 and the server replays the tail.
    storage.setItem("mc.coreLink.lastEventId", "3");
    const client = makeClient();
    const cb = vi.fn();
    client.onEvent(cb);

    // Server replays the events the Panel missed while away.
    pair.client.receive({
      type: "event",
      event: { eventId: 4, ts: 1, kind: "task:updated", ptyId: null, taskId: "t1", payload: '{"status":"running"}' },
    });
    pair.client.receive({
      type: "event",
      event: { eventId: 5, ts: 2, kind: "session:finished", ptyId: null, taskId: "t1", payload: '{}' },
    });
    pair.client.receive({ type: "eventsReplayed", lastEventId: 5 });

    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[0]![0].event.kind).toBe("task:updated");
    expect(cb.mock.calls[1]![0].event.kind).toBe("session:finished");
    expect(storage.getItem("mc.coreLink.lastEventId")).toBe("5");
    client.close();
  });

  it("isolates the cursor per Core (per-endpoint storage key by default)", () => {
    // Two Cores on different ports must not share a lastEventId cursor
    // (CONTEXT.md: "the single number the Panel stores per Core").
    const clientA = new PtyCoreLinkClient({
      url: "ws://127.0.0.1:5001",
      createSocket: () => pair.client as unknown as ClientWebSocketLike,
      reconnectInitialMs: 10_000,
      reconnectMaxMs: 10_000,
      storage,
    });
    pair.openClient();
    // Advance core A's cursor.
    pair.client.receive({
      type: "event",
      event: { eventId: 11, ts: 1, kind: "task:updated", ptyId: null, taskId: null, payload: "{}" },
    });
    // Dots in the host are sanitized to underscores (filesystem-safe key).
    expect(storage.getItem("mc.coreLink.lastEventId.127_0_0_1-5001")).toBe("11");
    clientA.close();

    // A second Core on a different port starts fresh — cursor 0, not 11.
    const pairB = new FakeWebSocketPair();
    const clientB = new PtyCoreLinkClient({
      url: "ws://127.0.0.1:5002",
      createSocket: () => pairB.client as unknown as ClientWebSocketLike,
      reconnectInitialMs: 10_000,
      reconnectMaxMs: 10_000,
      storage,
    });
    pairB.openClient();
    const sent = pairB.client.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    const subscribe = sent.find((f) => f.type === "subscribe");
    expect(subscribe).toMatchObject({ type: "subscribe", lastEventId: 0 });
    expect(storage.getItem("mc.coreLink.lastEventId.127_0_0_1-5002")).toBeNull();
    clientB.close();
  });
});

// ─── Bearer auth (issue 04) ────────────────────────────────────────────────

const AUTH_SECRET: BearerSecret = "auth-secret-32-bytes-0123456789ab";

/** Build an authVerifier backed by {@link verifyBearer} with the test secret. */
function makeAuthVerifier(
  secret: BearerSecret,
  now: () => number = Date.now,
): import("@actana/core/pty-core-link-server").AuthVerifier {
  return (bearer: string) => verifyBearer(bearer, secret, { now: now() });
}

describe("PtyCoreLinkServer bearer auth", () => {
  let core: ReturnType<typeof makeMockCore>;
  let server: PtyCoreLinkServer;
  let fakeWss: FakeWebSocketServer;
  let pair: FakeWebSocketPair;
  let eventLog: FakeEventLog;

  beforeEach(() => {
    core = makeMockCore();
    fakeWss = new FakeWebSocketServer();
    eventLog = new FakeEventLog();
    server = new PtyCoreLinkServer(core, {
      port: 0,
      createServer: () => fakeWss as unknown as WebSocketServerLike,
      eventLog,
      liveEventPollMs: 5,
      authVerifier: makeAuthVerifier(AUTH_SECRET),
    });
    pair = new FakeWebSocketPair();
    fakeWss.simulateConnection(pair.server);
    pair.openClient();
    // Drain the `ready` frame.
    pair.server.sent.length = 0;
  });

  afterEach(() => {
    server.close();
  });

  it("replies authOk for a valid bearer", () => {
    const exp = Date.now() + 60_000;
    const bearer = signBearer({ coreId: "core_1", exp }, AUTH_SECRET);
    pair.server.receive({ type: "auth", reqId: "a1", bearer });
    expect(pair.server.lastSent()).toMatchObject({
      type: "authOk",
      reqId: "a1",
      coreId: "core_1",
      exp,
    });
  });

  it("replies authError + closes the socket on an expired bearer", () => {
    const bearer = signBearer({ coreId: "core_1", exp: Date.now() - 1_000 }, AUTH_SECRET);
    pair.server.receive({ type: "auth", reqId: "a1", bearer });
    expect(pair.server.lastSent()).toMatchObject({ type: "authError", reason: "expired" });
    // The server closed the connection.
    expect(pair.server.readyState).toBe(3);
  });

  it("replies authError bad-signature for a bearer signed with another secret", () => {
    const bearer = signBearer({ coreId: "core_1", exp: Date.now() + 60_000 }, "wrong-secret-enough-len!");
    pair.server.receive({ type: "auth", reqId: "a1", bearer });
    expect(pair.server.lastSent()).toMatchObject({ type: "authError", reason: "bad-signature" });
  });

  it("rejects a non-auth frame before authentication with an error + close", () => {
    pair.server.receive({ type: "subscribe", reqId: "s1", lastEventId: 0 });
    expect(pair.server.lastSent()).toMatchObject({ type: "error", message: "not-authenticated" });
    expect(pair.server.readyState).toBe(3);
  });

  it("does not stream the event tail until authenticated", () => {
    eventLog.seed("task:created", "{}", { taskId: "t1" });
    // Subscribe before auth → rejected, no event frames sent.
    pair.server.receive({ type: "subscribe", reqId: "s1", lastEventId: 0 });
    const frames = pair.server.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    expect(frames.some((f) => f.type === "event")).toBe(false);
  });

  it("streams the event tail after auth → subscribe", () => {
    eventLog.seed("task:created", "{}", { taskId: "t1" });
    const bearer = signBearer({ coreId: "core_1", exp: Date.now() + 60_000 }, AUTH_SECRET);
    pair.server.receive({ type: "auth", reqId: "a1", bearer });
    pair.server.sent.length = 0;
    pair.server.receive({ type: "subscribe", reqId: "s1", lastEventId: 0 });
    const frames = pair.server.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    expect(frames.some((f) => f.type === "event")).toBe(true);
    expect(frames.some((f) => f.type === "eventsReplayed")).toBe(true);
  });

  it("dispatches a spawn frame after authentication", async () => {
    const bearer = signBearer({ coreId: "core_1", exp: Date.now() + 60_000 }, AUTH_SECRET);
    pair.server.receive({ type: "auth", reqId: "a1", bearer });
    pair.server.receive({
      type: "spawn",
      reqId: "r1",
      opts: { taskId: "t1", cwd: "/tmp", command: "claude", agent: "claude-code" },
    });
    await vi.waitFor(() => expect(core.spawn).toHaveBeenCalled());
    expect(pair.server.lastSent()).toMatchObject({ type: "spawned", reqId: "r1" });
  });
});

describe("PtyCoreLinkClient bearer auth", () => {
  let pair: FakeWebSocketPair;

  beforeEach(() => {
    pair = new FakeWebSocketPair();
  });

  function makeClient(bearer?: string): PtyCoreLinkClient {
    const client = new PtyCoreLinkClient({
      url: "ws://127.0.0.1:0",
      createSocket: () => pair.client as unknown as ClientWebSocketLike,
      reconnectInitialMs: 10_000,
      reconnectMaxMs: 10_000,
      bearer,
    });
    pair.openClient();
    return client;
  }

  it("sends an auth frame on connect when a bearer is configured", () => {
    const bearer = signBearer({ coreId: "core_1", exp: Date.now() + 60_000 }, AUTH_SECRET);
    const client = makeClient(bearer);
    const sent = pair.client.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    const auth = sent.find((f) => f.type === "auth");
    expect(auth).toBeDefined();
    expect(auth).toMatchObject({ type: "auth", bearer });
    // No subscribe yet — it's sent only after authOk.
    expect(sent.some((f) => f.type === "subscribe")).toBe(false);
    client.close();
  });

  it("does NOT send auth (and goes straight to subscribe) when no bearer is set", () => {
    const client = makeClient();
    const sent = pair.client.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    expect(sent.some((f) => f.type === "auth")).toBe(false);
    expect(sent.some((f) => f.type === "subscribe")).toBe(true);
    client.close();
  });

  it("sends subscribe after authOk and notifies onAuthOk", () => {
    const bearer = signBearer({ coreId: "core_1", exp: Date.now() + 60_000 }, AUTH_SECRET);
    const client = makeClient(bearer);
    const okCb = vi.fn();
    client.onAuthOk(okCb);
    pair.client.sent.length = 0;
    pair.client.receive({ type: "authOk", reqId: "auth-1", coreId: "core_1", exp: 123 });
    expect(okCb).toHaveBeenCalledWith({ coreId: "core_1", exp: 123 });
    const sent = pair.client.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    expect(sent.some((f) => f.type === "subscribe")).toBe(true);
    expect(client.isAuthenticated()).toBe(true);
    client.close();
  });

  it("notifies onAuthError on authError and stays unauthenticated", () => {
    const bearer = signBearer({ coreId: "core_1", exp: Date.now() + 60_000 }, AUTH_SECRET);
    const client = makeClient(bearer);
    const errCb = vi.fn();
    client.onAuthError(errCb);
    pair.client.receive({ type: "authError", reason: "expired" });
    expect(errCb).toHaveBeenCalledWith({ reason: "expired" });
    expect(client.isAuthenticated()).toBe(false);
    client.close();
  });
});

// ─── projectsMutate / tasksMutate / sessionsList via CoreMutationPort ────
// Issue 04 (ADR 0004): the Core process owns the write path against its
// SQLite. The server dispatches these frames to the mutation port; a null
// port keeps backward-compat stubs.

import type { CoreMutationPort } from "@actana/core/pty-core-link-server";
import type {
  CoreLinkProjectMutation,
  CoreLinkSessionSnapshot,
  CoreLinkTaskMutation,
} from "@actana/shared/core-link-frames";

/** In-memory CoreMutationPort for tests. Records every call so assertions
 *  can verify the server threaded the frame through unchanged. */
class FakeMutationPort implements CoreMutationPort {
  projects: CoreLinkProjectSnapshot[] = [];
  tasks: CoreLinkTaskSnapshot[] = [];
  sessions: CoreLinkSessionSnapshot[] = [];
  mutateProjectCalls: CoreLinkProjectMutation[] = [];
  mutateTaskCalls: CoreLinkTaskMutation[] = [];
  listSessionsCalls: (string | undefined)[] = [];
  throwOnNextMutateProject: string | null = null;
  throwOnNextMutateTask: string | null = null;

  mutateProject(mutation: CoreLinkProjectMutation): CoreLinkProjectSnapshot | null {
    this.mutateProjectCalls.push(mutation);
    if (this.throwOnNextMutateProject) {
      const msg = this.throwOnNextMutateProject;
      this.throwOnNextMutateProject = null;
      throw new Error(msg);
    }
    if (mutation.op === "create") {
      const snap: CoreLinkProjectSnapshot = {
        projectId: mutation.projectId ?? `p-${this.projects.length + 1}`,
        name: mutation.name,
        path: mutation.path,
        icon: mutation.icon ?? "PR",
        iconColor: mutation.iconColor ?? "#7ce58a",
        pinned: mutation.pinned === true,
        updatedAt: 1,
      };
      this.projects.push(snap);
      return snap;
    }
    if (mutation.op === "rename") {
      const p = this.projects.find((x) => x.projectId === mutation.projectId);
      if (!p) return null;
      p.name = mutation.name;
      return p;
    }
    if (mutation.op === "pin") {
      const p = this.projects.find((x) => x.projectId === mutation.projectId);
      if (!p) return null;
      p.pinned = mutation.pinned;
      return p;
    }
    // archive
    const idx = this.projects.findIndex((x) => x.projectId === mutation.projectId);
    if (idx < 0) return null;
    const [removed] = this.projects.splice(idx, 1);
    return removed ?? null;
  }

  mutateTask(mutation: CoreLinkTaskMutation): CoreLinkTaskSnapshot | null {
    this.mutateTaskCalls.push(mutation);
    if (this.throwOnNextMutateTask) {
      const msg = this.throwOnNextMutateTask;
      this.throwOnNextMutateTask = null;
      throw new Error(msg);
    }
    // Mirror the real store's runtime guard: an unknown `op` throws so the
    // server sends an actionable `error` frame instead of silently no-op'ing.
    if (mutation.op !== "create" && mutation.op !== "update") {
      throw new Error(`unknown task mutation op: ${(mutation as { op?: string }).op}`);
    }
    if (mutation.op === "create") {
      const snap: CoreLinkTaskSnapshot = {
        taskId: mutation.taskId ?? `t-${this.tasks.length + 1}`,
        projectId: mutation.projectId,
        title: mutation.title,
        agent: mutation.agent,
        status: mutation.status ?? "ready",
        pinned: false,
        archived: false,
        icon: mutation.icon ?? null,
        updatedAt: 1,
      };
      this.tasks.push(snap);
      return snap;
    }
    const t = this.tasks.find((x) => x.taskId === mutation.taskId);
    if (!t) return null;
    if (mutation.status !== undefined) t.status = mutation.status;
    if (mutation.title !== undefined) t.title = mutation.title;
    if (mutation.pinned !== undefined) t.pinned = mutation.pinned;
    if (mutation.archived !== undefined) t.archived = mutation.archived;
    if (mutation.icon !== undefined) t.icon = mutation.icon;
    return t;
  }

  listSessions(projectId?: string): CoreLinkSessionSnapshot[] {
    this.listSessionsCalls.push(projectId);
    if (projectId === undefined) return this.sessions;
    return this.sessions.filter((s) => this.tasks.find((t) => t.taskId === s.taskId)?.projectId === projectId);
  }
}

describe("PtyCoreLinkServer projectsMutate / tasksMutate / sessionsList (issue 04)", () => {
  let core: ReturnType<typeof makeMockCore>;
  let server: PtyCoreLinkServer;
  let fakeWss: FakeWebSocketServer;
  let pair: FakeWebSocketPair;
  let mutationPort: FakeMutationPort;
  let eventLog: FakeEventLog;

  beforeEach(() => {
    core = makeMockCore();
    fakeWss = new FakeWebSocketServer();
    mutationPort = new FakeMutationPort();
    eventLog = new FakeEventLog();
    server = new PtyCoreLinkServer(core, {
      port: 0,
      createServer: () => fakeWss as unknown as WebSocketServerLike,
      mutationPort,
      eventLog,
    });
    pair = new FakeWebSocketPair();
    fakeWss.simulateConnection(pair.server);
    pair.openClient();
  });

  afterEach(() => {
    server.close();
  });

  it("round-trips projectsMutate create → response carries the new snapshot", async () => {
    pair.server.receive({
      type: "projectsMutate",
      reqId: "r1",
      mutation: { op: "create", name: "New Project", path: "/home/op/np" },
    });
    await vi.waitFor(() =>
      expect(mutationPort.mutateProjectCalls).toHaveLength(1),
    );
    expect(pair.server.lastSent()).toMatchObject({
      type: "projectsMutateResult",
      reqId: "r1",
      project: { name: "New Project", path: "/home/op/np" },
    });
  });

  it("appends a project:created event on a successful create", async () => {
    pair.server.receive({
      type: "projectsMutate",
      reqId: "r1",
      mutation: { op: "create", projectId: "p-x", name: "X", path: "/x" },
    });
    await vi.waitFor(() =>
      expect(mutationPort.mutateProjectCalls).toHaveLength(1),
    );
    const events = eventLog.readEventTail(0);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "project:created" }),
    );
    const created = events.find((e) => e.kind === "project:created");
    expect(JSON.parse(created!.payload)).toEqual({ projectId: "p-x" });
  });

  it("does not append an event when the mutation returns null (unknown row)", async () => {
    pair.server.receive({
      type: "projectsMutate",
      reqId: "r1",
      mutation: { op: "rename", projectId: "missing", name: "y" },
    });
    await vi.waitFor(() =>
      expect(pair.server.lastSent()?.type).toBe("projectsMutateResult"),
    );
    expect(pair.server.lastSent()).toMatchObject({ project: null });
    expect(eventLog.readEventTail(0)).toEqual([]);
  });

  it("translates a mutation-store throw into an error frame with the message", async () => {
    mutationPort.throwOnNextMutateProject =
      "project path does not exist on the Core: /nowhere";
    pair.server.receive({
      type: "projectsMutate",
      reqId: "r1",
      mutation: { op: "create", name: "X", path: "/nowhere" },
    });
    await vi.waitFor(() => expect(pair.server.lastSent()?.type).toBe("error"));
    expect(pair.server.lastSent()).toMatchObject({
      type: "error",
      reqId: "r1",
      message: expect.stringContaining("does not exist on the Core"),
    });
    expect(eventLog.readEventTail(0)).toEqual([]);
  });

  it("round-trips tasksMutate create → response carries the new task", async () => {
    pair.server.receive({
      type: "tasksMutate",
      reqId: "r1",
      mutation: {
        op: "create",
        projectId: "p1",
        title: "fix bug",
        agent: "claude-code",
      },
    });
    await vi.waitFor(() => expect(mutationPort.mutateTaskCalls).toHaveLength(1));
    expect(pair.server.lastSent()).toMatchObject({
      type: "tasksMutateResult",
      reqId: "r1",
      task: { projectId: "p1", title: "fix bug", agent: "claude-code" },
    });
  });

  it("appends project:renamed on a rename (not project:updated — matches ADR-0004)", async () => {
    // Seed a project.
    pair.server.receive({
      type: "projectsMutate",
      reqId: "seed",
      mutation: { op: "create", projectId: "p1", name: "old", path: "/p" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateProjectCalls).toHaveLength(1));
    pair.server.receive({
      type: "projectsMutate",
      reqId: "r2",
      mutation: { op: "rename", projectId: "p1", name: "new" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateProjectCalls).toHaveLength(2));
    const kinds = eventLog.readEventTail(0).map((e) => e.kind);
    expect(kinds).toEqual(["project:created", "project:renamed"]);
  });

  it("appends project:archived on an archive", async () => {
    pair.server.receive({
      type: "projectsMutate",
      reqId: "seed",
      mutation: { op: "create", projectId: "p1", name: "x", path: "/p" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateProjectCalls).toHaveLength(1));
    pair.server.receive({
      type: "projectsMutate",
      reqId: "r2",
      mutation: { op: "archive", projectId: "p1" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateProjectCalls).toHaveLength(2));
    const kinds = eventLog.readEventTail(0).map((e) => e.kind);
    expect(kinds).toEqual(["project:created", "project:archived"]);
  });

  it("appends project:pinnedChanged on a pin (issue 10)", async () => {
    pair.server.receive({
      type: "projectsMutate",
      reqId: "seed",
      mutation: { op: "create", projectId: "p1", name: "x", path: "/p" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateProjectCalls).toHaveLength(1));
    pair.server.receive({
      type: "projectsMutate",
      reqId: "r2",
      mutation: { op: "pin", projectId: "p1", pinned: true },
    });
    await vi.waitFor(() => expect(mutationPort.mutateProjectCalls).toHaveLength(2));
    // Dedicated kind so a Panel listening for pin-only events can subscribe
    // distinctly from other project edits (see subscribe-core-project-events).
    const kinds = eventLog.readEventTail(0).map((e) => e.kind);
    expect(kinds).toEqual(["project:created", "project:pinnedChanged"]);
  });

  it("translates a stale-shape tasksMutate (missing op) into an error frame, not a silent no-op", async () => {
    // parseCoreLinkRequestFrame only checks `type`; the mutation store's
    // runtime `op` guard is what surfaces this as an actionable error.
    pair.server.receive({
      type: "tasksMutate",
      reqId: "r1",
      // Missing `op` — the old flat shape a stale Panel might still send.
      mutation: { taskId: "t1", status: "running" } as unknown as CoreLinkTaskMutation,
    });
    await vi.waitFor(() => expect(pair.server.lastSent()?.type).toBe("error"));
    expect(pair.server.lastSent()).toMatchObject({
      type: "error",
      reqId: "r1",
      message: expect.stringContaining("unknown task mutation op"),
    });
    expect(eventLog.readEventTail(0)).toEqual([]);
  });

  it("appends a task:updated event on an update", async () => {
    // Seed a task first via create.
    pair.server.receive({
      type: "tasksMutate",
      reqId: "seed",
      mutation: { op: "create", taskId: "t1", projectId: "p1", title: "a", agent: "claude-code" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateTaskCalls).toHaveLength(1));
    pair.server.receive({
      type: "tasksMutate",
      reqId: "r2",
      mutation: { op: "update", taskId: "t1", status: "running" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateTaskCalls).toHaveLength(2));
    const kinds = eventLog.readEventTail(0).map((e) => e.kind);
    expect(kinds).toEqual(["task:created", "task:updated"]);
  });

  it("appends task:iconChanged on an icon-only update (issue 09)", async () => {
    // Seed.
    pair.server.receive({
      type: "tasksMutate",
      reqId: "seed",
      mutation: { op: "create", taskId: "t1", projectId: "p1", title: "a", agent: "claude-code" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateTaskCalls).toHaveLength(1));
    // Icon-only patch → dedicated kind.
    pair.server.receive({
      type: "tasksMutate",
      reqId: "r2",
      mutation: { op: "update", taskId: "t1", icon: "bug" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateTaskCalls).toHaveLength(2));
    const kinds = eventLog.readEventTail(0).map((e) => e.kind);
    expect(kinds).toEqual(["task:created", "task:iconChanged"]);
  });

  it("appends task:pinnedChanged on a pinned-only update (issue 10)", async () => {
    pair.server.receive({
      type: "tasksMutate",
      reqId: "seed",
      mutation: { op: "create", taskId: "t1", projectId: "p1", title: "a", agent: "claude-code" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateTaskCalls).toHaveLength(1));
    // Pin-only patch → dedicated kind so consumers that only track pinned
    // state (e.g. the SessionGrid pinned filter) can subscribe distinctly.
    pair.server.receive({
      type: "tasksMutate",
      reqId: "r2",
      mutation: { op: "update", taskId: "t1", pinned: true },
    });
    await vi.waitFor(() => expect(mutationPort.mutateTaskCalls).toHaveLength(2));
    const kinds = eventLog.readEventTail(0).map((e) => e.kind);
    expect(kinds).toEqual(["task:created", "task:pinnedChanged"]);
  });

  it("degrades to task:updated when pinned rides with other patched fields", async () => {
    pair.server.receive({
      type: "tasksMutate",
      reqId: "seed",
      mutation: { op: "create", taskId: "t1", projectId: "p1", title: "a", agent: "claude-code" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateTaskCalls).toHaveLength(1));
    pair.server.receive({
      type: "tasksMutate",
      reqId: "r2",
      mutation: { op: "update", taskId: "t1", pinned: true, status: "running" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateTaskCalls).toHaveLength(2));
    const kinds = eventLog.readEventTail(0).map((e) => e.kind);
    expect(kinds).toEqual(["task:created", "task:updated"]);
  });

  it("degrades to task:updated when icon rides with other patched fields", async () => {
    pair.server.receive({
      type: "tasksMutate",
      reqId: "seed",
      mutation: { op: "create", taskId: "t1", projectId: "p1", title: "a", agent: "claude-code" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateTaskCalls).toHaveLength(1));
    pair.server.receive({
      type: "tasksMutate",
      reqId: "r2",
      mutation: { op: "update", taskId: "t1", icon: "bug", status: "running" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateTaskCalls).toHaveLength(2));
    const kinds = eventLog.readEventTail(0).map((e) => e.kind);
    expect(kinds).toEqual(["task:created", "task:updated"]);
  });

  it("answers sessionsList by delegating to the mutation port", async () => {
    mutationPort.sessions = [
      { taskId: "t1", ptyId: "pty-abc", status: "running", updatedAt: 10 },
      { taskId: "t2", ptyId: null, status: "ready", updatedAt: 5 },
    ];
    pair.server.receive({ type: "sessionsList", reqId: "r1" });
    await vi.waitFor(() => expect(mutationPort.listSessionsCalls).toEqual([undefined]));
    expect(pair.server.lastSent()).toEqual({
      type: "sessionsListResult",
      reqId: "r1",
      sessions: mutationPort.sessions,
    });
  });

  it("forwards a projectId filter on sessionsList", async () => {
    pair.server.receive({ type: "sessionsList", reqId: "r1", projectId: "p9" });
    await vi.waitFor(() =>
      expect(mutationPort.listSessionsCalls).toEqual(["p9"]),
    );
  });

  it("falls back to stubs when no mutationPort is configured (backward compat)", async () => {
    // Build a bare server (no mutation port).
    const bareCore = makeMockCore();
    const bareWss = new FakeWebSocketServer();
    const bareServer = new PtyCoreLinkServer(bareCore, {
      port: 0,
      createServer: () => bareWss as unknown as WebSocketServerLike,
    });
    const p = new FakeWebSocketPair();
    bareWss.simulateConnection(p.server);
    p.openClient();

    p.server.receive({
      type: "projectsMutate",
      reqId: "r1",
      mutation: { op: "create", name: "x", path: "/x" },
    });
    await vi.waitFor(() =>
      expect(p.server.lastSent()?.type).toBe("projectsMutateResult"),
    );
    expect(p.server.lastSent()).toMatchObject({ project: null });

    p.server.receive({
      type: "tasksMutate",
      reqId: "r2",
      mutation: { op: "create", projectId: "p1", title: "x", agent: "claude-code" },
    });
    await vi.waitFor(() =>
      expect(p.server.lastSent()?.type).toBe("tasksMutateResult"),
    );
    expect(p.server.lastSent()).toMatchObject({ task: null });

    p.server.receive({ type: "sessionsList", reqId: "r3" });
    await vi.waitFor(() =>
      expect(p.server.lastSent()?.type).toBe("sessionsListResult"),
    );
    expect(p.server.lastSent()).toMatchObject({ sessions: [] });

    bareServer.close();
  });

  it("round-trips the full create-project → list → create-task → list → sessions flow", async () => {
    // 1. Create a project.
    pair.server.receive({
      type: "projectsMutate",
      reqId: "r1",
      mutation: { op: "create", projectId: "p1", name: "MC", path: "/mc" },
    });
    await vi.waitFor(() =>
      expect(mutationPort.mutateProjectCalls).toHaveLength(1),
    );

    // 2. projectsList must include the new project — served from a query port
    // sharing the same in-memory rows. Wire a query port that reads from the
    // fake mutation port's projects[] so the round-trip flows through both.
    server.close();
    const queryPort: CoreQueryPort = {
      listProjects: () => mutationPort.projects,
      listTasks: (projectId?: string) =>
        projectId
          ? mutationPort.tasks.filter((t) => t.projectId === projectId)
          : mutationPort.tasks,
    };
    const wss2 = new FakeWebSocketServer();
    const server2 = new PtyCoreLinkServer(core, {
      port: 0,
      createServer: () => wss2 as unknown as WebSocketServerLike,
      queryPort,
      mutationPort,
      eventLog,
    });
    const p2 = new FakeWebSocketPair();
    wss2.simulateConnection(p2.server);
    p2.openClient();

    p2.server.receive({ type: "projectsList", reqId: "r2" });
    await vi.waitFor(() => expect(p2.server.lastSent()?.type).toBe("projectsListResult"));
    expect(p2.server.lastSent()).toMatchObject({
      projects: [expect.objectContaining({ projectId: "p1", name: "MC" })],
    });

    // 3. Create a task.
    p2.server.receive({
      type: "tasksMutate",
      reqId: "r3",
      mutation: { op: "create", taskId: "t1", projectId: "p1", title: "fix", agent: "claude-code" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateTaskCalls).toHaveLength(1));

    // 4. tasksList must include the new task.
    p2.server.receive({ type: "tasksList", reqId: "r4", projectId: "p1" });
    await vi.waitFor(() => expect(p2.server.lastSent()?.type).toBe("tasksListResult"));
    expect(p2.server.lastSent()).toMatchObject({
      tasks: [expect.objectContaining({ taskId: "t1", title: "fix" })],
    });

    // 5. sessionsList must include the new task as a session (no PTY yet → ptyId null).
    mutationPort.sessions = [
      { taskId: "t1", ptyId: null, status: "ready", updatedAt: 1 },
    ];
    p2.server.receive({ type: "sessionsList", reqId: "r5" });
    await vi.waitFor(() => expect(p2.server.lastSent()?.type).toBe("sessionsListResult"));
    expect(p2.server.lastSent()).toMatchObject({
      sessions: [{ taskId: "t1", ptyId: null, status: "ready", updatedAt: 1 }],
    });

    server2.close();
  });
});

// ─── Heartbeat / dead-connection detection ──────────────────────────────────
//
// A remote core-link crosses NATs and stateful firewalls that silently reap
// idle flows, and an agent parked at its prompt is idle for minutes. Without a
// heartbeat neither end notices: the Core writes PTY output into a socket
// that will never deliver it, and the Panel's RPCs hang for the full 30s
// timeout. These fakes add the ping/pong/terminate surface the real `ws`
// transport has (the plain FakeWebSocket deliberately omits it, which is how
// a plain browser transport behaves — no ping API, no heartbeat).

class PingableFakeWebSocket extends FakeWebSocket {
  pings = 0;
  terminated = false;

  ping(): void {
    this.pings++;
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit("close");
  }

  /** Answer a ping, as a live peer's `ws` would. */
  pong(): void {
    this.emit("pong");
  }
}

describe("core-link heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("server pings an idle connection and terminates it once pongs stop", () => {
    const core = makeMockCore();
    const fakeWss = new FakeWebSocketServer();
    const server = new PtyCoreLinkServer(core, {
      port: 0,
      createServer: () => fakeWss as unknown as WebSocketServerLike,
    });
    const ws = new PingableFakeWebSocket();
    ws.readyState = 1;
    fakeWss.simulateConnection(ws);

    // Idle but answering: pings go out, the connection survives.
    vi.advanceTimersByTime(15_000);
    expect(ws.pings).toBe(1);
    ws.pong();
    vi.advanceTimersByTime(15_000);
    expect(ws.pings).toBe(2);
    ws.pong();
    expect(ws.terminated).toBe(false);

    // Peer goes silent: no pong ever again. After the timeout window the
    // server tears the socket down so the emit target stops pointing at a
    // black hole and the Panel's reconnect path can take over.
    vi.advanceTimersByTime(60_000);
    expect(ws.terminated).toBe(true);

    server.close();
  });

  it("server leaves ping-less transports alone", () => {
    const core = makeMockCore();
    const fakeWss = new FakeWebSocketServer();
    const server = new PtyCoreLinkServer(core, {
      port: 0,
      createServer: () => fakeWss as unknown as WebSocketServerLike,
    });
    const pair = new FakeWebSocketPair();
    fakeWss.simulateConnection(pair.server);
    pair.openClient();

    // No ping surface → no heartbeat → the connection is never torn down.
    vi.advanceTimersByTime(120_000);
    expect(pair.server.readyState).toBe(1);

    server.close();
  });

  it("client rejects in-flight RPCs when the connection drops", async () => {
    const socket = new PingableFakeWebSocket();
    const client = new PtyCoreLinkClient({
      url: "wss://example:8443",
      createSocket: () => socket as unknown as ClientWebSocketLike,
      reconnectInitialMs: 10_000,
      reconnectMaxMs: 10_000,
    });
    socket.readyState = 1;
    socket.emit("open");

    const pending = client.replay("pty-1");
    const rejected = expect(pending).rejects.toThrow(/connection lost/);

    // The socket dies with the request already on the wire — its reply can
    // never arrive, so waiting out the 30s RPC timeout is pure dead time.
    socket.readyState = 3;
    socket.emit("close");
    await rejected;

    client.close();
  });

  it("client terminates a half-open socket after the heartbeat timeout", () => {
    const socket = new PingableFakeWebSocket();
    const client = new PtyCoreLinkClient({
      url: "wss://example:8443",
      createSocket: () => socket as unknown as ClientWebSocketLike,
      reconnectInitialMs: 10_000,
      reconnectMaxMs: 10_000,
    });
    socket.readyState = 1;
    socket.emit("open");

    vi.advanceTimersByTime(15_000);
    expect(socket.pings).toBe(1);
    socket.pong();

    // Peer stops answering — the client destroys the socket rather than
    // waiting for a FIN that a half-open connection will never send.
    vi.advanceTimersByTime(60_000);
    expect(socket.terminated).toBe(true);

    client.close();
  });
});
