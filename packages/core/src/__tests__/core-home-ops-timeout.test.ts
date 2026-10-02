// A helper that hangs, with the real 15 s default (issue 559, PR 3; the real-process version is core-home-ops-hang.test.ts). After the `setpriv` switch it is another
// uid, so the daemon's own `kill` would be EPERM: the stuck helper must be
// signalled through `killAsCore`, and the caller must get an error rather than
// wait forever.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => [] as Array<{ command: string; args: string[] }>);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[]) => {
      spawned.push({ command, args });
      const child = new EventEmitter() as EventEmitter & Record<string, any>;
      const pipe = () => Object.assign(new EventEmitter(), { destroy: vi.fn(), end: () => undefined });
      child.stdout = pipe();
      child.stderr = pipe();
      child.stdin = pipe();
      child.pid = 4242;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn(() => true);
      // The helper never answers; the wrapped kill succeeds.
      if (args.some((a) => a.startsWith("kill -s"))) setImmediate(() => child.emit("close", 0));
      return child;
    },
  };
});

import { coreHomeOp, HELPER_TIMEOUT_MS } from "../core-home-ops-client";

beforeEach(() => {
  spawned.length = 0;
  vi.stubEnv("AC_CORE_HOME", "/home/core");
  vi.stubEnv("AC_CORE_UID", "1000");
  vi.stubEnv("AC_CORE_GID", "1000");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const setpriv = (p: string) => p === "/usr/bin/setpriv";

describe("a helper that does not answer", () => {
  it("has a stated deadline of 15 s", () => {
    expect(HELPER_TIMEOUT_MS).toBe(15_000);
  });

  it("is signalled as core, and the caller gets an error naming the wait", async () => {
    vi.useFakeTimers();
    const pending = coreHomeOp({ op: "resolveExecCwd", cwd: null }, { exists: setpriv, helperPath: "/opt/actana/app/core-home-ops.cjs" });
    const outcome = expect(pending).rejects.toThrow(/did not finish: no answer within 15000 ms/);
    await vi.advanceTimersByTimeAsync(15_001);
    await outcome;
    await vi.advanceTimersByTimeAsync(10);

    const helper = spawned[0]!;
    expect(helper.command).toBe("/usr/bin/setpriv");
    const kill = spawned[1]!;
    expect(kill.command).toBe("/usr/bin/setpriv");
    // `kill -s KILL -- 4242`, run as core: not `child.kill()`, which the daemon cannot do.
    expect(kill.args.slice(-3)).toEqual(["sh", "KILL", "4242"]);
    expect(kill.args).toContain('kill -s "$1" -- "$2"');
  });
});
