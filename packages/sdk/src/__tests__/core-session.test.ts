// The session layer against the Core's own server (issue 155).
//
// The rig is the one the transport suites use — a real `PtyCoreLinkServer` over
// a fake socket — so what is asserted below is the agreement with the Core
// rather than with a stand-in that answers whatever this file expects. What is
// faked is the PTY manager behind it (there is no harness to run in a unit test)
// and the Core's task store, which is where a Session's status lives.
//
// The properties worth reading this file for:
//
//   - the spawn frame carries the prompt as text and **no timing** with it;
//   - the byte stream is wired before the spawn is answered, so a harness's
//     banner is in the transcript rather than lost in the round trip;
//   - `send` writes exactly its argument and appends nothing;
//   - idleness comes from the Core's status, not from the stream going quiet;
//   - a Core's rejection is surfaced, never pre-empted;
//   - nothing in the shipped package touches a terminal (D11).

import { describe, it, expect, afterEach, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  CoreMutationPort,
  WebSocketServerLike,
} from "@actana/core/pty-core-link-server";
import { PtyCoreLinkServer } from "@actana/core/pty-core-link-server";
import type { PtyCore, PtyCoreEvent } from "@actana/core/pty-manager";
import type {
  CoreLinkProjectMutation,
  CoreLinkProjectSnapshot,
  CoreLinkSessionSnapshot,
  CoreLinkTaskMutation,
  CoreLinkTaskSnapshot,
} from "../core-link-frames.ts";
import type { CoreLinkSocket } from "../core-link-socket.ts";
import { signBearer, verifyBearer } from "@actana/shared/core-link-bearer";
import { CoreClient } from "../core-client.ts";
import {
  CORE_LINK_LOST_GRACE_MS,
  CoreSession,
  CoreSessionAttachError,
  CoreSessionLinkLostError,
  CoreSessionStartError,
  CoreSessionTurnTimeoutError,
  HARNESS_LAUNCH_COMMANDS,
  STATUS_READ_RETRIES,
  STATUS_READ_RETRY_MS,
} from "../core-session.ts";
import {
  FakeEventLog,
  FakeSocket,
  FakeSocketPair,
  FakeSocketServer,
  makeMockPtyCore,
} from "./fake-core-link.ts";
import { CORE_LINK_PROTOCOL_VERSION } from "../core-link-frames.ts";

const ESC = "\u001B";
const CSI = `${ESC}[`;
const PROJECT_ID = "p-1";

/**
 * The Core's task store, in memory: create a row, patch its status, list the
 * Sessions — and append the event a patch produces, because that event is the
 * whole of how a client learns a harness stopped. The real port
 * (`core-task-writer.ts`) appends exactly these two kinds.
 */
class FakeTaskStore implements CoreMutationPort {
  readonly tasks = new Map<string, CoreLinkTaskSnapshot>();
  private seq = 0;

  constructor(private readonly eventLog: FakeEventLog) {}

  mutateProject(mutation: CoreLinkProjectMutation): CoreLinkProjectSnapshot | null {
    void mutation;
    return null;
  }

  mutateTask(mutation: CoreLinkTaskMutation): CoreLinkTaskSnapshot | null {
    if (mutation.op === "create") {
      if (mutation.projectId !== PROJECT_ID) return null;
      const taskId = mutation.taskId ?? `t-${++this.seq}`;
      const task: CoreLinkTaskSnapshot = {
        taskId,
        projectId: mutation.projectId,
        title: mutation.title,
        titleManuallySet: false,
        claudeSessionId: null,
        agent: mutation.agent,
        status: mutation.status ?? "ready",
        pinned: false,
        archived: false,
        icon: null,
        updatedAt: 1,
      };
      this.tasks.set(taskId, task);
      this.eventLog.appendEvent("task:created", JSON.stringify({ taskId }), { taskId });
      return task;
    }
    if (mutation.op === "delete") {
      this.tasks.delete(mutation.taskId);
      return null;
    }
    const existing = this.tasks.get(mutation.taskId);
    if (!existing) return null;
    const previousStatus = existing.status;
    const next: CoreLinkTaskSnapshot = {
      ...existing,
      ...(mutation.status ? { status: mutation.status } : {}),
      ...(mutation.title ? { title: mutation.title } : {}),
      updatedAt: existing.updatedAt + 1,
    };
    this.tasks.set(next.taskId, next);
    // The **patched** status rides in the payload, as `core-task-writer.ts`
    // appends it: it is what tells a waiter that this event reported a turn
    // rather than a rename, and a fake that dropped it would let a wait pass
    // here and hang against a Core.
    this.eventLog.appendEvent(
      "task:updated",
      JSON.stringify({
        taskId: next.taskId,
        ...(mutation.status === undefined ? {} : { status: mutation.status }),
      }),
      { taskId: next.taskId },
    );
    if (next.status === "finished" && previousStatus !== "finished") {
      this.eventLog.appendEvent("session:finished", JSON.stringify({ id: next.taskId }), {
        taskId: next.taskId,
      });
    }
    return next;
  }

  listSessions(): CoreLinkSessionSnapshot[] {
    return [...this.tasks.values()].map((t) => ({
      taskId: t.taskId,
      ptyId: null,
      status: t.status,
      updatedAt: t.updatedAt,
    }));
  }

  /** What the Core's hook pipeline does when a harness reports its lifecycle. */
  setStatus(taskId: string, status: string): void {
    this.mutateTask({ op: "update", taskId, status });
  }

  /** A row change that is not a turn — what the title generator does (issue 84). */
  rename(taskId: string, title: string): void {
    this.mutateTask({ op: "update", taskId, title });
  }

  /**
   * A status change the event does not name: the row moves and the event says
   * only that it moved.
   *
   * The shape a Core too old to name the patched status sends (#289 A), and the
   * one route by which a status still reaches a client through a read rather
   * than through the event that announced it.
   */
  setStatusSilently(taskId: string, status: string): void {
    const existing = this.tasks.get(taskId);
    if (!existing) return;
    this.tasks.set(taskId, { ...existing, status, updatedAt: existing.updatedAt + 1 });
    this.eventLog.appendEvent("task:updated", JSON.stringify({ taskId }), { taskId });
  }
}

type Rig = {
  client: CoreClient;
  ptyCore: PtyCore & { emitEvent: (e: PtyCoreEvent) => void };
  tasks: FakeTaskStore;
  eventLog: FakeEventLog;
  /** Every connection this rig has handed out, in dial order. */
  pairs: FakeSocketPair[];
  /** The link dies the way a reaped NAT flow or a restarted Core kills it (#396). */
  drop: () => void;
  close: () => void;
};

