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
import { CoreClient } from "../core-client.ts";
import { CoreSession, CoreSessionStartError, HARNESS_LAUNCH_COMMANDS } from "../core-session.ts";
import {
  FakeEventLog,
  FakeSocketPair,
  FakeSocketServer,
  makeMockPtyCore,
} from "./fake-core-link.ts";

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
    this.eventLog.appendEvent("task:updated", JSON.stringify({ taskId: next.taskId }), {
      taskId: next.taskId,
    });
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
}

type Rig = {
  client: CoreClient;
  ptyCore: PtyCore & { emitEvent: (e: PtyCoreEvent) => void };
  tasks: FakeTaskStore;
  eventLog: FakeEventLog;
  close: () => void;
};

function startRig(
  opts: {
    announceMultiConnection?: boolean;
    spawn?: PtyCore["spawn"];
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
  });
  const client = new CoreClient({
    url: "wss://core.test:9444",
    createSocket: () => {
      const pair = new FakeSocketPair();
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
  const built: Rig = { client, ptyCore, tasks, eventLog, close: () => server.close() };
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

  it("subscribes the client to the event log when nothing else has", async () => {
    rig = startRig();
    expect(rig.client.isSubscribedToEvents()).toBe(false);

    session = await startSession(rig);

    expect(rig.client.isSubscribedToEvents()).toBe(true);
  });
});

describe("D11 — no terminal, anywhere", () => {
  it("touches nothing terminal-shaped in any shipped module", () => {
    // The rule is absolute and structural, so the check is too: terminal
    // handling belongs to the CLI, and an SDK that read `process.stdin` or set
    // raw mode would be unusable from the cron job, the CI runner and the web
    // service this package exists for. A grep is a poor test of behaviour and a
    // good test of a boundary nobody may cross by accident.
    const src = path.resolve(import.meta.dirname, "..");
    const forbidden = /process\.stdin|process\.stdout|setRawMode|\/dev\/tty|isTTY|readline/;
    const offences: string[] = [];
    const sweep = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "node_modules") continue;
          sweep(path.join(dir, entry.name));
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          const file = path.join(dir, entry.name);
          const source = readFileSync(file, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, "");
          if (forbidden.test(source)) offences.push(entry.name);
        }
      }
    };
    sweep(src);

    expect(offences).toEqual([]);
  });
});
