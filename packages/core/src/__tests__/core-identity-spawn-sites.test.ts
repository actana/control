// Every child the daemon starts goes through `asCore` (issue 559, PR 2).
//
// `node:child_process` is replaced so the test sees the exact argv, cwd and env
// each site hands the OS. The argv itself is pinned in
// `packages/shared/src/__tests__/core-home.test.ts`; here the claim is that
// *these call sites* use it, and that outside the container they spawn exactly
// what they always did.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => ({
  spawn: [] as Array<{ command: string; args: string[]; options: Record<string, any> }>,
  spawnSync: [] as Array<{ command: string; args: string[]; options: Record<string, any> }>,
}));
const setprivPresent = vi.hoisted(() => ({ value: true }));
// A command that never finishes on its own: only its timeout ends it.
const hang = vi.hoisted(() => ({ value: false }));

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[], options: Record<string, any>) => {
    spawned.spawn.push({ command, args, options });
    const child = new EventEmitter() as EventEmitter & Record<string, any>;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.pid = 4242;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => true);
    const isWrappedKill = args.some((a) => a.startsWith("kill -s"));
    if (isWrappedKill) {
      // The wrapped kill itself fails, as it does on ESRCH or a wrapper timeout.
      setImmediate(() => {
        child.stderr.emit("data", Buffer.from("sh: 1: kill: No such process"));
        child.emit("close", 1);
      });
    } else if (!hang.value) {
      setImmediate(() => {
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
    }
    return child;
  },
  spawnSync: (command: string, args: string[], options: Record<string, any>) => {
    spawned.spawnSync.push({ command, args, options });
    return { status: 0, stdout: "", stderr: "", error: undefined };
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const existsSync = (p: string) =>
    typeof p === "string" && p.endsWith("/setpriv") ? setprivPresent.value : actual.existsSync(p);
  return { ...actual, default: { ...actual, existsSync }, existsSync };
});

import { runCoreExec } from "../core-exec";
import { runCli } from "../harness-cli-run";
import { daemonHarnessSystem } from "../core-harness-system";
import log from "@actana/shared/log";

const SCRIPT = 'cd -- "$0" && exec "$@"';

function inContainer() {
  vi.stubEnv("AC_CORE_HOME", "/home/core");
  vi.stubEnv("AC_CORE_UID", "1000");
  vi.stubEnv("AC_CORE_GID", "1000");
  // What the daemon's own environment looks like in the image.
  vi.stubEnv("HOME", "/var/lib/actana");
  vi.stubEnv("USER", "actana");
  vi.stubEnv("AC_USER_DATA_DIR", "/var/lib/actana/data");
  vi.stubEnv("AC_CORE_MATERIAL_FILE", "/var/lib/actana/config/material.json");
  vi.stubEnv("AC_SECRETS_KEY", "daemon-secret");
}

beforeEach(() => {
  spawned.spawn.length = 0;
  spawned.spawnSync.length = 0;
  setprivPresent.value = true;
  hang.value = false;
});
afterEach(() => vi.unstubAllEnvs());

function expectWrapped(call: { command: string; args: string[]; options: Record<string, any> }, inner: string[]) {
  expect(call.command).toBe("/usr/bin/setpriv");
  expect(call.args.slice(0, 7)).toEqual([
    "--reuid=1000",
    "--regid=1000",
    "--clear-groups",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--no-new-privs",
    "--",
  ]);
  expect(call.args.slice(7, 10)).toEqual(["/bin/sh", "-c", SCRIPT]);
  expect(call.args.slice(11)).toEqual(inner);
  expect(call.options.cwd).toBe("/");
  const env = call.options.env as Record<string, string>;
  expect(env.HOME).toBe("/home/core");
  expect(env.USER).toBe("core");
  expect(env.LOGNAME).toBe("core");
  expect(env.SHELL).toBe("/bin/bash");
  expect(env.PATH.split(":")[0]).toBe("/home/core/.local/bin");
  expect(JSON.stringify(env)).not.toContain("/var/lib/actana");
  expect(JSON.stringify(env)).not.toContain("daemon-secret");
}

