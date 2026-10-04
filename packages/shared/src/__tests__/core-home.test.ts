import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  asCore,
  coreChildEnv,
  coreHome,
  coreIdentity,
  CoreIdentityError,
  CoreSpawnRefusedError,
  coreKillSpec,
  coreShell,
  coreUsername,
} from "../core-home";
import { harnessHomePathSuffixes } from "../harness-cli-config";

const CONTAINER = { AC_CORE_HOME: "/home/core", AC_CORE_UID: "1000", AC_CORE_GID: "1000" };
const hasSetpriv = () => true;

describe("coreIdentity", () => {
  it("is null outside container mode", () => {
    expect(coreIdentity({})).toBeNull();
    expect(coreIdentity({ AC_CORE_HOME: "  " })).toBeNull();
  });

  it("reads the three image variables", () => {
    expect(coreIdentity(CONTAINER)).toEqual({
      user: "core",
      uid: 1000,
      gid: 1000,
      home: "/home/core",
      shell: "/bin/bash",
    });
  });

  it("refuses a half-set identity instead of running as the daemon", () => {
    expect(() => coreIdentity({ AC_CORE_HOME: "/home/core", AC_CORE_UID: "1000" })).toThrow(
      /incomplete Core identity.*AC_CORE_GID missing/,
    );
  });

  it.each([
    [{ ...CONTAINER, AC_CORE_UID: "0" }, /AC_CORE_UID must be a non-root id/],
    [{ ...CONTAINER, AC_CORE_GID: "0" }, /AC_CORE_GID must be a non-root id/],
    [{ ...CONTAINER, AC_CORE_UID: "core" }, /AC_CORE_UID must be a whole number/],
    [{ ...CONTAINER, AC_CORE_UID: "-5" }, /AC_CORE_UID must be a whole number/],
    [{ ...CONTAINER, AC_CORE_HOME: "home/core" }, /AC_CORE_HOME must be an absolute path/],
  ])("rejects %j", (env, message) => {
    expect(() => coreIdentity(env)).toThrow(CoreIdentityError);
    expect(() => coreIdentity(env)).toThrow(message);
  });
});

describe("coreHome / coreShell / coreUsername", () => {
  it("answer for core in container mode, not for the daemon's own user", () => {
    expect(coreHome(CONTAINER)).toBe("/home/core");
    expect(coreShell(CONTAINER)).toBe("/bin/bash");
    expect(coreUsername(CONTAINER)).toBe("core");
  });

  it("fall back to the operator outside container mode", () => {
    expect(coreHome({})).toBe(os.homedir());
    expect(coreUsername({})).toBe(os.userInfo().username);
    expect(coreShell({})).toBe((os.userInfo() as { shell?: string }).shell ?? null);
  });

  it("drops a trailing slash", () => {
    expect(coreHome({ ...CONTAINER, AC_CORE_HOME: "/home/core/" })).toBe("/home/core");
  });
});

