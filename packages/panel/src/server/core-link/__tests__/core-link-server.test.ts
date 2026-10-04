// The Core's core-link server, driven frame by frame over a socket pair.
//
// **These are `@actana/core`'s tests, living in the Panel's package for the reason
// they were written here**: the Panel's own core-link client used to sit in the
// directory above, and every suite below was written against the real server it
// talked to rather than a stand-in — the auth gate that closes a connection on a
// pre-auth frame, the `ready` frame nobody asked for, the event tail replayed
// past a cursor, the mutation port's throw becoming an `error` frame.
//
// That client is gone: the Panel dials with `@actana/sdk`'s durable Core client
// now (#156), and the client-side suites went with it — the SDK's own suite (actana/client) covers
// that half against this same server, plus a real `wss://` handshake. What is
// left here is every server-side test, unchanged, because nothing about the
// Core moved and coverage of it should not have been collateral.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PtyCoreLinkServer,
  type WebSocketLike,
  type WebSocketServerLike,
  type EventLogPort,
} from "@actana/core/pty-core-link-server";
import type { PtyCore, PtyCoreEvent } from "@actana/core/pty-manager";
import {
  CORE_LINK_PROTOCOL_VERSION,
  type CoreLinkEvent,
  type CoreLinkSessionLock,
} from "@actana/sdk/core";
import { signBearer, verifyBearer, type BearerSecret } from "@actana/shared/core-link-bearer";

/**
 * Every Session snapshot leaves a multi-connection Core stamped with the lock
 * as the receiving connection must be told it (issue 145, ADR 0024 D8), and the
 * connections in this suite claim nothing — so every row comes back writable and
 * unlocked. The exact-equality assertions below carry it rather than loosening
 * to `toMatchObject`: a snapshot that quietly stopped answering "can I write to
 * this" is precisely the regression worth failing on.
 */
const UNLOCKED: CoreLinkSessionLock = { writable: true, state: "unlocked" };

/** The same rows the port handed over, as the wire carries them. */
function published<T extends { sessionId: string }>(
  rows: T[],
): Array<T & { lock: CoreLinkSessionLock }> {
  return rows.map((row) => ({ ...row, lock: UNLOCKED }));
}

