// The shared modules that spawn, and the ones that read a home, in container
// mode (issue 559, PR 2). `node:child_process` is replaced so the exact argv, cwd
// and env are visible; outside the container each site must hand the OS what it
// always did.

import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncCalls = vi.hoisted(
  () => [] as Array<{ command: string; args: string[]; options: Record<string, any> }>,
);
const setprivPresent = vi.hoisted(() => ({ value: true }));

vi.mock("node:child_process", () => ({
  spawnSync: (command: string, args: string[], options: Record<string, any>) => {
    spawnSyncCalls.push({ command, args, options });
    return { status: 0, stdout: "claude 9.9.9\n/usr/local\n", stderr: "", error: undefined };
  },
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const existsSync = (p: string) =>
    typeof p === "string" && p.endsWith("/setpriv") ? setprivPresent.value : actual.existsSync(p);
  return { ...actual, default: { ...actual, existsSync }, existsSync };
});

import { checkHarnessCliVersion } from "../harness-cli-version";
import { HARNESS_CLI_CONFIG } from "../harness-cli-version-requirements";
import { resolveNpmGlobalPrefix } from "../npm-install-prefix";
import { resolveShell } from "../login-shell";
import { buildUserPath, sanitizedProcessEnv } from "../shell-env";
import { piAgentDir } from "../pi-agent-dir";
import { sharedLimitsFile, statuslineTapPath } from "../statusline-tap";

function inContainer() {
  vi.stubEnv("AC_CORE_HOME", "/home/core");
  vi.stubEnv("AC_CORE_UID", "1000");
  vi.stubEnv("AC_CORE_GID", "1000");
  vi.stubEnv("HOME", "/var/lib/actana");
  vi.stubEnv("USER", "actana");
  vi.stubEnv("SHELL", "/usr/sbin/nologin");
  vi.stubEnv("AC_USER_DATA_DIR", "/var/lib/actana/data");
  vi.stubEnv("AC_SECRETS_KEY", "daemon-secret");
}

beforeEach(() => {
  spawnSyncCalls.length = 0;
  setprivPresent.value = true;
});
afterEach(() => vi.unstubAllEnvs());

function expectAsCore(call: { command: string; args: string[]; options: Record<string, any> }) {
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
  expect(call.options.cwd).toBe("/");
  expect(call.options.env.HOME).toBe("/home/core");
  expect(JSON.stringify(call.options.env)).not.toContain("/var/lib/actana");
  expect(JSON.stringify(call.options.env)).not.toContain("daemon-secret");
}

describe("version probes", () => {
  const requirement = HARNESS_CLI_CONFIG["claude-code"];

  it("run as core", () => {
    inContainer();
    checkHarnessCliVersion("/home/core/.local/bin/claude", { PATH: "/usr/bin" }, requirement, "linux");
    expect(spawnSyncCalls).toHaveLength(1);
    expectAsCore(spawnSyncCalls[0]!);
    expect(spawnSyncCalls[0]!.args.slice(11)).toEqual(["/home/core/.local/bin/claude", "--version"]);
  });

  it("refuse when setpriv is missing", () => {
    inContainer();
    setprivPresent.value = false;
    expect(() =>
      checkHarnessCliVersion("/x/claude", { PATH: "/usr/bin" }, requirement, "linux"),
    ).toThrow(/setpriv is not in/);
    expect(spawnSyncCalls).toHaveLength(0);
  });

  it("are unchanged outside container mode", () => {
    checkHarnessCliVersion("/x/claude", { PATH: "/usr/bin" }, requirement, "linux");
    expect(spawnSyncCalls[0]).toMatchObject({ command: "/x/claude", args: ["--version"] });
  });
});

describe("npm prefix probe", () => {
  it("runs as core", () => {
    inContainer();
    expect(resolveNpmGlobalPrefix({ PATH: "/usr/bin" })).toBe("claude 9.9.9\n/usr/local".trim());
    expect(spawnSyncCalls).toHaveLength(1);
    expectAsCore(spawnSyncCalls[0]!);
    expect(spawnSyncCalls[0]!.args.slice(11)).toEqual(["npm", "prefix", "-g"]);
  });

  it("is unchanged outside container mode", () => {
    resolveNpmGlobalPrefix({ PATH: "/usr/bin" });
    expect(spawnSyncCalls[0]).toMatchObject({ command: "npm", args: ["prefix", "-g"] });
    expect(spawnSyncCalls[0]!.options.env).toEqual({ PATH: "/usr/bin" });
  });
});

describe("the shell and the env a Session gets", () => {
  it("the login shell is core's, not the daemon's nologin", () => {
    inContainer();
    expect(resolveShell()).toBe("/bin/bash");
  });

  it("sanitizedProcessEnv is rebuilt for core, with the login shell captured as core", async () => {
    inContainer();
    vi.resetModules();
    const { sanitizedProcessEnv: fresh } = await import("../shell-env");
    const env = fresh();
    expect(env.HOME).toBe("/home/core");
    expect(env.USER).toBe("core");
    expect(env.LOGNAME).toBe("core");
    expect(env.SHELL).toBe("/bin/bash");
    expect(env.PATH!.split(":")[0]).toBe("/home/core/.local/bin");
    expect(env.AC_USER_DATA_DIR).toBeUndefined();
    expect(env.AC_SECRETS_KEY).toBeUndefined();
    // The one spawn it makes, the login-shell env capture, is core's too.
    const capture = spawnSyncCalls.find((c) => c.args.includes("/bin/bash"));
    expect(capture).toBeDefined();
    expectAsCore(capture!);
  });

  it("outside container mode it is the daemon's own env, as before", () => {
    const env = sanitizedProcessEnv();
    expect(env.HOME).toBe(process.env.HOME);
  });

  it("the PATH candidates are core's home, not the daemon's", () => {
    inContainer();
    const seen: string[] = [];
    buildUserPath("/usr/bin", { pathExists: (entry) => (seen.push(entry), false), env: {} });
    expect(seen).toContain("/home/core/.local/bin");
    expect(seen.some((entry) => entry.startsWith("/var/lib/actana"))).toBe(false);
  });
});

describe("paths are computed when asked, from the Core's home", () => {
  it("Pi, the statusline tap and the shared limits file follow AC_CORE_HOME", () => {
    inContainer();
    expect(piAgentDir({})).toBe("/home/core/.pi/agent");
    expect(statuslineTapPath()).toBe("/home/core/.claude/mission-control/statusline-tap.sh");
    expect(sharedLimitsFile()).toBe("/home/core/.cache/claude-limits/limits.json");
  });

  it("follow the operator outside container mode", () => {
    expect(piAgentDir({})).toBe(`${os.homedir()}/.pi/agent`);
    expect(statuslineTapPath()).toBe(`${os.homedir()}/.claude/mission-control/statusline-tap.sh`);
  });

  it("are not fixed at import: importing the module before the identity exists still follows it", async () => {
    vi.resetModules();
    const tap = await import("../statusline-tap");
    inContainer();
    expect(tap.statuslineTapPath()).toBe("/home/core/.claude/mission-control/statusline-tap.sh");
    vi.unstubAllEnvs();
    expect(tap.statuslineTapPath()).toBe(`${os.homedir()}/.claude/mission-control/statusline-tap.sh`);
  });
});