describe("asCore", () => {
  const spec = { command: "claude", args: ["--model", "x y"], cwd: "/srv/work", env: { FOO: "1" } };

  it("returns the very same spec outside container mode", () => {
    expect(asCore(spec, { identityEnv: {} })).toBe(spec);
    const bare = { command: "ls", args: [] };
    expect(asCore(bare, { identityEnv: {} })).toBe(bare);
  });

  it("builds exactly the setpriv argv, flags in order, cd after the switch", () => {
    const out = asCore(spec, { identityEnv: CONTAINER, exists: (f) => f === "/usr/bin/setpriv" });
    expect(out.command).toBe("/usr/bin/setpriv");
    expect(out.args).toEqual([
      "--reuid=1000",
      "--regid=1000",
      "--clear-groups",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--no-new-privs",
      "--",
      "/bin/sh",
      "-c",
      'cd -- "$0" && exec "$@"',
      "/srv/work",
      "claude",
      "--model",
      "x y",
    ]);
    // node-pty / child_process get "/" as their own cwd: the daemon may not be
    // able to enter the real one, the cd runs as core.
    expect(out.cwd).toBe("/");
  });

  it("passes a cwd with spaces, a leading dash and shell syntax as one argument", () => {
    for (const cwd of ["/srv/my work", "-rf", "/srv/$(id)`x`;y", "/srv/it's"]) {
      const out = asCore({ command: "ls", args: [], cwd }, { identityEnv: CONTAINER, exists: hasSetpriv });
      expect(out.args.slice(-2)).toEqual([cwd, "ls"]);
      // The script text is constant: nothing of the cwd is spliced into it.
      expect(out.args[9]).toBe('cd -- "$0" && exec "$@"');
    }
  });

  it("starts in core's home when no cwd is given", () => {
    const out = asCore({ command: "ls", args: [] }, { identityEnv: CONTAINER, exists: hasSetpriv });
    expect(out.args.slice(-2)).toEqual(["/home/core", "ls"]);
  });

  it("uses the ids of the image", () => {
    const out = asCore(spec, {
      identityEnv: { ...CONTAINER, AC_CORE_UID: "2001", AC_CORE_GID: "2002" },
      exists: hasSetpriv,
    });
    expect(out.args.slice(0, 2)).toEqual(["--reuid=2001", "--regid=2002"]);
  });

  it("refuses to spawn when setpriv is missing", () => {
    expect(() => asCore(spec, { identityEnv: CONTAINER, exists: () => false })).toThrow(
      CoreSpawnRefusedError,
    );
    expect(() => asCore(spec, { identityEnv: CONTAINER, exists: () => false })).toThrow(
      /setpriv is not in .*would run as the daemon instead of as core/,
    );
  });

  it("finds setpriv only in fixed system directories, never through PATH", () => {
    const probed: string[] = [];
    asCore(spec, {
      identityEnv: CONTAINER,
      exists: (f) => {
        probed.push(f);
        return f === "/bin/setpriv";
      },
    });
    expect(probed).toEqual(["/usr/bin/setpriv", "/bin/setpriv"]);
  });

  it("refuses an empty command", () => {
    expect(() =>
      asCore({ command: "", args: [] }, { identityEnv: CONTAINER, exists: hasSetpriv }),
    ).toThrow(CoreSpawnRefusedError);
  });

  it("propagates a half-set identity instead of spawning as the daemon", () => {
    expect(() => asCore(spec, { identityEnv: { AC_CORE_UID: "1000" } })).toThrow(CoreIdentityError);
  });
});

