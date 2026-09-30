import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
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
    expect(env.PATH).toBe("/home/core/.local/bin:/opt/actana/bin:/usr/bin:/bin");
  });

  it("does not leak the daemon's state, secrets or identity variables", () => {
    const env = coreChildEnv(identity, daemonEnv);
    expect(Object.keys(env).filter((k) => /AC_(USER_DATA|SECRETS|PANEL|HARNESS_MATERIAL|CORE_)/.test(k))).toEqual([]);
    expect(JSON.stringify(env)).not.toContain("/var/lib/actana");
    expect(JSON.stringify(env)).not.toContain("actana\"");
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
        "/home/core/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      );
    } finally {
      delete process.env.SENTINEL_DAEMON_ONLY;
    }
  });

  it("does not repeat core's local bin", () => {
    const env = coreChildEnv(identity, { PATH: "/home/core/.local/bin:/usr/bin" });
    expect(env.PATH).toBe("/home/core/.local/bin:/usr/bin");
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

// The wrapper for real. It needs CAP_SETUID and CAP_SETGID, so it only runs as
// root (CI's container, or `unshare -Ur`); everywhere else it is skipped and
// vitest says so in its summary. The argv tests above are what runs on every
// machine.
const isRoot = process.platform === "linux" && process.getuid?.() === 0;
const realSetpriv = ["/usr/bin/setpriv", "/bin/setpriv"].some((f) => fs.existsSync(f));

describe.skipIf(!isRoot || !realSetpriv)("asCore for real (Linux, root)", () => {
  const id = { AC_CORE_HOME: "", AC_CORE_UID: "65534", AC_CORE_GID: "65534" };

  function run(command: string, args: string[], cwd: string | undefined, home: string) {
    const spec = asCore(
      { command, args, cwd, env: { PATH: "/usr/bin:/bin", AC_USER_DATA_DIR: "/secret" } },
      { identityEnv: { ...id, AC_CORE_HOME: home } },
    );
    return spawnSync(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, encoding: "utf8" });
  }

  it("runs the child as the core ids with no capabilities, no groups and no new privileges", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "core-home-"));
    fs.chmodSync(home, 0o755);
    try {
      const r = run("/bin/cat", ["/proc/self/status"], undefined, home);
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      const field = (name: string) => new RegExp(`^${name}:\\s*(.*)$`, "m").exec(r.stdout)?.[1];
      expect(field("Uid")).toBe("65534\t65534\t65534\t65534");
      expect(field("Gid")).toBe("65534\t65534\t65534\t65534");
      expect(field("Groups")?.trim()).toBe("");
      expect(field("CapPrm")).toBe("0000000000000000");
      expect(field("CapEff")).toBe("0000000000000000");
      expect(field("CapInh")).toBe("0000000000000000");
      expect(field("CapAmb")).toBe("0000000000000000");
      expect(field("NoNewPrivs")).toBe("1");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does the cd after the switch, rebuilds the env, and leaks nothing from the caller", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "core cwd "));
    fs.chmodSync(dir, 0o755);
    const dashed = path.join(dir, "-dash dir");
    fs.mkdirSync(dashed, { mode: 0o755 });
    try {
      const r = run("/usr/bin/env", [], dashed, "/home/core");
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("HOME=/home/core\n");
      expect(r.stdout).toContain("USER=core\n");
      expect(r.stdout).toContain("SHELL=/bin/bash\n");
      expect(r.stdout).not.toContain("AC_USER_DATA_DIR");
      const pwd = run("/bin/pwd", [], dashed, "/home/core");
      expect(pwd.stdout.trim()).toBe(fs.realpathSync(dashed));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cannot setuid back: the capabilities really are gone", () => {
    const r = run("/usr/bin/setpriv", ["--reuid=0", "true"], undefined, "/tmp");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Operation not permitted|setresuid/i);
  });

  it("coreKillSpec stops a process of the core user that the caller could not signal", () => {
    const spec = asCore(
      { command: "/bin/sleep", args: ["30"], env: { PATH: "/usr/bin:/bin" } },
      { identityEnv: { ...id, AC_CORE_HOME: "/tmp" } },
    );
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: "ignore" });
    const pid = child.pid as number;
    const kill = coreKillSpec(pid, "SIGKILL", { identityEnv: { ...id, AC_CORE_HOME: "/tmp" } });
    const r = spawnSync(kill.command, kill.args, { cwd: kill.cwd, env: kill.env, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    return new Promise<void>((resolve) =>
      child.on("exit", (_code, signal) => {
        expect(signal).toBe("SIGKILL");
        resolve();
      }),
    );
  });
});
