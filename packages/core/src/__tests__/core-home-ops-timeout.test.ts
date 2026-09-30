// A helper that hangs (issue 559, PR 3). After the `setpriv` switch it is another
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
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = Object.assign(new EventEmitter(), { end: () => undefined });
      child.pid = 4242;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn(() => true);
      // The helper never answers; the wrapped kill succeeds.
      if (args.some((a) => a.startsWith("kill -s"))) setImmediate(() => child.emit("close", 0));
      return child;
    },
    spawnSync: (command: string, args: string[]) => {
      spawned.push({ command, args });
      return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }), pid: 4343 };
    },
  };
});

import { coreHomeOp, coreHomeOpSync } from "../core-home-ops-client";

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
  it("is signalled as core, and the caller gets an error naming the wait", async () => {
    vi.useFakeTimers();
    const pending = coreHomeOp({ op: "dirList", path: null }, { exists: setpriv, helperPath: "/opt/actana/app/core-home-ops.cjs" });
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

  it("does the same for a sync caller whose wait ran out", () => {
    expect(() => coreHomeOpSync({ op: "ensureClaudeShiftEnterBinding" }, { exists: setpriv })).toThrow(/did not finish.*ETIMEDOUT/);
    expect(spawned[0]!.command).toBe("/usr/bin/setpriv");
    // The kill is async and quiet: it is on its way, as core, for the helper's pid.
    expect(spawned[1]!.args.slice(-3)).toEqual(["sh", "KILL", "4343"]);
  });
});
