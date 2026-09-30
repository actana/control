// `killAsCore` — the only way the daemon signals a Session's process (issue 559).
//
// In the container the daemon is another uid with no CAP_KILL, so the signal is
// sent by a short-lived process that is `core`. Outside it, nothing changes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import log from "@actana/shared/log";
import { killAsCore, killAsCoreQuietly } from "../core-identity";

const CONTAINER = { AC_CORE_HOME: "/home/core", AC_CORE_UID: "1000", AC_CORE_GID: "1000" };
const exists = () => true;

// Never a real signal, whatever the code under test does: a mutated killAsCore
// must fail these tests, not kill the runner's own process group.
beforeEach(() => {
  vi.spyOn(process, "kill").mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

type Spec = { command: string; args: string[] };
const okRun = () => vi.fn(async (_spec: Spec) => ({ status: 0 as number | null, stderr: "" }));

describe("killAsCore outside container mode", () => {
  it("calls the handle's own kill, as the call sites did before, synchronously", async () => {
    const kill = vi.fn(() => true);
    const done = killAsCore({ pid: 4242, kill }, "SIGTERM", { identityEnv: {} });
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(await done).toBe(true);
  });

  it("passes no signal through when none is given, as `proc.kill()` did", async () => {
    const kill = vi.fn(() => true);
    await killAsCore({ pid: 4242, kill }, undefined, { identityEnv: {} });
    expect(kill).toHaveBeenCalledWith(undefined);
  });

  it("calls process.kill for a bare pid, and rejects with its error", async () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await killAsCore(4242, "SIGKILL", { identityEnv: {} })).toBe(true);
    expect(spy).toHaveBeenCalledWith(4242, "SIGKILL");

    spy.mockImplementation(() => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    });
    await expect(killAsCore(4242, "SIGKILL", { identityEnv: {} })).rejects.toThrow(/ESRCH/);
  });

  it("does not spawn anything", async () => {
    const run = okRun();
    vi.spyOn(process, "kill").mockImplementation(() => true);
    await killAsCore({ pid: 1234, kill: () => true }, "SIGTERM", { identityEnv: {}, run });
    await killAsCore(1234, "SIGTERM", { identityEnv: {}, run });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("killAsCore in container mode", () => {
  it("never signals itself: the wrapped kill runs as core instead", async () => {
    const kill = vi.fn();
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const run = okRun();
    expect(await killAsCore({ pid: 4242, kill }, "SIGKILL", { identityEnv: CONTAINER, exists, run })).toBe(true);
    expect(kill).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    const spec = run.mock.calls[0]![0];
    expect(spec.command).toBe("/usr/bin/setpriv");
    expect(spec.args).toContain("--reuid=1000");
    expect(spec.args.slice(-4)).toEqual(['kill -s "$1" -- "$2"', "sh", "KILL", "4242"]);
  });

  it("defaults to SIGHUP, node-pty's own default", async () => {
    const run = okRun();
    await killAsCore({ pid: 4242, kill: vi.fn() }, undefined, { identityEnv: CONTAINER, exists, run });
    expect(run.mock.calls[0]![0].args.slice(-2)).toEqual(["HUP", "4242"]);
  });

  it("signals a process group with a negative pid", async () => {
    const run = okRun();
    await killAsCore(-4242, "SIGTERM", { identityEnv: CONTAINER, exists, run });
    expect(run.mock.calls[0]![0].args.slice(-2)).toEqual(["TERM", "-4242"]);
  });

  it("rejects with the kill's own stderr when it fails", async () => {
    const run = async () => ({ status: 1, stderr: "sh: 1: kill: No such process\n" });
    await expect(killAsCore(4242, "SIGKILL", { identityEnv: CONTAINER, exists, run })).rejects.toThrow(
      /kill SIGKILL 4242 as core failed \(exit 1\): sh: 1: kill: No such process/,
    );
  });

  it("rejects when the wrapper could not even start", async () => {
    const run = async () => ({ status: null, error: new Error("spawn ENOENT") });
    await expect(killAsCore(4242, "SIGKILL", { identityEnv: CONTAINER, exists, run })).rejects.toThrow(/ENOENT/);
  });

  it("leaves a handle that already exited alone, so a recycled pid is never signalled", async () => {
    const run = okRun();
    expect(
      await killAsCore({ pid: 4242, exitCode: 0, kill: vi.fn() }, "SIGKILL", { identityEnv: CONTAINER, exists, run }),
    ).toBe(false);
    expect(
      await killAsCore({ pid: 4242, signalCode: "SIGTERM", kill: vi.fn() }, "SIGKILL", {
        identityEnv: CONTAINER,
        exists,
        run,
      }),
    ).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("does nothing for a handle with no pid", async () => {
    const run = okRun();
    expect(await killAsCore({ kill: vi.fn() }, "SIGKILL", { identityEnv: CONTAINER, exists, run })).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses to signal pid 0, 1 or -1, which would reach far more than a Session", async () => {
    const run = okRun();
    for (const pid of [0, 1, -1]) {
      await expect(killAsCore(pid, "SIGKILL", { identityEnv: CONTAINER, exists, run })).rejects.toThrow(/refusing/);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses when setpriv is missing instead of signalling as the daemon", async () => {
    const run = okRun();
    await expect(
      killAsCore(4242, "SIGKILL", { identityEnv: CONTAINER, exists: () => false, run }),
    ).rejects.toThrow(/setpriv is not in/);
    expect(run).not.toHaveBeenCalled();
  });

  it("never throws synchronously, so a timer or a handler cannot be taken down by it", () => {
    let returned: Promise<boolean> | undefined;
    expect(() => {
      returned = killAsCore(0, "SIGKILL", { identityEnv: CONTAINER, exists });
    }).not.toThrow();
    return expect(returned).rejects.toThrow(/refusing/);
  });
});

describe("killAsCoreQuietly", () => {
  it("logs a failure as <context>.failed and leaves no rejection behind", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const run = async () => ({ status: 1, stderr: "sh: kill: No such process" });
      expect(() =>
        killAsCoreQuietly(4242, "SIGKILL", "core-exec.kill", { identityEnv: CONTAINER, exists, run }),
      ).not.toThrow();
      await new Promise((r) => setTimeout(r, 10));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toBe("core-exec.kill.failed");
      expect(JSON.stringify(warn.mock.calls[0]![1])).toContain("No such process");
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("logs a refusal too (no setpriv), without throwing", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    killAsCoreQuietly(4242, "SIGKILL", "harness-cli-run.kill", { identityEnv: CONTAINER, exists: () => false });
    await new Promise((r) => setTimeout(r, 10));
    expect(warn.mock.calls[0]![0]).toBe("harness-cli-run.kill.failed");
    expect(JSON.stringify(warn.mock.calls[0]![1])).toContain("setpriv is not in");
  });
});
