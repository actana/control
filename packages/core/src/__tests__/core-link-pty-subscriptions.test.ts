import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PtyCoreLinkServer,
  type EventLogPort,
  type WebSocketLike,
  type WebSocketServerLike,
} from "../pty-core-link-server";
import type { PtyCore, PtyCoreEvent } from "../pty-manager";
import type { CoreLinkEvent } from "@actana/shared/core-link-frames";

// PTY output fans out per connection, by subscription (issue 142, ADR 0024 D2).
//
// The property under test is negative first: a connection receives a PTY's
// bytes only after asking, so a CLI attached to one Session no longer receives
// every other Session's output on the machine. The rest is what asking has to
// guarantee — that the catch-up lands in front of the live stream rather than
// behind it, that a PTY dying mid-handshake still reaches the new subscriber,
// and that none of it survives the connection that asked.

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
  /** Every frame this socket was sent, in order, parsed. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
  ofType<T extends Record<string, unknown>>(type: string): T[] {
    return this.frames().filter((frame) => frame.type === type) as T[];
  }
  /** The frame `type`s in the order they were written — what an ordering test reads. */
  order(...types: string[]): string[] {
    return this.frames()
      .map((frame) => String(frame.type))
      .filter((type) => types.includes(type));
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

/**
 * A `PtyCore` whose replay ring is real enough to answer a `sinceSeq`: the
 * catch-up path is the thing under test, so a stub that always answers empty
 * would pass the ordering assertions for the wrong reason.
 */
function mockCore() {
  const chunks = new Map<string, Array<{ seq: number; data: string }>>();
  const replayCalls: Array<{ ptyId: string; sinceSeq?: number }> = [];
  let nextPty = 0;
  let target: ((event: PtyCoreEvent) => void) | null = null;
  const core = {
    setEmitTarget: (fn: ((event: PtyCoreEvent) => void) | null) => {
      target = fn;
    },
    spawn: async () => ({ ptyId: `pty-${++nextPty}`, hooksReportTurnStart: true }),
    write: () => true,
    resize: () => true,
    kill: () => true,
    killLaunchProcesses: async () => ({ ptyCount: 0, ports: [] }),
    findByTask: () => ({ ptyId: null }),
    replay: (ptyId: string, sinceSeq?: number) => {
      replayCalls.push({ ptyId, sinceSeq });
      const all = chunks.get(ptyId) ?? [];
      const window = all.filter((c) => sinceSeq === undefined || c.seq >= sinceSeq);
      const nextSeq = all.length ? all[all.length - 1].seq + 1 : 0;
      return {
        data: window.map((c) => c.data).join(""),
        nextSeq,
        from: window[0]?.seq,
      };
    },
    killAll: () => {},
  } as unknown as PtyCore;
  return {
    core,
    replayCalls,
    /** Emit a chunk, recording it in the ring the way a real PTY would. */
    emitData: (ptyId: string, data: string, seq: number) => {
      const all = chunks.get(ptyId) ?? [];
      all.push({ seq, data });
      chunks.set(ptyId, all);
      target?.({ type: "data", ptyId, data, seq });
    },
    emitExit: (ptyId: string, exitCode = 0) => {
      target?.({ type: "exit", ptyId, exitCode });
    },
  };
}

describe("PTY output fans out per connection, by subscription (issue 142)", () => {
  let wss: FakeWebSocketServer;
  let server: PtyCoreLinkServer;
  let core: ReturnType<typeof mockCore>;
  let log: ReturnType<typeof fakeEventLog>;

  function connect(): FakeWebSocket {
    const ws = new FakeWebSocket();
    wss.connect(ws);
    return ws;
  }

  beforeEach(() => {
    wss = new FakeWebSocketServer();
    core = mockCore();
    log = fakeEventLog();
    server = new PtyCoreLinkServer(core.core, {
      port: 0,
      createServer: () => wss as unknown as WebSocketServerLike,
      eventLog: log.port,
      liveEventPollMs: 100_000,
    });
  });

  afterEach(() => {
    server.close();
  });

  describe("subscribe and unsubscribe", () => {
    it("delivers a PTY's stream only after the connection asks for it", () => {
      const ws = connect();

      core.emitData("pty-1", "before", 1);
      expect(ws.ofType("data")).toHaveLength(0);

      ws.receive({ type: "ptySubscribe", reqId: "s1", ptyId: "pty-1" });
      core.emitData("pty-1", "after", 2);

      expect(ws.ofType<{ data: string }>("data").map((f) => f.data)).toEqual(["after"]);
    });

    it("acks a subscribe with the state that is now true for the connection", () => {
      const ws = connect();
      ws.receive({ type: "ptySubscribe", reqId: "s1", ptyId: "pty-1" });

      expect(ws.ofType("ptySubscribeAck")).toEqual([
        { type: "ptySubscribeAck", reqId: "s1", ptyId: "pty-1", subscribed: true, holding: false },
      ]);
    });

    it("is idempotent on subscribe — a second ask delivers each chunk once", () => {
      const ws = connect();
      ws.receive({ type: "ptySubscribe", reqId: "s1", ptyId: "pty-1" });
      ws.receive({ type: "ptySubscribe", reqId: "s2", ptyId: "pty-1" });

      core.emitData("pty-1", "once", 1);

      expect(ws.ofType("ptySubscribeAck")).toHaveLength(2);
      expect(ws.ofType("data")).toHaveLength(1);
      expect(server.ptySubscriptionCount()).toBe(1);
    });

    it("is idempotent on unsubscribe — a second release is an ack, not an error", () => {
      const ws = connect();
      ws.receive({ type: "ptySubscribe", reqId: "s1", ptyId: "pty-1" });
      ws.receive({ type: "ptyUnsubscribe", reqId: "u1", ptyId: "pty-1" });
      ws.receive({ type: "ptyUnsubscribe", reqId: "u2", ptyId: "pty-1" });

      core.emitData("pty-1", "gone", 1);

      expect(ws.ofType("ptyUnsubscribeAck")).toEqual([
        { type: "ptyUnsubscribeAck", reqId: "u1", ptyId: "pty-1", subscribed: false },
        { type: "ptyUnsubscribeAck", reqId: "u2", ptyId: "pty-1", subscribed: false },
      ]);
      expect(ws.ofType("error")).toHaveLength(0);
      expect(ws.ofType("data")).toHaveLength(0);
    });

    it("does not re-arm a hold when a live subscription is asked for again", () => {
      const ws = connect();
      ws.receive({ type: "ptySubscribe", reqId: "s1", ptyId: "pty-1" });
      // A second ask carrying `catchUp` must not start holding a stream that is
      // already live: nothing further is coming to release it, and the pane
      // would go dark for the rest of the connection.
      ws.receive({ type: "ptySubscribe", reqId: "s2", ptyId: "pty-1", catchUp: true });

      core.emitData("pty-1", "still flowing", 1);

      expect(
        ws.ofType<{ holding: boolean }>("ptySubscribeAck").map((f) => f.holding),
      ).toEqual([false, false]);
      expect(ws.ofType("data")).toHaveLength(1);
    });
  });

  describe("a connection receives exactly the PTYs it subscribed to", () => {
    it("routes two PTYs to the two connections that each asked for one", () => {
      const cli = connect();
      const panel = connect();
      cli.receive({ type: "ptySubscribe", reqId: "c1", ptyId: "pty-cli" });
      panel.receive({ type: "ptySubscribe", reqId: "p1", ptyId: "pty-panel" });

      core.emitData("pty-cli", "cli output", 1);
      core.emitData("pty-panel", "panel output", 1);
      core.emitExit("pty-cli", 0);

      expect(cli.ofType<{ data: string }>("data").map((f) => f.data)).toEqual(["cli output"]);
      expect(panel.ofType<{ data: string }>("data").map((f) => f.data)).toEqual(["panel output"]);
      // The exit is the same story as the bytes: it is one PTY's fact, not the
      // machine's broadcast.
      expect(cli.ofType("exit")).toHaveLength(1);
      expect(panel.ofType("exit")).toHaveLength(0);
    });

    it("subscribes the spawning connection to what it spawned, and nobody else", async () => {
      const spawner = connect();
      const bystander = connect();

      spawner.receive({
        type: "spawn",
        reqId: "sp1",
        opts: { taskId: "t1", cwd: "/tmp", command: "sh", agent: "claude-code" },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const ptyId = spawner.ofType<{ ptyId: string }>("spawned")[0]?.ptyId;
      expect(ptyId).toBe("pty-1");

      core.emitData(ptyId, "banner", 1);

      // The id did not exist before the answer, so nothing else could have
      // asked in time — the harness's first line would be lost to the round
      // trip if the spawn did not carry the subscription with it.
      expect(spawner.ofType("data")).toHaveLength(1);
      expect(bystander.ofType("data")).toHaveLength(0);
    });

    it("stops delivering once the connection unsubscribes", () => {
      const ws = connect();
      ws.receive({ type: "ptySubscribe", reqId: "s1", ptyId: "pty-1" });
      core.emitData("pty-1", "watched", 1);
      ws.receive({ type: "ptyUnsubscribe", reqId: "u1", ptyId: "pty-1" });
      core.emitData("pty-1", "unwatched", 2);
      core.emitExit("pty-1", 0);

      expect(ws.ofType<{ data: string }>("data").map((f) => f.data)).toEqual(["watched"]);
      expect(ws.ofType("exit")).toHaveLength(0);
    });
  });

  describe("catch-up: subscribe, hold, replay, drain — in that order", () => {
    it("serves the replay window before the bytes that arrived behind it", () => {
      const ws = connect();
      core.emitData("pty-1", "scrollback", 1);

      ws.receive({ type: "ptySubscribe", reqId: "s1", ptyId: "pty-1", catchUp: true });
      expect(ws.ofType<{ holding: boolean }>("ptySubscribeAck")[0]?.holding).toBe(true);

      // The gap this exists to close: the PTY keeps talking between the
      // subscription taking effect and the replay being served.
      core.emitData("pty-1", "during the gap", 2);
      expect(ws.ofType("data")).toHaveLength(0);

      ws.receive({ type: "replay", reqId: "r1", ptyId: "pty-1", sinceSeq: 0 });

      // Subscribe first, then the window, then what was held — never the
      // reverse, which would paint live bytes in front of the scrollback.
      expect(ws.order("ptySubscribeAck", "replayResult", "data")).toEqual([
        "ptySubscribeAck",
        "replayResult",
      ]);
      // Both chunks are inside the window this client asked for, so nothing is
      // drained behind it and nothing is delivered twice.
      expect(ws.ofType<{ data: string }>("replayResult")[0]?.data).toBe("scrollbackduring the gap");
      expect(ws.ofType("data")).toHaveLength(0);
    });

    it("drains only what the replay window did not already carry", () => {
      const ws = connect();
      core.emitData("pty-1", "old", 1);
      ws.receive({ type: "ptySubscribe", reqId: "s1", ptyId: "pty-1", catchUp: true });
      core.emitData("pty-1", "gap", 2);

      // The client resumes from a cursor of its own, and the window ends where
      // the ring did when it was read. `live` arrives after that read, so it is
      // the one chunk the drain still owes the client.
      ws.receive({ type: "replay", reqId: "r1", ptyId: "pty-1", sinceSeq: 2 });
      core.emitData("pty-1", "live", 3);

      expect(core.replayCalls).toEqual([{ ptyId: "pty-1", sinceSeq: 2 }]);
      expect(ws.ofType<{ data: string }>("replayResult")[0]?.data).toBe("gap");
      expect(ws.ofType<{ data: string }>("data").map((f) => f.data)).toEqual(["live"]);
      expect(ws.order("replayResult", "data")).toEqual(["replayResult", "data"]);
    });

    it("drops a held chunk the client had already painted", () => {
      const ws = connect();
      core.emitData("pty-1", "painted", 1);
      ws.receive({ type: "ptySubscribe", reqId: "s1", ptyId: "pty-1", catchUp: true });
      core.emitData("pty-1", "also painted", 2);

      // This client resumes past both chunks — it has them on screen already.
      // The drain filters by the window's `nextSeq`, so what it held is dropped
      // rather than written a second time under the scrollback it duplicates.
      ws.receive({ type: "replay", reqId: "r1", ptyId: "pty-1", sinceSeq: 3 });

      expect(ws.ofType<{ data: string }>("replayResult")[0]?.data).toBe("");
      expect(ws.ofType("data")).toHaveLength(0);
    });

    it("keeps the hold bounded, and the replay covers what it dropped", () => {
      const ws = connect();
      ws.receive({ type: "ptySubscribe", reqId: "s1", ptyId: "pty-1", catchUp: true });

      // Well past the hold's byte cap. Overflow drops the oldest held chunks,
      // which is lossless here: the replay below is read from the ring *after*
      // the drop, so those bytes come back inside the window.
      for (let seq = 1; seq <= 40; seq += 1) core.emitData("pty-1", "x".repeat(10_000), seq);
      expect(ws.ofType("data")).toHaveLength(0);

      ws.receive({ type: "replay", reqId: "r1", ptyId: "pty-1", sinceSeq: 0 });

      expect(ws.ofType<{ data: string }>("replayResult")[0]?.data).toHaveLength(400_000);
      expect(ws.ofType("data")).toHaveLength(0);
    });

    it("goes live for good once the hold is released", () => {
      const ws = connect();
      ws.receive({ type: "ptySubscribe", reqId: "s1", ptyId: "pty-1", catchUp: true });
      ws.receive({ type: "replay", reqId: "r1", ptyId: "pty-1", sinceSeq: 0 });

      core.emitData("pty-1", "a", 1);
      core.emitData("pty-1", "b", 2);

      expect(ws.ofType<{ data: string }>("data").map((f) => f.data)).toEqual(["a", "b"]);
    });

    it("leaves a plain replay alone on a connection that is not catching up", () => {
      const ws = connect();
      core.emitData("pty-1", "history", 1);
      ws.receive({ type: "replay", reqId: "r1", ptyId: "pty-1" });

      expect(ws.ofType<{ data: string }>("replayResult")[0]?.data).toBe("history");
      expect(server.ptySubscriptionCount()).toBe(0);
    });

    it("delivers the exit of a PTY that died between the subscribe and the replay", () => {
      const ws = connect();
      core.emitData("pty-1", "last words", 1);

      ws.receive({ type: "ptySubscribe", reqId: "s1", ptyId: "pty-1", catchUp: true });
      // The process is gone before the catch-up is served. Nothing will emit a
      // second exit for it, so if this one is dropped the client waits forever
      // on a dead process.
      core.emitExit("pty-1", 3);
      expect(ws.ofType("exit")).toHaveLength(0);

      ws.receive({ type: "replay", reqId: "r1", ptyId: "pty-1", sinceSeq: 0 });

      expect(ws.ofType<{ exitCode: number }>("exit")).toEqual([
        { type: "exit", ptyId: "pty-1", exitCode: 3, signal: undefined },
      ]);
      expect(ws.order("replayResult", "exit")).toEqual(["replayResult", "exit"]);
    });
  });

  describe("an exit reaches every subscriber, and the Core's bookkeeping fires once", () => {
    it("appends one pty:exit however many connections were watching", () => {
      const watchers = [connect(), connect(), connect()];
      for (const [i, ws] of watchers.entries()) {
        ws.receive({ type: "ptySubscribe", reqId: `s${i}`, ptyId: "pty-1" });
      }
      // One of them is mid-catch-up: a held exit must not append a second row
      // when it is finally drained.
      const catchingUp = connect();
      catchingUp.receive({ type: "ptySubscribe", reqId: "c1", ptyId: "pty-1", catchUp: true });

      core.emitExit("pty-1", 0);
      catchingUp.receive({ type: "replay", reqId: "r1", ptyId: "pty-1", sinceSeq: 0 });

      for (const ws of [...watchers, catchingUp]) {
        expect(ws.ofType("exit")).toHaveLength(1);
      }
      expect(log.events.filter((event) => event.kind === "pty:exit")).toHaveLength(1);
    });

    it("still records the exit when nobody is subscribed at all", () => {
      connect();
      core.emitExit("pty-1", 1);

      // The event log is a fact about the machine, not about who was watching.
      expect(log.events.filter((event) => event.kind === "pty:exit")).toHaveLength(1);
    });
  });

  describe("subscriptions die with the connection", () => {
    it("leaves nothing behind when a client disappears without unsubscribing", () => {
      const leaving = connect();
      const staying = connect();
      leaving.receive({ type: "ptySubscribe", reqId: "a1", ptyId: "pty-1" });
      leaving.receive({ type: "ptySubscribe", reqId: "a2", ptyId: "pty-2" });
      staying.receive({ type: "ptySubscribe", reqId: "b1", ptyId: "pty-1" });
      expect(server.ptySubscriptionCount()).toBe(3);

      leaving.close();

      expect(server.ptySubscriptionCount()).toBe(1);
      core.emitData("pty-1", "still flowing", 1);
      expect(staying.ofType("data")).toHaveLength(1);
      expect(leaving.ofType("data")).toHaveLength(0);
    });

    it("holds nothing for a PTY that has exited", () => {
      const ws = connect();
      ws.receive({ type: "ptySubscribe", reqId: "s1", ptyId: "pty-1" });
      core.emitExit("pty-1", 0);

      // One entry per exited PTY per connection would accumulate for the life
      // of a long-lived link — the Panel's, which is the life of the process.
      expect(server.ptySubscriptionCount()).toBe(0);
    });

    it("drops every subscription when the server closes", () => {
      const ws = connect();
      ws.receive({ type: "ptySubscribe", reqId: "s1", ptyId: "pty-1" });

      server.close();

      expect(server.ptySubscriptionCount()).toBe(0);
    });
  });
});
