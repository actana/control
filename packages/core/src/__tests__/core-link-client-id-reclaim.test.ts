import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PtyCoreLinkServer,
  type AuthVerifier,
  type WebSocketLike,
  type WebSocketServerLike,
} from "../pty-core-link-server";
import type { PtyCore, PtyCoreEvent } from "../pty-manager";
import { SESSION_LOCKED_ERROR_CODE } from "@actana/shared/core-link-frames";

// A connection presents a stable client id, and it is used for reaping and
// nothing else (issue 146, ADR 0024 D9).
//
// The suite is organised around the ticket's "Done when", and the last of those
// items is the one with the most to prove. Two properties carry the feature:
//
//  1. **There is no unlocked window.** A reconnecting client's locks arrive by
//     being rewritten in place, and the predecessor's socket is closed only
//     after they have. The test that matters here does not check the end state
//     — the wrong order reaches the same end state — it reaches *into* the
//     moment the predecessor is dropped and tries to steal the Session from a
//     third connection. That is what tells the two implementations apart, and
//     closing that window is the entire reason this ticket exists.
//
//  2. **The id is not authority and not identity** (D9, D10). It is a string a
//     client made up; nothing signs it and nothing verifies it. What that has to
//     mean, and what is asserted below, is that presenting one buys *nothing* a
//     connection did not already have: it does not authenticate, it does not
//     survive the auth gate, and the only thing it can move — a Session lock —
//     is something any authenticated connection can already take outright with
//     `forceTakeover`. A forged id is therefore not a privilege escalation but a
//     slower spelling of a frame that is already unconditional.
//
// What this deliberately does not assert is that a client can be stopped from
// presenting somebody else's id. It cannot, by design: whoever opened this
// socket holds the bearer, and a bearer holder can open a VM Shell Session and
// kill the process directly. Defending this string would be theatre (D10) and
// would build the per-client credential D3 rejected.

type Listener = (...args: unknown[]) => void;

