import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PtyCoreLinkServer,
  type CoreMutationPort,
  type EventLogPort,
  type WebSocketLike,
  type WebSocketServerLike,
} from "../pty-core-link-server";
import type { PtyCore, PtyCoreEvent } from "../pty-manager";
import {
  SESSION_LOCKED_ERROR_CODE,
  type CoreLinkEvent,
  type CoreLinkTaskSnapshot,
} from "@actana/sdk/core-link-frames";

// One Session, at most one writer, named by the core-link connection
// (issue 144, ADR 0024 D3–D7, D10).
//
// The suite is organised around the ticket's "Done when", because each item
// there is a property rather than a code path: the lock exists to make certain
// things impossible, and a test that only walked the happy path would pass on a
// Core that had no lock at all.
//
// Two things it deliberately asserts the *absence* of. There is no idle timeout
// (D7) — a long agent run is idle by definition, so a lock that expired on
// silence would expire exactly when losing it costs most. And there is no
// creator privilege (D5) — a Session starts unlocked, which is what makes the
// claim race real and accepted rather than a defect to be closed.

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
  /** The frame answering `reqId`, whatever its type — what a correlation test reads. */
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
 * A `PtyCore` that remembers which Task each PTY was spawned for, because that
 * mapping is what the gate is built on: `write` and `kill` name a `ptyId`, and
 * the lock is keyed by the Session. A stub answering a constant taskId would
 * pass the refusal assertions without ever proving the resolution happened.
 *
 * `writes` and `kills` record what actually reached the Core, which is the only
 * way to tell a refusal from a mutation that was served and answered unhappily.
 */
function mockCore() {
  const ptyTasks = new Map<string, string>();
  const writes: Array<{ ptyId: string; data: string }> = [];
  const kills: string[] = [];
  const spawns: string[] = [];
  let nextPty = 0;
  let target: ((event: PtyCoreEvent) => void) | null = null;
  const core = {
    setEmitTarget: (fn: ((event: PtyCoreEvent) => void) | null) => {
      target = fn;
    },
    spawn: async (opts: { taskId: string }) => {
      spawns.push(opts.taskId);
      const ptyId = `pty-${++nextPty}`;
      ptyTasks.set(ptyId, opts.taskId);
      return { ptyId, hooksReportTurnStart: true };
    },
    write: (ptyId: string, data: string) => {
      writes.push({ ptyId, data });
      return ptyTasks.has(ptyId);
    },
    resize: () => true,
    kill: (ptyId: string) => {
      kills.push(ptyId);
      return ptyTasks.delete(ptyId);
    },
    killLaunchProcesses: async () => ({ ptyCount: 0, ports: [] }),
    findByTask: () => ({ ptyId: null }),
    taskIdForPty: (ptyId: string) => ptyTasks.get(ptyId) ?? null,
    replay: () => ({ data: "", nextSeq: 0 }),
    killAll: () => {},
  };
  return {
    core: core as unknown as PtyCore,
    writes,
    kills,
    spawns,
    ptyTasks,
    emit: (event: PtyCoreEvent) => target?.(event),
  };
}

/**
 * The seam `harnessPrompt` lands on. It records what reached it because that is
 * the only way to tell a refusal from a prompt that was accepted and answered:
 * the frame's own `accepted: false` also means "no port, or an empty prompt".
 */
function mockPromptPort() {
  const submitted: Array<{ taskId: string; prompt: string }> = [];
  return {
    submitted,
    port: { submitted: (taskId: string, prompt: string) => void submitted.push({ taskId, prompt }) },
  };
}

