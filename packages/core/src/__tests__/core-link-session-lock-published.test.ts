import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PtyCoreLinkServer,
  type CoreMutationPort,
  type CoreQueryPort,
  type EventLogPort,
  type WebSocketLike,
  type WebSocketServerLike,
} from "../pty-core-link-server";
import type { PtyCore, PtyCoreEvent } from "../pty-manager";
import {
  SESSION_LOCK_CHANGED_EVENT_KIND,
  type CoreLinkEvent,
  type CoreLinkSessionLock,
  type CoreLinkSessionLockChangedPayload,
  type CoreLinkSessionSnapshot,
  type CoreLinkTaskSnapshot,
} from "@actana/shared/core-link-frames";

// Lock state is published, not discovered by failing (issue 145, ADR 0024 D8).
//
// The suite is organised around the ticket's "Done when", and two of those items
// are properties of what the Core does *not* say. A snapshot that answered "is
// this locked" would pass every rendering test and still be the wrong protocol:
// the client would carry the comparison, and it would need an identity to
// compare against. So the assertions below pin the *asker's* answer, and pin the
// absence of any holder identity on the wire — no client id reaches a watcher,
// on the snapshot or in an event payload, because there is none to reach it
// (D3: the holder is a connection; D10: the lock is coordination, not security).
//
// The other half is timing. Everything here is about a client learning of a lock
// change it did not cause, which is why the takeover tests assert on a socket
// that sent nothing and the replay tests assert on a socket that was not
// connected when the change happened.

type Listener = (...args: unknown[]) => void;