function startRig(
  opts: {
    announceMultiConnection?: boolean;
    spawn?: PtyCore["spawn"];
    /**
     * Arm the Core's auth gate and give the client a bearer, so a connection is
     * not usable until `authOk` lands. The remote shape rather than the
     * loopback one — what #492's blocking 2 is about (`ready` arrives first, and
     * is not the link coming back).
     */
    authVerifier?: (bearer: string) =>
      | { ok: true; coreId: string; exp: number }
      | { ok: false; reason: "expired" | "bad-signature" | "malformed" };
    bearer?: string;
    /**
     * Take over a dial. Called with the 0-based dial number; return a socket to
     * hand the client instead of a connection to this rig's Core, or null to
     * dial the Core as usual. How a test stages a connection the Core never
     * accepts.
     */
    dial?: (n: number) => CoreLinkSocket | null;
    /**
     * Called after the server has written a frame, in the same synchronous
     * turn. Node's `ws` emits several `message` events from one socket read, so
     * this is how a test reproduces two frames reaching the client before its
     * microtasks run — the exact window the held-bytes buffer exists for.
     */
    afterServerFrame?: (frame: Record<string, unknown>, rig: () => Rig) => void;
  } = {},
): Rig {
  const ptyCore = makeMockPtyCore();
  if (opts.spawn) ptyCore.spawn = opts.spawn;
  const eventLog = new FakeEventLog();
  const tasks = new FakeTaskStore(eventLog);
  // The Core stamps a delivery with the Task behind the PTY (#289 A), and the
  // shared fake answers `null` — every Session in this suite runs on `pty-1`,
  // so the newest row is the one it belongs to.
  ptyCore.taskIdForPty = vi.fn((ptyId: string) =>
    ptyId === "pty-1" ? ([...tasks.tasks.keys()].at(-1) ?? null) : null,
  ) as unknown as typeof ptyCore.taskIdForPty;
  const wss = new FakeSocketServer();
  const server = new PtyCoreLinkServer(ptyCore, {
    port: 0,
    createServer: () => wss as unknown as WebSocketServerLike,
    eventLog,
    mutationPort: tasks,
    liveEventPollMs: 5,
    ...(opts.announceMultiConnection === undefined
      ? {}
      : { announceMultiConnection: opts.announceMultiConnection }),
    ...(opts.authVerifier ? { authVerifier: opts.authVerifier } : {}),
  });
  const pairs: FakeSocketPair[] = [];
  let dials = 0;
  const client = new CoreClient({
    url: "wss://core.test:9444",
    ...(opts.bearer ? { bearer: opts.bearer } : {}),
    createSocket: () => {
      const staged = opts.dial?.(dials++) ?? null;
      if (staged) return staged;
      const pair = new FakeSocketPair();
      pairs.push(pair);
      if (opts.afterServerFrame) {
        const send = pair.server.send.bind(pair.server);
        pair.server.send = (data: string) => {
          send(data);
          opts.afterServerFrame!(JSON.parse(data) as Record<string, unknown>, () => built);
        };
      }
      wss.accept(pair.server);
      queueMicrotask(() => pair.open());
      return pair.client.asClientSocket();
    },
  });
  const built: Rig = {
    client,
    ptyCore,
    tasks,
    eventLog,
    pairs,
    drop: () => pairs[pairs.length - 1]?.server.close(),
    close: () => server.close(),
  };
  return built;
}

let rig: Rig | null = null;
let session: CoreSession | null = null;

afterEach(() => {
  session?.dispose();
  session = null;
  rig?.client.close();
  rig?.close();
  rig = null;
});

async function startSession(
  r: Rig,
  overrides: Partial<Parameters<typeof CoreSession.start>[1]> = {},
): Promise<CoreSession> {
  await r.client.connect();
  return CoreSession.start(r.client, {
    projectId: PROJECT_ID,
    cwd: "/home/op/projects/thing",
    harness: "claude-code",
    prompt: "summarise this repo",
    cols: 40,
    rows: 6,
    ...overrides,
  });
}

describe("CoreSession.start", () => {
  it("creates the Task, spawns the harness, and hands the prompt over as text", async () => {
    rig = startRig();
    session = await startSession(rig);

    expect(rig.tasks.tasks.size).toBe(1);
    const spawn = vi.mocked(rig.ptyCore.spawn).mock.calls[0]?.[0];
    expect(spawn).toMatchObject({
      taskId: session.taskId,
      cwd: "/home/op/projects/thing",
      command: HARNESS_LAUNCH_COMMANDS["claude-code"],
      agent: "claude-code",
      cols: 40,
      rows: 6,
      initialInput: "summarise this repo",
    });
    expect(session.ptyId).toBe("pty-1");
  });

  it("sends no timing with the prompt — there is no field for one", async () => {
    // ADR 0026: a Core client supplies text and never a delay, a ready-signal or
    // a retry. The assertion is the *absence* of anything else, because the
    // failure this guards against is a future option that looks helpful.
    rig = startRig();
    session = await startSession(rig);

    const spawn = vi.mocked(rig.ptyCore.spawn).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(spawn).sort()).toEqual(
      ["agent", "cols", "command", "cwd", "initialInput", "rows", "taskId"].sort(),
    );
  });

  // ─── The turn-start signal (issue 177 finding 4) ──────────────────────
  //
  // The Core already answered this on `spawned` and the SDK threw it away, so
  // an automation had no way to learn that its cursor-cli Session would sit at
  // its pre-turn status for the whole of a turn that was genuinely running.

  it("carries the Core's turn-start answer onto the Session", async () => {
    rig = startRig({
      spawn: (async () => ({ ptyId: "pty-1", hooksReportTurnStart: true })) as PtyCore["spawn"],
    });
    session = await startSession(rig);

    expect(session.reportsTurnStart).toBe(true);
  });

  it("reports no turn-start when the Core says a harness does not report one", async () => {
    // cursor-cli's answer today: the Core writes `.cursor/hooks.json` and
    // cursor-agent never fires `beforeSubmitPrompt`.
    rig = startRig({
      spawn: (async () => ({ ptyId: "pty-1", hooksReportTurnStart: false })) as PtyCore["spawn"],
    });
    session = await startSession(rig, { harness: "cursor-cli" });

    expect(session.reportsTurnStart).toBe(false);
  });

  it("reads a Core that answers nothing at all as no turn-start", async () => {
    // The safe direction on an older Core: a redundant caveat, never a Session
    // that silently looks idle for its whole life.
    rig = startRig({
      spawn: (async () => ({ ptyId: "pty-1" })) as unknown as PtyCore["spawn"],
    });
    session = await startSession(rig);

    expect(session.reportsTurnStart).toBe(false);
  });

  it("starts a Session with no prompt when none was given", async () => {
    rig = startRig();
    session = await startSession(rig, { prompt: undefined });

    const spawn = vi.mocked(rig.ptyCore.spawn).mock.calls[0]?.[0] as Record<string, unknown>;
    expect("initialInput" in spawn).toBe(false);
  });

  it("uses an existing Task when handed one, and creates nothing", async () => {
    rig = startRig();
    await rig.client.connect();
    const created = await rig.client.tasksMutate({
      op: "create",
      projectId: PROJECT_ID,
      title: "mine",
      agent: "claude-code",
    });

    session = await startSession(rig, { projectId: undefined, taskId: created!.taskId });

    expect(session.taskId).toBe(created!.taskId);
    expect(rig.tasks.tasks.size).toBe(1);
  });

  it("appends the harness's skip-permissions flag to the command it defaults to", async () => {
    rig = startRig();
    session = await startSession(rig, { dangerouslySkipPermissions: true });

    const spawn = vi.mocked(rig.ptyCore.spawn).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(spawn.command).toBe("claude --dangerously-skip-permissions");
    expect(spawn.dangerouslySkipPermissions).toBe(true);
  });

  it("refuses to start without a Project or a Task to start against", async () => {
    rig = startRig();
    await rig.client.connect();

    await expect(
      CoreSession.start(rig.client, { cwd: "/x", harness: "claude-code" }),
    ).rejects.toBeInstanceOf(CoreSessionStartError);
  });

  it("surfaces the Core's rejection rather than pre-empting it", async () => {
    // The working-directory check, the argv[0] check and the flag allow-list are
    // the Core's: they read a database and a filesystem this process is not on.
    // What this asserts is that the spawn was *attempted* and the Core's own
    // reason came back — a client that had refused locally would never have
    // reached the server, and would be guessing.
    rig = startRig({
      spawn: vi.fn(async () => {
        throw new Error("pty:spawn rejected (cwd-outside-project-roots)");
      }) as unknown as PtyCore["spawn"],
    });

    const start = startSession(rig, { cwd: "/etc" });

    await expect(start).rejects.toThrow(/cwd-outside-project-roots/);
    await expect(start).rejects.toBeInstanceOf(CoreSessionStartError);
    expect(rig.ptyCore.spawn).toHaveBeenCalledTimes(1);
  });

  it("keeps the bytes that arrived before the spawn was answered", async () => {
    // A harness prints its banner immediately, and the Core subscribes the
    // spawning connection to the PTY before it answers (issue 142) — so the
    // first bytes can reach this side in the same read as the answer, while the
    // promise carrying the PTY's id is still a queued microtask. Held and
    // replayed, so the transcript starts at the beginning rather than wherever
    // the round trip happened to end.
    let banner = false;
    rig = startRig({
      afterServerFrame: (frame, rig2) => {
        if (frame.type !== "spawned" || banner) return;
        banner = true;
        rig2().ptyCore.emitEvent({
          type: "data",
          ptyId: String(frame.ptyId),
          data: "banner line\r\n",
          seq: 1,
        });
      },
    });

    session = await startSession(rig);

    expect(banner).toBe(true);
    expect(session.screen()).toContain("banner line");
  });

  it("keeps its own exit when a co-tenant PTY exits in the same window", async () => {
    // The exit listener hears every PTY this connection holds, and during the
    // spawn's round trip it cannot yet filter by id — the id is what has not
    // come back. So the frames are held like the bytes are, all of them: a
    // Session that started while another one was dying used to lose its own
    // exit to the co-tenant's, leaving `onExit` silent and `waitForIdle` short
    // an exit route.
    let spawned = 0;
    rig = startRig({
      spawn: vi.fn(async () => ({ ptyId: `pty-${++spawned}` })) as unknown as PtyCore["spawn"],
      afterServerFrame: (frame, rig2) => {
        if (frame.type !== "spawned" || frame.ptyId !== "pty-2") return;
        // The co-tenant first, so a hold with one slot is already full when
        // this Session's own exit arrives behind it.
        rig2().ptyCore.emitEvent({ type: "exit", ptyId: "pty-1", exitCode: 0 });
        rig2().ptyCore.emitEvent({ type: "exit", ptyId: "pty-2", exitCode: 7, signal: 15 });
      },
    });
    const cotenant = await startSession(rig);

    session = await startSession(rig);

    expect(cotenant.ptyId).toBe("pty-1");
    expect(session.ptyId).toBe("pty-2");
    expect(session.exitStatus()).toEqual({ exitCode: 7, signal: 15 });
    await expect(session.waitForIdle()).resolves.toMatchObject({ exited: true, exitCode: 7 });
    cotenant.dispose();
  });
});

