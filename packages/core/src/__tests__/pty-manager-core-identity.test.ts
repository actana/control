// Session PTYs and their teardown in container mode (issue 559, PR 2).
//
// node-pty's own `uid`/`gid` options keep the daemon's capabilities, so they are
// never used: the PTY is `setpriv` -> `core`, built by `asCore`. Teardown cannot
// `kill(2)` a process of another uid, so it goes through `killAsCore`.

import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncCalls = vi.hoisted(
  () => [] as Array<{ command: string; args: string[]; options: Record<string, any> }>,
);
const spawnCalls = vi.hoisted(
  () => [] as Array<{ command: string; args: string[]; options: Record<string, any> }>,
);
const setprivPresent = vi.hoisted(() => ({ value: true }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    // The wrapped kill is an async spawn; lsof and taskkill are spawnSync.
    spawn: (command: string, args: string[], options: Record<string, any>) => {
      spawnCalls.push({ command, args, options });
      const child = new EventEmitter() as EventEmitter & Record<string, any>;
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      setImmediate(() => child.emit("close", 0));
      return child;
    },
    spawnSync: (command: string, args: string[], options: Record<string, any>) => {
      spawnSyncCalls.push({ command, args, options });
      return { status: 0, stdout: "", stderr: "", error: undefined };
    },
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const existsSync = (p: string) =>
    typeof p === "string" && p.endsWith("/setpriv") ? setprivPresent.value : actual.existsSync(p);
  return { ...actual, default: { ...actual, existsSync }, existsSync };
});

import { disposePty, ensureClaudeShiftEnterBinding, PtyCore } from "../pty-manager";
import { configureCoreHomeOps } from "../core-home-ops-client";
import { cannedHelper, inProcessHelper } from "./core-home-ops-kit";

const nodePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");

function inContainer(home = "/home/core") {
  vi.stubEnv("AC_CORE_HOME", home);
  vi.stubEnv("AC_CORE_UID", "1000");
  vi.stubEnv("AC_CORE_GID", "1000");
  vi.stubEnv("HOME", "/var/lib/actana");
  vi.stubEnv("AC_USER_DATA_DIR", "/var/lib/actana/data");
  vi.stubEnv("AC_SECRETS_KEY", "daemon-secret");
}

