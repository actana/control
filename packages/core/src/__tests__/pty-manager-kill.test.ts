// Issue 292: a kill through the real PtyCore, with a fake pty and fake timers.
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & Record<string, any>;
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      setImmediate(() => child.emit("close", 0));
      return child;
    },
    spawnSync: () => ({ status: 0, stdout: "", stderr: "", error: undefined }),
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const existsSync = (p: string) => (typeof p === "string" && p.endsWith("/setpriv") ? true : actual.existsSync(p));
  return { ...actual, default: { ...actual, existsSync }, existsSync };
});

const workspace = vi.hoisted(() => ({ dir: "", lookups: [] as string[], checks: {} as Record<string, { ok: boolean; reason?: string; version?: string }> }));
vi.mock("@actana/shared/harness-cli-resolution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actana/shared/harness-cli-resolution")>();
  return {
    ...actual,
    resolveHarnessCommandMeetingVersion: (name: string) => (workspace.lookups.push(name), { binary: "/daemon/looked/up/claude" }),
    resolveHarnessCommandOnPath: (name: string) => (workspace.lookups.push(name), "/daemon/looked/up/claude"),
  };
});
vi.mock("@actana/shared/harness-cli-version", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actana/shared/harness-cli-version")>();
  return { ...actual, checkHarnessCliVersionCached: (binary: string) => workspace.checks[binary] ?? { ok: true } };
});

import { PtyCore, type PtySessionExit } from "../pty-manager";
import { CLIENT_KILL_REASON } from "../session-kill";
import { configureCoreHomeOps } from "../core-home-ops-client";

const nodePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");

// Issue 292: a requested kill travels with the exit. A harness that catches the
// hang-up and exits 0 must still reach `onSessionExit` as a kill, and the
// signal node-pty reports must not be dropped on the way.

function pty() {
  const data: Array<(chunk: string) => void> = [];
  const writes: string[] = [];
  return {
    writes,
    emit: (chunk: string) => data.forEach((fn) => fn(chunk)),
    proc: {
      pid: 4242,
      onData: (fn: (chunk: string) => void) => void data.push(fn),
      onExit: vi.fn(),
      write: (w: string) => void writes.push(w),
      resize: vi.fn(),
      kill: vi.fn(),
      destroy: vi.fn(),
    },
  };
}

beforeEach(() => {
  workspace.lookups = [];
  workspace.checks = {};
  workspace.dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prompt-block-")));
  vi.stubEnv("AC_CORE_HOME", workspace.dir);
  vi.stubEnv("AC_CORE_UID", "1000");
  vi.stubEnv("AC_CORE_GID", "1000");
  vi.stubEnv("HOME", "/var/lib/actana");
  configureCoreHomeOps({
    run: async (_spec, input) => {
      const request = JSON.parse(input) as { op: string; cwd?: string; roots?: string[] };
      const result =
        request.op === "spawnPathFacts"
          ? { cwdOk: true, realpaths: Object.fromEntries([request.cwd!, ...request.roots!].map((p) => [p, p])) }
          : request.op === "resolveCommand"
            ? { candidates: ["/bin/claude"] }
            : request.op === "installHarnessHooks"
              ? { installed: false, reportsTurnStart: false, hookTrustBypassEarned: false }
              : null;
      return { status: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
    },
  });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  configureCoreHomeOps(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(workspace.dir, { recursive: true, force: true });
});

describe("a kill through PtyCore (issue 292)", () => {
  type Exit = { exitCode: number; signal?: number };
  function fireExit(fake: ReturnType<typeof pty>, exit: Exit): void {
    for (const [handler] of fake.proc.onExit.mock.calls) (handler as (e: Exit) => void)(exit);
  }
  function makeCore(exits: PtySessionExit[]): PtyCore {
    return new PtyCore({
      userDataDir: os.tmpdir(),
      appPath: os.tmpdir(),
      getHookEnv: () => null,
      getProtectedPorts: () => [],
      onSessionExit: (info: PtySessionExit) => void exits.push(info),
    } as never);
  }

  it("reports a requested kill, its time and reason, with the exit that follows it", async () => {
    const fake = pty();
    vi.spyOn(nodePty, "spawn").mockReturnValue(fake.proc as never);
    const exits: PtySessionExit[] = [];
    const core = makeCore(exits);
    const { ptyId } = await core.spawn({ sessionId: "t-kill", agent: "claude-code", command: "claude" } as never);

    vi.setSystemTime(Date.UTC(2026, 7, 20, 11, 13, 0));
    expect(core.kill(ptyId, CLIENT_KILL_REASON)).toBe(true);
    expect(fake.proc.destroy).toHaveBeenCalledTimes(1);
    // The harness caught the hang-up and exited cleanly: the shape that read `finished`.
    fireExit(fake, { exitCode: 0, signal: 0 });

    expect(exits).toEqual([
      {
        sessionId: "t-kill",
        ptyId,
        exitCode: 0,
        signal: 0,
        kill: { at: Date.UTC(2026, 7, 20, 11, 13, 0), reason: CLIENT_KILL_REASON },
      },
    ]);
  });

  it("carries the signal of an exit nobody asked for, and no kill", async () => {
    const fake = pty();
    vi.spyOn(nodePty, "spawn").mockReturnValue(fake.proc as never);
    const exits: PtySessionExit[] = [];
    const core = makeCore(exits);
    const { ptyId } = await core.spawn({ sessionId: "t-sig", agent: "claude-code", command: "claude" } as never);

    fireExit(fake, { exitCode: 0, signal: 9 });

    expect(exits).toEqual([{ sessionId: "t-sig", ptyId, exitCode: 0, signal: 9 }]);
  });

  it("records no kill for a teardown that names no reason", async () => {
    const fake = pty();
    vi.spyOn(nodePty, "spawn").mockReturnValue(fake.proc as never);
    const exits: PtySessionExit[] = [];
    const core = makeCore(exits);
    const { ptyId } = await core.spawn({ sessionId: "t-quiet", agent: "claude-code", command: "claude" } as never);

    core.kill(ptyId);
    fireExit(fake, { exitCode: 0 });

    expect(exits).toEqual([{ sessionId: "t-quiet", ptyId, exitCode: 0 }]);
  });
});