/** A mutation port that answers every `update`/`delete` for a known task. */
function mockMutationPort(): CoreMutationPort & { mutations: string[] } {
  const mutations: string[] = [];
  const snapshot = (taskId: string): CoreLinkTaskSnapshot => ({
    taskId,
    projectId: "p1",
    title: "t",
    titleManuallySet: false,
    claudeSessionId: null,
    agent: "claude-code",
    status: "ready",
    pinned: false,
    archived: false,
    icon: null,
    updatedAt: 1,
  });
  return {
    mutations,
    mutateProject: () => null,
    mutateTask: (mutation) => {
      mutations.push(`${mutation.op}:${"taskId" in mutation ? mutation.taskId : "-"}`);
      return "taskId" in mutation && mutation.taskId ? snapshot(mutation.taskId) : null;
    },
    listSessions: () => [],
  };
}

describe("the Session write lock (issue 144, ADR 0024 D3-D7, D10)", () => {
  let wss: FakeWebSocketServer;
  let core: ReturnType<typeof mockCore>;
  let mutationPort: ReturnType<typeof mockMutationPort>;
  let promptPort: ReturnType<typeof mockPromptPort>;
  let server: PtyCoreLinkServer;

  /** Open a connection and return its socket. Each is one Core client (D3). */
  function connect(): FakeWebSocket {
    const ws = new FakeWebSocket();
    wss.connect(ws);
    return ws;
  }

  /** Spawn a Session on one connection and hand back its ptyId. */
  async function spawn(ws: FakeWebSocket, taskId: string): Promise<string> {
    ws.receive({ type: "spawn", reqId: `spawn-${taskId}`, opts: { taskId, cwd: "/w", command: "c" } });
    await vi.waitFor(() => expect(ws.ofType("spawned").length).toBeGreaterThan(0));
    const spawned = ws.ofType("spawned").at(-1)!;
    return String(spawned.ptyId);
  }

  beforeEach(() => {
    wss = new FakeWebSocketServer();
    core = mockCore();
    mutationPort = mockMutationPort();
    promptPort = mockPromptPort();
    server = new PtyCoreLinkServer(core.core, {
      port: 0,
      createServer: () => wss as unknown as WebSocketServerLike,
      eventLog: fakeEventLog().port,
      mutationPort,
      promptPort: promptPort.port,
      liveEventPollMs: 10_000,
    });
  });

  afterEach(() => {
    server.close();
    vi.useRealTimers();
  });

  // ── Done when: the three frames exist and correlate by reqId ──────────────
  describe("claim, release and force takeover are ordinary requests", () => {
    it("answers each one on the reqId it was asked with", async () => {
      const ws = connect();
      await spawn(ws, "task-a");

      ws.receive({ type: "claim", reqId: "q1", taskId: "task-a" });
      ws.receive({ type: "forceTakeover", reqId: "q2", taskId: "task-a" });
      ws.receive({ type: "release", reqId: "q3", taskId: "task-a" });

      expect(ws.answerTo("q1")).toMatchObject({
        type: "claimResult",
        taskId: "task-a",
        granted: true,
      });
      // Taking a Session this connection already holds names itself honestly
      // rather than claiming to have evicted somebody.
      expect(ws.answerTo("q2")).toMatchObject({
        type: "forceTakeoverResult",
        takenFrom: "this-connection",
      });
      expect(ws.answerTo("q3")).toMatchObject({ type: "releaseResult", released: true });
    });

    it("denies a claim on a Session another connection holds, and changes nothing", async () => {
      const holder = connect();
      const other = connect();
      const ptyId = await spawn(holder, "task-a");
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });

      other.receive({ type: "claim", reqId: "o1", taskId: "task-a" });

      // A denied claim is an answer, not an error frame: the caller's next move
      // is the same whether or not it expected one.
      expect(other.answerTo("o1")).toMatchObject({ type: "claimResult", granted: false });
      // And the holder still holds it — a denied claim must not disturb the lock.
      holder.receive({ type: "write", reqId: "h2", ptyId, data: "x" });
      expect(holder.answerTo("h2")).toMatchObject({ type: "writeResult", ok: true });
    });

    it("is idempotent for the connection that already holds the Session", async () => {
      const ws = connect();
      await spawn(ws, "task-a");
      ws.receive({ type: "claim", reqId: "c1", taskId: "task-a" });
      ws.receive({ type: "claim", reqId: "c2", taskId: "task-a" });
      expect(ws.answerTo("c2")).toMatchObject({ granted: true });
    });

    it("ignores a release from a connection that does not hold the lock", async () => {
      const holder = connect();
      const other = connect();
      const ptyId = await spawn(holder, "task-a");
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });

      other.receive({ type: "release", reqId: "o1", taskId: "task-a" });

      // Idempotent, not an error — and emphatically not a way to unlock
      // somebody else's Session.
      expect(other.answerTo("o1")).toMatchObject({ type: "releaseResult", released: false });
      other.receive({ type: "write", reqId: "o2", ptyId, data: "x" });
      expect(other.answerTo("o2")).toMatchObject({ code: SESSION_LOCKED_ERROR_CODE });
    });
  });

  // ── Done when: a mutation without the lock is refused, distinguishably ────
  describe("a mutation from a connection that does not hold the lock", () => {
    it("refuses write, kill and task mutations with a distinguishable code", async () => {
      const holder = connect();
      const other = connect();
      const ptyId = await spawn(holder, "task-a");
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });

      other.receive({ type: "write", reqId: "o1", ptyId, data: "rm -rf\r" });
      other.receive({ type: "kill", reqId: "o2", ptyId });
      other.receive({
        type: "tasksMutate",
        reqId: "o3",
        mutation: { op: "update", taskId: "task-a", status: "finished" },
      });
      other.receive({
        type: "tasksMutate",
        reqId: "o4",
        mutation: { op: "delete", taskId: "task-a" },
      });

      for (const reqId of ["o1", "o2", "o3", "o4"]) {
        expect(other.answerTo(reqId)).toMatchObject({
          type: "error",
          code: SESSION_LOCKED_ERROR_CODE,
        });
      }
      // Refused, not merely reported as failed: nothing reached the Core.
      expect(core.writes).toHaveLength(0);
      expect(core.kills).toHaveLength(0);
      expect(mutationPort.mutations).toHaveLength(0);
    });

    it("tells 'locked by someone else' apart from 'that Session is gone'", async () => {
      const holder = connect();
      const other = connect();
      const ptyId = await spawn(holder, "task-a");
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });

      other.receive({ type: "write", reqId: "locked", ptyId, data: "x" });
      other.receive({ type: "write", reqId: "gone", ptyId: "pty-vanished", data: "x" });
      other.receive({ type: "kill", reqId: "gone-kill", ptyId: "pty-vanished" });

      // The two answers are different frames, so a client never has to read
      // prose to know which happened — and only one of the two is worth
      // retrying after a claim.
      expect(other.answerTo("locked")).toMatchObject({
        type: "error",
        code: SESSION_LOCKED_ERROR_CODE,
      });
      expect(other.answerTo("gone")).toMatchObject({ type: "writeResult", ok: false });
      expect(other.answerTo("gone-kill")).toMatchObject({ type: "killResult", ok: false });
    });

    it("serves a mutation on an unlocked Session — a client that never claims is untouched", async () => {
      // The D11 compatibility promise, as a test: an old client "never claims,
      // and never notices it is no longer evicting anybody". If an unlocked
      // Session refused mutations, the capability's absence would yield
      // something *lesser* than today rather than exactly today.
      const ws = connect();
      const ptyId = await spawn(ws, "task-a");

      ws.receive({ type: "write", reqId: "w1", ptyId, data: "hello" });
      ws.receive({
        type: "tasksMutate",
        reqId: "m1",
        mutation: { op: "update", taskId: "task-a", status: "running" },
      });

      expect(ws.answerTo("w1")).toMatchObject({ type: "writeResult", ok: true });
      expect(ws.answerTo("m1")).toMatchObject({ type: "tasksMutateResult" });
      expect(core.writes).toEqual([{ ptyId, data: "hello" }]);
    });

    it("never lets a refused mutation acquire the lock (D6)", async () => {
      const holder = connect();
      const other = connect();
      const ptyId = await spawn(holder, "task-a");
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });

      other.receive({ type: "write", reqId: "o1", ptyId, data: "x" });
      other.receive({ type: "write", reqId: "o2", ptyId, data: "x" });

      // Not on the second attempt either. First-mutation-claims was rejected
      // precisely so one keystroke in a stray tab cannot take a Session.
      expect(other.answerTo("o2")).toMatchObject({ code: SESSION_LOCKED_ERROR_CODE });
      expect(server.sessionLockCount()).toBe(1);
    });

    it("lets the holder start another Session while holding one", async () => {
      // `create` names no existing Session, so there is none for the lock to
      // refuse it by. An automation holding one Session must still be able to
      // start the next.
      const holder = connect();
      const other = connect();
      await spawn(holder, "task-a");
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });

      other.receive({
        type: "tasksMutate",
        reqId: "o1",
        mutation: { op: "create", projectId: "p1", title: "new", agent: "claude-code" },
      });

      expect(other.answerTo("o1")).toMatchObject({ type: "tasksMutateResult" });
    });
  });

  // ── The mutations D4 does not name in so many words ───────────────────────
  //
  // Neither of these appears in D4's list, and both are gated: one because it
  // lands on the task row through the same writer a gated `tasksMutate` uses,
  // the other because it starts a second process on a Session somebody else is
  // driving. The ADR's consequences record both readings.
  describe("harnessPrompt is a task mutation, whatever it reads like", () => {
    it("refuses a prompt aimed at a Session another connection holds", async () => {
      // It reaches the title generator, which writes the row's title through
      // the same writer a gated `tasksMutate` uses — so a connection holding
      // nothing must not rename a Session another connection is driving.
      const holder = connect();
      const other = connect();
      await spawn(holder, "task-a");
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });

      other.receive({ type: "harnessPrompt", reqId: "o1", taskId: "task-a", prompt: "rename me" });

      expect(other.answerTo("o1")).toMatchObject({
        type: "error",
        code: SESSION_LOCKED_ERROR_CODE,
      });
      // Refused, not accepted-and-ignored: nothing reached the generator.
      expect(promptPort.submitted).toHaveLength(0);
    });

    it("serves it for the holder, and on a Session nobody holds", async () => {
      // The other half of the gate, and the D11 promise for this frame too: a
      // client that never claims goes on submitting prompts exactly as today.
      const holder = connect();
      const stranger = connect();
      await spawn(holder, "task-a");
      await spawn(stranger, "task-b");
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });

      holder.receive({ type: "harnessPrompt", reqId: "h2", taskId: "task-a", prompt: "mine" });
      stranger.receive({ type: "harnessPrompt", reqId: "s1", taskId: "task-b", prompt: "unheld" });

      expect(holder.answerTo("h2")).toMatchObject({ type: "harnessPromptResult", accepted: true });
      expect(stranger.answerTo("s1")).toMatchObject({
        type: "harnessPromptResult",
        accepted: true,
      });
      expect(promptPort.submitted).toEqual([
        { taskId: "task-a", prompt: "mine" },
        { taskId: "task-b", prompt: "unheld" },
      ]);
    });
  });

  describe("spawn against a Session another connection holds", () => {
    it("is refused before a second process exists", async () => {
      // Two harnesses in one worktree is the interference the lock exists for,
      // not a lesser cousin of it. And the `resize` reading does not transfer:
      // the refusing connection could not have typed into the PTY it was
      // asking for anyway, since the lock is keyed by taskId for every PTY kind.
      const holder = connect();
      const other = connect();
      await spawn(holder, "task-a");
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });

      other.receive({
        type: "spawn",
        reqId: "o1",
        opts: { taskId: "task-a", cwd: "/w", command: "c" },
      });

      expect(other.answerTo("o1")).toMatchObject({
        type: "error",
        code: SESSION_LOCKED_ERROR_CODE,
      });
      // Refused rather than spawned-and-reported: the Core never started one.
      expect(core.spawns).toEqual(["task-a"]);
      expect(other.ofType("spawned")).toHaveLength(0);
    });

    it("still starts a Session nobody holds, from any connection (D5)", async () => {
      // The creator gets no privilege, and gains no obligation either: a
      // Session starts unlocked and anybody may spawn into it. A connection
      // holding one Session can also start the next, the same carve-out
      // `tasksMutate`'s `create` has.
      const holder = connect();
      const other = connect();
      await spawn(holder, "task-a");
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });

      const strangerPty = await spawn(other, "task-b");
      const nextPty = await spawn(holder, "task-c");

      expect(strangerPty).not.toBe(nextPty);
      expect(core.spawns).toEqual(["task-a", "task-b", "task-c"]);
      expect(server.sessionLockCount()).toBe(1);
    });
  });

  // ── Done when: two connections drive two Sessions concurrently ────────────
  describe("two connections, two Sessions, one Core", () => {
    it("lets each drive its own with no interference (D4 — not Core-wide)", async () => {
      const cli = connect();
      const panel = connect();
      const ptyA = await spawn(cli, "task-a");
      const ptyB = await spawn(panel, "task-b");

      cli.receive({ type: "claim", reqId: "c1", taskId: "task-a" });
      panel.receive({ type: "claim", reqId: "p1", taskId: "task-b" });
      expect(cli.answerTo("c1")).toMatchObject({ granted: true });
      expect(panel.answerTo("p1")).toMatchObject({ granted: true });

      cli.receive({ type: "write", reqId: "c2", ptyId: ptyA, data: "a" });
      panel.receive({ type: "write", reqId: "p2", ptyId: ptyB, data: "b" });
      expect(cli.answerTo("c2")).toMatchObject({ type: "writeResult", ok: true });
      expect(panel.answerTo("p2")).toMatchObject({ type: "writeResult", ok: true });

      // Each is a Reader of the other's Session: it may watch, and may not write.
      cli.receive({ type: "write", reqId: "c3", ptyId: ptyB, data: "stray" });
      panel.receive({ type: "write", reqId: "p3", ptyId: ptyA, data: "stray" });
      expect(cli.answerTo("c3")).toMatchObject({ code: SESSION_LOCKED_ERROR_CODE });
      expect(panel.answerTo("p3")).toMatchObject({ code: SESSION_LOCKED_ERROR_CODE });
      expect(core.writes).toEqual([
        { ptyId: ptyA, data: "a" },
        { ptyId: ptyB, data: "b" },
      ]);
    });
  });

  // ── Done when: dropping the holding connection releases its locks. All. ───
  describe("a lock dies with its connection (D7)", () => {
    it("releases every Session the dropped connection held, not just one", async () => {
      const holder = connect();
      const other = connect();
      const ptyA = await spawn(holder, "task-a");
      const ptyB = await spawn(holder, "task-b");
      const ptyC = await spawn(holder, "task-c");
      for (const taskId of ["task-a", "task-b", "task-c"]) {
        holder.receive({ type: "claim", reqId: `h-${taskId}`, taskId });
      }
      expect(server.sessionLockCount()).toBe(3);

      holder.close();

      expect(server.sessionLockCount()).toBe(0);
      for (const [i, ptyId] of [ptyA, ptyB, ptyC].entries()) {
        other.receive({ type: "write", reqId: `o${i}`, ptyId, data: "x" });
        expect(other.answerTo(`o${i}`)).toMatchObject({ type: "writeResult", ok: true });
      }
    });

    it("leaves another connection's locks alone when one drops", async () => {
      const a = connect();
      const b = connect();
      const ptyB = await spawn(b, "task-b");
      await spawn(a, "task-a");
      a.receive({ type: "claim", reqId: "a1", taskId: "task-a" });
      b.receive({ type: "claim", reqId: "b1", taskId: "task-b" });

      a.close();

      expect(server.sessionLockCount()).toBe(1);
      b.receive({ type: "write", reqId: "b2", ptyId: ptyB, data: "x" });
      expect(b.answerTo("b2")).toMatchObject({ type: "writeResult", ok: true });
    });

    it("releases the locks of a heartbeat-reaped connection too", async () => {
      // The stale-connection case ADR 0024 D7 calls out: the socket is still
      // open, the client is gone, and the heartbeat terminates it. That path
      // ends in the same `close` the graceful one does, which is why the sweep
      // lives there and not beside each individual disconnect reason.
      const holder = connect();
      const other = connect();
      const ptyId = await spawn(holder, "task-a");
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });

      holder.emit("close");

      other.receive({ type: "write", reqId: "o1", ptyId, data: "x" });
      expect(other.answerTo("o1")).toMatchObject({ type: "writeResult", ok: true });
    });
  });

  // ── Done when: force takeover transfers immediately ───────────────────────
  describe("force takeover (D7 — the hung-client ending)", () => {
    it("transfers the lock immediately and refuses the previous holder's next mutation", async () => {
      const stuck = connect();
      const rescuer = connect();
      const ptyId = await spawn(stuck, "task-a");
      stuck.receive({ type: "claim", reqId: "s1", taskId: "task-a" });

      rescuer.receive({ type: "forceTakeover", reqId: "r1", taskId: "task-a" });

      expect(rescuer.answerTo("r1")).toMatchObject({
        type: "forceTakeoverResult",
        takenFrom: "another-connection",
      });
      // Immediately: the very next mutation, with nothing in between.
      stuck.receive({ type: "write", reqId: "s2", ptyId, data: "x" });
      expect(stuck.answerTo("s2")).toMatchObject({ code: SESSION_LOCKED_ERROR_CODE });
      rescuer.receive({ type: "write", reqId: "r2", ptyId, data: "y" });
      expect(rescuer.answerTo("r2")).toMatchObject({ type: "writeResult", ok: true });
    });

    it("says when it took an unheld Session from nobody", async () => {
      const ws = connect();
      await spawn(ws, "task-a");
      ws.receive({ type: "forceTakeover", reqId: "f1", taskId: "task-a" });
      // Taking an unlocked Session is an ordinary claim by another name, and a
      // client should not report having evicted someone when it did not.
      expect(ws.answerTo("f1")).toMatchObject({ takenFrom: "nobody" });
    });

    it("leaves the loser able to claim again once the winner releases", async () => {
      const loser = connect();
      const winner = connect();
      await spawn(loser, "task-a");
      loser.receive({ type: "claim", reqId: "l1", taskId: "task-a" });
      winner.receive({ type: "forceTakeover", reqId: "w1", taskId: "task-a" });
      winner.receive({ type: "release", reqId: "w2", taskId: "task-a" });

      loser.receive({ type: "claim", reqId: "l2", taskId: "task-a" });

      expect(loser.answerTo("l2")).toMatchObject({ granted: true });
    });
  });

  // ── Done when: the D5 window ──────────────────────────────────────────────
  describe("the D5 window — a Session starts unlocked and its creator gets no privilege", () => {
    it("lets a second connection claim a Session the first started and did not claim", async () => {
      const creator = connect();
      const second = connect();
      const ptyId = await spawn(creator, "task-a");

      // The creator gets nothing for having spawned it. This window is the
      // claim race, and it is accepted rather than closed: closing it means
      // reintroducing creator privilege, which was decided against.
      expect(server.sessionLockCount()).toBe(0);

      second.receive({ type: "claim", reqId: "s1", taskId: "task-a" });

      expect(second.answerTo("s1")).toMatchObject({ granted: true });
      creator.receive({ type: "write", reqId: "c1", ptyId, data: "x" });
      expect(creator.answerTo("c1")).toMatchObject({ code: SESSION_LOCKED_ERROR_CODE });
    });

    it("gives the creator the lock only when it asks — and it can lose the race", async () => {
      const creator = connect();
      const rival = connect();
      await spawn(creator, "task-a");

      rival.receive({ type: "claim", reqId: "r1", taskId: "task-a" });
      creator.receive({ type: "claim", reqId: "c1", taskId: "task-a" });

      expect(rival.answerTo("r1")).toMatchObject({ granted: true });
      expect(creator.answerTo("c1")).toMatchObject({ granted: false });
    });
  });

  // ── The traps ─────────────────────────────────────────────────────────────
  describe("no idle timeout (D7)", () => {
    it("holds the lock through a long silent agent run", async () => {
      vi.useFakeTimers();
      const holder = connect();
      const other = connect();
      const ptyId = await spawn(holder, "task-a");
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });

      // Far past every timer in this server, including the 45s heartbeat
      // timeout. A long agent run is idle by definition: no mutation for many
      // minutes is the success case, not the abandoned one.
      await vi.advanceTimersByTimeAsync(30 * 60_000);

      expect(server.sessionLockCount()).toBe(1);
      other.receive({ type: "write", reqId: "o1", ptyId, data: "x" });
      expect(other.answerTo("o1")).toMatchObject({ code: SESSION_LOCKED_ERROR_CODE });
    });
  });

  describe("the Core never refuses itself", () => {
    it("leaves PtyCore's own kill ungated for its non-Session callers", async () => {
      // `kill` has callers inside the Core — the PTY exit paths, the task
      // writer — that hold no lock and are nobody's client. The gate is on the
      // client-facing frame; `PtyCore.kill` is untouched, so the Core can still
      // tear down a Session another client holds.
      const holder = connect();
      const ptyId = await spawn(holder, "task-a");
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });

      expect(core.core.kill(ptyId)).toBe(true);
      expect(core.kills).toEqual([ptyId]);
    });

    it("leaves killLaunchProcesses ungated — it is addressed at a folder, not a Session", async () => {
      const holder = connect();
      const other = connect();
      await spawn(holder, "task-a");
      holder.receive({ type: "claim", reqId: "h1", taskId: "task-a" });

      other.receive({
        type: "killLaunchProcesses",
        reqId: "o1",
        cwd: "/w",
        commands: ["npm run dev"],
      });

      await vi.waitFor(() =>
        expect(other.answerTo("o1")).toMatchObject({ type: "killLaunchProcessesResult" }),
      );
    });
  });

  describe("a VM Shell Session is locked by the same rule", () => {
    it("refuses another connection's write to a claimed VM Shell Session", async () => {
      // ADR 0024 records this as an assumption that was never separately
      // decided, and this ticket is the one that touches it: `write`/`kill`
      // resolve a `ptyId` to the Task it was spawned for whatever kind of PTY it
      // is, so a VM Shell Session is claimable and gated exactly like a harness
      // Session. Flagged for confirmation (or a D4 amendment) on the PR.
      const holder = connect();
      const other = connect();
      holder.receive({
        type: "spawn",
        reqId: "vm",
        opts: { shellSession: true, taskId: "term_vm_1", command: "" },
      });
      await vi.waitFor(() => expect(holder.ofType("spawned").length).toBeGreaterThan(0));
      const ptyId = String(holder.ofType("spawned").at(-1)!.ptyId);
      holder.receive({ type: "claim", reqId: "h1", taskId: "term_vm_1" });

      other.receive({ type: "write", reqId: "o1", ptyId, data: "x" });

      expect(other.answerTo("o1")).toMatchObject({ code: SESSION_LOCKED_ERROR_CODE });
    });
  });

  describe("locks die with the Core (D12)", () => {
    it("holds nothing after the server closes", async () => {
      const ws = connect();
      await spawn(ws, "task-a");
      ws.receive({ type: "claim", reqId: "c1", taskId: "task-a" });

      server.close();

      expect(server.sessionLockCount()).toBe(0);
    });
  });
});
