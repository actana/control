// Issue 895: a cap on live harness PTYs per Core, through the real PtyCore with a fake pty.
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
import { setSpawnConcurrencyForTests } from "../pty-spawn-queue";

const nodePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");


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


describe("the live harness PTY cap (issue 895)", () => {
  const fakes: Array<ReturnType<typeof pty>> = [];
  let prevConcurrency = 0;
  function fireExit(fake: ReturnType<typeof pty>): void {
    for (const [handler] of fake.proc.onExit.mock.calls) (handler as (e: { exitCode: number }) => void)({ exitCode: 0 });
  }
  function makeCore(): PtyCore {
    return new PtyCore({
      userDataDir: os.tmpdir(),
      appPath: os.tmpdir(),
      getHookEnv: () => null,
      getProtectedPorts: () => [],
    } as never);
  }
  function nextFake() {
    const fake = pty();
    fakes.push(fake);
    return fake;
  }
  async function spawnHarness(core: PtyCore, n: number) {
    vi.spyOn(nodePty, "spawn").mockReturnValueOnce(nextFake().proc as never);
    return core.spawn({ sessionId: `t-cap-${n}`, agent: "claude-code", command: "claude" } as never);
  }

  beforeEach(() => {
    prevConcurrency = setSpawnConcurrencyForTests(100);
  });
  afterEach(() => {
    // Free the process-wide PTY map for the next test.
    for (const fake of fakes.splice(0)) fireExit(fake);
    setSpawnConcurrencyForTests(prevConcurrency);
  });

  it("refuses the 9th live harness spawn with a clear error", async () => {
    const core = makeCore();
    for (let i = 0; i < 8; i++) await spawnHarness(core, i);
    await expect(spawnHarness(core, 8)).rejects.toThrow(/8 live harness PTYs.*ACTANA_MAX_LIVE_HARNESS_PTYS/);
  });

  it("does not count user shells, and a shell is never refused", async () => {
    const core = makeCore();
    for (let i = 0; i < 3; i++) {
      vi.spyOn(nodePty, "spawn").mockReturnValueOnce(nextFake().proc as never);
      await core.spawn({ sessionId: `t-shell-${i}`, shell: true } as never);
    }
    for (let i = 0; i < 8; i++) await spawnHarness(core, i);
    vi.spyOn(nodePty, "spawn").mockReturnValueOnce(nextFake().proc as never);
    await expect(core.spawn({ sessionId: "t-shell-late", shell: true } as never)).resolves.toBeDefined();
    await expect(spawnHarness(core, 8)).rejects.toThrow(/live harness PTYs/);
  });

  it("honours ACTANA_MAX_LIVE_HARNESS_PTYS", async () => {
    vi.stubEnv("ACTANA_MAX_LIVE_HARNESS_PTYS", "2");
    const core = makeCore();
    await spawnHarness(core, 0);
    await spawnHarness(core, 1);
    await expect(spawnHarness(core, 2)).rejects.toThrow(/2 live harness PTYs/);
  });

  it.each(["0", "-3", "abc", "", "1.5"])("falls back to 8 for the invalid value %j", async (value) => {
    vi.stubEnv("ACTANA_MAX_LIVE_HARNESS_PTYS", value);
    const core = makeCore();
    for (let i = 0; i < 8; i++) await spawnHarness(core, i);
    await expect(spawnHarness(core, 8)).rejects.toThrow(/8 live harness PTYs/);
  });

  it("frees a slot when a harness PTY exits", async () => {
    vi.stubEnv("ACTANA_MAX_LIVE_HARNESS_PTYS", "2");
    const core = makeCore();
    await spawnHarness(core, 0);
    await spawnHarness(core, 1);
    await expect(spawnHarness(core, 2)).rejects.toThrow(/live harness PTYs/);
    fireExit(fakes[0]!);
    await expect(spawnHarness(core, 3)).resolves.toBeDefined();
  });

  it("counts spawns that are still starting, so a burst cannot slip past the cap", async () => {
    vi.stubEnv("ACTANA_MAX_LIVE_HARNESS_PTYS", "2");
    const core = makeCore();
    const burst = [0, 1, 2, 3].map((n) => spawnHarness(core, n));
    const settled = await Promise.allSettled(burst);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(2);
  });
});