describe("core exec", () => {
  it("starts the command as core, in the requested directory, with core's env", async () => {
    inContainer();
    await runCoreExec({ command: "id", args: ["-un"], cwd: "/tmp" });
    expect(spawned.spawn).toHaveLength(1);
    expectWrapped(spawned.spawn[0]!, ["id", "-un"]);
    expect(spawned.spawn[0]!.args[10]).toBe("/tmp");
  });

  it("refuses to run when setpriv is missing, and spawns nothing", async () => {
    inContainer();
    setprivPresent.value = false;
    await expect(runCoreExec({ command: "id", args: [], cwd: "/tmp" })).rejects.toThrow(
      /setpriv is not in.*would run as the daemon instead of as core/,
    );
    expect(spawned.spawn).toHaveLength(0);
  });

  it("is unchanged outside container mode: the bare command, the real cwd", async () => {
    await runCoreExec({ command: "id", args: ["-un"], cwd: "/tmp" });
    expect(spawned.spawn[0]!.command).toBe("id");
    expect(spawned.spawn[0]!.args).toEqual(["-un"]);
    expect(spawned.spawn[0]!.options.cwd).toBe("/tmp");
  });
});

describe("headless Harness calls", () => {
  it("run as core", async () => {
    inContainer();
    await runCli("claude", ["-p", "hi"], { cwd: "/tmp" });
    expect(spawned.spawn).toHaveLength(1);
    const call = spawned.spawn[0]!;
    expect(call.command).toBe("/usr/bin/setpriv");
    expect(call.args.slice(11).slice(1)).toEqual(["-p", "hi"]);
    expect(call.args[10]).toBe("/tmp");
    expect(call.options.env.HOME).toBe("/home/core");
  });

  it("are unchanged outside container mode", async () => {
    await runCli("claude", ["-p", "hi"], { cwd: "/tmp" });
    expect(spawned.spawn[0]!.args).toEqual(["-p", "hi"]);
    expect(spawned.spawn[0]!.options.cwd).toBe("/tmp");
  });
});

describe("Harness installs", () => {
  it("run the installer as core, with and without a captured result", async () => {
    inContainer();
    const system = daemonHarnessSystem();
    system.run("npm", ["prefix", "-g"]);
    await system.passthrough("sh", ["-c", "true"]);
    expect(spawned.spawnSync).toHaveLength(1);
    expectWrapped(spawned.spawnSync[0]!, ["npm", "prefix", "-g"]);
    expect(spawned.spawn).toHaveLength(1);
    expectWrapped(spawned.spawn[0]!, ["sh", "-c", "true"]);
    // The installer starts in core's home, not wherever the daemon was started.
    expect(spawned.spawn[0]!.args[10]).toBe("/home/core");
  });

  it("are unchanged outside container mode", async () => {
    const system = daemonHarnessSystem();
    system.run("npm", ["prefix", "-g"]);
    expect(spawned.spawnSync[0]).toMatchObject({ command: "npm", args: ["prefix", "-g"] });
    expect(spawned.spawnSync[0]!.options.env).toBeUndefined();
  });
});

describe("a failing wrapped kill cannot strand a caller", () => {
  it("core exec still rejects with its timeout sentence, and the failure is a log line", async () => {
    inContainer();
    hang.value = true;
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await expect(runCoreExec({ command: "sleep", args: ["9"], cwd: "/tmp", timeoutMs: 20 })).rejects.toThrow(
        /did not finish within/,
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(warn.mock.calls.map((c) => c[0])).toContain("core-exec.kill.failed");
      expect(JSON.stringify(warn.mock.calls)).toContain("No such process");
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      warn.mockRestore();
    }
  });

  it("a headless Harness call still rejects with its timeout, and logs the failed kill", async () => {
    inContainer();
    hang.value = true;
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      await expect(runCli("claude", ["-p", "hi"], { timeoutMs: 20 })).rejects.toThrow("timeout");
      await new Promise((r) => setTimeout(r, 20));
      expect(warn.mock.calls.map((c) => c[0])).toContain("harness-cli-run.kill.failed");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a refused spawn in the Harness install port", () => {
  it("run() returns status 127 with the refusal, as it does for any failed run", () => {
    inContainer();
    setprivPresent.value = false;
    const result = daemonHarnessSystem().run("npm", ["prefix", "-g"]);
    expect(result.status).toBe(127);
    expect(result.stderr).toMatch(/setpriv is not in/);
    expect(spawned.spawnSync).toHaveLength(0);
  });

  it("passthrough() resolves 127 instead of rejecting", async () => {
    inContainer();
    setprivPresent.value = false;
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    await expect(daemonHarnessSystem().passthrough("sh", ["-c", "true"])).resolves.toBe(127);
    expect(error.mock.calls[0]![0]).toMatch(/setpriv is not in/);
    error.mockRestore();
    expect(spawned.spawn).toHaveLength(0);
  });
});