beforeEach(() => {
  spawnSyncCalls.length = 0;
  spawnCalls.length = 0;
  setprivPresent.value = true;
});
afterEach(() => {
  configureCoreHomeOps(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakePty() {
  return {
    pid: 4242,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    destroy: vi.fn(),
  };
}

function core() {
  return new PtyCore({
    userDataDir: os.tmpdir(),
    appPath: os.tmpdir(),
    getHookEnv: () => null,
    getProtectedPorts: () => [],
  });
}

describe("PtyCore.spawn", () => {
  it("starts a VM shell as core: setpriv argv, no uid/gid options, core's env, core's home", async () => {
    inContainer();
    configureCoreHomeOps(cannedHelper().options);
    const spawn = vi.spyOn(nodePty, "spawn").mockReturnValue(fakePty() as never);
    await core().spawn({ sessionId: "t1", shellSession: true } as never);

    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0]! as [string, string[], Record<string, any>];
    expect(command).toBe("/usr/bin/setpriv");
    expect(args.slice(0, 7)).toEqual([
      "--reuid=1000",
      "--regid=1000",
      "--clear-groups",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--no-new-privs",
      "--",
    ]);
    expect(args.slice(7, 10)).toEqual(["/bin/sh", "-c", 'cd -- "$0" && exec "$@"']);
    // The VM shell opens in core's home and runs core's shell, not the daemon's.
    expect(args[10]).toBe("/home/core");
    expect(args[11]).toBe("/bin/bash");
    // node-pty's own switch keeps the capabilities: never passed.
    expect(options).not.toHaveProperty("uid");
    expect(options).not.toHaveProperty("gid");
    expect(options.cwd).toBe("/");
    expect(options.env.HOME).toBe("/home/core");
    expect(options.env.USER).toBe("core");
    expect(options.env.SHELL).toBe("/bin/bash");
    expect(JSON.stringify(options.env)).not.toContain("/var/lib/actana");
    expect(JSON.stringify(options.env)).not.toContain("daemon-secret");
  });

  it("refuses to start the PTY when setpriv is missing", async () => {
    inContainer();
    configureCoreHomeOps(cannedHelper().options);
    setprivPresent.value = false;
    const spawn = vi.spyOn(nodePty, "spawn").mockReturnValue(fakePty() as never);
    await expect(core().spawn({ sessionId: "t2", shellSession: true } as never)).rejects.toThrow(
      /setpriv is not in/,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("is unchanged outside container mode: the shell itself, the real home, no wrapper", async () => {
    const spawn = vi.spyOn(nodePty, "spawn").mockReturnValue(fakePty() as never);
    await core().spawn({ sessionId: "t3", shellSession: true } as never);
    const [command, args, options] = spawn.mock.calls[0]! as [string, string[], Record<string, any>];
    expect(command).not.toContain("setpriv");
    expect(args).not.toContain("--reuid=1000");
    expect(options.cwd).toBe(os.homedir());
  });
});

describe("disposePty in container mode", () => {
  it("SIGKILLs the process group as core if the Session outlives the hang-up", () => {
    vi.useFakeTimers();
    inContainer();
    const proc = fakePty();
    disposePty(proc as never);
    expect(proc.destroy).toHaveBeenCalledTimes(1);
    expect(spawnCalls).toHaveLength(0);

    vi.advanceTimersByTime(1_499);
    expect(spawnCalls).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0]!;
    expect(call.command).toBe("/usr/bin/setpriv");
    expect(call.args).toContain("--reuid=1000");
    expect(call.args.slice(-2)).toEqual(["KILL", "-4242"]);
  });

  it("does not signal a Session that has exited", () => {
    vi.useFakeTimers();
    inContainer();
    const proc = fakePty();
    disposePty(proc as never);
    (proc.onExit.mock.calls[0]![0] as () => void)();
    vi.advanceTimersByTime(5_000);
    expect(spawnCalls).toHaveLength(0);
  });

  it("arms nothing outside container mode", () => {
    vi.useFakeTimers();
    const proc = fakePty();
    disposePty(proc as never);
    vi.advanceTimersByTime(5_000);
    expect(proc.onExit).not.toHaveBeenCalled();
    expect(spawnCalls).toHaveLength(0);
  });

  it("the no-destroy fallback signals as core, not with the handle's own kill", () => {
    inContainer();
    const proc = { pid: 4242, kill: vi.fn() };
    disposePty(proc as never);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.args.slice(-2)).toEqual(["HUP", "4242"]);
  });
});

describe("ensureClaudeShiftEnterBinding", () => {
  it("writes into core's home, not the daemon's (through the helper)", async () => {
    const coreHome = fs.mkdtempSync(path.join(os.tmpdir(), "core-home-"));
    const daemonHome = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-home-"));
    try {
      inContainer(coreHome);
      vi.stubEnv("HOME", daemonHome);
      const helper = inProcessHelper(coreHome);
      configureCoreHomeOps(helper.options);
      await ensureClaudeShiftEnterBinding();
      expect(helper.requests.map((r) => r.request.op)).toEqual(["ensureClaudeShiftEnterBinding"]);
      expect(fs.existsSync(path.join(coreHome, ".claude", "settings.json"))).toBe(true);
      expect(fs.existsSync(path.join(daemonHome, ".claude"))).toBe(false);
    } finally {
      fs.rmSync(coreHome, { recursive: true, force: true });
      fs.rmSync(daemonHome, { recursive: true, force: true });
    }
  });
});
