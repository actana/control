// The `session` noun against a Core that is actually running (#160).
//
// `session-command.test.ts` injects the gateway, which is what makes the flags,
// the tables, the `--json` shapes and the exit codes testable without a Core —
// and is exactly why it cannot say whether the frames this noun sends are the
// ones a Core answers. This suite closes that gap the way
// `in-process-core.test.ts` closed it for `core status`: the real
// `PtyCoreLinkServer` on a real `wss://` port, the real `openSessionGateway`,
// and nothing faked between them except the machine they would otherwise be on.
//
// The Core here holds **Sessions this CLI did not start** — a task list, a
// project list, and a PTY that was already running when the command was typed.
// That is not scene-setting: it is the ticket's criterion. Nothing about having
// started a Session is remembered locally, so `ls`, `logs`, `send` and `kill`
// have nothing to recognise and work on any Session on the Core.
//
// Starting a Session is deliberately not exercised here. A spawn needs a real
// harness binary on this machine's PATH and a real PTY, which is
// `packages/sdk`'s `live-session.test.ts` — an opt-in suite against an
// operator's own Core. What is provable without one is proved here.

import { describe, it, expect, afterEach } from "vitest";
import { PtyCoreLinkServer } from "@actana/core/pty-core-link-server";
import type {
  CoreLinkProjectSnapshot,
  CoreLinkSessionSnapshot,
  CoreLinkTaskSnapshot,
} from "@actana/sdk/core-link-frames.ts";
import { openSessionGateway } from "../session-gateway.ts";
import { EXIT_FAILURE, EXIT_OK } from "../exit-codes.ts";
import { makeCliFixture, type CliFixture } from "./cli-harness.ts";
import { startInProcessCore } from "./in-process-core-harness.ts";

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

function task(overrides: Partial<CoreLinkTaskSnapshot> = {}): CoreLinkTaskSnapshot {
  return {
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
    ...overrides,
  };
}

/**
 * The transcript a harness actually produces: a repainted line, not a log.
 *
 * `ESC[1G` walks the cursor back to column one and the next write lands on top
 * of what was there. Concatenated raw, this reads `Scanning…Scanning… 2
 * filesdone: 3 files changed`; rendered, it reads what a terminal would be
 * showing. That difference is the ticket's `logs` trap, and it is asserted in
 * both directions below.
 */
const REPAINTED =
  "\u001B[2J\u001B[H\u001B[1GScanning…\u001B[1GScanning… 2 files\u001B[1Gdone: 3 files changed\r\n";

/** A PTY manager holding one live PTY, and a record of what was done to it. */
function livePtyCore(): {
  core: unknown;
  writes: string[];
  killed: string[];
} {
  const writes: string[] = [];
  const killed: string[] = [];
  const ptys = new Map<string, string>([["task_live", "pty_live"]]);
  const core = {
    setEmitTarget: () => {},
    findByTask: (taskId: string) => ({ ptyId: ptys.get(taskId) ?? null }),
    taskIdForPty: (ptyId: string) =>
      [...ptys.entries()].find(([, id]) => id === ptyId)?.[0] ?? null,
    replay: (ptyId: string) =>
      ptyId === "pty_live"
        ? { data: REPAINTED, nextSeq: 1 }
        : { data: "", nextSeq: 0 },
    write: (ptyId: string, data: string) => {
      if (ptyId !== "pty_live") return false;
      writes.push(data);
      return true;
    },
    kill: (ptyId: string) => {
      if (ptyId !== "pty_live") return false;
      killed.push(ptyId);
      for (const [taskId, id] of ptys) if (id === ptyId) ptys.delete(taskId);
      return true;
    },
    resize: () => true,
    spawn: () => {
      throw new Error("this suite does not spawn — see the header");
    },
    killAll: () => {},
    killLaunchProcesses: () => ({ ptyCount: 0, ports: [] }),
    killPtysUnderPath: () => {},
  };
  return { core, writes, killed };
}

/** Task and project reads, answered from memory. */
function ports(tasks: CoreLinkTaskSnapshot[], live: (taskId: string) => string | null) {
  const sessions = (): CoreLinkSessionSnapshot[] =>
    tasks
      .filter((row) => !row.archived)
      .map((row) => ({
        taskId: row.taskId,
        ptyId: live(row.taskId),
        status: row.status,
        updatedAt: row.updatedAt,
      }));
  return {
    queryPort: {
      listProjects: () => [PROJECT],
      listTasks: () => tasks.filter((row) => !row.archived),
      listArchivedTasks: () => tasks.filter((row) => row.archived),
      countArchivedTasks: () => tasks.filter((row) => row.archived).length,
      getTask: (taskId: string) => tasks.find((row) => row.taskId === taskId) ?? null,
    },
    mutationPort: {
      mutateProject: () => null,
      mutateTask: () => null,
      listSessions: sessions,
    },
  };
}

let server: PtyCoreLinkServer | null = null;
let fixture: CliFixture | null = null;

afterEach(() => {
  server?.close();
  server = null;
  fixture?.cleanup();
  fixture = null;
});