class FakeWebSocket {
  readyState = 1;
  sent: string[] = [];
  closed = false;
  terminated = false;
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
  answerTo(reqId: string): Record<string, unknown> | undefined {
    return this.frames().find((frame) => frame.reqId === reqId);
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
 * A `PtyCore` that remembers which Task each PTY belongs to — the resolution
 * the lock gate is built on, so a `write` refusal proves the Session was found
 * rather than a constant being echoed back.
 */
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

describe("the stable client id, for reaping only (issue 146, ADR 0024 D9)", () => {
  let wss: FakeWebSocketServer;
  let core: ReturnType<typeof mockCore>;
  let server: PtyCoreLinkServer;

  /** One connection is one Core client (D3). */
  function connect(): FakeWebSocket {
    const ws = new FakeWebSocket();
    wss.connect(ws);
    return ws;
  }

  async function spawn(ws: FakeWebSocket, taskId: string): Promise<string> {
    ws.receive({
      type: "spawn",
      reqId: `spawn-${taskId}`,
      opts: { taskId, cwd: "/w", command: "c" },
    });
    await vi.waitFor(() => expect(ws.frames().some((f) => f.type === "spawned")).toBe(true));
    return String(ws.answerTo(`spawn-${taskId}`)!.ptyId);
  }

  /** Present a client id and hand back the Core's answer. */
  function reclaim(ws: FakeWebSocket, clientId: unknown, reqId = `rc-${clientId}`): Record<string, unknown> {
    ws.receive({ type: "reclaim", reqId, clientId });
    return ws.answerTo(reqId)!;
  }

  function startServer(opts: { authVerifier?: AuthVerifier } = {}): void {
    server = new PtyCoreLinkServer(core.core, {
      port: 0,
      createServer: () => wss as unknown as WebSocketServerLike,
      liveEventPollMs: 10_000,
      ...opts,
    });
  }

  beforeEach(() => {
    wss = new FakeWebSocketServer();
    core = mockCore();
    startServer();
  });

  afterEach(() => {
    server.close();
    vi.useRealTimers();
  });

  // ── Done when: same id → predecessor closed, locks transferred, one step ───
  describe("reconnecting with the same client id", () => {
    it("closes the predecessor and moves its Sessions to the successor", async () => {
      const first = connect();
      reclaim(first, "panel-1");
      const ptyId = await spawn(first, "task-a");
      first.receive({ type: "claim", reqId: "c1", taskId: "task-a" });

      const second = connect();
      const answer = reclaim(second, "panel-1");

      expect(answer).toMatchObject({
        type: "reclaimResult",
        clientId: "panel-1",
        replaced: true,
        taskIds: ["task-a"],
      });
      expect(first.closed).toBe(true);
      // The lock did not merely survive the handover — it is the successor's.
      second.receive({ type: "write", reqId: "w1", ptyId, data: "x" });
      expect(second.answerTo("w1")).toMatchObject({ type: "writeResult", ok: true });
      expect(server.sessionLockCount()).toBe(1);
    });

    it("carries every Session the predecessor held, not the first one", async () => {
      const first = connect();
      reclaim(first, "panel-1");
      await spawn(first, "task-a");
      await spawn(first, "task-b");
      await spawn(first, "task-c");
      first.receive({ type: "claim", reqId: "c1", taskId: "task-a" });
      first.receive({ type: "claim", reqId: "c2", taskId: "task-b" });
      first.receive({ type: "claim", reqId: "c3", taskId: "task-c" });

      const second = connect();
      const answer = reclaim(second, "panel-1");

      // A partial sweep would leave a Session held by a socket that has just
      // been closed — nothing left to release it but a Core restart.
      expect((answer.taskIds as string[]).sort()).toEqual(["task-a", "task-b", "task-c"]);
      expect(server.sessionLockCount()).toBe(3);
    });

    it("replaces nobody when this connection is the one that presented the id", async () => {
      // A client re-presenting its own id on a live connection must not reap
      // itself: `reclaim` is sent on every (re)connect, and a self-match would
      // turn an ordinary re-presentation into a closed socket and lost locks.
      const only = connect();
      reclaim(only, "panel-1");
      const ptyId = await spawn(only, "task-a");
      only.receive({ type: "claim", reqId: "c1", taskId: "task-a" });

      const answer = reclaim(only, "panel-1", "rc-again");

      expect(answer).toMatchObject({ replaced: false, taskIds: [] });
      expect(only.closed).toBe(false);
      only.receive({ type: "write", reqId: "w1", ptyId, data: "x" });
      expect(only.answerTo("w1")).toMatchObject({ ok: true });
    });

    it("answers a client id nobody has presented as the ordinary first connect", () => {
      const fresh = connect();
      expect(reclaim(fresh, "panel-never-seen")).toMatchObject({
        replaced: false,
        taskIds: [],
      });
      expect(fresh.closed).toBe(false);
    });

    it("reaps a predecessor that held nothing — the ghost socket is the point", async () => {
      // The locks are the visible half; the dead socket is the other. A client
      // that reconnects having held nothing still leaves a connection the Core
      // would otherwise fan output into for the full heartbeat timeout.
      const first = connect();
      reclaim(first, "panel-1");
      await spawn(first, "task-a");

      const second = connect();
      expect(reclaim(second, "panel-1")).toMatchObject({ replaced: true, taskIds: [] });
      expect(first.closed).toBe(true);
    });
  });

  // ── Done when: no window in which the Session is unlocked and claimable ────
  describe("the transfer is one step, with no unlocked instant", () => {
    it("leaves nothing claimable at the moment the predecessor is dropped", async () => {
      const first = connect();
      reclaim(first, "panel-1");
      const ptyId = await spawn(first, "task-a");
      first.receive({ type: "claim", reqId: "c1", taskId: "task-a" });

      const third = connect();
      const stolen: Array<Record<string, unknown>> = [];
      // The probe, and what it distinguishes. Two statements run back to back
      // cannot be interleaved in a single-threaded runtime, so the ordering
      // this catches is the one that genuinely opens a window: retiring the
      // predecessor before its locks are secured. `dropConnection` runs
      // `releaseAll`, and a close handler is where other code gets to run — on
      // a real transport, for as long as the close takes. This listener is
      // registered after the server's own, so it runs *inside* that drop, and a
      // third client tries both ways in: the explicit claim, and the write an
      // unlocked Session serves to anybody (D5, D11).
      first.on("close", () => {
        third.receive({ type: "claim", reqId: "steal-claim", taskId: "task-a" });
        third.receive({ type: "write", reqId: "steal-write", ptyId, data: "rm -rf" });
        stolen.push(third.answerTo("steal-claim")!, third.answerTo("steal-write")!);
      });

      const second = connect();
      reclaim(second, "panel-1");

      expect(first.closed).toBe(true);
      expect(stolen).toHaveLength(2);
      // Denied, and refused, from inside the handover: the Session was already
      // the successor's before the predecessor's socket was touched.
      expect(stolen[0]).toMatchObject({ type: "claimResult", granted: false });
      expect(stolen[1]).toMatchObject({ code: SESSION_LOCKED_ERROR_CODE });
    });

    it("does not let the predecessor's own drop release what has moved", async () => {
      // `dropConnection` sweeps every lock its connection holds — correct, and
      // the reason the order in `reclaimFor` is load-bearing. Run the other way
      // round, this assertion is what fails: the sweep would take the Session
      // back out of the table on its way past.
      const first = connect();
      reclaim(first, "panel-1");
      await spawn(first, "task-a");
      first.receive({ type: "claim", reqId: "c1", taskId: "task-a" });

      const second = connect();
      reclaim(second, "panel-1");
      // Deliver the close a real transport would deliver asynchronously, after
      // the frame was answered.
      first.emit("close");

      expect(server.sessionLockCount()).toBe(1);
      const third = connect();
      third.receive({ type: "claim", reqId: "t1", taskId: "task-a" });
      expect(third.answerTo("t1")).toMatchObject({ granted: false });
    });
  });

  // ── Done when: a different client id disturbs nobody ──────────────────────
  describe("reconnecting with a different client id", () => {
    it("leaves the other client's connection and its Sessions alone", async () => {
      const panel = connect();
      reclaim(panel, "panel-1");
      const ptyId = await spawn(panel, "task-a");
      panel.receive({ type: "claim", reqId: "c1", taskId: "task-a" });

      // The CLI is a Core client of its own, and mints its own id per
      // invocation — the Panel's id is not the CLI's.
      const cli = connect();
      const answer = reclaim(cli, "cli-7");

      expect(answer).toMatchObject({ replaced: false, taskIds: [] });
      expect(panel.closed).toBe(false);
      panel.receive({ type: "write", reqId: "w1", ptyId, data: "x" });
      expect(panel.answerTo("w1")).toMatchObject({ ok: true });
      cli.receive({ type: "claim", reqId: "cli-c", taskId: "task-a" });
      expect(cli.answerTo("cli-c")).toMatchObject({ granted: false });
    });

    it("never reaps a connection that has presented no id at all", async () => {
      // Every client that predates D9 is this connection (D11), and so is one
      // whose reclaim is still in flight. It is reaped by the heartbeat when it
      // dies and by nothing else — a reclaim must not take it out.
      const silent = connect();
      const ptyId = await spawn(silent, "task-a");
      silent.receive({ type: "claim", reqId: "c1", taskId: "task-a" });

      const other = connect();
      expect(reclaim(other, "panel-1")).toMatchObject({ replaced: false });
      // And an id-less reclaim finds no id-less peer to match either: an absent
      // field is no id, not a shared one.
      const third = connect();
      third.receive({ type: "reclaim", reqId: "empty" });
      expect(third.answerTo("empty")).toMatchObject({
        type: "reclaimResult",
        clientId: "",
        replaced: false,
        taskIds: [],
      });

      expect(silent.closed).toBe(false);
      silent.receive({ type: "write", reqId: "w1", ptyId, data: "x" });
      expect(silent.answerTo("w1")).toMatchObject({ ok: true });
    });
  });

  // ── Done when: nothing anywhere treats the id as authentication ───────────
  //
  // The ticket says a test asserting that a forged id grants no authority is
  // worth more than the feature. This is that test, in four parts.
  describe("a forged client id grants no authority", () => {
    const verifier: AuthVerifier = (bearer) =>
      bearer.startsWith("good")
        ? { ok: true, coreId: `core-for-${bearer}`, exp: 2 ** 40 }
        : { ok: false, reason: "bad-signature" };

    function authed(bearer = "good-1"): FakeWebSocket {
      const ws = connect();
      ws.receive({ type: "auth", reqId: `auth-${bearer}`, bearer });
      return ws;
    }

    beforeEach(() => {
      server.close();
      wss = new FakeWebSocketServer();
      core = mockCore();
      startServer({ authVerifier: verifier });
    });

    it("does not authenticate: presented before a bearer it is refused like any other frame", async () => {
      const holder = authed();
      const ptyId = await spawn(holder, "task-a");
      holder.receive({ type: "claim", reqId: "c1", taskId: "task-a" });
      reclaim(holder, "panel-1");

      // A connection with no bearer, presenting the holder's id. The id is not
      // a credential, and there is no path on which it becomes one.
      const forger = connect();
      forger.receive({ type: "reclaim", reqId: "forge", clientId: "panel-1" });

      expect(forger.answerTo("forge")).toMatchObject({ message: "not-authenticated" });
      expect(forger.frames().some((f) => f.type === "reclaimResult")).toBe(false);
      expect(forger.closed).toBe(true);
      // Nothing moved, nothing was reaped, nothing was authenticated.
      expect(holder.closed).toBe(false);
      expect(server.sessionLockCount()).toBe(1);
      holder.receive({ type: "write", reqId: "w1", ptyId, data: "x" });
      expect(holder.answerTo("w1")).toMatchObject({ ok: true });
    });

    it("grants nothing beyond the predecessor's own locks", async () => {
      // The escalation a forged id would have to buy to be worth defending: a
      // Session held by a *different* client. It does not — the transfer moves
      // what one connection held, and nothing reads the id anywhere else.
      const victim = authed("good-1");
      reclaim(victim, "panel-1");
      await spawn(victim, "task-a");
      victim.receive({ type: "claim", reqId: "v1", taskId: "task-a" });

      const bystander = authed("good-2");
      reclaim(bystander, "cli-7");
      const bystanderPty = await spawn(bystander, "task-b");
      bystander.receive({ type: "claim", reqId: "b1", taskId: "task-b" });

      const forger = authed("good-3");
      const answer = reclaim(forger, "panel-1", "forge");

      expect(answer).toMatchObject({ replaced: true, taskIds: ["task-a"] });
      // The bystander is untouched, and the forger cannot write its Session.
      expect(bystander.closed).toBe(false);
      forger.receive({ type: "write", reqId: "w1", ptyId: bystanderPty, data: "x" });
      expect(forger.answerTo("w1")).toMatchObject({ code: SESSION_LOCKED_ERROR_CODE });
    });

    it("takes no more than `forceTakeover` already hands any authenticated connection", async () => {
      // The whole argument for not defending the id, as an assertion. Whatever
      // a forged reclaim can take, the frame beside it takes unconditionally
      // and without an id at all (D7) — so the id is not the thing standing
      // between a client and somebody else's Session.
      const victim = authed("good-1");
      reclaim(victim, "panel-1");
      const ptyId = await spawn(victim, "task-a");
      victim.receive({ type: "claim", reqId: "v1", taskId: "task-a" });

      const blunt = authed("good-2");
      blunt.receive({ type: "forceTakeover", reqId: "ft", taskId: "task-a" });

      expect(blunt.answerTo("ft")).toMatchObject({ takenFrom: "another-connection" });
      blunt.receive({ type: "write", reqId: "w1", ptyId, data: "x" });
      expect(blunt.answerTo("w1")).toMatchObject({ ok: true });
    });

    it("is never verified, and is bound to no credential", async () => {
      // Not an oversight to be tightened later — the recorded posture (D9,
      // D10). The Core accepts any string, from a connection authenticated with
      // an entirely different bearer, and never compares the two. Pinned so
      // that a future change which starts checking the id has to argue with
      // this test and the ADR behind it rather than land quietly.
      const first = authed("good-1");
      reclaim(first, "  ../weird id 🙂  ");
      await spawn(first, "task-a");
      first.receive({ type: "claim", reqId: "c1", taskId: "task-a" });

      const second = authed("good-2-different-bearer-different-coreId");
      const answer = reclaim(second, "  ../weird id 🙂  ", "rc-2");

      expect(answer).toMatchObject({ replaced: true, taskIds: ["task-a"] });
      expect(first.closed).toBe(true);
    });
  });
});
