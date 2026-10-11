// A Session's spawn, in container mode, asks `core` for everything it needs from
// core's home (issue 559, PR 3): the spawn policy's two questions about the disk,
// the statusline tap and the hook files. The daemon itself writes none of it.
//
// The helper is stood in for by the kit; the point here is what *this call site*
// does. Before the change each of these was an `fs` call in the daemon's own
// process, and a workspace ended up with `.claude/settings.local.json` written by
// the wrong user.

import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import log from "@actana/shared/log";

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

const workspace = vi.hoisted(() => ({
  dir: "",
  lookups: [] as string[],
  checks: {} as Record<string, { ok: boolean; reason?: string; version?: string }>,
  /** What the daemon's own lookup (outside the container) resolves to. */
  binary: "/daemon/looked/up/claude",
}));
vi.mock("@actana/shared/harness-cli-resolution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actana/shared/harness-cli-resolution")>();
  return {
    ...actual,
    resolveHarnessCommandMeetingVersion: (name: string) => (workspace.lookups.push(name), { binary: workspace.binary }),
    resolveHarnessCommandOnPath: (name: string) => (workspace.lookups.push(name), workspace.binary),
  };
});
vi.mock("@actana/shared/harness-cli-version", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actana/shared/harness-cli-version")>();
  return { ...actual, checkHarnessCliVersionCached: (binary: string) => workspace.checks[binary] ?? { ok: true } };
});

import { PtyCore } from "../pty-manager";
import { configureCoreHomeOps } from "../core-home-ops-client";
import { cannedHelper } from "./core-home-ops-kit";

const nodePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");

function fakePty() {
  return { pid: 4242, onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn(), destroy: vi.fn() };
}
function core(hookEnv: boolean) {
  return new PtyCore({
    userDataDir: os.tmpdir(),
    appPath: os.tmpdir(),
    getHookEnv: () => (hookEnv ? { apiUrl: "http://127.0.0.1:9", token: "t" } : null),
    getProtectedPorts: () => [],
  } as never);
}
// The workspace is core's home: a Session starts nowhere else (ADR 0041 D2).
function inContainer(home: string = workspace.dir) {
  vi.stubEnv("AC_CORE_HOME", home);
  vi.stubEnv("AC_CORE_UID", "1000");
  vi.stubEnv("AC_CORE_GID", "1000");
  vi.stubEnv("HOME", "/var/lib/actana");
}

