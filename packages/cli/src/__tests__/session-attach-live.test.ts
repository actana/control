// `actana session attach` against a Core that is actually running (#163).
//
// `session-attach.test.ts` injects the attachment, which is what makes raw mode,
// the detach key and every teardown path testable without a Core — and is
// exactly why it cannot say whether the *lock* behaves. A lock is a fact about
// two connections to one Core, and there is no way to fake one honestly: the
// interesting states are the ones the Core decides.
//
// So this suite runs the real `openSessionAttach` against the real
// `PtyCoreLinkServer` on a real `wss://` port, twice at a time, and checks the
// three claims the ticket makes about contention:
//
//   1. **Two attaches on one Session: one writes, one reads.** Both see the
//      output; only the first can type, and the second is told why.
//   2. **Detaching releases the lock** — the next attach is granted it.
//   3. **So does the connection dropping.** The connection is destroyed with no
//      close frame and no `release` (`dropConnections`), and the Session is
//      claimable again afterwards. This is the case the ticket calls the one
//      that gets missed and the one that strands a Session unwritable, and it is
//      the reason a fake cannot stand in here: nothing this CLI does produces
//      it, which is precisely why it is worth a test.
//
// The Core comes from `in-process-core.ts` — the rig #205 unified — with the
// live PTY this suite drives, the same shape `in-process-core-session.test.ts`
// contributed for `logs`, `send` and `kill`.

import { describe, it, expect, afterEach } from "vitest";
import { EXIT_FAILURE, EXIT_OK } from "../exit-codes.ts";
import { openSessionAttach } from "../session-attach-channel.ts";
import { fakeTerminal, makeCliFixture, type CliFixture, type FakeTerminal } from "./cli-harness.ts";
import { startInProcessCore, waitFor, type InProcessCore } from "./in-process-core.ts";
import type {
  CoreLinkProjectSnapshot,
  CoreLinkSessionSnapshot,
  CoreLinkTaskSnapshot,
} from "@actana/sdk/core-link-frames.ts";

/** `Ctrl-]`, the detach key. */
const DETACH = "\u001D";

const PROJECT: CoreLinkProjectSnapshot = {
  projectId: "proj_web",
  name: "web",
  path: "/home/core/projects/web",
  icon: "WE",
  iconColor: "#123456",
  pinned: false,
  rememberHarnessSettings: false,
  savedHarness: null,
  savedSkipPermissions: false,
  savedBareSession: false,
  defaultGridView: false,
  updatedAt: 1_700_000_000_000,
};

const TASK: CoreLinkTaskSnapshot = {
  taskId: "task_live",
  projectId: PROJECT.projectId,
  title: "rebuild the flaky auth test",
  titleManuallySet: false,
  claudeSessionId: "00000000-0000-4000-8000-000000000000",
  agent: "claude-code",
  status: "running",
  pinned: false,
  archived: false,
  icon: null,
  updatedAt: 1_700_000_000_000,
};

/** What the harness had already printed before anybody attached. */
const SCROLLBACK = "the harness was already running\r\n";

/**
 * A PTY manager holding one live PTY, with the Core's fan-out callback captured
 * so the test can make the harness print.
 *
 * `setEmitTarget` is the Core's one hook into a PTY's output, and it is the only
 * way to prove a Reader is really reading: the Core fans a PTY's bytes out to
 * the connections that subscribed to it and to no others (ADR 0024 D2), so an
 * attach that never sent `ptySubscribe` would paint the scrollback and then sit
 * there silently.
 */
function livePtyCore() {
  const writes: string[] = [];
  let emit: ((event: unknown) => void) | null = null;
  let seq = 0;
  const ptys = new Map<string, string>([["task_live", "pty_live"]]);

  const core = {
    setEmitTarget: (cb: ((event: unknown) => void) | null) => {
      emit = cb;
    },
    findByTask: (taskId: string) => ({ ptyId: ptys.get(taskId) ?? null }),
    taskIdForPty: (ptyId: string) =>
      [...ptys.entries()].find(([, id]) => id === ptyId)?.[0] ?? null,
    replay: (ptyId: string) =>
      ptyId === "pty_live" ? { data: SCROLLBACK, nextSeq: 1 } : { data: "", nextSeq: 0 },
    write: (ptyId: string, data: string) => {
      if (ptyId !== "pty_live") return false;
      writes.push(data);
      return true;
    },
    kill: () => true,
    resize: () => true,
    spawn: () => {
      throw new Error("this suite attaches to a Session that is already running");
    },
    killAll: () => {},
    killLaunchProcesses: () => ({ ptyCount: 0, ports: [] }),
    killPtysUnderPath: () => {},
  };

  return {
    core,
    writes,
    /** The harness prints a line, as the Core's PTY would. */
    print: (data: string) => {
      seq += 1;
      emit?.({ type: "data", ptyId: "pty_live", data, seq });
    },
  };
}

/** Task and project reads, answered from memory. */
function ports() {
  const sessions = (): CoreLinkSessionSnapshot[] => [
    { taskId: TASK.taskId, ptyId: "pty_live", status: TASK.status, updatedAt: TASK.updatedAt },
  ];
  return {
    queryPort: {
      listProjects: () => [PROJECT],
      listTasks: () => [TASK],
      listArchivedTasks: () => [],
      countArchivedTasks: () => 0,
      getTask: (taskId: string) => (taskId === TASK.taskId ? TASK : null),
    },
    mutationPort: {
      mutateProject: () => null,
      mutateTask: () => null,
      listSessions: sessions,
    },
  };
}

