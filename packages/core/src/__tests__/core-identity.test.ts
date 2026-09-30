// `killAsCore` — the only way the daemon signals a Session's process (issue 559).
//
// In the container the daemon is another uid with no CAP_KILL, so the signal is
// sent by a short-lived process that is `core`. Outside it, nothing changes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { killAsCore } from "../core-identity";

const CONTAINER = { AC_CORE_HOME: "/home/core", AC_CORE_UID: "1000", AC_CORE_GID: "1000" };
const exists = () => true;

// Never a real signal, whatever the code under test does: a mutated killAsCore
// must fail these tests, not kill the runner's own process group.
beforeEach(() => {
  vi.spyOn(process, "kill").mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

describe("killAsCore outside container mode", () => {
  it("calls the handle's own kill, as the call sites did before", () => {
    const kill = vi.fn(() => true);
    expect(killAsCore({ pid: 4242, kill }, "SIGTERM", { identityEnv: {} })).toBe(true);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("calls process.kill for a bare pid, and lets its error through", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(killAsCore(4242, "SIGKILL", { identityEnv: {} })).toBe(true);
    expect(spy).toHaveBeenCalledWith(4242, "SIGKILL");

    spy.mockImplementation(() => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    });
    expect(() => killAsCore(4242, "SIGKILL", { identityEnv: {} })).toThrow(/ESRCH/);
  });

  it("does not spawn anything", () => {
    const run = vi.fn();
    vi.spyOn(process, "kill").mockImplementation(() => true);
    killAsCore({ pid: 1234, kill: () => true }, "SIGTERM", { identityEnv: {}, run });
    killAsCore(1234, "SIGTERM", { identityEnv: {}, run });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("killAsCore in container mode", () => {
  it("never signals itself: the wrapped kill runs as core instead", () => {
    const kill = vi.fn();
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const run = vi.fn(() => ({ status: 0, stderr: "" }));
    expect(killAsCore({ pid: 4242, kill }, "SIGKILL", { identityEnv: CONTAINER, exists, run })).toBe(true);
    expect(kill).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    const spec = run.mock.calls[0]![0];
    expect(spec.command).toBe("/usr/bin/setpriv");
    expect(spec.args).toContain("--reuid=1000");
    expect(spec.args.slice(-4)).toEqual(['kill -s "$1" -- "$2"', "sh", "KILL", "4242"]);
  });

  it("signals a process group with a negative pid", () => {
    const run = vi.fn(() => ({ status: 0, stderr: "" }));
    killAsCore(-4242, "SIGTERM", { identityEnv: CONTAINER, exists, run });
    expect(run.mock.calls[0]![0].args.slice(-2)).toEqual(["TERM", "-4242"]);
  });

  it("throws with the kill's own stderr when it fails", () => {
    const run = () => ({ status: 1, stderr: "sh: 1: kill: No such process\n" });
    expect(() => killAsCore(4242, "SIGKILL", { identityEnv: CONTAINER, exists, run })).toThrow(
      /kill SIGKILL 4242 as core failed \(exit 1\): sh: 1: kill: No such process/,
    );
  });

  it("throws when the wrapper could not even start", () => {
    const run = () => ({ status: null, error: new Error("spawn ENOENT") });
    expect(() => killAsCore(4242, "SIGKILL", { identityEnv: CONTAINER, exists, run })).toThrow(/ENOENT/);
  });

  it("leaves a handle that already exited alone, so a recycled pid is never signalled", () => {
    const run = vi.fn();
    expect(
      killAsCore({ pid: 4242, exitCode: 0, kill: vi.fn() }, "SIGKILL", { identityEnv: CONTAINER, exists, run }),
    ).toBe(false);
    expect(
      killAsCore({ pid: 4242, signalCode: "SIGTERM", kill: vi.fn() }, "SIGKILL", {
        identityEnv: CONTAINER,
        exists,
        run,
      }),
    ).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("does nothing for a handle with no pid", () => {
    const run = vi.fn();
    expect(killAsCore({ kill: vi.fn() }, "SIGKILL", { identityEnv: CONTAINER, exists, run })).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses to signal pid 0, 1 or -1, which would reach far more than a Session", () => {
    const run = vi.fn();
    for (const pid of [0, 1, -1]) {
      expect(() => killAsCore(pid, "SIGKILL", { identityEnv: CONTAINER, exists, run })).toThrow(/refusing/);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses when setpriv is missing instead of signalling as the daemon", () => {
    const run = vi.fn();
    expect(() => killAsCore(4242, "SIGKILL", { identityEnv: CONTAINER, exists: () => false, run })).toThrow(
      /setpriv is not in/,
    );
    expect(run).not.toHaveBeenCalled();
  });
});
