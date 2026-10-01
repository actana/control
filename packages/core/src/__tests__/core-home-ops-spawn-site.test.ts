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

const workspace = vi.hoisted(() => ({ dir: "", roots: null as string[] | null }));
vi.mock("../project-roots", () => ({ loadProjectRoots: () => workspace.roots ?? [workspace.dir] }));
vi.mock("@actana/shared/harness-cli-resolution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actana/shared/harness-cli-resolution")>();
  return {
    ...actual,
    resolveHarnessCommandMeetingVersion: () => ({ binary: "/home/core/.local/bin/claude" }),
    resolveHarnessCommandOnPath: () => "/home/core/.local/bin/claude",
  };
});
vi.mock("@actana/shared/harness-cli-version", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actana/shared/harness-cli-version")>();
  return { ...actual, checkHarnessCliVersionCached: () => ({ ok: true }) };
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
function inContainer() {
  vi.stubEnv("AC_CORE_HOME", path.dirname(workspace.dir));
  vi.stubEnv("AC_CORE_UID", "1000");
  vi.stubEnv("AC_CORE_GID", "1000");
  vi.stubEnv("HOME", "/var/lib/actana");
}

beforeEach(() => {
  workspace.roots = null;
  workspace.dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "spawn-site-")));
});
afterEach(() => {
  configureCoreHomeOps(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(workspace.dir, { recursive: true, force: true });
});

describe("spawning a Claude Code Session in container mode", () => {
  it("asks core for the path facts, the tap and the hooks, in that order, and writes none of it itself", async () => {
    inContainer();
    const helper = cannedHelper();
    configureCoreHomeOps(helper.options);
    vi.spyOn(nodePty, "spawn").mockReturnValue(fakePty() as never);

    const result = await core(true).spawn({
      taskId: "t1",
      cwd: workspace.dir,
      agent: "claude-code",
      command: "claude",
    } as never);

    expect(helper.requests.map((r) => r.request.op)).toEqual(["spawnPathFacts", "ensureStatuslineTap", "installHarnessHooks"]);
    expect(helper.requests[0]!.request).toMatchObject({ op: "spawnPathFacts", cwd: workspace.dir });
    expect((helper.requests[0]!.request as { roots: string[] }).roots).toContain(workspace.dir);
    expect(helper.requests[1]!.request).toEqual({ op: "ensureStatuslineTap", cwd: workspace.dir });
    expect(helper.requests[2]!.request).toEqual({ op: "installHarnessHooks", harness: "claude-code", cwd: workspace.dir, piAgentDir: null });
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
    await core(false).spawn({ taskId: "t2", cwd: workspace.dir, agent: "claude-code", command: "claude" } as never);
    expect(helper.requests.map((r) => r.request.op)).toEqual(["spawnPathFacts", "ensureStatuslineTap"]);
  });

  it("refuses a cwd core cannot see, through the policy's own rejection", async () => {
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
      core(true).spawn({ taskId: "t3", cwd: workspace.dir, agent: "claude-code", command: "claude" } as never),
    ).rejects.toThrow("pty:spawn rejected (invalid-cwd)");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("drops a project root that core reports as unreachable, so a cwd under it is rejected", async () => {
    inContainer();
    const other = path.join(workspace.dir, "sub");
    fs.mkdirSync(other);
    configureCoreHomeOps({
      run: async (_spec, input) => {
        const { cwd, roots } = JSON.parse(input) as { cwd: string; roots: string[] };
        // core can see the cwd, but the registered root is one it cannot resolve.
        const realpaths: Record<string, string | null> = Object.fromEntries(roots.map((r) => [r, null]));
        realpaths[cwd] = cwd;
        return { status: 0, stdout: JSON.stringify({ ok: true, result: { cwdOk: true, realpaths } }), stderr: "" };
      },
    });
    const spawn = vi.spyOn(nodePty, "spawn").mockReturnValue(fakePty() as never);
    await expect(core(false).spawn({ taskId: "t4", cwd: other, agent: "claude-code", command: "claude" } as never)).rejects.toThrow(
      "pty:spawn rejected (cwd-outside-project-roots)",
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("a path the helper will not look at does not fail the spawn with a raw error", () => {
  it("sends only roots the helper accepts, so one bad or surplus root cannot fail every spawn", async () => {
    inContainer();
    const helper = cannedHelper();
    configureCoreHomeOps(helper.options);
    vi.spyOn(nodePty, "spawn").mockReturnValue(fakePty() as never);
    workspace.roots = [
      workspace.dir,
      "",
      "x".repeat(5000),
      "a\0b",
      ...Array.from({ length: 300 }, (_, i) => `/srv/root-${i}`),
    ];
    await core(false).spawn({ taskId: "t6", cwd: workspace.dir, agent: "claude-code", command: "claude" } as never);
    const roots = (helper.requests[0]!.request as { roots: string[] }).roots;
    expect(roots).toContain(workspace.dir);
    expect(roots[0]).toBe(path.dirname(workspace.dir)); // core home first: it is what a home shell needs
    expect(roots.length).toBe(256);
    expect(roots.every((r) => r.length > 0 && r.length <= 4096 && !r.includes("\0"))).toBe(true);
  });

  it("turns the helper's refusal of the cwd into the policy's invalid-cwd rejection", async () => {
    inContainer();
    configureCoreHomeOps(cannedHelper().options);
    const spawn = vi.spyOn(nodePty, "spawn").mockReturnValue(fakePty() as never);
    await expect(
      core(false).spawn({ taskId: "t7", cwd: `${workspace.dir}/a\0b`, agent: "claude-code", command: "claude" } as never),
    ).rejects.toThrow("pty:spawn rejected (invalid-cwd)");
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("spawning outside container mode", () => {
  it("asks no helper for anything: the policy and the writers run in this process as before", async () => {
    const helperRequests: string[] = [];
    configureCoreHomeOps({ run: async (_s, input) => (helperRequests.push(input), { status: 0, stdout: "{}", stderr: "" }) });
    vi.spyOn(nodePty, "spawn").mockReturnValue(fakePty() as never);
    await core(true).spawn({ taskId: "t5", cwd: workspace.dir, agent: "claude-code", command: "claude" } as never);
    expect(helperRequests).toEqual([]);
    // In process, the hook file is written by the daemon, exactly as before.
    expect(fs.existsSync(path.join(workspace.dir, ".claude", "settings.local.json"))).toBe(true);
  });
});
