// Issue 563: the standard block through the real PtyCore.spawn, with a fake pty and fake timers.
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

import { PtyCore } from "../pty-manager";
import { configureCoreHomeOps } from "../core-home-ops-client";

import { buildPromptBlock, PROMPT_BLOCK_VERSION } from "../prompt-standard-block";
const nodePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");

// Issue 563: a Session's starting prompt reaches the harness with the standard
// block after the user's text, once, and the Core reports which version it was.

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

describe("a starting prompt through PtyCore.spawn", () => {
  it("ends with the standard block exactly once, and reports the block version it carried", async () => {
    const fake = pty();
    vi.spyOn(nodePty, "spawn").mockReturnValue(fake.proc as never);
    const delivered: Array<Record<string, unknown>> = [];
    const core = new PtyCore({
      userDataDir: os.tmpdir(),
      appPath: os.tmpdir(),
      getHookEnv: () => null,
      getProtectedPorts: () => [],
      onSessionPromptDelivered: (info: Record<string, unknown>) => void delivered.push(info),
    } as never);

    await core.spawn({ sessionId: "t-abc", agent: "claude-code", command: "claude", initialInput: "fix the bug" } as never);
    const composer = 'Try "fix the bug"';
    fake.emit(composer);
    for (let second = 0; second < 30; second++) {
      await vi.advanceTimersByTimeAsync(1_000);
      const last = fake.writes.filter((w) => w !== "\r").at(-1);
      if (last) fake.emit(`\u001B[2J\u001B[H${composer}\n> ${last}`);
    }

    const typed = fake.writes.filter((w) => w !== "\r");
    expect(typed).toEqual([`fix the bug ${buildPromptBlock({ sessionId: "t-abc", turn: 1 })}`]);
    expect(fake.writes.at(-1)).toBe("\r");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ sessionId: "t-abc", promptBlockVersion: PROMPT_BLOCK_VERSION });
  });

  it("appends nothing, and reports no version, when the Session has no starting prompt", async () => {
    const fake = pty();
    vi.spyOn(nodePty, "spawn").mockReturnValue(fake.proc as never);
    const core = new PtyCore({
      userDataDir: os.tmpdir(),
      appPath: os.tmpdir(),
      getHookEnv: () => null,
      getProtectedPorts: () => [],
    } as never);
    await core.spawn({ sessionId: "t-none", agent: "claude-code", command: "claude" } as never);
    fake.emit('Try "x"');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fake.writes).toEqual([]);
  });
});