describe("programmatic I/O", () => {
  it("renders what a terminal would be showing, scrolled-off lines included", async () => {
    rig = startRig();
    session = await startSession(rig);
    const r = rig;
    // Six rows of viewport, ten lines of output: four of them are only in the
    // scrollback, which is exactly where a transcript lives.
    for (let i = 1; i <= 10; i += 1) {
      r.ptyCore.emitEvent({ type: "data", ptyId: "pty-1", data: `answer ${i}\r\n`, seq: i });
    }
    await vi.waitFor(() => expect(session!.screen()).toContain("answer 10"));

    expect(session.screen()).toContain("answer 1");
    expect(session.viewport()).not.toContain("answer 1\n");
    expect(session.lines().filter((l) => l.startsWith("answer"))).toHaveLength(10);
  });

  it("reads a screen a harness positioned with cursor moves", async () => {
    rig = startRig();
    session = await startSession(rig);
    const r = rig;
    r.ptyCore.emitEvent({
      type: "data",
      ptyId: "pty-1",
      data: `${CSI}2;4HDone.${CSI}1;1H${CSI}2Kheader`,
      seq: 1,
    });

    await vi.waitFor(() => expect(session!.screen()).toContain("Done."));
    expect(session.screen().split("\n")[0]).toBe("header");
    expect(session.screen().split("\n")[1]).toBe("   Done.");
  });

  it("ignores another Session's PTY on the same link", async () => {
    rig = startRig();
    session = await startSession(rig);
    const r = rig;
    r.ptyCore.emitEvent({ type: "data", ptyId: "pty-other", data: "not mine\r\n", seq: 1 });
    r.ptyCore.emitEvent({ type: "data", ptyId: "pty-1", data: "mine\r\n", seq: 2 });

    await vi.waitFor(() => expect(session!.screen()).toContain("mine"));
    expect(session.screen()).not.toContain("not mine");
  });

  it("hands every chunk to a data listener, escape sequences and all", async () => {
    rig = startRig();
    session = await startSession(rig);
    const chunks: string[] = [];
    session.onData((c) => chunks.push(c));
    rig.ptyCore.emitEvent({ type: "data", ptyId: "pty-1", data: `${CSI}31mred`, seq: 1 });

    await vi.waitFor(() => expect(chunks).toHaveLength(1));
    expect(chunks[0]).toBe(`${CSI}31mred`);
  });

  it("writes exactly what it is given and appends nothing", async () => {
    // Not even a carriage return. Deciding when to press Enter is prompt
    // delivery, prompt delivery is the Core's (ADR 0026), and a client that did
    // it here would do it differently from every other client.
    rig = startRig();
    session = await startSession(rig);

    await session.send("2");

    expect(rig.ptyCore.write).toHaveBeenCalledWith("pty-1", "2");
    expect(vi.mocked(rig.ptyCore.write).mock.calls).toHaveLength(1);
  });

  it("resizes the PTY and the screen together", async () => {
    rig = startRig();
    session = await startSession(rig);

    await session.resize(20, 4);

    expect(rig.ptyCore.resize).toHaveBeenCalledWith("pty-1", 20, 4);
    const r = rig;
    r.ptyCore.emitEvent({
      type: "data",
      ptyId: "pty-1",
      data: "123456789012345678901234567890",
      seq: 1,
    });
    // Twenty columns wide now, so thirty characters is two lines.
    await vi.waitFor(() => expect(session!.screen().split("\n")).toHaveLength(2));
  });

  it("stops advancing once disposed and leaves the harness alone", async () => {
    rig = startRig();
    session = await startSession(rig);
    const r = rig;
    r.ptyCore.emitEvent({ type: "data", ptyId: "pty-1", data: "before\r\n", seq: 1 });
    await vi.waitFor(() => expect(session!.screen()).toContain("before"));

    session.dispose();
    r.ptyCore.emitEvent({ type: "data", ptyId: "pty-1", data: "after\r\n", seq: 2 });
    await new Promise((r2) => setTimeout(r2, 20));

    expect(session.screen()).not.toContain("after");
    expect(r.ptyCore.kill).not.toHaveBeenCalled();
  });
});

