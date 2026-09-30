// How the daemon starts the helper, and what it does with the answer (issue 559, PR 3).

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CoreHomeOpFailedError,
  CoreHomeOpRefusedError,
  configureCoreHomeOps,
  coreHomeOp,
  coreHomeOpSync,
  decodeHelperOutcome,
  ensureClaudeShiftEnterBindingViaCore,
  installHarnessHooksViaCore,
  type HelperOutcome,
} from "../core-home-ops-client";
import log from "@actana/shared/log";

function inContainer() {
  vi.stubEnv("AC_CORE_HOME", "/home/core");
  vi.stubEnv("AC_CORE_UID", "1000");
  vi.stubEnv("AC_CORE_GID", "1000");
  // What the daemon's environment looks like in the image, secrets included.
  vi.stubEnv("HOME", "/var/lib/actana");
  vi.stubEnv("AC_USER_DATA_DIR", "/var/lib/actana/data");
  vi.stubEnv("AC_CORE_MATERIAL_FILE", "/var/lib/actana/config/material.json");
  vi.stubEnv("AC_SECRETS_KEY", "daemon-secret");
  vi.stubEnv("XDG_STATE_HOME", "/var/lib/actana/state");
  vi.stubEnv("NPM_TOKEN", "npm-daemon-token");
}

const setpriv = (p: string) => p === "/usr/bin/setpriv";
const ok = (result: unknown): HelperOutcome => ({ status: 0, stdout: `${JSON.stringify({ ok: true, result })}\n`, stderr: "" });