describe("coreChildEnv", () => {
  const identity = coreIdentity(CONTAINER)!;
  const daemonEnv = {
    HOME: "/var/lib/actana",
    USER: "actana",
    LOGNAME: "actana",
    SHELL: "/usr/sbin/nologin",
    PATH: "/opt/actana/bin:/usr/bin:/bin",
    NPM_CONFIG_PREFIX: "/var/lib/actana/.npm",
    AC_USER_DATA_DIR: "/var/lib/actana/data",
    AC_CORE_MATERIAL_FILE: "/var/lib/actana/config/material.json",
    AC_SECRETS_KEY: "s3cret",
    AC_PANEL_DB_PASSWORD: "pw",
    AC_HARNESS_MATERIAL_FILE: "/var/lib/actana/x",
    AC_CORE_HOME: "/home/core",
    AC_CORE_UID: "1000",
    AC_CORE_GID: "1000",
    AC_HOOK_URL: "http://127.0.0.1:1/x",
    LANG: "C.UTF-8",
  };

  it("rebuilds HOME, USER, LOGNAME, SHELL and PATH for core", () => {
    const env = coreChildEnv(identity, daemonEnv);
    expect(env.HOME).toBe("/home/core");
    expect(env.USER).toBe("core");
    expect(env.LOGNAME).toBe("core");
    expect(env.SHELL).toBe("/bin/bash");
    expect(env.NPM_CONFIG_PREFIX).toBe("/home/core/.local");
    expect(env.PATH).toBe("/home/core/.local/bin:/home/core/.opencode/bin:/opt/actana/bin:/usr/bin:/bin");
  });

  // #559: only `~/.local/bin` was on a Session's PATH, so an OpenCode installed into
  // `~/.opencode/bin` was never found. Every directory the registry says a Harness
  // installs into has to lead, however the daemon's own PATH looks.
  it("leads with every home directory the Harness registry names, .local/bin first", () => {
    const entries = coreChildEnv(identity, { PATH: "/usr/bin" }).PATH.split(":");
    const expected = harnessHomePathSuffixes("linux").map((suffix) => `/home/core/${suffix}`);
    expect(expected.length).toBeGreaterThan(1);
    expect(entries.slice(0, expected.length + 1)).toEqual(
      expect.arrayContaining(["/home/core/.local/bin", ...expected]),
    );
    expect(entries[0]).toBe("/home/core/.local/bin");
    for (const dir of expected) expect(entries.filter((entry) => entry === dir)).toHaveLength(1);
    expect(entries.at(-1)).toBe("/usr/bin");
  });

  it("does not leak the daemon's state, secrets or identity variables", () => {
    const env = coreChildEnv(identity, daemonEnv);
    expect(Object.keys(env).filter((k) => /AC_(USER_DATA|SECRETS|PANEL|HARNESS_MATERIAL|CORE_)/.test(k))).toEqual([]);
    expect(JSON.stringify(env)).not.toContain("/var/lib/actana");
    expect(JSON.stringify(env)).not.toContain("actana\"");
  });

  it("drops the whole AC_ namespace except AC_HOOK_, including names nobody listed", () => {
    const env = coreChildEnv(
      identity,
      { ...daemonEnv, AC_SOMETHING_NEW: "x", AC_CORE_LINK_HOST: "0.0.0.0", AC_HOOK_TOKEN: "t", AC_HOOK_MISS_LOG: "/tmp/m" },
      daemonEnv,
    );
    expect(Object.keys(env).filter((k) => k.startsWith("AC_")).sort()).toEqual([
      "AC_HOOK_MISS_LOG",
      "AC_HOOK_TOKEN",
      "AC_HOOK_URL",
    ]);
  });

  it("no value in the child env contains the daemon's state directory, whatever the variable is called", () => {
    const leaky = {
      ...daemonEnv,
      XDG_STATE_HOME: "/var/lib/actana/state",
      FOO_CACHE: "/var/lib/actana/cache/foo",
      SOME_TOOL_DB: "sqlite:///var/lib/actana/data/x.db",
      PATH: "/var/lib/actana/bin:/opt/actana/bin:/usr/bin",
      ACTANA_ROOT: "/opt/actana",
    };
    const env = coreChildEnv(identity, leaky, daemonEnv);
    for (const [key, value] of Object.entries(env)) {
      expect(value, key).not.toContain("/var/lib/actana");
    }
    expect(env.XDG_STATE_HOME).toBeUndefined();
    expect(env.FOO_CACHE).toBeUndefined();
    expect(env.SOME_TOOL_DB).toBeUndefined();
    expect(env.PATH).toBe("/home/core/.local/bin:/home/core/.opencode/bin:/opt/actana/bin:/usr/bin");
    // Not secret, and the CLI in a Session may need it.
    expect(env.ACTANA_ROOT).toBe("/opt/actana");
  });

  it("learns the daemon's paths from its own env too, not only from the list", () => {
    const env = coreChildEnv(
      identity,
      { LEAK: "/srv/actana-state/keys", OK: "/srv/work" },
      { HOME: "/srv/actana-state", AC_USER_DATA_DIR: "/srv/actana-state/data" },
    );
    expect(env.LEAK).toBeUndefined();
    expect(env.OK).toBe("/srv/work");
  });

  it("keeps what the caller meant the child to have", () => {
    const env = coreChildEnv(identity, daemonEnv);
    expect(env.LANG).toBe("C.UTF-8");
    expect(env.AC_HOOK_URL).toBe("http://127.0.0.1:1/x");
  });

  it("never reads process.env, and gives a default PATH when the caller had none", () => {
    process.env.SENTINEL_DAEMON_ONLY = "leak";
    try {
      const env = coreChildEnv(identity, {});
      expect(env.SENTINEL_DAEMON_ONLY).toBeUndefined();
      expect(env.PATH).toBe(
        "/home/core/.local/bin:/home/core/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      );
    } finally {
      delete process.env.SENTINEL_DAEMON_ONLY;
    }
  });

  it("does not repeat core's local bin", () => {
    const env = coreChildEnv(identity, { PATH: "/home/core/.local/bin:/usr/bin" });
    expect(env.PATH).toBe("/home/core/.local/bin:/home/core/.opencode/bin:/usr/bin");
  });

  it("is what asCore puts on the spawn, and an absent env does not mean the daemon's", () => {
    process.env.SENTINEL_DAEMON_ONLY = "leak";
    try {
      const out = asCore({ command: "ls", args: [] }, { identityEnv: CONTAINER, exists: hasSetpriv });
      expect(out.env?.SENTINEL_DAEMON_ONLY).toBeUndefined();
      expect(out.env?.HOME).toBe("/home/core");
    } finally {
      delete process.env.SENTINEL_DAEMON_ONLY;
    }
  });
});

describe("coreKillSpec", () => {
  it("signals from a sh builtin, as core, with the signal name and pid as arguments", () => {
    const out = coreKillSpec(4242, "SIGKILL", { identityEnv: CONTAINER, exists: hasSetpriv });
    expect(out.args.slice(0, 7)).toEqual([
      "--reuid=1000",
      "--regid=1000",
      "--clear-groups",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--no-new-privs",
      "--",
    ]);
    expect(out.args.slice(7)).toEqual([
      "/bin/sh",
      "-c",
      'cd -- "$0" && exec "$@"',
      "/home/core",
      "/bin/sh",
      "-c",
      'kill -s "$1" -- "$2"',
      "sh",
      "KILL",
      "4242",
    ]);
  });

  it("takes a process group as a negative pid", () => {
    const out = coreKillSpec(-4242, "SIGTERM", { identityEnv: CONTAINER, exists: hasSetpriv });
    expect(out.args.slice(-2)).toEqual(["TERM", "-4242"]);
  });

  it.each([0, 1, -1, -0.5, NaN, Infinity])("refuses pid %s", (pid) => {
    expect(() => coreKillSpec(pid, "SIGKILL", { identityEnv: CONTAINER, exists: hasSetpriv })).toThrow(
      /refusing to signal pid/,
    );
  });

  it("refuses anything that is not a signal name", () => {
    expect(() =>
      coreKillSpec(10, "KILL; reboot" as never, { identityEnv: CONTAINER, exists: hasSetpriv }),
    ).toThrow(/not a signal name/);
  });
});

// The script half of the argv needs no privilege: run it on the machine's own
// /bin/sh so a quoting mistake shows up on every Linux developer box.
describe.skipIf(process.platform !== "linux")("the cd-then-exec script on the real /bin/sh", () => {
  const script = asCore(
    { command: "x", args: [], cwd: "/" },
    { identityEnv: CONTAINER, exists: hasSetpriv },
  ).args[9] as string;

  function sh(cwd: string, command: string[]) {
    return spawnSync("/bin/sh", ["-c", script, cwd, ...command], { encoding: "utf8" });
  }

  it("enters cwds with spaces, leading dashes and shell syntax, then runs the command there", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "core-sh-"));
    try {
      for (const name of ["a b", "-dash", "$(echo x)", "it's"]) {
        const dir = path.join(base, name);
        fs.mkdirSync(dir);
        const r = sh(dir, ["/bin/pwd"]);
        expect(r.stderr).toBe("");
        expect(r.stdout.trim()).toBe(fs.realpathSync(dir));
      }
      // A relative cwd that starts with a dash: `cd --` keeps it from being an option.
      const r = spawnSync("/bin/sh", ["-c", script, "-dash", "/bin/pwd"], { cwd: base, encoding: "utf8" });
      expect(r.stderr).toBe("");
      expect(r.stdout.trim()).toBe(fs.realpathSync(path.join(base, "-dash")));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("does not run the command when the cd fails, and says so on stderr with a non-zero exit", () => {
    const r = sh("/nonexistent-core-dir", ["/bin/echo", "ran"]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("/nonexistent-core-dir");
  });

  it("passes every argument through untouched", () => {
    const r = sh("/", ["/usr/bin/printf", "%s|", "a b", "-n", "$HOME", "*"]);
    expect(r.stdout).toBe("a b|-n|$HOME|*|");
  });
});

// The wrapper for real, as PR 4 will run it.
//
// The daemon there is not root: it is `actana`, holding ambient CAP_SETUID and
// CAP_SETGID and nothing else. That matters for what is being proven. A uid-0 to
// non-zero switch clears every capability by itself, so a root caller would pass
// `CapPrm = 0` even without `--inh-caps=-all --ambient-caps=-all`, and root can
// signal anyone. So the test first becomes that daemon (a non-root uid, with an
// extra supplementary group, holding only the two ambient caps), proves it is
// one, and only then runs what `asCore` and `coreKillSpec` build from there.
//
// It needs real root to set that up, so on a developer machine and in the plain
// `Unit Tests` step it is SKIPPED. CI's "Real asCore wrapper" step runs this file
// under `sudo` with ACTANA_REQUIRE_ROOT_TESTS=1, and with that set a missing root
// or setpriv FAILS instead of skipping, so the step cannot go green without it.
const isRoot = process.platform === "linux" && process.getuid?.() === 0;
const SETPRIV = ["/usr/bin/setpriv", "/bin/setpriv"].find((f) => fs.existsSync(f));
const required = process.env.ACTANA_REQUIRE_ROOT_TESTS === "1";

describe.runIf(required)("the real-wrapper step has what it needs", () => {
  it("is root on Linux with setpriv installed", () => {
    expect(process.platform).toBe("linux");
    expect(process.getuid?.()).toBe(0);
    expect(SETPRIV).toBeDefined();
  });
});

describe.skipIf(!isRoot || !SETPRIV)("asCore for real: from a non-root daemon with only SETUID and SETGID", () => {
  const DAEMON_UID = 65533;
  const DAEMON_EXTRA_GID = 65001;
  const CORE_UID = 65534;
  const CORE_GID = 65534;
  const ZERO = "0000000000000000";
  const SET_UID_GID = "00000000000000c0"; // CAP_SETGID (6) and CAP_SETUID (7)

  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });
  function publicDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join("/tmp", prefix));
    fs.chmodSync(dir, 0o755);
    dirs.push(dir);
    return dir;
  }

  /** argv that becomes the daemon: uid 65533, groups {65533, 65001}, ambient SETUID+SETGID only. */
  function asDaemon(argv: string[]): string[] {
    return [
      `--reuid=${DAEMON_UID}`,
      `--regid=${DAEMON_UID}`,
      `--groups=${DAEMON_UID},${DAEMON_EXTRA_GID}`,
      "--inh-caps=-all,+setuid,+setgid",
      "--ambient-caps=+setuid,+setgid",
      "--",
      ...argv,
    ];
  }

  const field = (status: string, name: string) =>
    new RegExp(`^${name}:[ \\t]*(.*)$`, "m").exec(status)?.[1];

  function run(argv: string[], env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" }) {
    return spawnSync(SETPRIV!, argv, { cwd: "/", env, encoding: "utf8", timeout: 15_000 });
  }

  function coreSpec(command: string, args: string[], cwd: string | undefined, home: string) {
    return asCore(
      { command, args, cwd, env: { PATH: "/usr/bin:/bin", AC_USER_DATA_DIR: "/var/lib/actana/data" } },
      { identityEnv: { AC_CORE_HOME: home, AC_CORE_UID: String(CORE_UID), AC_CORE_GID: String(CORE_GID) } },
    );
  }

  /** Runs what `asCore` built, from inside the daemon. */
  function runAsCoreFromDaemon(spec: ReturnType<typeof coreSpec>) {
    return run(asDaemon([spec.command, ...spec.args]), spec.env);
  }

  it("the harness really is the daemon it claims to be (so the rest means something)", () => {
    const r = run(asDaemon(["/bin/cat", "/proc/self/status"]));
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(field(r.stdout, "Uid")).toBe(`${DAEMON_UID}\t${DAEMON_UID}\t${DAEMON_UID}\t${DAEMON_UID}`);
    expect(field(r.stdout, "Groups")?.trim().split(/\s+/).sort()).toEqual(
      [String(DAEMON_EXTRA_GID), String(DAEMON_UID)].sort(),
    );
    expect(field(r.stdout, "CapPrm")).toBe(SET_UID_GID);
    expect(field(r.stdout, "CapEff")).toBe(SET_UID_GID);
    expect(field(r.stdout, "CapAmb")).toBe(SET_UID_GID);
  });

  it("the child has core's ids, no groups, no capabilities and no new privileges, read from its own /proc/self/status", () => {
    const home = publicDir("core-home-real-");
    const r = runAsCoreFromDaemon(coreSpec("/bin/cat", ["/proc/self/status"], undefined, home));
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(field(r.stdout, "Uid")).toBe(`${CORE_UID}\t${CORE_UID}\t${CORE_UID}\t${CORE_UID}`);
    expect(field(r.stdout, "Gid")).toBe(`${CORE_GID}\t${CORE_GID}\t${CORE_GID}\t${CORE_GID}`);
    // Only the target gid may appear: none of the daemon's supplementary groups.
    const groups = (field(r.stdout, "Groups") ?? "").trim().split(/\s+/).filter(Boolean);
    expect(groups.filter((g) => g !== String(CORE_GID))).toEqual([]);
    expect(field(r.stdout, "CapPrm")).toBe(ZERO);
    expect(field(r.stdout, "CapEff")).toBe(ZERO);
    expect(field(r.stdout, "CapInh")).toBe(ZERO);
    expect(field(r.stdout, "CapAmb")).toBe(ZERO);
    expect(field(r.stdout, "NoNewPrivs")).toBe("1");
  });

  it("does the cd after the switch (a home only core could enter), and rebuilds the env", () => {
    const base = publicDir("core-cwd-real-");
    const dashed = path.join(base, "-dash dir");
    fs.mkdirSync(dashed, { mode: 0o700 });
    fs.chownSync(dashed, CORE_UID, CORE_GID);
    const pwd = runAsCoreFromDaemon(coreSpec("/bin/pwd", [], dashed, "/tmp"));
    expect(pwd.stderr).toBe("");
    expect(pwd.status).toBe(0);
    expect(pwd.stdout.trim()).toBe(fs.realpathSync(dashed));

    const env = runAsCoreFromDaemon(coreSpec("/usr/bin/env", [], dashed, "/home/core"));
    expect(env.stderr).toBe("");
    expect(env.stdout).toContain("HOME=/home/core\n");
    expect(env.stdout).toContain("USER=core\n");
    expect(env.stdout).not.toContain("AC_USER_DATA_DIR");
    expect(env.stdout).not.toContain("/var/lib/actana");
  });

  it("the child cannot give itself back the daemon's ids: the capabilities are gone", () => {
    const r = runAsCoreFromDaemon(
      coreSpec("/usr/bin/setpriv", [`--reuid=${DAEMON_UID}`, "/bin/true"], undefined, "/tmp"),
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not permitted|setresuid/i);
  });

  it("coreKillSpec reaches a core process the daemon itself cannot signal", async () => {
    const spec = coreSpec("/bin/sleep", ["30"], undefined, "/tmp");
    const child = spawn(SETPRIV!, asDaemon([spec.command, ...spec.args]), {
      cwd: "/",
      env: spec.env,
      stdio: "ignore",
    });
    const pid = child.pid as number;
    const exited = new Promise<string | null>((resolve) => child.on("exit", (_c, signal) => resolve(signal)));
    try {
      // Wait until it has become core's, so the signal is aimed at the right thing.
      const deadline = Date.now() + 5_000;
      let uid = "";
      while (Date.now() < deadline) {
        uid = /^Uid:\s*(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? "";
        if (uid === String(CORE_UID)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(uid).toBe(String(CORE_UID));

      // The daemon's own kill(2): refused, and the child is still there.
      const direct = run(asDaemon(["/bin/sh", "-c", 'kill -s KILL "$1"', "sh", String(pid)]));
      expect(direct.status).not.toBe(0);
      expect(direct.stderr).toMatch(/not permitted/i);
      expect(fs.existsSync(`/proc/${pid}`)).toBe(true);

      // Through the wrapper: delivered.
      const kill = coreKillSpec(pid, "SIGKILL", {
        identityEnv: { AC_CORE_HOME: "/tmp", AC_CORE_UID: String(CORE_UID), AC_CORE_GID: String(CORE_GID) },
      });
      const r = run(asDaemon([kill.command, ...kill.args]), kill.env);
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(await exited).toBe("SIGKILL");
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });
});