class FakeWebSocket {
  readyState = 1;
  sent: string[] = [];
  closed = false;
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
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
  ofType<T extends Record<string, unknown>>(type: string): T[] {
    return this.frames().filter((frame) => frame.type === type) as T[];
  }
  answerTo(reqId: string): Record<string, unknown> | undefined {
    return this.frames().find((frame) => frame.reqId === reqId);
  }
  /** Every `event` frame pushed to this connection, in the order it arrived. */
  events(): CoreLinkEvent[] {
    return this.ofType<{ event: CoreLinkEvent }>("event").map((frame) => frame.event);
  }
  /** Just the lock changes, decoded — what a client routing by kind would act on. */
  lockChanges(): CoreLinkSessionLockChangedPayload[] {
    return this.events()
      .filter((event) => event.kind === SESSION_LOCK_CHANGED_EVENT_KIND)
      .map((event) => JSON.parse(event.payload) as CoreLinkSessionLockChangedPayload);
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

function taskSnapshot(taskId: string, archived = false): CoreLinkTaskSnapshot {
  return {
    taskId,
    projectId: "p1",
    title: "t",
    titleManuallySet: false,
    claudeSessionId: null,
    agent: "claude-code",
    status: "ready",
    pinned: false,
    archived,
    icon: null,
    updatedAt: 1,
  };
}

/**
 * A query port over two fixed Sessions and one archived one. The rows it hands
 * back are the *same objects* every call, which is deliberate: it is how this
 * suite would catch the server patching a port's row in place and leaking one
 * connection's answer into the next connection's list.
 */
function mockQueryPort(): CoreQueryPort {
  const active = [taskSnapshot("task-a"), taskSnapshot("task-b")];
  const archived = [taskSnapshot("task-old", true)];
  return {
    listProjects: () => [],
    listTasks: () => active,
    listArchivedTasks: () => archived,
    countArchivedTasks: () => archived.length,
    getTask: (taskId) => active.find((task) => task.taskId === taskId) ?? null,
  };
}

function mockMutationPort(): CoreMutationPort {
  const sessions: CoreLinkSessionSnapshot[] = [
    { taskId: "task-a", ptyId: null, status: "ready", updatedAt: 1 },
    { taskId: "task-b", ptyId: null, status: "ready", updatedAt: 1 },
  ];
  return {
    mutateProject: () => null,
    mutateTask: (mutation) =>
      "taskId" in mutation && mutation.taskId ? taskSnapshot(mutation.taskId) : null,
    listSessions: () => sessions,
  };
}

function mockCore() {
  const ptyTasks = new Map<string, string>();
  let nextPty = 0;
  let target: ((event: PtyCoreEvent) => void) | null = null;
  const core = {
    setEmitTarget: (fn: ((event: PtyCoreEvent) => void) | null) => {
      target = fn;
    },
    spawn: async (opts: { taskId: string }) => {
      const ptyId = `pty-${++nextPty}`;
      ptyTasks.set(ptyId, opts.taskId);
      return { ptyId, hooksReportTurnStart: true };
    },
    write: (ptyId: string) => ptyTasks.has(ptyId),
    resize: () => true,
    kill: (ptyId: string) => ptyTasks.delete(ptyId),
    killLaunchProcesses: async () => ({ ptyCount: 0, ports: [] }),
    findByTask: () => ({ ptyId: null }),
    taskIdForPty: (ptyId: string) => ptyTasks.get(ptyId) ?? null,
    replay: () => ({ data: "", nextSeq: 0 }),
    killAll: () => {},
  };
  return { core: core as unknown as PtyCore, emit: (event: PtyCoreEvent) => target?.(event) };
}

/** The lock a connection was told about one Session in its last `tasksList`. */
function lockOf(ws: FakeWebSocket, taskId: string): CoreLinkSessionLock | undefined {
  const result = ws.ofType<{ tasks: CoreLinkTaskSnapshot[] }>("tasksListResult").at(-1);
  return result?.tasks.find((task) => task.taskId === taskId)?.lock;
}

describe("published Session lock state (issue 145, ADR 0024 D8)", () => {
  let wss: FakeWebSocketServer;
  let core: ReturnType<typeof mockCore>;
  let log: ReturnType<typeof fakeEventLog>;
  let server: PtyCoreLinkServer;

  function connect(): FakeWebSocket {
    const ws = new FakeWebSocket();
    wss.connect(ws);
    return ws;
  }

  /** Connect and start the event stream, the way a real client opens. */
  function connectSubscribed(reqId: string): FakeWebSocket {
    const ws = connect();
    ws.receive({ type: "subscribe", reqId, lastEventId: 0 });
    return ws;
  }

  function makeServer(opts: { announceMultiConnection?: boolean } = {}): PtyCoreLinkServer {
    return new PtyCoreLinkServer(core.core, {
      port: 0,
      createServer: () => wss as unknown as WebSocketServerLike,
      eventLog: log.port,
      queryPort: mockQueryPort(),
      mutationPort: mockMutationPort(),
      // Short, because half of this ticket is a client learning something it
      // never asked for: the tests below wait for a push, not for an answer.
      liveEventPollMs: 5,
      ...opts,
    });
  }

  beforeEach(() => {
    wss = new FakeWebSocketServer();
    core = mockCore();
    log = fakeEventLog();
    server = makeServer();
  });

  afterEach(() => {
    server.close();
    vi.useRealTimers();
  });

  // ── Done when: the snapshot answers "can *I* write to this?" ───────────────
  describe("the Session snapshot carries the asking connection's own answer", () => {
    it("says an unlocked Session is writable, to everybody", () => {
      const a = connect();
      const b = connect();

      a.receive({ type: "tasksList", reqId: "a1" });
      b.receive({ type: "tasksList", reqId: "b1" });

      // Unlocked is a real state (D5), and writable by anybody — the D11
      // promise that a client which never claims is served exactly as today.
      expect(lockOf(a, "task-a")).toEqual({ writable: true, state: "unlocked" });
      expect(lockOf(b, "task-a")).toEqual({ writable: true, state: "unlocked" });
    });

    it("answers the same frame differently for the holder and for a watcher", () => {
      const holder = connect();
      const watcher = connect();
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });

      holder.receive({ type: "tasksList", reqId: "h2" });
      watcher.receive({ type: "tasksList", reqId: "w1" });

      // The point of D8: neither client compares a holder against itself,
      // because the Core did it before the frame went out.
      expect(lockOf(holder, "task-a")).toEqual({ writable: true, state: "held-by-you" });
      expect(lockOf(watcher, "task-a")).toEqual({ writable: false, state: "held-by-another" });
      // And only the Session that was claimed moved.
      expect(lockOf(watcher, "task-b")).toEqual({ writable: true, state: "unlocked" });
    });

    it("agrees with the gate: what a snapshot calls writable is what is served", async () => {
      const holder = connect();
      const watcher = connect();
      holder.receive({ type: "spawn", reqId: "s1", opts: { taskId: "task-a", cwd: "/w", command: "c" } });
      await vi.waitFor(() => expect(holder.ofType("spawned").length).toBe(1));
      const ptyId = String(holder.ofType("spawned")[0].ptyId);
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });

      holder.receive({ type: "tasksList", reqId: "h2" });
      watcher.receive({ type: "tasksList", reqId: "w1" });
      holder.receive({ type: "write", reqId: "h3", ptyId, data: "x" });
      watcher.receive({ type: "write", reqId: "w2", ptyId, data: "x" });

      // A client told it may write and then refused would be worse than one
      // never told anything: the published answer has to be the gate's answer.
      expect(lockOf(holder, "task-a")?.writable).toBe(true);
      expect(holder.answerTo("h3")).toMatchObject({ type: "writeResult", ok: true });
      expect(lockOf(watcher, "task-a")?.writable).toBe(false);
      expect(watcher.answerTo("w2")).toMatchObject({ type: "error", code: "session-locked" });
    });

    it("tells a watcher nothing about who holds it", () => {
      const holder = connect();
      const watcher = connect();
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });

      watcher.receive({ type: "tasksList", reqId: "w1" });

      // The whole vocabulary a watcher gets for a holder that is not itself.
      // No id, no label, no field that a second Core client could correlate a
      // program or a person with (D3, D10).
      const lock = lockOf(watcher, "task-a")!;
      expect(Object.keys(lock).sort()).toEqual(["state", "writable"]);
      expect(lock.state).toBe("held-by-another");
      // Belt and braces on the serialized bytes, not just the parsed shape:
      // nothing that reads as an identity for the other connection is on the
      // wire at all.
      const raw = watcher.sent.join("\n");
      expect(raw).not.toMatch(/holder|clientId|connectionId|heldBy"/i);
    });