afterEach(() => {
  configureCoreHomeOps(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("in the container: one helper process per request, started as core", () => {
  it("hands the helper a request on stdin and runs it through setpriv, as core, from the bundle beside the daemon", async () => {
    inContainer();
    const seen: Array<{ spec: any; input: string }> = [];
    const result = await coreHomeOp(
      { op: "resolveExecCwd", cwd: "/home/core/w" },
      {
        exists: setpriv,
        helperPath: "/opt/actana/app/core-home-ops.cjs",
        run: async (spec, input) => {
          seen.push({ spec, input });
          return ok({ cwd: "/home/core/w" });
        },
      },
    );
    expect(result).toEqual({ cwd: "/home/core/w" });
    expect(seen).toHaveLength(1);
    const { spec, input } = seen[0]!;
    expect(JSON.parse(input)).toEqual({ op: "resolveExecCwd", cwd: "/home/core/w" });
    expect(spec.command).toBe("/usr/bin/setpriv");
    expect(spec.args.slice(0, 7)).toEqual([
      "--reuid=1000",
      "--regid=1000",
      "--clear-groups",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--no-new-privs",
      "--",
    ]);
    // The node binary and the helper bundle run inside `cd -- <home> && exec`.
    expect(spec.args.slice(7)).toEqual(["/bin/sh", "-c", 'cd -- "$0" && exec "$@"', "/home/core", process.execPath, "/opt/actana/app/core-home-ops.cjs"]);
    expect(spec.cwd).toBe("/");
  });

  it("never gives the helper the daemon's environment", async () => {
    inContainer();
    let env: Record<string, string> | undefined;
    await coreHomeOp(
      { op: "dirList", path: null },
      {
        exists: setpriv,
        run: async (spec) => {
          env = spec.env as Record<string, string>;
          return ok({});
        },
      },
    );
    expect(env).toBeDefined();
    const text = JSON.stringify(env);
    for (const leak of ["daemon-secret", "npm-daemon-token", "/var/lib/actana", "AC_USER_DATA_DIR", "AC_CORE_MATERIAL_FILE", "AC_SECRETS_KEY", "AC_CORE_HOME"]) {
      expect(text, leak).not.toContain(leak);
    }
    expect(Object.keys(env!).filter((k) => k.startsWith("AC_"))).toEqual([]);
    expect(env!.HOME).toBe("/home/core");
    expect(env!.USER).toBe("core");
  });

  it("uses the sync runner for sync callers and never the async one", () => {
    inContainer();
    const run = vi.fn();
    const runSync = vi.fn(() => ok(null));
    coreHomeOpSync({ op: "ensureClaudeShiftEnterBinding" }, { exists: setpriv, run, runSync });
    expect(runSync).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses to start the helper when setpriv is missing: it would run as the daemon", async () => {
    inContainer();
    const run = vi.fn();
    await expect(coreHomeOp({ op: "dirList", path: null }, { exists: () => false, run })).rejects.toThrow(/setpriv is not in/);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses an unknown operation in either mode, and never starts a helper for it", async () => {
    const run = vi.fn();
    await expect(coreHomeOp({ op: "rm" } as never, { run })).rejects.toThrow(CoreHomeOpRefusedError);
    inContainer();
    await expect(coreHomeOp({ op: "rm" } as never, { exists: setpriv, run })).rejects.toMatchObject({ code: "unknown-op" });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("outside the container: the same request, handled in this process", () => {
  it("starts no process", async () => {
    const run = vi.fn();
    const runSync = vi.fn();
    await coreHomeOp({ op: "resolveExecCwd", cwd: null }, { run, runSync, home: process.cwd() });
    expect(run).not.toHaveBeenCalled();
    expect(runSync).not.toHaveBeenCalled();
  });

  it("still refuses an unknown operation and a malformed field", async () => {
    await expect(coreHomeOp({ op: "rm" } as never)).rejects.toMatchObject({ code: "unknown-op" });
    await expect(coreHomeOp({ op: "resolveExecCwd", cwd: "a\0b" })).rejects.toMatchObject({ code: "bad-field" });
  });
});

describe("what the helper's outcome means", () => {
  it("decodes exit 0 to the result", () => {
    expect(decodeHelperOutcome("dirList", ok({ a: 1 }))).toEqual({ a: 1 });
  });

  it("decodes exit 2 to a refusal with the helper's code and message", () => {
    const outcome: HelperOutcome = {
      status: 2,
      stdout: JSON.stringify({ ok: false, code: "path-escape", message: "cwd is not inside" }),
      stderr: "core-home-ops: refused (path-escape): cwd is not inside",
    };
    expect(() => decodeHelperOutcome("x", outcome)).toThrow(CoreHomeOpRefusedError);
    expect(() => decodeHelperOutcome("x", outcome)).toThrow("cwd is not inside");
    try {
      decodeHelperOutcome("x", outcome);
    } catch (err) {
      expect((err as CoreHomeOpRefusedError).code).toBe("path-escape");
    }
  });

  it("decodes exit 1 to a failure carrying the operator's sentence", () => {
    const outcome: HelperOutcome = { status: 1, stdout: JSON.stringify({ ok: false, code: "failed", message: "Folder not found" }), stderr: "" };
    expect(() => decodeHelperOutcome("dirList", outcome)).toThrow(new CoreHomeOpFailedError("Folder not found"));
  });

  it("names a crash, a signal, a spawn error and unreadable stdout as what they are, with stderr", () => {
    expect(() => decodeHelperOutcome("x", { status: 70, stdout: "", stderr: "core-home-ops: crashed: boom" })).toThrow(/exit 70.*boom/s);
    expect(() => decodeHelperOutcome("x", { status: null, stdout: "", stderr: "" })).toThrow(/did not finish/);
    expect(() => decodeHelperOutcome("x", { status: null, stdout: "", stderr: "", error: new Error("ENOENT") })).toThrow(/ENOENT/);
    expect(() => decodeHelperOutcome("x", { status: 0, stdout: "not json", stderr: "warn" })).toThrow(/unreadable answer: warn/);
  });
});

describe("the daemon's wrappers keep the contracts of what they replaced", () => {
  it("Shift+Enter is best-effort: a failed helper is a log line, not a throw", () => {
    inContainer();
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    configureCoreHomeOps({ exists: setpriv, runSync: () => ({ status: 70, stdout: "", stderr: "boom" }) });
    expect(() => ensureClaudeShiftEnterBindingViaCore()).not.toThrow();
    expect(warn.mock.calls.map((c) => c[0])).toContain("core-home-ops.shift-enter.failed");
  });

  it("a hook install the helper could not do reports `installed: false`, like a failed write always did", async () => {
    inContainer();
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    configureCoreHomeOps({ exists: setpriv, run: async () => ({ status: 2, stdout: JSON.stringify({ ok: false, code: "path-escape", message: "no" }), stderr: "" }) });
    await expect(installHarnessHooksViaCore("claude-code", "/home/core/w", {})).resolves.toEqual({
      installed: false,
      reportsTurnStart: false,
      hookTrustBypassEarned: false,
    });
    expect(warn.mock.calls.map((c) => c[0])).toContain("core-home-ops.hooks.failed");
  });

  it("sends only PI_CODING_AGENT_DIR from the spawn env, never the env", async () => {
    inContainer();
    const inputs: string[] = [];
    configureCoreHomeOps({ exists: setpriv, run: async (_s, input) => (inputs.push(input), ok({ installed: true, reportsTurnStart: true, hookTrustBypassEarned: false })) });
    await installHarnessHooksViaCore("pi", "/home/core/w", { PI_CODING_AGENT_DIR: " ~/.pi/custom ", AC_SECRETS_KEY: "s", PATH: "/x" });
    expect(JSON.parse(inputs[0]!)).toEqual({ op: "installHarnessHooks", harness: "pi", cwd: "/home/core/w", piAgentDir: "~/.pi/custom" });
    expect(inputs[0]).not.toContain("AC_SECRETS_KEY");
  });
});