describe("waiting on the Core's report", () => {
  it("resolves when the Core says the turn finished", async () => {
    rig = startRig();
    session = await startSession(rig);
    const r = rig;
    const idle = session.waitForIdle();

    // What the harness's own Stop hook does on the Core.
    r.tasks.setStatus(session.taskId, "running");
    r.tasks.setStatus(session.taskId, "finished");

    await expect(idle).resolves.toEqual({ status: "finished", exited: false });
  });

  it("resolves on a question, because a question is not something to wait out", async () => {
    rig = startRig();
    session = await startSession(rig);
    const r = rig;
    const idle = session.waitForIdle();

    r.tasks.setStatus(session.taskId, "needs-input");

    await expect(idle).resolves.toEqual({ status: "needs-input", exited: false });
  });

  it("does not settle on the status the Task already carried", async () => {
    // A Session started on a Task that finished yesterday is waiting for this
    // turn, not being handed the last one's answer.
    rig = startRig();
    await rig.client.connect();
    const created = await rig.client.tasksMutate({
      op: "create",
      projectId: PROJECT_ID,
      title: "old",
      agent: "claude-code",
    });
    rig.tasks.setStatus(created!.taskId, "finished");

    session = await startSession(rig, { projectId: undefined, taskId: created!.taskId });
    let settled = false;
    void session.waitForIdle().then(() => {
      settled = true;
    });
    await new Promise((r2) => setTimeout(r2, 50));

    expect(settled).toBe(false);
    expect(session.status()).toBeNull();
  });

  it("reports the status as it moves", async () => {
    rig = startRig();
    session = await startSession(rig);
    const seen: string[] = [];
    session.onStatus((s) => seen.push(s));
    const r = rig;

    r.tasks.setStatus(session.taskId, "running");
    await vi.waitFor(() => expect(seen).toContain("running"));
    r.tasks.setStatus(session.taskId, "finished");
    await vi.waitFor(() => expect(seen).toContain("finished"));

    expect(seen).toEqual(["running", "finished"]);
  });

  it("resolves when the harness's process exits", async () => {
    rig = startRig();
    session = await startSession(rig);
    const r = rig;
    const idle = session.waitForIdle();

    r.ptyCore.emitEvent({ type: "exit", ptyId: "pty-1", exitCode: 2, signal: 9 });

    await expect(idle).resolves.toMatchObject({ exited: true, exitCode: 2 });
    expect(session.exitStatus()).toEqual({ exitCode: 2, signal: 9 });
  });

  it("answers straight away when the Session has already settled", async () => {
    rig = startRig();
    session = await startSession(rig);
    const r = rig;
    r.tasks.setStatus(session.taskId, "finished");
    await vi.waitFor(() => expect(session!.status()).toBe("finished"));

    await expect(session.waitForIdle()).resolves.toEqual({
      status: "finished",
      exited: false,
    });
  });

  it("gives up on a deadline the caller set, and says what it was still doing", async () => {
    rig = startRig();
    session = await startSession(rig);
    rig.tasks.setStatus(session.taskId, "running");
    await vi.waitFor(() => expect(session!.status()).toBe("running"));

    await expect(session.waitForIdle({ timeoutMs: 30 })).rejects.toThrow(/still running/);
  });

  it("settles a pending wait when the Session is disposed rather than stranding it", async () => {
    // `await session.kill()` while a `waitForIdle()` is outstanding is an
    // ordinary thing to write, and a disposed Session hears no more reports —
    // so the waiter is answered on the way out instead of left pending forever.
    rig = startRig();
    session = await startSession(rig);
    const idle = session.waitForIdle();

    session.dispose();

    await expect(idle).resolves.toMatchObject({ exited: false });
  });

  it("asks again when the status read fails, because the event will not come twice", async () => {
    // Against a Core that does not name the status it patched, a transition
    // reaches this layer as a bare `task:updated` — the event says a row moved
    // and nothing more, so the status is read back off the Core, and that event
    // is appended once. A read swallowed on the transition that mattered leaves
    // `waitForIdle()` waiting for a report already made, and by design it has no
    // deadline to end on.
    rig = startRig();
    session = await startSession(rig);
    const r = rig;
    const answer = r.client.sessionsList.bind(r.client);
    let failed = 0;
    vi.spyOn(r.client, "sessionsList").mockImplementation(async () => {
      if (failed === 0) {
        failed += 1;
        throw new Error("link dropped mid-read");
      }
      return answer();
    });
    const idle = session.waitForIdle();

    r.tasks.setStatusSilently(session.taskId, "needs-input");

    await expect(idle).resolves.toEqual({ status: "needs-input", exited: false });
    expect(failed).toBe(1);
  });

  it("stops re-asking rather than polling a Core that is gone", async () => {
    // The re-ask is bounded: a link still down after this many tries is not
    // going to be talked round by more, and a Session that asked forever would
    // be the busy-loop version of the timer #191 deleted.
    rig = startRig();
    session = await startSession(rig);
    const r = rig;
    vi.spyOn(r.client, "sessionsList").mockRejectedValue(new Error("link dropped"));

    r.tasks.setStatusSilently(session.taskId, "needs-input");

    const attempts = () => vi.mocked(r.client.sessionsList).mock.calls.length;
    await vi.waitFor(() => expect(attempts()).toBe(1 + STATUS_READ_RETRIES), { timeout: 3000 });
    await new Promise((done) => setTimeout(done, STATUS_READ_RETRY_MS * 2));
    expect(attempts()).toBe(1 + STATUS_READ_RETRIES);
  });

  it("subscribes the client to the event log when nothing else has", async () => {
    rig = startRig();
    expect(rig.client.isSubscribedToEvents()).toBe(false);

    session = await startSession(rig);

    expect(rig.client.isSubscribedToEvents()).toBe(true);
  });
});