/** A Core holding one live Session and one that has already stopped. */
async function coreWithSessions(): Promise<{ writes: string[]; killed: string[] }> {
  const pty = livePtyCore();
  const tasks = [
    task(),
    task({ taskId: "task_done", title: "ship the changelog", status: "finished" }),
  ];
  const { queryPort, mutationPort } = ports(tasks, (taskId) =>
    (pty.core as { findByTask(id: string): { ptyId: string | null } }).findByTask(taskId).ptyId,
  );
  const core = await startInProcessCore({ ptyCore: pty.core, queryPort, mutationPort });
  server = core.server;
  fixture = makeCliFixture();
  await fixture.run(["core", "add", "inproc"], { stdin: core.blobText });
  return { writes: pty.writes, killed: pty.killed };
}

/** Every session verb dials the Core for real in this suite. */
function withCore() {
  return { sessions: openSessionGateway };
}

describe("actana session, against a Core in this process", () => {
  it("lists the Sessions the Core holds, with the live one marked", async () => {
    await coreWithSessions();

    const run = await fixture!.run(["session", "ls", "--json"], withCore());
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);

    const rows = JSON.parse(run.out.join("\n")) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    const live = rows.find((row) => row.taskId === "task_live")!;
    expect(live.live).toBe(true);
    expect(live.ptyId).toBe("pty_live");
    // Joined off the Task rows: `sessionsList` carries neither, and a listing
    // that showed only ids would be unreadable.
    expect(live.title).toBe("rebuild the flaky auth test");
    expect(live.project).toBe("web");
    expect(live.harness).toBe("claude-code");
    expect(rows.find((row) => row.taskId === "task_done")!.live).toBe(false);
  }, 30_000);

  it("renders the transcript rather than concatenating the bytes", async () => {
    await coreWithSessions();

    const rendered = await fixture!.run(["session", "logs", "task_live"], withCore());
    expect(rendered.code, rendered.err.join("\n")).toBe(EXIT_OK);
    const screen = rendered.out.join("\n");
    expect(screen).toContain("done: 3 files changed");
    // The repaints are gone, which is the whole difference between a screen and
    // a byte log — and they are gone because the SDK's terminal drew them, not
    // because an escape stripper deleted them.
    expect(screen).not.toContain("Scanning…");
    expect(screen).not.toContain("\u001B");

    const raw = await fixture!.run(["session", "logs", "task_live", "--raw"], withCore());
    expect(raw.code).toBe(EXIT_OK);
    expect(raw.out.join("\n")).toContain("\u001B[1G");
  }, 30_000);

  it("sends exactly the bytes it was given, and adds a return only when asked", async () => {
    const { writes } = await coreWithSessions();

    const sent = await fixture!.run(["session", "send", "task_live", "2"], withCore());
    expect(sent.code, sent.err.join("\n")).toBe(EXIT_OK);
    // No carriage return, no second write, no timer: prompt delivery is the
    // Core's (ADR 0026) and `send` is the equivalent of typing.
    expect(writes).toEqual(["2"]);

    const withEnter = await fixture!.run(["session", "send", "task_live", "2", "--enter"], withCore());
    expect(withEnter.code).toBe(EXIT_OK);
    expect(writes).toEqual(["2", "2", "\r"]);
  }, 30_000);

  it("kills a Session this CLI did not start", async () => {
    // The ticket's criterion, stated as a test: the PTY below was running
    // before this process existed, and the only thing naming it is a Task id.
    const { killed } = await coreWithSessions();

    const run = await fixture!.run(["session", "kill", "task_live", "--json"], withCore());
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(killed).toEqual(["pty_live"]);
    expect(JSON.parse(run.out.join("\n"))).toEqual({
      taskId: "task_live",
      ptyId: "pty_live",
      killed: true,
    });

    // And it is gone: the second kill finds no PTY and says so rather than
    // reporting a success the Core did not perform.
    const again = await fixture!.run(["session", "kill", "task_live", "--json"], withCore());
    expect(again.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(again.out.join("\n")).error).toContain("no harness running");
  }, 30_000);

  it("says a stopped Session has no transcript rather than printing an empty one", async () => {
    await coreWithSessions();

    const run = await fixture!.run(["session", "logs", "task_done", "--json"], withCore());
    expect(run.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(run.out.join("\n")).error).toContain("no harness running");
    expect(run.err.join("\n")).toContain("actana session logs");
  }, 30_000);

  it("puts nothing but JSON on stdout, on the failing path as well as the happy one", async () => {
    await coreWithSessions();

    for (const argv of [
      ["session", "ls", "--json", "--verbose"],
      ["session", "logs", "task_live", "--json", "--verbose"],
      ["session", "logs", "task_missing", "--json", "--verbose"],
      ["session", "kill", "task_missing", "--json", "--verbose"],
    ]) {
      const run = await fixture!.run(argv, withCore());
      // One document, parsed whole. A single stray progress line would throw.
      expect(() => JSON.parse(run.out.join("\n")), `${argv.join(" ")} put prose on stdout`).not.toThrow();
      expect(run.err.length, `${argv.join(" ")} sent nothing to stderr`).toBeGreaterThan(0);
    }
  }, 30_000);
});