    it("carries the lock on every Session snapshot, not only the Fleet list", () => {
      const holder = connect();
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });
      const watcher = connect();

      watcher.receive({ type: "sessionsList", reqId: "w1" });
      watcher.receive({ type: "archivedTasksList", reqId: "w2" });
      watcher.receive({
        type: "tasksMutate",
        reqId: "w3",
        mutation: { op: "update", taskId: "task-b", status: "running" },
      });

      // `actana session ls` reads this one.
      const sessions = watcher.answerTo("w1") as { sessions: CoreLinkSessionSnapshot[] };
      expect(sessions.sessions.find((s) => s.taskId === "task-a")?.lock).toEqual({
        writable: false,
        state: "held-by-another",
      });
      const archived = watcher.answerTo("w2") as { tasks: CoreLinkTaskSnapshot[] };
      expect(archived.tasks[0].lock).toEqual({ writable: true, state: "unlocked" });
      const mutated = watcher.answerTo("w3") as { task: CoreLinkTaskSnapshot };
      expect(mutated.task.lock).toEqual({ writable: true, state: "unlocked" });
    });

    it("never leaves one connection's answer on another connection's row", () => {
      const holder = connect();
      const watcher = connect();
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });

      holder.receive({ type: "tasksList", reqId: "h2" });
      watcher.receive({ type: "tasksList", reqId: "w1" });
      holder.receive({ type: "tasksList", reqId: "h3" });

      // The query port hands back the same row objects every call. A stamp
      // written into them instead of onto a copy would have the holder read
      // `held-by-another` about its own Session here.
      expect(lockOf(holder, "task-a")).toEqual({ writable: true, state: "held-by-you" });
    });

    it("publishes nothing on a Core that does not announce multiConnection", () => {
      server.close();
      server = makeServer({ announceMultiConnection: false });
      const ws = connect();

      ws.receive({ type: "claim", reqId: "c1", taskId: "task-a" });
      ws.receive({ type: "tasksList", reqId: "t1" });

      // Such a Core has told the client it has no lock table (D11). Absent is
      // the honest answer, and it is what an older Panel already handles.
      const tasks = (ws.answerTo("t1") as { tasks: CoreLinkTaskSnapshot[] }).tasks;
      expect(tasks.every((task) => task.lock === undefined)).toBe(true);
      expect(log.events.filter((e) => e.kind === SESSION_LOCK_CHANGED_EVENT_KIND)).toHaveLength(0);
    });
  });

  // ── Done when: a dedicated event kind fires on claim, release, takeover ────
  describe("a dedicated event kind, on every change", () => {
    it("appends one session:lockChanged per transition, on its own kind", () => {
      const ws = connect();

      ws.receive({ type: "claim", reqId: "c1", taskId: "task-a" });
      ws.receive({ type: "release", reqId: "r1", taskId: "task-a" });

      // Not a widened `task:updated` carrying a lock field — that is the
      // generic field patch ADR 0017 and ADR 0022 both rejected, and it would
      // have every client refetching on every task edit to find out whether
      // this one was about the lock.
      expect(log.events.map((e) => e.kind)).toEqual([
        SESSION_LOCK_CHANGED_EVENT_KIND,
        SESSION_LOCK_CHANGED_EVENT_KIND,
      ]);
      expect(log.events.map((e) => JSON.parse(e.payload))).toEqual([
        { taskId: "task-a", transition: "claimed", locked: true },
        { taskId: "task-a", transition: "released", locked: false },
      ]);
      // Routable without parsing the payload, like every other event row.
      expect(log.events.every((e) => e.taskId === "task-a")).toBe(true);
    });

    it("names a takeover a takeover, and a takeover of nobody's Session a claim", () => {
      const holder = connect();
      const taker = connect();
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });

      taker.receive({ type: "forceTakeover", reqId: "t1", taskId: "task-a" });
      taker.receive({ type: "forceTakeover", reqId: "t2", taskId: "task-b" });

      // The wire says what happened to the lock, not which frame arrived: no
      // client reports having evicted somebody who was never there.
      expect(log.events.map((e) => JSON.parse(e.payload).transition)).toEqual([
        "claimed",
        "taken-over",
        "claimed",
      ]);
    });

    it("publishes the drop of a holder's connection, like the other two endings", () => {
      const holder = connect();
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });
      holder.receive({ type: "claim", reqId: "h2", taskId: "task-b" });

      holder.close();

      // A drop is one of the three ways a lock ends (D7). Nobody sent a frame
      // for this one, so the event is the only way a waiting client hears that
      // the Session is claimable again.
      expect(log.events.slice(2).map((e) => JSON.parse(e.payload))).toEqual([
        { taskId: "task-a", transition: "released", locked: false },
        { taskId: "task-b", transition: "released", locked: false },
      ]);
    });

    it("stays silent when nothing changed", () => {
      const holder = connect();
      const other = connect();
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });
      const afterClaim = log.events.length;

      // Idempotent re-claim by the holder, a claim denied to another
      // connection, a release from a connection that holds nothing, and a
      // takeover by the holder itself. Four frames, four answers, no change —
      // and an event for any of them would be a transition nobody made.
      holder.receive({ type: "claim", reqId: "h2", taskId: "task-a" });
      other.receive({ type: "claim", reqId: "o1", taskId: "task-a" });
      other.receive({ type: "release", reqId: "o2", taskId: "task-a" });
      holder.receive({ type: "forceTakeover", reqId: "h3", taskId: "task-a" });

      expect(log.events.length).toBe(afterClaim);
      expect(other.answerTo("o1")).toMatchObject({ granted: false });
      expect(other.answerTo("o2")).toMatchObject({ released: false });
      expect(holder.answerTo("h3")).toMatchObject({ takenFrom: "this-connection" });
    });

    it("carries no client identity in the payload", () => {
      const holder = connect();
      const taker = connect();
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });
      taker.receive({ type: "forceTakeover", reqId: "t1", taskId: "task-a" });

      // One row, read by every connection: anything identifying here would be
      // broadcast to every watcher of this Core. A takeover names neither
      // winner nor loser and needs to name neither — the winner has its own
      // `forceTakeoverResult`, and for everyone else "the holder is now
      // somebody who is not me" is the whole of the fact.
      for (const event of log.events) {
        expect(Object.keys(JSON.parse(event.payload)).sort()).toEqual([
          "locked",
          "taskId",
          "transition",
        ]);
      }
    });
  });

  // ── Done when: a force-taken client observes the transition without polling ─
  describe("the loser of a force takeover", () => {
    it("is told, on a connection that asked for nothing", async () => {
      const loser = connectSubscribed("l0");
      const taker = connect();
      loser.receive({ type: "claim", reqId: "l1", taskId: "task-a" });
      await vi.waitFor(() => expect(loser.lockChanges()).toHaveLength(1));
      const sentBeforeTakeover = loser.sent.length;

      taker.receive({ type: "forceTakeover", reqId: "t1", taskId: "task-a" });

      // Pushed on the ordinary event stream. The loser sends nothing between
      // its claim and hearing about the takeover — no poll, no retry, no
      // keystroke that comes back refused.
      await vi.waitFor(() => expect(loser.lockChanges()).toHaveLength(2));
      expect(loser.lockChanges().at(-1)).toEqual({
        taskId: "task-a",
        transition: "taken-over",
        locked: true,
      });
      expect(loser.sent.length).toBeGreaterThan(sentBeforeTakeover);
    });

    it("reads its new answer off the next snapshot it takes", async () => {
      const loser = connectSubscribed("l0");
      const taker = connect();
      loser.receive({ type: "claim", reqId: "l1", taskId: "task-a" });
      taker.receive({ type: "forceTakeover", reqId: "t1", taskId: "task-a" });
      await vi.waitFor(() => expect(loser.lockChanges()).toHaveLength(2));

      loser.receive({ type: "tasksList", reqId: "l2" });

      // The event says the lock moved; the snapshot says what that means for
      // this connection. Between them a client never has to hold an identity.
      expect(lockOf(loser, "task-a")).toEqual({ writable: false, state: "held-by-another" });
    });
  });

  // ── Done when: the event is in the log and replays by cursor ───────────────
  describe("replay by cursor", () => {
    it("hands a reconnecting client the lock changes it missed, in order", () => {
      const holder = connect();
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });
      holder.receive({ type: "release", reqId: "h2", taskId: "task-a" });

      // A client that was not connected for either of them.
      const late = connect();
      late.receive({ type: "subscribe", reqId: "s1", lastEventId: 0 });

      expect(late.lockChanges()).toEqual([
        { taskId: "task-a", transition: "claimed", locked: true },
        { taskId: "task-a", transition: "released", locked: false },
      ]);
      // Replayed like every other event, and closed off the same way, so a
      // client learns where its cursor now is.
      expect(late.ofType("eventsReplayed").at(-1)).toMatchObject({ lastEventId: 2 });
    });

    it("replays only what is past the cursor the client presents", () => {
      const holder = connect();
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });
      holder.receive({ type: "release", reqId: "h2", taskId: "task-a" });

      const late = connect();
      late.receive({ type: "subscribe", reqId: "s1", lastEventId: 1 });

      // The claim is behind the cursor; the release is not. Nothing about a
      // lock event is exempt from the cursor rule.
      expect(late.lockChanges()).toEqual([
        { taskId: "task-a", transition: "released", locked: false },
      ]);
    });
  });
});