beforeEach(() => {
  workspace.lookups = [];
  workspace.checks = {};
  workspace.binary = "/daemon/looked/up/claude";
  workspace.dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "spawn-site-")));
});
afterEach(() => {
  configureCoreHomeOps(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(workspace.dir, { recursive: true, force: true });
});

describe("spawning a Claude Code Session in container mode", () => {
  it("asks core for the path facts, the tap, the trust and the hooks, in that order, and writes none of it itself", async () => {
    inContainer();
    const helper = cannedHelper();
    configureCoreHomeOps(helper.options);
    vi.spyOn(nodePty, "spawn").mockReturnValue(fakePty() as never);

    const result = await core(true).spawn({
      sessionId: "t1",
      agent: "claude-code",
      command: "claude",
    } as never);

    expect(helper.requests.map((r) => r.request.op)).toEqual([
      "spawnPathFacts",
      "resolveCommand",
      "ensureStatuslineTap",
      "pretrustWorkspaces",
      "installHarnessHooks",
    ]);
    expect(helper.requests[0]!.request).toMatchObject({ op: "spawnPathFacts", cwd: workspace.dir });
    expect((helper.requests[0]!.request as { roots: string[] }).roots).toContain(workspace.dir);
    expect(helper.requests[1]!.request).toMatchObject({ op: "resolveCommand", command: "claude" });
    expect(helper.requests[2]!.request).toEqual({ op: "ensureStatuslineTap", cwd: workspace.dir });
    expect(helper.requests[3]!.request).toEqual({ op: "pretrustWorkspaces", harnesses: ["claude-code"], dirs: [workspace.dir] });
    expect(helper.requests[4]!.request).toEqual({ op: "installHarnessHooks", harness: "claude-code", cwd: workspace.dir, piAgentDir: null });
    // The helper said it installed them, so the Session reports its turn starts.
    expect(result.hooksReportTurnStart).toBe(true);
    // And the daemon's own process touched nothing in the workspace.
    expect(fs.readdirSync(workspace.dir)).toEqual([]);
  });

  it("starts no hook install when there is no hook receiver, as before, and still asks for the path facts", async () => {
    inContainer();
    const helper = cannedHelper();
    configureCoreHomeOps(helper.options);
    vi.spyOn(nodePty, "spawn").mockReturnValue(fakePty() as never);
    await core(false).spawn({ sessionId: "t2", agent: "claude-code", command: "claude" } as never);
    expect(helper.requests.map((r) => r.request.op)).toEqual(["spawnPathFacts", "resolveCommand", "ensureStatuslineTap", "pretrustWorkspaces"]);
  });

  it("refuses a home core cannot see, through the policy's own rejection", async () => {
    inContainer();
    configureCoreHomeOps({
      run: async () => ({
        status: 0,
        stdout: JSON.stringify({ ok: true, result: { cwdOk: false, realpaths: { [workspace.dir]: null } } }),
        stderr: "",
      }),
    });
    const spawn = vi.spyOn(nodePty, "spawn").mockReturnValue(fakePty() as never);
    await expect(
      core(true).spawn({ sessionId: "t3", agent: "claude-code", command: "claude" } as never),
    ).rejects.toThrow("pty:spawn rejected (invalid-cwd)");
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("resolving the Harness CLI in container mode", () => {
  function spawnWith(candidates: string[], agent = "claude-code", command = "claude") {
    const seen: Array<Record<string, unknown>> = [];
    configureCoreHomeOps({
      run: async (_spec, input) => {
        const request = JSON.parse(input) as { op: string; cwd?: string; roots?: string[] };
        seen.push(request);
        const result =
          request.op === "spawnPathFacts"
            ? { cwdOk: true, realpaths: Object.fromEntries([request.cwd!, ...request.roots!].map((p) => [p, p])) }
            : request.op === "resolveCommand"
              ? { candidates }
              : request.op === "installHarnessHooks"
                ? { installed: false, reportsTurnStart: false, hookTrustBypassEarned: false }
                : null;
        return { status: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
      },
    });
    const spawn = vi.spyOn(nodePty, "spawn").mockReturnValue(fakePty() as never);
    return { seen, spawn, run: () => core(false).spawn({ sessionId: "tr", agent, command } as never) };
  }

  it("takes the CLI core found, and never looks the command up itself", async () => {
    inContainer();
    const { seen, spawn, run } = spawnWith(["/home/core/.local/bin/claude"]);
    await run();
    expect(workspace.lookups).toEqual([]);
    const request = seen.find((r) => r.op === "resolveCommand")!;
    // core's own `~/.local/bin` leads the PATH it is asked to search: its home is whatever
    // this test made it (the runner's HOME is not core's, and CI's is a temp dir).
    const coreBin = `${workspace.dir}/.local/bin`;
    expect(request).toEqual({ op: "resolveCommand", command: "claude", path: expect.stringMatching(/.+/) });
    expect((request as { path: string }).path.split(":")[0]).toBe(coreBin);
    expect(JSON.stringify(spawn.mock.calls[0])).toContain("/home/core/.local/bin/claude");
  });

  it("picks among core's candidates by version, so an outdated early match does not win", async () => {
    inContainer();
    workspace.checks["/usr/local/bin/claude"] = { ok: false, reason: "outdated", version: "0.1.0" };
    const { spawn, run } = spawnWith(["/usr/local/bin/claude", "/home/core/.local/bin/claude"]);
    await run();
    const target = JSON.stringify(spawn.mock.calls[0]);
    expect(target).toContain("/home/core/.local/bin/claude");
    expect(target).not.toContain("/usr/local/bin/claude");
  });

  it("rejects the spawn as binary-not-found when core finds no CLI, the policy's own rejection", async () => {
    inContainer();
    const { spawn, run } = spawnWith([]);
    await expect(run()).rejects.toThrow("pty:spawn rejected (binary-not-found)");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reads a PATH the helper refuses as finding nothing: binary-not-found, not a raw error", async () => {
    inContainer();
    configureCoreHomeOps({
      run: async (_spec, input) => {
        const request = JSON.parse(input) as { op: string; cwd: string; roots: string[] };
        if (request.op === "resolveCommand") {
          return { status: 2, stdout: JSON.stringify({ ok: false, code: "bad-field", message: "path is too long" }), stderr: "" };
        }
        const realpaths = Object.fromEntries([request.cwd, ...request.roots].map((p) => [p, p]));
        return { status: 0, stdout: JSON.stringify({ ok: true, result: { cwdOk: true, realpaths } }), stderr: "" };
      },
    });
    const spawn = vi.spyOn(nodePty, "spawn").mockReturnValue(fakePty() as never);
    await expect(core(false).spawn({ sessionId: "tp", agent: "claude-code", command: "claude" } as never)).rejects.toThrow(
      "pty:spawn rejected (binary-not-found)",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  // A regression guard, not a test of the change: on the base nothing is ever
  // looked up, so it passes there too. It fails if the own-property check on the
  // agent name goes (`toString` is on every object, and would be "a harness").
  it("regression guard: asks no one about a command for an agent the policy does not know", async () => {
    inContainer();
    // Without the own-property check a function would be sent as the command, refused
    // by the helper's validation (so `seen` stays quiet) and logged: that log is the tell.
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    for (const agent of ["not-a-harness", "toString", "constructor"]) {
      const { seen, run } = spawnWith(["/x"], agent, "claude");
      await expect(run()).rejects.toThrow(/pty:spawn rejected \(/);
      expect(seen.map((r) => r.op), agent).toEqual(["spawnPathFacts"]);
    }
    expect(warn.mock.calls.map((c) => c[0])).not.toContain("pty.spawn.command-lookup-refused");
  });
});

describe("what the spawned pid is to the harness (issue 460)", () => {
  // The hook receiver holds every hook to the spawned pid, climbing through
  // shells; the npm `codex` wrapper keeps a node process alive above the
  // harness, so the Core records at spawn whether it launched a wrapper.
  function spawnWith(found: { candidates: string[]; scripts: string[] }, agent: string, command: string) {
    configureCoreHomeOps({
      run: async (_spec, input) => {
        const request = JSON.parse(input) as { op: string; cwd?: string; roots?: string[] };
        const result =
          request.op === "spawnPathFacts"
            ? { cwdOk: true, realpaths: Object.fromEntries([request.cwd!, ...request.roots!].map((p) => [p, p])) }
            : request.op === "resolveCommand"
              ? found
              : request.op === "installHarnessHooks"
                ? { installed: false, reportsTurnStart: false, hookTrustBypassEarned: false }
                : null;
        return { status: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
      },
    });
    vi.spyOn(nodePty, "spawn").mockReturnValue(fakePty() as never);
    const pty = core(false);
    return pty.spawn({ sessionId: "tl", agent, command } as never).then(() => pty.spawnedProcessForSession("tl"));
  }

  it("records the npm codex wrapper core found as a wrapper, with node-pty's pid", async () => {
    inContainer();
    const wrapper = "/home/core/.local/bin/codex";
    await expect(spawnWith({ candidates: [wrapper], scripts: [wrapper] }, "codex", "codex")).resolves.toEqual({
      pid: 4242,
      launcher: "wrapper",
    });
  });

  it("records a native codex as the harness", async () => {
    inContainer();
    const native = "/home/core/.local/bin/codex";
    await expect(spawnWith({ candidates: [native], scripts: [] }, "codex", "codex")).resolves.toEqual({
      pid: 4242,
      launcher: "harness",
    });
  });

  it("records every other family as the harness, script launcher or not", async () => {
    inContainer();
    const claude = "/home/core/.local/bin/claude";
    await expect(spawnWith({ candidates: [claude], scripts: [claude] }, "claude-code", "claude")).resolves.toEqual({
      pid: 4242,
      launcher: "harness",
    });
  });

  it("outside the container reads the launcher the daemon resolved itself", async () => {
    const wrapper = path.join(workspace.dir, "codex");
    fs.writeFileSync(wrapper, "#!/usr/bin/env node\nimport { spawn } from 'node:child_process';\n", { mode: 0o755 });
    workspace.binary = wrapper;
    vi.spyOn(nodePty, "spawn").mockReturnValue(fakePty() as never);
    const pty = core(false);
    await pty.spawn({ sessionId: "tm", agent: "codex", command: "codex" } as never);
    expect(pty.spawnedProcessForSession("tm")).toEqual({ pid: 4242, launcher: "wrapper" });
    expect(pty.spawnedProcessForSession("no-such-session")).toBeNull();
  });
});

describe("a path the helper will not look at does not fail the spawn with a raw error", () => {
  it("asks about the home and nothing else: a spawn names no other path for core to look at", async () => {
    inContainer();
    const helper = cannedHelper();
    configureCoreHomeOps(helper.options);
    vi.spyOn(nodePty, "spawn").mockReturnValue(fakePty() as never);
    await core(false).spawn({ sessionId: "t6", agent: "claude-code", command: "claude" } as never);
    expect(helper.requests[0]!.request).toMatchObject({ op: "spawnPathFacts", cwd: workspace.dir, roots: [workspace.dir] });
  });

  it("turns the helper's refusal of the home into the policy's invalid-cwd rejection", async () => {
    // A home too long for the helper to look at (an env var cannot carry a NUL).
    inContainer(`/${"x".repeat(5000)}`);
    configureCoreHomeOps(cannedHelper().options);
    const spawn = vi.spyOn(nodePty, "spawn").mockReturnValue(fakePty() as never);
    await expect(
      core(false).spawn({ sessionId: "t7", agent: "claude-code", command: "claude" } as never),
    ).rejects.toThrow("pty:spawn rejected (invalid-cwd)");
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("spawning outside container mode", () => {
  it("starts a Session in the home directory when the spawn names no project and no cwd", async () => {
    vi.stubEnv("HOME", workspace.dir);
    const pty = vi.spyOn(nodePty, "spawn").mockReturnValue(fakePty() as never);
    await core(false).spawn({ sessionId: "t8", agent: "claude-code", command: "claude" } as never);
    expect(pty).toHaveBeenCalledTimes(1);
    expect((pty.mock.calls[0]![2] as { cwd: string }).cwd).toBe(workspace.dir);
  });

  it("asks no helper for anything: the policy and the writers run in this process as before", async () => {
    vi.stubEnv("HOME", workspace.dir);
    const helperRequests: string[] = [];
    configureCoreHomeOps({ run: async (_s, input) => (helperRequests.push(input), { status: 0, stdout: "{}", stderr: "" }) });
    vi.spyOn(nodePty, "spawn").mockReturnValue(fakePty() as never);
    await core(true).spawn({ sessionId: "t5", agent: "claude-code", command: "claude" } as never);
    expect(helperRequests).toEqual([]);
    // In process, the hook file is written by the daemon, exactly as before.
    expect(fs.existsSync(path.join(workspace.dir, ".claude", "settings.local.json"))).toBe(true);
  });
});