let core: InProcessCore | null = null;
let fixture: CliFixture | null = null;

afterEach(() => {
  core?.close();
  core = null;
  fixture?.cleanup();
  fixture = null;
});

/** A Core holding one live Session, with the CLI pointed at it. */
async function coreWithLiveSession(): Promise<ReturnType<typeof livePtyCore>> {
  const pty = livePtyCore();
  core = await startInProcessCore({ ptyCore: pty.core, ...ports() });
  fixture = makeCliFixture();
  await fixture.run(["core", "add", "inproc"], { stdin: core.blobText });
  return pty;
}

/** One `actana session attach`, dialling the Core for real, fully wired. */
async function attach(argv: string[] = ["session", "attach", "task_live"]): Promise<{
  run: Promise<{ code: number; err: string[] }>;
  terminal: FakeTerminal;
}> {
  const terminal = fakeTerminal();
  const run = fixture!.run(argv, { terminal, openAttach: openSessionAttach });
  await terminal.wired;
  return { run, terminal };
}

describe("two attaches on one Session, against a Core in this process", () => {
  it("gives the first the write lock and the second a read-only view that says why", async () => {
    const pty = await coreWithLiveSession();

    const first = await attach();
    const second = await attach();

    // Both are reading — the Core fans this PTY out to every connection that
    // subscribed to it, and both did.
    pty.print("a line from the harness\r\n");
    await waitFor(
      () => first.terminal.painted().includes("a line") && second.terminal.painted().includes("a line"),
      "one of the two attaches never received the live stream",
    );
    expect(first.terminal.painted()).toContain(SCROLLBACK.trim());
    expect(second.terminal.painted()).toContain(SCROLLBACK.trim());

    // Only one is writing. The second's keystrokes are never put on the wire —
    // and if they were, this Core would refuse them.
    first.terminal.type("typed by the holder");
    second.terminal.type("typed by the reader");
    await waitFor(() => pty.writes.length > 0, "the holder's keystrokes never reached the PTY");

    second.terminal.type(DETACH);
    first.terminal.type(DETACH);
    const [a, b] = await Promise.all([first.run, second.run]);

    expect(pty.writes.join("")).toBe("typed by the holder");
    expect(a.code).toBe(EXIT_OK);
    expect(b.code).toBe(EXIT_OK);
    expect(a.err.join("\n")).toContain("You hold the write lock");
    expect(b.err.join("\n")).toContain("READ-ONLY");
    expect(b.err.join("\n")).toContain("another Core client holds this Session's write lock");
  }, 30_000);

  it("hands the lock to the next attach once the first detaches", async () => {
    const pty = await coreWithLiveSession();

    const first = await attach();
    first.terminal.type(DETACH);
    expect((await first.run).err.join("\n")).toContain("You hold the write lock");

    // Same Session, new connection, and it is claimable — which is only true
    // because the detach above sent a `release` (ADR 0024 D7).
    const second = await attach();
    second.terminal.type("typed after the handover");
    await waitFor(() => pty.writes.length > 0, "the second attach never got the lock");
    second.terminal.type(DETACH);

    const result = await second.run;
    expect(result.err.join("\n")).toContain("You hold the write lock");
    expect(pty.writes.join("")).toBe("typed after the handover");
  }, 30_000);

  it("does not leave the Session locked when the connection drops abruptly", async () => {
    // **The case that strands a Session.** No detach, no release frame, no close
    // handshake: the socket is destroyed under a live attach that holds the
    // lock. Everything below is what must still be true afterwards.
    const pty = await coreWithLiveSession();

    const holder = await attach();
    holder.terminal.type("typed before the drop");
    await waitFor(() => pty.writes.length > 0, "the first attach never got the lock");

    core!.dropConnections();

    const dropped = await holder.run;
    // This side: the terminal is back, the exit code says it did not end well,
    // and the operator is told the Session is not stuck.
    expect(holder.terminal.isRaw()).toBe(false);
    expect(dropped.code).toBe(EXIT_FAILURE);
    expect(dropped.err.join("\n")).toContain("dropped");
    expect(dropped.err.join("\n")).toContain("claimable again");

    // The Core's side, which is the half that matters: the lock went with the
    // connection, so the next attach is granted it and can type.
    const next = await attach();
    next.terminal.type("typed after the drop");
    await waitFor(
      () => pty.writes.length > 1,
      "the Session was left locked by a connection that no longer exists",
    );
    next.terminal.type(DETACH);

    const result = await next.run;
    expect(result.err.join("\n")).toContain("You hold the write lock");
    expect(pty.writes.join("|")).toBe("typed before the drop|typed after the drop");
  }, 30_000);

  it("attaches read-only without taking a lock nobody else holds", async () => {
    // `--read-only` on an unclaimed Session. The point is what happens *next*:
    // the Session is still free, so an attach that meant to drive it gets the
    // lock rather than finding a watcher holding it.
    const pty = await coreWithLiveSession();

    const watcher = await attach(["session", "attach", "task_live", "--read-only"]);
    const driver = await attach();

    driver.terminal.type("typed by the driver");
    await waitFor(() => pty.writes.length > 0, "the driver never got the lock");

    watcher.terminal.type(DETACH);
    driver.terminal.type(DETACH);
    const [w, d] = await Promise.all([watcher.run, driver.run]);

    expect(w.err.join("\n")).toContain("--read-only");
    expect(d.err.join("\n")).toContain("You hold the write lock");
    expect(pty.writes.join("")).toBe("typed by the driver");
  }, 30_000);
});