// ─── Fake WebSocket ───────────────────────────────────────────────────────────
//
// A pair of connected fakes: `server` is the WebSocket the PtyCoreLinkServer
// holds; `client` is the one the peer on the other end holds. `send` on one side
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
    findBySession: vi.fn(() => ({ ptyId: "pty-test-1" })),
    // Which Session a `write`/`kill` would touch (issue 144) — the lookup the
    // Core's Session-lock gate resolves a ptyId through. Null here: this suite
    // claims nothing, so every Session it touches is unlocked and served.
    sessionIdForPty: vi.fn(() => null),
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
    // It also announces `multiConnection` (issue 143, ADR 0024 D11): this build
    // serves many connections, and says so without moving the version above.
    expect(pair.server.lastSent()).toEqual({
      type: "ready",
      version: CORE_LINK_PROTOCOL_VERSION,
      multiConnection: { version: 1 },
    });
  });

  it("wires core events as data/exit frames", () => {
    // Since issue 142 a Core streams a PTY only to the connections that asked
    // for it, so the subscription is what makes this connection a recipient at
    // all — without it the frames below go nowhere.
    pair.server.receive({ type: "ptySubscribe", reqId: "sub1", ptyId: "p1" });
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
      opts: { sessionId: "t1", command: "claude", agent: "claude-code" },
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

  it("dispatches findBySession and sends findBySessionResult", async () => {
    pair.server.receive({ type: "findBySession", reqId: "r4", sessionId: "t1" });
    await vi.waitFor(() => expect(core.findBySession).toHaveBeenCalledWith("t1"));
    expect(pair.server.lastSent()).toEqual({
      type: "findBySessionResult",
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

// ─── sessionRowsList via CoreQueryPort (issue 07) ───────────────

import type { CoreQueryPort } from "@actana/core/pty-core-link-server";
import type { CoreSessionRow } from "@actana/shared/core-query";

/** In-memory CoreQueryPort for tests. */
class FakeQueryPort implements CoreQueryPort {
  sessions: CoreSessionRow[] = [];
  listSessionRowsCalls = 0;
  listArchivedSessionsCalls = 0;

  // Mirrors the real port's split: `listSessionRows` is the active list and has no
  // argument that reaches an archived row; the archived rows have their own
  // method behind their own frame (ADR 0019).
  listSessionRows(): CoreSessionRow[] {
    this.listSessionRowsCalls++;
    return this.sessions.filter((t) => !t.archived);
  }
  listArchivedSessions(): CoreSessionRow[] {
    this.listArchivedSessionsCalls++;
    return this.sessions.filter((t) => t.archived);
  }
  countArchivedSessions(): number {
    return this.sessions.filter((t) => t.archived).length;
  }
  getSession(sessionId: string): CoreSessionRow | null {
    return this.sessions.find((t) => t.sessionId === sessionId) ?? null;
  }
}

describe("PtyCoreLinkServer sessionRowsList (issue 07)", () => {
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

  it("answers sessionRowsList with every session from the query port", async () => {
    queryPort.sessions = [
      {
        sessionId: "t1",
       
        title: "fix bug",
        titleManuallySet: false,
        claudeSessionId: null,
        agent: "claude-code",
        status: "running",
        pinned: false,
        archived: false,
        icon: null,
        updatedAt: 2,
      },
      {
        sessionId: "t2",
       
        title: "ship",
        titleManuallySet: false,
        claudeSessionId: null,
        agent: "codex",
        status: "needs-input",
        pinned: false,
        archived: false,
        icon: "bug",
        updatedAt: 3,
      },
    ];
    pair.server.receive({ type: "sessionRowsList", reqId: "r2" });
    await vi.waitFor(() => expect(queryPort.listSessionRowsCalls).toBe(1));
    expect(pair.server.lastSent()).toEqual({
      type: "sessionRowsListResult",
      reqId: "r2",
      sessions: published(queryPort.sessions),
      archivedCount: 0,
    });
  });

  // ─── Archived read path (issue 62, ADR 0019) ───

  it("keeps archived rows off sessionRowsListResult and reports only how many there are", async () => {
    queryPort.sessions = [
      { sessionId: "live", title: "a", titleManuallySet: false, claudeSessionId: null, agent: "claude-code", status: "running", pinned: false, archived: false, icon: null, updatedAt: 3 },
      { sessionId: "old1", title: "b", titleManuallySet: false, claudeSessionId: null, agent: "claude-code", status: "done", pinned: false, archived: true, icon: null, updatedAt: 2 },
      { sessionId: "old2", title: "c", titleManuallySet: false, claudeSessionId: null, agent: "claude-code", status: "done", pinned: false, archived: true, icon: null, updatedAt: 1 },
    ];
    pair.server.receive({ type: "sessionRowsList", reqId: "r4" });
    await vi.waitFor(() => expect(pair.server.lastSent()?.type).toBe("sessionRowsListResult"));
    expect(pair.server.lastSent()).toEqual({
      type: "sessionRowsListResult",
      reqId: "r4",
      sessions: published([queryPort.sessions[0]]),
      archivedCount: 2,
    });
  });

  it("answers archivedSessionRowsList with the archived rows and nothing else", async () => {
    queryPort.sessions = [
      { sessionId: "live", title: "a", titleManuallySet: false, claudeSessionId: null, agent: "claude-code", status: "running", pinned: false, archived: false, icon: null, updatedAt: 3 },
      { sessionId: "old", title: "b", titleManuallySet: false, claudeSessionId: null, agent: "claude-code", status: "done", pinned: false, archived: true, icon: null, updatedAt: 2 },
    ];
    pair.server.receive({ type: "archivedSessionRowsList", reqId: "r5" });
    await vi.waitFor(() => expect(queryPort.listArchivedSessionsCalls).toBe(1));
    expect(pair.server.lastSent()).toEqual({
      type: "archivedSessionRowsListResult",
      reqId: "r5",
      sessions: published([queryPort.sessions[1]]),
    });
    // The archived read path never reaches the active one.
    expect(queryPort.listSessionRowsCalls).toBe(0);
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

    p.server.receive({ type: "sessionRowsList", reqId: "r2" });
    await vi.waitFor(() => expect(p.server.lastSent()?.type).toBe("sessionRowsListResult"));
    expect(p.server.lastSent()).toMatchObject({
      type: "sessionRowsListResult",
      reqId: "r2",
      sessions: [],
      archivedCount: 0,
    });

    p.server.receive({ type: "archivedSessionRowsList", reqId: "r3" });
    await vi.waitFor(() => expect(p.server.lastSent()?.type).toBe("archivedSessionRowsListResult"));
    expect(p.server.lastSent()).toMatchObject({
      type: "archivedSessionRowsListResult",
      reqId: "r3",
      sessions: [],
    });
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
    opts: { ptyId?: string | null; sessionId?: string | null } = {},
  ): number {
    const event: CoreLinkEvent = {
      eventId: this.nextId++,
      ts: Date.now(),
      kind,
      ptyId: opts.ptyId ?? null,
      sessionId: opts.sessionId ?? null,
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
  seed(kind: string, payload: string, opts?: { ptyId?: string; sessionId?: string }): number {
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
      opts: { sessionId: "t1", command: "claude", agent: "claude-code" },
    });
    await vi.waitFor(() => expect(core.spawn).toHaveBeenCalled());
    expect(eventLog.readEventTail(0)).toContainEqual(
      expect.objectContaining({ kind: "pty:spawn", ptyId: "pty-test-1", sessionId: "t1" }),
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
      opts: { shellSession: true, sessionId: "vm1" },
    });
    await vi.waitFor(() => expect(core.spawn).toHaveBeenCalled());
    const spawns = eventLog.readEventTail(0).filter((e) => e.kind === "pty:spawn");
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.ptyId).toBe("pty-test-1");
    expect(spawns[0]!.sessionId).toBe("vm1");
    expect(JSON.parse(spawns[0]!.payload).shellSession).toBe(true);
  });

  it("records a pty:spawn event for an agent spawn with shellSession false in the payload", async () => {
    // Backward compat: agent/shell spawns carry `shellSession: false` so the
    // payload shape is uniform across spawn modes.
    pair.server.receive({
      type: "spawn",
      reqId: "r3",
      opts: { sessionId: "t1", command: "claude", agent: "claude-code" },
    });
    await vi.waitFor(() => expect(core.spawn).toHaveBeenCalled());
    const spawns = eventLog.readEventTail(0).filter((e) => e.kind === "pty:spawn");
    expect(spawns).toHaveLength(1);
    expect(JSON.parse(spawns[0]!.payload).shellSession).toBe(false);
  });

  it("replays the event tail on subscribe then sends eventsReplayed", () => {
    // Seed events from the "server process" (session lifecycle).
    eventLog.seed("session:created", '{"id":"t1"}', { sessionId: "t1" });
    eventLog.seed("session:updated", '{"id":"t1","status":"running"}', { sessionId: "t1" });

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
    expect((eventFrames[0] as { event: CoreLinkEvent }).event.kind).toBe("session:created");
    expect((eventFrames[1] as { event: CoreLinkEvent }).event.kind).toBe("session:updated");
    // Then the eventsReplayed marker carrying the new cursor
    const replayed = frames.filter((f) => f.type === "eventsReplayed");
    expect(replayed).toHaveLength(1);
    expect((replayed[0] as { lastEventId: number }).lastEventId).toBe(2);
  });

  it("replays only events past the lastEventId cursor", () => {
    const first = eventLog.seed("session:created", "{}", { sessionId: "t1" });
    eventLog.seed("session:updated", "{}", { sessionId: "t1" });

    pair.server.sent.length = 0;
    pair.server.receive({ type: "subscribe", reqId: "sub1", lastEventId: first });

    const frames = sentFrames();
    const eventFrames = frames.filter((f) => f.type === "event");
    expect(eventFrames).toHaveLength(1);
    expect((eventFrames[0] as { event: CoreLinkEvent }).event.kind).toBe("session:updated");
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

    // A session event lands "after" the replay — the poll must push it live.
    eventLog.seed("session:updated", '{"status":"running"}', { sessionId: "t1" });

    await vi.waitFor(() => {
      expect(sentFrames().some((f) => f.type === "event")).toBe(true);
    });
    const eventFrames = sentFrames().filter((f) => f.type === "event");
    expect((eventFrames[0] as { event: CoreLinkEvent }).event.kind).toBe("session:updated");
  });

  it("does not push live events before the connection subscribes", async () => {
    eventLog.seed("session:updated", "{}", { sessionId: "t1" });
    // Give the poll a chance to run — it must stay silent (not subscribed).
    await new Promise((r) => setTimeout(r, 20));
    expect(sentFrames().some((f) => f.type === "event")).toBe(false);
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
    eventLog.seed("session:created", "{}", { sessionId: "t1" });
    // Subscribe before auth → rejected, no event frames sent.
    pair.server.receive({ type: "subscribe", reqId: "s1", lastEventId: 0 });
    const frames = pair.server.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    expect(frames.some((f) => f.type === "event")).toBe(false);
  });

  it("streams the event tail after auth → subscribe", () => {
    eventLog.seed("session:created", "{}", { sessionId: "t1" });
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
      opts: { sessionId: "t1", command: "claude", agent: "claude-code" },
    });
    await vi.waitFor(() => expect(core.spawn).toHaveBeenCalled());
    expect(pair.server.lastSent()).toMatchObject({ type: "spawned", reqId: "r1" });
  });
});


// ─── sessionsMutate / sessionsList via CoreMutationPort ────
// Issue 04 (ADR 0004): the Core process owns the write path against its
// SQLite. The server dispatches these frames to the mutation port; a null
// port keeps backward-compat stubs.

import type { CoreMutationPort } from "@actana/core/pty-core-link-server";
import type { CoreLinkSessionSnapshot } from "@actana/sdk/core";
import type { CoreSessionMutation } from "@actana/shared/core-mutations";

/** In-memory CoreMutationPort for tests. Records every call so assertions
 *  can verify the server threaded the frame through unchanged. */
class FakeMutationPort implements CoreMutationPort {
  sessionRows: CoreSessionRow[] = [];
  sessions: CoreLinkSessionSnapshot[] = [];
  mutateSessionCalls: CoreSessionMutation[] = [];
  listSessionsCalls = 0;
  throwOnNextMutateSession: string | null = null;

  mutateSession(mutation: CoreSessionMutation): CoreSessionRow | null {
    this.mutateSessionCalls.push(mutation);
    if (this.throwOnNextMutateSession) {
      const msg = this.throwOnNextMutateSession;
      this.throwOnNextMutateSession = null;
      throw new Error(msg);
    }
    // Mirror the real store's runtime guard: an unknown `op` throws so the
    // server sends an actionable `error` frame instead of silently no-op'ing.
    if (mutation.op !== "create" && mutation.op !== "update") {
      throw new Error(`unknown session mutation op: ${(mutation as { op?: string }).op}`);
    }
    if (mutation.op === "create") {
      const snap: CoreSessionRow = {
        sessionId: mutation.sessionId ?? `t-${this.sessionRows.length + 1}`,
        title: mutation.title,
        titleManuallySet: false,
        claudeSessionId: null,
        agent: mutation.agent,
        status: mutation.status ?? "ready",
        pinned: false,
        archived: false,
        icon: mutation.icon ?? null,
        updatedAt: 1,
      };
      this.sessionRows.push(snap);
      return snap;
    }
    const t = this.sessionRows.find((x) => x.sessionId === mutation.sessionId);
    if (!t) return null;
    if (mutation.status !== undefined) t.status = mutation.status;
    if (mutation.title !== undefined) t.title = mutation.title;
    if (mutation.pinned !== undefined) t.pinned = mutation.pinned;
    if (mutation.archived !== undefined) t.archived = mutation.archived;
    if (mutation.icon !== undefined) t.icon = mutation.icon;
    return t;
  }

  listSessions(): CoreLinkSessionSnapshot[] {
    this.listSessionsCalls++;
    return this.sessions;
  }
}

describe("PtyCoreLinkServer sessionsMutate / sessionsList (issue 04)", () => {
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

  it("round-trips sessionsMutate create → response carries the new session", async () => {
    pair.server.receive({
      type: "sessionsMutate",
      reqId: "r1",
      mutation: {
        op: "create",
        title: "fix bug",
        agent: "claude-code",
      },
    });
    await vi.waitFor(() => expect(mutationPort.mutateSessionCalls).toHaveLength(1));
    expect(pair.server.lastSent()).toMatchObject({
      type: "sessionsMutateResult",
      reqId: "r1",
      session: { title: "fix bug", agent: "claude-code" },
    });
  });

  it("translates a session mutation-store throw into an error frame with the message", async () => {
    mutationPort.throwOnNextMutateSession = "session title is required";
    pair.server.receive({
      type: "sessionsMutate",
      reqId: "r1",
      mutation: { op: "create", title: "", agent: "claude-code" },
    });
    await vi.waitFor(() => expect(pair.server.lastSent()?.type).toBe("error"));
    expect(pair.server.lastSent()).toMatchObject({
      type: "error",
      reqId: "r1",
      message: expect.stringContaining("title is required"),
    });
    expect(eventLog.readEventTail(0)).toEqual([]);
  });

  it("translates a stale-shape sessionsMutate (missing op) into an error frame, not a silent no-op", async () => {
    // parseCoreLinkRequestFrame only checks `type`; the mutation store's
    // runtime `op` guard is what surfaces this as an actionable error.
    pair.server.receive({
      type: "sessionsMutate",
      reqId: "r1",
      // Missing `op` — the old flat shape a stale Panel might still send.
      mutation: { sessionId: "t1", status: "running" } as unknown as CoreSessionMutation,
    });
    await vi.waitFor(() => expect(pair.server.lastSent()?.type).toBe("error"));
    expect(pair.server.lastSent()).toMatchObject({
      type: "error",
      reqId: "r1",
      message: expect.stringContaining("unknown session mutation op"),
    });
    expect(eventLog.readEventTail(0)).toEqual([]);
  });

  it("appends a session:updated event on an update", async () => {
    // Seed a session first via create.
    pair.server.receive({
      type: "sessionsMutate",
      reqId: "seed",
      mutation: { op: "create", sessionId: "t1", title: "a", agent: "claude-code" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateSessionCalls).toHaveLength(1));
    pair.server.receive({
      type: "sessionsMutate",
      reqId: "r2",
      mutation: { op: "update", sessionId: "t1", status: "running" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateSessionCalls).toHaveLength(2));
    const kinds = eventLog.readEventTail(0).map((e) => e.kind);
    expect(kinds).toEqual(["session:created", "session:updated"]);
  });

  it("appends session:iconChanged on an icon-only update (issue 09)", async () => {
    // Seed.
    pair.server.receive({
      type: "sessionsMutate",
      reqId: "seed",
      mutation: { op: "create", sessionId: "t1", title: "a", agent: "claude-code" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateSessionCalls).toHaveLength(1));
    // Icon-only patch → dedicated kind.
    pair.server.receive({
      type: "sessionsMutate",
      reqId: "r2",
      mutation: { op: "update", sessionId: "t1", icon: "bug" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateSessionCalls).toHaveLength(2));
    const kinds = eventLog.readEventTail(0).map((e) => e.kind);
    expect(kinds).toEqual(["session:created", "session:iconChanged"]);
  });

  it("appends session:pinnedChanged on a pinned-only update (issue 10)", async () => {
    pair.server.receive({
      type: "sessionsMutate",
      reqId: "seed",
      mutation: { op: "create", sessionId: "t1", title: "a", agent: "claude-code" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateSessionCalls).toHaveLength(1));
    // Pin-only patch → dedicated kind so consumers that only track pinned
    // state (e.g. the SessionGrid pinned filter) can subscribe distinctly.
    pair.server.receive({
      type: "sessionsMutate",
      reqId: "r2",
      mutation: { op: "update", sessionId: "t1", pinned: true },
    });
    await vi.waitFor(() => expect(mutationPort.mutateSessionCalls).toHaveLength(2));
    const kinds = eventLog.readEventTail(0).map((e) => e.kind);
    expect(kinds).toEqual(["session:created", "session:pinnedChanged"]);
  });

  it("degrades to session:updated when pinned rides with other patched fields", async () => {
    pair.server.receive({
      type: "sessionsMutate",
      reqId: "seed",
      mutation: { op: "create", sessionId: "t1", title: "a", agent: "claude-code" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateSessionCalls).toHaveLength(1));
    pair.server.receive({
      type: "sessionsMutate",
      reqId: "r2",
      mutation: { op: "update", sessionId: "t1", pinned: true, status: "running" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateSessionCalls).toHaveLength(2));
    const kinds = eventLog.readEventTail(0).map((e) => e.kind);
    expect(kinds).toEqual(["session:created", "session:updated"]);
  });

  it("degrades to session:updated when icon rides with other patched fields", async () => {
    pair.server.receive({
      type: "sessionsMutate",
      reqId: "seed",
      mutation: { op: "create", sessionId: "t1", title: "a", agent: "claude-code" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateSessionCalls).toHaveLength(1));
    pair.server.receive({
      type: "sessionsMutate",
      reqId: "r2",
      mutation: { op: "update", sessionId: "t1", icon: "bug", status: "running" },
    });
    await vi.waitFor(() => expect(mutationPort.mutateSessionCalls).toHaveLength(2));
    const kinds = eventLog.readEventTail(0).map((e) => e.kind);
    expect(kinds).toEqual(["session:created", "session:updated"]);
  });

  it("answers sessionsList by delegating to the mutation port", async () => {
    mutationPort.sessions = [
      { sessionId: "t1", ptyId: "pty-abc", status: "running", updatedAt: 10 },
      { sessionId: "t2", ptyId: null, status: "ready", updatedAt: 5 },
    ];
    pair.server.receive({ type: "sessionsList", reqId: "r1" });
    await vi.waitFor(() => expect(mutationPort.listSessionsCalls).toBe(1));
    expect(pair.server.lastSent()).toEqual({
      type: "sessionsListResult",
      reqId: "r1",
      sessions: published(mutationPort.sessions),
    });
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
      type: "sessionsMutate",
      reqId: "r2",
      mutation: { op: "create", title: "x", agent: "claude-code" },
    });
    await vi.waitFor(() =>
      expect(p.server.lastSent()?.type).toBe("sessionsMutateResult"),
    );
    expect(p.server.lastSent()).toMatchObject({ session: null });

    p.server.receive({ type: "sessionsList", reqId: "r3" });
    await vi.waitFor(() =>
      expect(p.server.lastSent()?.type).toBe("sessionsListResult"),
    );
    expect(p.server.lastSent()).toMatchObject({ sessions: [] });

    bareServer.close();
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
});