describe("attaching to a Session that is already running (#289)", () => {
  /** A Session on the Core, started by somebody else, still on `pty-1`. */
  async function runningSession(status = "running"): Promise<string> {
    const r = rig!;
    await r.client.connect();
    const created = await r.client.tasksMutate({
      op: "create",
      projectId: PROJECT_ID,
      title: "somebody else's session",
      agent: "claude-code",
    });
    r.tasks.setStatus(created!.taskId, status);
    return created!.taskId;
  }

  it("joins a running PTY, paints its scrollback, and names none of the spawn's answers", async () => {
    rig = startRig();
    const taskId = await runningSession();

    session = await CoreSession.attach(rig.client, { taskId });

    expect(session.taskId).toBe(taskId);
    expect(session.ptyId).toBe("pty-1");
    // The Core's replay ring, so the transcript starts where the conversation
    // does rather than where this process happened to arrive.
    expect(session.screen()).toContain("scrollback");
    // An attach did not spawn, so the three answers a spawn gives are null
    // rather than plausible. `reportsTurnStart` above all: `false` would read
    // as "this harness does not report turn starts", which was never asked.
    expect(session.harness).toBeNull();
    expect(session.command).toBeNull();
    expect(session.reportsTurnStart).toBeNull();
  });

  it("refuses to attach to a Session with no harness running, rather than hanging", async () => {
    // The failure this replaces is the worst one available: a wait against a
    // Session nothing is running for has nothing that will ever report a turn,
    // so it would sit until the caller's deadline and then blame the Core.
    rig = startRig();
    const taskId = await runningSession();
    rig.ptyCore.findByTask = vi.fn(() => ({ ptyId: null })) as unknown as typeof rig.ptyCore.findByTask;

    await expect(CoreSession.attach(rig.client, { taskId })).rejects.toThrow(
      /has no harness running/,
    );
  });

  it("answers a bare wait from the status the Session is already in", async () => {
    // `actana session wait` with nothing delivered asks "tell me when this
    // Session is not working". A Session parked on a question is not working,
    // and saying so at once is the truthful answer — there is no turn in flight
    // that this could be mistaken for.
    rig = startRig();
    const taskId = await runningSession("needs-input");

    session = await CoreSession.attach(rig.client, { taskId });

    await expect(session.waitForIdle()).resolves.toEqual({
      status: "needs-input",
      exited: false,
    });
  });

  it("does not answer a delivered wait with the status the Session was already in", async () => {
    // **The `settledNow` landmine, pinned.** This is the failure the delivery
    // stamp exists to prevent: a Session sitting at `finished`, a write, and a
    // wait that would otherwise return before the harness had read a character
    // — reporting the previous turn's answer as this turn's.
    rig = startRig();
    const taskId = await runningSession("finished");
    const r = rig;

    session = await CoreSession.attach(r.client, { taskId });
    expect(session.status()).toBe("finished");

    const { ok, deliveryEventId } = await session.deliver("carry on");
    expect(ok).toBe(true);
    expect(deliveryEventId).toBeGreaterThan(0);

    let settled: unknown = null;
    void session.waitForTurnEnd({ afterEventId: deliveryEventId }).then((idle) => {
      settled = idle;
    });
    await new Promise((done) => setTimeout(done, 50));

    // The pre-existing status is still `finished` and the wait has not moved.
    expect(settled).toBeNull();
    expect(session.status()).toBe("finished");

    // Now the turn this write started ends. The status it lands on is the one
    // it was already at — which is the ordinary case on a harness that never
    // moved the row to `running` — and it still ends the wait, because what
    // the wait is counting is *events after the delivery*, not value changes.
    r.tasks.setStatus(taskId, "finished");

    await vi.waitFor(() => expect(settled).toEqual({ status: "finished", exited: false }));
  });

  it("awaits a follow-up turn on a harness that never reports a turn's start", async () => {
    // `codex` and `cursor-cli` are `reportsTurnStart: false` in `HOOK_FAMILIES`,
    // so their Sessions never move to `running` and there is no transition to
    // poll on. The wait is keyed on the turn's *end*, which they do report, and
    // **no wait path consults `reportsTurnStart`** — the whole point of (A).
    rig = startRig();
    const r = rig;
    await r.client.connect();
    const created = await r.client.tasksMutate({
      op: "create",
      projectId: PROJECT_ID,
      title: "a codex session",
      agent: "codex",
    });
    const taskId = created!.taskId;
    // Its first turn ended here, and nothing will move it again until the next
    // one ends: `ready` → `finished`, and then `finished` → `finished`.
    r.tasks.setStatus(taskId, "finished");

    session = await CoreSession.attach(r.client, { taskId });
    const { deliveryEventId } = await session.deliver("and now the tests\r");
    const idle = session.waitForTurnEnd({ afterEventId: deliveryEventId });

    r.tasks.setStatus(taskId, "finished");

    await expect(idle).resolves.toEqual({ status: "finished", exited: false });
  });

  it("resolves on any of the five settled statuses, not on a finish alone", async () => {
    // A turn that ended on a permission prompt, an escape, a dead harness or a
    // Core that restarted underneath it *ended*. `session:finished` is appended
    // for exactly one of the five, so a wait keyed on it waits forever on the
    // four a caller most needs to hear about.
    for (const status of ["finished", "needs-input", "interrupted", "terminated", "disconnected"]) {
      rig = startRig();
      const r = rig;
      const taskId = await runningSession();
      session = await CoreSession.attach(r.client, { taskId });
      const { deliveryEventId } = await session.deliver("go on");
      const idle = session.waitForTurnEnd({ afterEventId: deliveryEventId });

      r.tasks.setStatus(taskId, status);

      await expect(idle).resolves.toEqual({ status, exited: false });
      session.dispose();
      session = null;
      r.client.close();
      r.close();
      rig = null;
    }
  });

  it("does not read a rename as the end of a turn", async () => {
    // A `task:updated` that patched no status is not a report about a turn. The
    // title generator renames a Session while it works (issue 84), and a waiter
    // that took the row's status from that event would call the rename the end
    // of the turn — with the row still carrying the status it had before.
    rig = startRig();
    const taskId = await runningSession("finished");
    const r = rig;

    session = await CoreSession.attach(r.client, { taskId });
    const { deliveryEventId } = await session.deliver("carry on");
    let settled: unknown = null;
    void session.waitForTurnEnd({ afterEventId: deliveryEventId }).then((idle) => {
      settled = idle;
    });

    r.tasks.rename(taskId, "a better title");
    await new Promise((done) => setTimeout(done, 50));

    expect(settled).toBeNull();
  });

  it("subscribes to the PTY even with the replay off, so an exit still settles a wait", async () => {
    // Until a connection subscribes, a multi-connection Core fans this PTY out
    // to somebody else: `onData` and `onExit` never fire, the screen stays
    // empty, and the "an exit answers every wait" route is dead — so a caller
    // that attached with `replay: false` to await a harness that then died
    // would hang to its deadline instead. The subscribe is not part of the
    // replay, and turning the scrollback off does not make the attachment deaf.
    rig = startRig();
    const taskId = await runningSession("finished");
    const r = rig;

    session = await CoreSession.attach(r.client, { taskId, replay: false });
    // No scrollback: that is what `replay: false` buys, and all it buys.
    expect(session.screen().trim()).toBe("");

    const { deliveryEventId } = await session.deliver("carry on");
    const idle = session.waitForTurnEnd({ afterEventId: deliveryEventId });

    r.ptyCore.emitEvent({ type: "exit", ptyId: "pty-1", exitCode: 4 });

    await expect(idle).resolves.toMatchObject({ exited: true, exitCode: 4 });
  });

  it("reports a link that blinked mid-attach as a failed attach, not as a dead harness", async () => {
    // The two are different next steps. "Nothing is running" sends an operator
    // to `logs` or `resume`; a Core that was busy for a moment wants a retry.
    // Only the `findByTask` answer decides the first, and it decided before any
    // of this ran.
    rig = startRig();
    const taskId = await runningSession();
    const r = rig;
    vi.spyOn(r.client, "sessionsList").mockRejectedValueOnce(new Error("link dropped mid-read"));

    const attaching = CoreSession.attach(r.client, { taskId });

    await expect(attaching).rejects.toThrow(/could not attach/);
    await expect(attaching).rejects.not.toBeInstanceOf(CoreSessionAttachError);
  });

  it("gives the PTY subscription back on dispose", async () => {
    // Removing the listener stops this process reading the bytes; it does not
    // stop the Core sending them. An orchestrator that attaches to and disposes
    // many Sessions on one long-lived client would otherwise leave every one of
    // those streams running at it for the life of the client.
    rig = startRig();
    const taskId = await runningSession();
    const r = rig;
    const unsubscribe = vi.spyOn(r.client, "ptyUnsubscribe");

    const attached = await CoreSession.attach(r.client, { taskId });
    expect(unsubscribe).not.toHaveBeenCalled();
    attached.dispose();

    expect(unsubscribe).toHaveBeenCalledWith("pty-1");
    // Idempotent: a second dispose is not a second frame.
    attached.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does not unsubscribe a PTY it never subscribed to — a spawned Session's is the Core's", async () => {
    // The Core subscribes the connection that spawned a PTY, inside the spawn
    // (issue 142). Nothing here asked for it, so nothing here gives it back.
    rig = startRig();
    const spawned = await startSession(rig);
    const unsubscribe = vi.spyOn(rig.client, "ptyUnsubscribe");

    spawned.dispose();

    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("resolves a delivered wait when the harness's process exits", async () => {
    // A harness that died is not going to report anything else, cursor or no
    // cursor. The alternative is a wait that outlives the process it is about.
    rig = startRig();
    const taskId = await runningSession("finished");
    const r = rig;

    session = await CoreSession.attach(r.client, { taskId });
    const { deliveryEventId } = await session.deliver("carry on");
    const idle = session.waitForTurnEnd({ afterEventId: deliveryEventId });

    r.ptyCore.emitEvent({ type: "exit", ptyId: "pty-1", exitCode: 3 });

    await expect(idle).resolves.toMatchObject({ exited: true, exitCode: 3 });
  });

  it("unblocks on the turn a delivered carriage return started", async () => {
    // #405's second acceptance criterion, at the layer that implements it:
    // `send --enter --wait` is a text write, a return write, and a wait counting
    // from the **later** stamp — the turn starts at the return, not at the text.
    rig = startRig();
    const taskId = await runningSession("finished");
    const r = rig;

    session = await CoreSession.attach(r.client, { taskId });
    const text = await session.deliver("run the tests");
    const submit = await session.deliver("\r");
    expect(submit.deliveryEventId).toBeGreaterThan(text.deliveryEventId);

    const idle = session.waitForTurnEnd({ afterEventId: submit.deliveryEventId });
    r.tasks.setStatus(taskId, "finished");

    await expect(idle).resolves.toEqual({ status: "finished", exited: false });
  });

  it("gives up on the caller's deadline and says what it was still doing", async () => {
    // The honest degradation (#289 D): a harness that reports nothing runs the
    // deadline out, and what is reported is that this side gave up — never a
    // status the Core did not send, and never a turn inferred from the bytes.
    //
    // This is the *working* half: the Core reported something after the
    // delivery, so the wait was waiting on a harness that is doing something,
    // and the wording that has said so since #289 is kept.
    rig = startRig();
    const taskId = await runningSession("finished");
    const r = rig;

    session = await CoreSession.attach(r.client, { taskId });
    const { deliveryEventId } = await session.deliver("carry on");
    r.tasks.setStatus(taskId, "running");
    await vi.waitFor(() => expect(session!.status()).toBe("running"));

    const err = await session
      .waitForTurnEnd({ afterEventId: deliveryEventId, timeoutMs: 30 })
      .catch((thrown: unknown) => thrown);
    expect(err).toBeInstanceOf(CoreSessionTurnTimeoutError);
    expect((err as CoreSessionTurnTimeoutError).reportedSinceDelivery).toBe(true);
    expect((err as Error).message).toMatch(/still running/);
  });

  it("names a deadline with no reported turn end as the open question it is", async () => {
    // **The seeded-status landmine, made loud** (#405). A status seeded from the
    // Task row carries event id 0, so it can never satisfy a delivery cursor —
    // which is correct, and which is why a Session parked at a dialog that ate
    // the carriage return has nothing that will ever end this wait. The
    // comparison that cannot be satisfied is reported rather than sat on.
    //
    // What the message may **not** do is diagnose (#486 review): `codex` and
    // `cursor-cli` report nothing between a turn's start and its end, so this
    // same silence is what a working harness looks like on half the families in
    // the table. It names both readings, sends the reader to the screen, and
    // says the text was delivered so it is not sent twice.
    rig = startRig();
    const taskId = await runningSession("needs-input");

    session = await CoreSession.attach(rig.client, { taskId });
    // Seeded, not learned: this is the state the cursor can never be answered by.
    expect(session.status()).toBe("needs-input");
    const { deliveryEventId } = await session.deliver("2\r");
    expect(deliveryEventId).toBeGreaterThan(0);

    const err = await session
      .waitForTurnEnd({ afterEventId: deliveryEventId, timeoutMs: 30 })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(CoreSessionTurnTimeoutError);
    const timeout = err as CoreSessionTurnTimeoutError;
    expect(timeout.reportedSinceDelivery).toBe(false);
    expect(timeout.afterEventId).toBe(deliveryEventId);
    expect(timeout.lastStatus).toBe("needs-input");
    // Never "still needs-input": that reads as a harness the Core is reporting
    // on, and the whole point is that it has reported nothing.
    expect(timeout.message).not.toMatch(/still needs-input/);
    expect(timeout.message).toMatch(/no turn end was reported/);
    // Both readings, neither chosen.
    expect(timeout.message).toMatch(/dialog rather than a composer/);
    expect(timeout.message).toMatch(/reports nothing until it ends/);
    expect(timeout.message).toMatch(/cannot tell those apart/);
    expect(timeout.message).toContain("The text was delivered");
  });
});

describe("a wait cannot outlive its link (#396)", () => {
  // The hang this suite is about: every way a wait can end well — a status
  // change, a process exit — reaches this side down the core link, so a link
  // that drops takes all of them with it and the wait goes quiet instead of
  // ending. With no `--wait-timeout` there was nothing left that could ever
  // settle it, which is the operator's `actana session start … --wait` sitting
  // for ever after a Core blip.
  //
  // What is asserted below is the shape of the fix as much as its presence: the
  // wait **rejects**. Resolving it with the status the Session was last seen at
  // would report a turn as ended because a socket died, and a false completion
  // is the one outcome worse than the hang (ADR 0033 D6).

  async function runningSession(status = "running"): Promise<string> {
    const r = rig!;
    await r.client.connect();
    const created = await r.client.tasksMutate({
      op: "create",
      projectId: PROJECT_ID,
      title: "somebody else's session",
      agent: "claude-code",
    });
    r.tasks.setStatus(created!.taskId, status);
    return created!.taskId;
  }

  it("ends a wait that has no deadline at all, rather than hanging on a dead link", async () => {
    // Issue #396's acceptance criterion, at the layer that implements it. No
    // `timeoutMs` — which is `session wait` with no `--wait-timeout`, and what
    // `--wait-timeout 0` opts back into on the one verb that has a default
    // (#405) — so this rejection is the only thing in the world that will ever
    // settle this promise.
    rig = startRig();
    const taskId = await runningSession("running");

    session = await CoreSession.attach(rig.client, { taskId });
    const idle = session.waitForIdle().catch((thrown: unknown) => thrown);

    rig.drop();

    const err = await idle;
    expect(err).toBeInstanceOf(CoreSessionLinkLostError);
  });

  it("says the outcome is unknown, and never that the turn ended", async () => {
    // The distinction the whole train exists to protect. The Session is parked
    // at `running`, the link dies, and what comes back must not read as a turn
    // that ended — not in the class, not in the fields, and not in the prose.
    rig = startRig();
    const taskId = await runningSession("finished");
    const r = rig;

    session = await CoreSession.attach(r.client, { taskId });
    const { deliveryEventId } = await session.deliver("carry on");
    r.tasks.setStatus(taskId, "running");
    await vi.waitFor(() => expect(session!.status()).toBe("running"));

    const idle = session
      .waitForTurnEnd({ afterEventId: deliveryEventId })
      .catch((thrown: unknown) => thrown);
    r.drop();

    const err = (await idle) as CoreSessionLinkLostError;
    expect(err).toBeInstanceOf(CoreSessionLinkLostError);
    expect(err.name).toBe("CoreSessionLinkLostError");
    // **Distinguishable from the deadline #405 added**, which is a different
    // next step: that one is this side giving up on a clock it set, this one is
    // this side going deaf. A caller branches on the class, not on the wording.
    expect(err).not.toBeInstanceOf(CoreSessionTurnTimeoutError);
    // The cursor and the last-known status are carried as context…
    expect(err.taskId).toBe(taskId);
    expect(err.afterEventId).toBe(deliveryEventId);
    expect(err.lastStatus).toBe("running");
    // …and `running` was learned after the delivery, so the turn was seen to be
    // under way when the link went. Informative, never settling: a settling
    // status would have ended the wait instead.
    expect(err.reportedSinceDelivery).toBe(true);
    // The sentence that matters.
    expect(err.message).toMatch(/outcome is unknown/);
    expect(err.message).toMatch(/not a report that the turn finished/);
    expect(err.message).toMatch(/may still be running/);
  });

  it("fails a wait started after the link had already gone", async () => {
    // The same hang through the other door: nothing drops mid-wait here, the
    // wait simply begins against a link that is already down. It has exactly as
    // little chance of hearing a status, so it gets exactly the same ending.
    rig = startRig();
    const taskId = await runningSession("running");

    session = await CoreSession.attach(rig.client, { taskId });
    rig.drop();

    await expect(session.waitForIdle()).rejects.toBeInstanceOf(CoreSessionLinkLostError);
  });

  it("fails at once on a client with no reconnect coming, and names the reason", async () => {
    // A one-shot `CoreClient` — the `actana` CLI's — does not dial again, so
    // there is no reconnect for a grace to be time for and the wait fails on the
    // drop itself. Sitting out thirty seconds first would be thirty seconds of
    // the hang this fixes.
    rig = startRig();
    expect(rig.client.willReconnect()).toBe(false);
    const taskId = await runningSession("running");

    session = await CoreSession.attach(rig.client, { taskId });
    const idle = session.waitForIdle().catch((thrown: unknown) => thrown);
    rig.drop();

    const err = (await idle) as CoreSessionLinkLostError;
    expect(err.graceMs).toBe(0);
    expect(err.message).toMatch(/this client does not reconnect/);
  });

  it("gives a link that may come back the grace to do it in", async () => {
    // The other half, and the reason this is not a bare rejection on the first
    // blip: on a client that reconnects, a drop is usually not even an
    // interruption — the link returns, the client re-subscribes from its cursor,
    // and the Core streams the tail it missed. Failing instantly would report a
    // turn as unobservable while it was being observed again.
    //
    // The grace is asked for explicitly here because the default is thirty
    // seconds and a unit test may not take thirty seconds. That default is
    // asserted separately, below.
    rig = startRig();
    const taskId = await runningSession("running");
    const r = rig;

    session = await CoreSession.attach(r.client, { taskId, linkLostGraceMs: 60 });
    const idle = session.waitForIdle().catch((thrown: unknown) => thrown);

    r.drop();
    // Still waiting a tick later: the drop alone decides nothing.
    let settled = false;
    void idle.then(() => {
      settled = true;
    });
    await new Promise((r2) => setTimeout(r2, 10));
    expect(settled).toBe(false);

    const err = (await idle) as CoreSessionLinkLostError;
    expect(err).toBeInstanceOf(CoreSessionLinkLostError);
    expect(err.graceMs).toBe(60);
    expect(err.downMs).toBeGreaterThanOrEqual(60);
    expect(err.message).toMatch(/been deaf for \d+ms, past the 60ms/);
  });

  it("keeps waiting when the link comes back inside the grace", async () => {
    // The recovery this grace exists for, and the property that makes it safe to
    // have one: a link that returns leaves the wait exactly as it was — still
    // pending, still owed a status by the Core, never resolved and never failed
    // by anything that happened to the socket.
    rig = startRig();
    const taskId = await runningSession("running");
    const r = rig;

    session = await CoreSession.attach(r.client, { taskId, linkLostGraceMs: 40 });
    let outcome: unknown = null;
    void session.waitForIdle().then(
      (idle) => {
        outcome = idle;
      },
      (err: unknown) => {
        outcome = err;
      },
    );

    r.drop();
    // A second connection, well inside the grace. `onReady` on the new link is
    // what disarms it.
    await r.client.connect();
    await new Promise((r2) => setTimeout(r2, 120));

    expect(outcome).toBeNull();
  });

  it("takes its default grace from whether the client reconnects at all", async () => {
    // The default is not a number this layer picked for everyone: it is thirty
    // seconds for a client that dials again and zero for one that does not, and
    // the client is the one that knows which it is.
    expect(CORE_LINK_LOST_GRACE_MS).toBe(30_000);
    rig = startRig();
    const taskId = await runningSession("running");

    session = await CoreSession.attach(rig.client, { taskId });
    const idle = session.waitForIdle().catch((thrown: unknown) => thrown);
    rig.drop();

    // A one-shot client, so zero — and the wait is over long before any
    // thirty-second grace could have run.
    expect(((await idle) as CoreSessionLinkLostError).graceMs).toBe(0);
  });

  /**
   * Await `p`, but never for longer than `ms` — a regression here is a **hang**,
   * and a test that hangs takes the suite down with it rather than failing.
   */
  async function settledWithin(p: Promise<unknown>, ms: number): Promise<unknown> {
    const STILL_PENDING = Symbol("still pending");
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bound = new Promise((resolve) => {
      timer = setTimeout(() => resolve(STILL_PENDING), ms);
    });
    try {
      const settled = await Promise.race([p, bound]);
      if (settled === STILL_PENDING) {
        throw new Error(`the wait was still pending after ${ms}ms — it is hanging`);
      }
      return settled;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  it("adds a flapping link's outages up rather than forgiving each one", async () => {
    // **#492 review, blocking 1.** `onLinkBack` used to clear the grace outright,
    // so the next drop got a full fresh one and nothing anywhere added up how
    // long this side had actually been deaf. A link that drops and returns
    // repeatedly — each outage shorter than the grace — therefore never failed
    // the wait, however much total time was lost. A Core in a restart crash-loop
    // and a `DurableCoreClient` on its 500 ms–5 s backoff are exactly that
    // shape, so this is #396's own bug through a slower door.
    //
    // Five outages of ~65 ms against a 100 ms budget, and **no `timeoutMs`** —
    // the deaf time is what has to end this, because nothing else can.
    rig = startRig();
    const taskId = await runningSession("running");
    const r = rig;

    session = await CoreSession.attach(r.client, { taskId, linkLostGraceMs: 100 });
    const idle = session.waitForIdle().catch((thrown: unknown) => thrown);

    for (let flap = 0; flap < 5; flap += 1) {
      r.drop();
      await new Promise((res) => setTimeout(res, 65));
      await r.client.connect().catch(() => {});
      await new Promise((res) => setTimeout(res, 15));
    }

    const err = (await settledWithin(idle, 4000)) as CoreSessionLinkLostError;
    expect(err).toBeInstanceOf(CoreSessionLinkLostError);
    // The budget is the configured constant; `downMs` is what was actually
    // spent, and it is the sum across outages rather than the last one alone.
    expect(err.graceMs).toBe(100);
    expect(err.downMs).toBeGreaterThanOrEqual(100);
  });

  it("does not take an unauthenticated `ready` for the link coming back", async () => {
    // **#492 review, blocking 2.** The disarm hung on `onReady`, and `ready` is
    // the Core's first unsolicited frame — it lands *before* `auth` is answered.
    // So a connection the Core is about to refuse, or one that simply never
    // authenticates, counted as recovery: the guard was disarmed, nothing could
    // be sent on that connection, no `subscribe` went out, and the wait sat
    // there with the link permanently unusable and nothing left to end it.
    //
    // Staged exactly: dial 0 is this rig's Core with a good bearer; dial 1 is a
    // socket that opens, says `ready`, and never answers the `auth` behind it.
    const secret = "core-session-suite-secret-32-byte-x";
    let bogus: FakeSocket | null = null;
    rig = startRig({
      authVerifier: (bearer) => verifyBearer(bearer, secret),
      bearer: signBearer({ coreId: "core_test", exp: Date.now() + 60_000 }, secret),
      dial: (n) => {
        if (n === 0) return null;
        const socket = new FakeSocket();
        bogus = socket;
        queueMicrotask(() => {
          socket.readyState = 1;
          socket.emit("open");
          socket.receive({ type: "ready", version: CORE_LINK_PROTOCOL_VERSION });
        });
        return socket.asClientSocket();
      },
    });
    const taskId = await runningSession("running");
    const r = rig;

    session = await CoreSession.attach(r.client, { taskId, linkLostGraceMs: 120 });
    const idle = session.waitForIdle().catch((thrown: unknown) => thrown);

    r.drop();
    void r.client.connect().catch(() => {});

    const err = (await settledWithin(idle, 4000)) as CoreSessionLinkLostError;
    expect(err).toBeInstanceOf(CoreSessionLinkLostError);
    expect(err.downMs).toBeGreaterThanOrEqual(120);
    // The replacement connection really did say `ready` and really did get an
    // `auth` it never answered — so the case under test is the one described,
    // not a dial that failed to happen.
    const staged = bogus as FakeSocket | null;
    expect(staged?.framesOfType("auth")).toHaveLength(1);
  });

  it("hands the grace back when the caller's own deadline fires", async () => {
    // **#492 review, should fix 1.** `notify` and `fail` released the grace; the
    // `timeoutMs` callback did not. The timer is deliberately not `unref`ed, so
    // it went on holding the event loop after the wait had settled — and because
    // `armLinkLostGrace` keeps one timer per Session, the *next* wait inherited
    // that stale, part-spent one and was failed early against a budget it never
    // had.
    rig = startRig();
    const taskId = await runningSession("running");
    const r = rig;

    session = await CoreSession.attach(r.client, { taskId, linkLostGraceMs: 300 });
    r.drop();

    // Wait A gives up on its own clock well inside the grace.
    await expect(session.waitForIdle({ timeoutMs: 60 })).rejects.toBeInstanceOf(
      CoreSessionTurnTimeoutError,
    );

    // Wait B, started fresh, gets the whole budget rather than what was left of
    // A's — and reports the deaf time it actually sat through.
    const startedAt = Date.now();
    const err = (await settledWithin(
      session.waitForIdle().catch((thrown: unknown) => thrown),
      4000,
    )) as CoreSessionLinkLostError;
    const elapsed = Date.now() - startedAt;

    expect(err).toBeInstanceOf(CoreSessionLinkLostError);
    expect(err.downMs).toBeGreaterThanOrEqual(300);
    // Comfortably above the ~240ms A would have left behind.
    expect(elapsed).toBeGreaterThan(260);
  });

  it("orphans no deadline timer when a grace of 0 rejects inside the executor", async () => {
    // **#492 review, should fix 2.** The `linkDown` check ran *before* the
    // deadline was armed, so on a grace of 0 — the `actana` CLI's one-shot
    // client — `fail` ran with `timer` still null and the `setTimeout` armed two
    // lines later was never cleared by anything, `dispose()` included. Harmless
    // where the process exits; an SDK consumer holds the event loop for the
    // whole of a seventeen-minute deadline it has already stopped caring about.
    rig = startRig();
    const taskId = await runningSession("running");

    session = await CoreSession.attach(rig.client, { taskId });
    rig.drop();
    await new Promise((res) => setTimeout(res, 5));

    vi.useFakeTimers();
    try {
      const err = await session
        .waitForIdle({ timeoutMs: 1_020_000 })
        .catch((thrown: unknown) => thrown);
      expect(err).toBeInstanceOf(CoreSessionLinkLostError);
      // Nothing left armed under the fake clock: the deadline went back with the
      // wait it belonged to.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a turn that really ended ending the wait, drop or no drop", async () => {
    // The regression guard on the whole of this: nothing above may make a
    // settled status stop resolving a wait, and a Session whose link never
    // wobbles must behave exactly as it did before #396.
    rig = startRig();
    const taskId = await runningSession("running");
    const r = rig;

    session = await CoreSession.attach(r.client, { taskId });
    const { deliveryEventId } = await session.deliver("carry on");
    const idle = session.waitForTurnEnd({ afterEventId: deliveryEventId });
    r.tasks.setStatus(taskId, "finished");

    await expect(idle).resolves.toEqual({ status: "finished", exited: false });
  });
});

describe("no wait is keyed on a turn's start (#289 A)", () => {
  it("mentions reportsTurnStart nowhere in the waiting half of the session layer", () => {
    // `reportsTurnStart` survives as reported information — the `spawned` frame,
    // `session start --json`, the Panel's terminal-input fallback — and gates
    // nothing about waiting. Half the harness families answer `false`, so a wait
    // that consulted it would work on half of them and be a coin flip for every
    // family added after it.
    const source = readFileSync(new URL("../core-session.ts", import.meta.url), "utf8");
    const waiting = source
      .slice(source.indexOf("  waitForIdle("), source.indexOf("  // ─── Lifecycle"))
      // Comments out: the prose there *says* no wait consults the field, and a
      // check that could not tell that sentence from a call is a check that
      // punishes writing it down.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    expect(waiting.length).toBeGreaterThan(200);
    expect(waiting).not.toContain("reportsTurnStart");
  });

  it("mentions it nowhere in the handlers that end a wait on a lost link either", () => {
    // **#492 review, advisory.** The slice above stops at `// ─── Lifecycle`, and
    // #396's handlers sit under `// ─── Internals` — so the guard no longer
    // covered every path that ends a wait, which is the property it exists to
    // protect. Second slice, same rule.
    const source = readFileSync(new URL("../core-session.ts", import.meta.url), "utf8");
    const linkLost = source
      .slice(source.indexOf("  private onLinkLost("), source.indexOf("  private ingestExit("))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    expect(linkLost.length).toBeGreaterThan(200);
    expect(linkLost).not.toContain("reportsTurnStart");
    // And nothing here reads the screen either (#191, ADR 0026 D3).
    expect(linkLost).not.toContain("terminal");
    expect(linkLost).not.toContain("screen");
  });
});

describe("D11 — no terminal, anywhere", () => {
  it("touches nothing terminal-shaped in any shipped module", () => {
    // The rule is absolute and structural, so the check is too: terminal
    // handling belongs to the CLI, and an SDK that read `process.stdin` or set
    // raw mode would be unusable from the cron job, the CI runner and the web
    // service this package exists for. A grep is a poor test of behaviour and a
    // good test of a boundary nobody may cross by accident.
    // `examples/` is swept with `src/`, not instead of it: the one file in this
    // package a user is *invited* to run with plain `node` is the example, so it
    // is the last place a `process.stdin` may appear. Its extension is `.mjs`,
    // which is why the match is on a set rather than on `.ts`.
    const root = path.resolve(import.meta.dirname, "..", "..");
    const roots = [path.join(root, "src"), path.join(root, "examples")];
    const shipped = /\.(ts|mts|cts|js|mjs|cjs)$/;
    const forbidden = /process\.stdin|process\.stdout|setRawMode|\/dev\/tty|isTTY|readline/;
    const offences: string[] = [];
    const swept: string[] = [];
    const sweep = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "node_modules") continue;
          sweep(path.join(dir, entry.name));
        } else if (shipped.test(entry.name) && !/\.test\.[a-z]+$/.test(entry.name)) {
          const file = path.join(dir, entry.name);
          swept.push(path.relative(root, file).split(path.sep).join("/"));
          const source = readFileSync(file, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, "");
          if (forbidden.test(source)) {
            offences.push(path.relative(root, file).split(path.sep).join("/"));
          }
        }
      }
    };
    for (const dir of roots) sweep(dir);

    expect(offences).toEqual([]);
    // An empty sweep passes an empty assertion, and this one walked `src` alone
    // until now: name a file from each tree so a narrowed walk fails here.
    expect(swept).toEqual(
      expect.arrayContaining(["src/core-session.ts", "examples/start-a-session.mjs"]),
    );
  });
});
