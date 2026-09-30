// A helper that hangs, for real (issue 559, PR 3, fix round 1).
//
// The review's point: a `spawnSync` wait cannot be bounded against a child the
// daemon cannot signal, so every request is async with its own deadline, and past
// it the helper is killed through `killAsCore`. This runs a real process that
// never answers, through every wrapper the daemon uses, and holds that each one
// settles within the deadline and that the process is really gone afterwards.
// `child_process` is not mocked here. The kill runner is the one stand-in: the
// wrapped kill is `setpriv`, which needs root, so it delivers the same SIGKILL
// to the same pid directly; its argv is pinned in `core-home-ops-timeout.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import log from "@actana/shared/log";
import {
  configureCoreHomeOps,
  coreHomeOp,
  ensureClaudeShiftEnterBindingViaCore,
  ensureOrchestrationSkillViaCore,
  ensureStatuslineTapViaCore,
  installHarnessHooksViaCore,
  listDirectoryViaCore,
  resolveExecCwdViaCore,
  spawnPathFactsViaCore,
  wireLocalCoreViaCore,
} from "../core-home-ops-client";
import { registerSelfWithLocalCli } from "../core-self-register";

const DEADLINE_MS = 300;
const killed: number[] = [];

function inContainer() {
  vi.stubEnv("AC_CORE_HOME", "/home/core");
  vi.stubEnv("AC_CORE_UID", "1000");
  vi.stubEnv("AC_CORE_GID", "1000");
}

/** A helper that reads nothing, answers nothing and never exits. */
function hangingLaunch() {
  return {
    wrap: ((spec: { command: string }) => ({
      command: spec.command,
      args: ["-e", "setInterval(() => {}, 1e6)"],
      cwd: "/",
      env: { PATH: process.env.PATH ?? "" },
    })) as never,
    timeoutMs: DEADLINE_MS,
    killOptions: {
      exists: (p: string) => p === "/usr/bin/setpriv",
      // `kill -s KILL -- <pid>` as the wrapped kill would send it.
      run: async (spec: { args: string[] }) => {
        const pid = Number(spec.args[spec.args.length - 1]);
        killed.push(pid);
        process.kill(pid, "SIGKILL");
        return { status: 0 };
      },
    },
  };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return !alive(pid);
}

beforeEach(() => {
  killed.length = 0;
  inContainer();
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  configureCoreHomeOps(hangingLaunch());
});
afterEach(() => {
  configureCoreHomeOps(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const pid of killed) if (alive(pid)) process.kill(pid, "SIGKILL");
});

const material = { caCert: "a", clientCert: "b", clientKey: "c", bearerSecret: "d".repeat(64), coreId: "core_1" };

/** Every way the daemon asks the helper for something; each resolves or rejects, never hangs. */
const callers: Array<[string, () => Promise<unknown>]> = [
  ["a raw request", () => coreHomeOp({ op: "dirList", path: null })],
  ["Shift+Enter (boot)", () => ensureClaudeShiftEnterBindingViaCore()],
  ["the skill install (boot and the watcher)", () => ensureOrchestrationSkillViaCore()],
  ["the registry blob (boot)", () => registerSelfWithLocalCli({ material, bindHost: "0.0.0.0", port: 1, label: "c", bearerDays: 1, env: {}, home: "/home/core" })],
  ["the registry write itself", () => wireLocalCoreViaCore("c", { endpoint: "wss://127.0.0.1:1", label: "c", caCert: "a", clientCert: "b", clientKey: "c", bearer: "d" })],
  ["the statusline tap", () => ensureStatuslineTapViaCore("/home/core/w")],
  ["the hook install", () => installHarnessHooksViaCore("claude-code", "/home/core/w", {})],
  ["the spawn policy's path facts", () => spawnPathFactsViaCore("/home/core/w", ["/home/core/w"])],
  ["core exec's cwd", () => resolveExecCwdViaCore("/home/core/w")],
  ["the folder picker", () => listDirectoryViaCore(null)],
];

describe("a helper that never answers", () => {
  it.each(callers)("%s settles within the deadline and the helper is killed", async (_name, call) => {
    const started = Date.now();
    await call().catch(() => undefined);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(DEADLINE_MS - 20);
    expect(took).toBeLessThan(DEADLINE_MS + 1500);
    expect(killed).toHaveLength(1);
    expect(await goneWithin(killed[0]!, 2000)).toBe(true);
  });

  it("keeps the event loop running while it waits", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    await coreHomeOp({ op: "dirList", path: null }).catch(() => undefined);
    clearInterval(timer);
    // A blocking wait would have let almost none of these through.
    expect(ticks).toBeGreaterThan(8);
  });

  it("rejects a required request with an error naming the wait", async () => {
    await expect(coreHomeOp({ op: "dirList", path: null })).rejects.toThrow(`no answer within ${DEADLINE_MS} ms`);
  });
});
