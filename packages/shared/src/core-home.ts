// Who the Core's Sessions run as, and how a child process becomes that user.
//
// Issue 559 (PR 2 of 5). In the container the daemon runs as its own user
// (`actana`) and every Session runs as `core`, so "the home directory" and "the
// login shell" stop being questions `os` can answer for the daemon: `os.homedir()`
// would return the daemon's home. The image tells the daemon who `core` is:
//
//   AC_CORE_HOME  absolute path of core's home          (/home/core)
//   AC_CORE_UID   core's numeric uid                    (1000)
//   AC_CORE_GID   core's numeric gid                    (1000)
//
// **Container mode is exactly "all three are set".** Outside it (metal installs,
// the tarball, every test that does not set them) the operator is the Session
// user, the functions below fall back to `os`, and {@link asCore} hands its
// argument back unchanged. Two of three set is neither mode, it is a broken
// image, and it throws: running a Session as the daemon because a variable was
// misspelt would hand a Session the daemon's keys.
//
// This file holds the only `os.homedir()` / `os.userInfo()` calls the daemon's
// spawn and home paths are allowed to make. Everything else asks here.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CORE_HOME_ENV = "AC_CORE_HOME";
const CORE_UID_ENV = "AC_CORE_UID";
const CORE_GID_ENV = "AC_CORE_GID";

/** The Session user's name. A constant: the image creates it, nothing renames it. */
const CORE_USER = "core";
/** The Session user's login shell in the container image (`useradd --shell`). */
const CORE_CONTAINER_SHELL = "/bin/bash";

export type CoreIdentity = {
  user: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
};

/** The image's identity variables are missing, partial or not usable. */
export class CoreIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreIdentityError";
  }
}

/** A child could not be started as `core`; nothing was spawned. */
export class CoreSpawnRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreSpawnRefusedError";
  }
}

function parseId(name: string, raw: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new CoreIdentityError(`${name} must be a whole number, got ${JSON.stringify(raw)}`);
  }
  const value = Number(raw.trim());
  // 0 is root: "start the Session as root" is the opposite of this whole change.
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CoreIdentityError(`${name} must be a non-root id (1 or more), got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * The Session identity, or `null` outside container mode. Throws
 * {@link CoreIdentityError} when the variables are only partly there.
 */
export function coreIdentity(env: NodeJS.ProcessEnv = process.env): CoreIdentity | null {
  const names = [CORE_HOME_ENV, CORE_UID_ENV, CORE_GID_ENV] as const;
  const present = names.filter((name) => (env[name] ?? "").trim() !== "");
  if (present.length === 0) return null;
  if (present.length !== names.length) {
    const missing = names.filter((name) => !present.includes(name));
    throw new CoreIdentityError(
      `incomplete Core identity: ${present.join(", ")} set but ${missing.join(", ")} missing`,
    );
  }
  const home = (env[CORE_HOME_ENV] as string).trim();
  if (!path.posix.isAbsolute(home) || home.includes("\0")) {
    throw new CoreIdentityError(`${CORE_HOME_ENV} must be an absolute path, got ${JSON.stringify(home)}`);
  }
  return {
    user: CORE_USER,
    uid: parseId(CORE_UID_ENV, env[CORE_UID_ENV] as string),
    gid: parseId(CORE_GID_ENV, env[CORE_GID_ENV] as string),
    home: path.posix.normalize(home).replace(/(.)\/+$/, "$1"),
    shell: CORE_CONTAINER_SHELL,
  };
}

/** True in the container, where the daemon and its Sessions are different users. */
export function isContainerMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return coreIdentity(env) !== null;
}

/** The home the Core's Sessions see: `core`'s in the container, the operator's otherwise. */
export function coreHome(env: NodeJS.ProcessEnv = process.env): string {
  return coreIdentity(env)?.home ?? os.homedir();
}

/** The Session user's name: `core` in the container, the operator's login otherwise. */
export function coreUsername(env: NodeJS.ProcessEnv = process.env): string {
  return coreIdentity(env)?.user ?? os.userInfo().username;
}

/**
 * The Session user's login shell from the account database, or null when there
 * is none. In the container that is `core`'s, never the daemon's `nologin`.
 */
export function coreShell(env: NodeJS.ProcessEnv = process.env): string | null {
  const identity = coreIdentity(env);
  if (identity) return identity.shell;
  return (os.userInfo() as { shell?: string }).shell ?? null;
}

// ─── the child's environment ──────────────────────────────────────────

/**
 * The whole `AC_` namespace is the daemon's own configuration: where its state
 * is, its keys and secrets, the Panel's database, the link's host and port. It is
 * dropped as a namespace and not variable by variable, so a variable a later PR
 * adds (PR 1's state path, the Shared-folder key) is private by default. The one
 * exception is `AC_HOOK_`, which is what a Session's hook commands read back to
 * the daemon's loopback receiver.
 */
function isDaemonNamespace(key: string): boolean {
  return key.startsWith("AC_") && !key.startsWith("AC_HOOK_");
}

/** Identity variables `asCore` sets itself, so the daemon's values can never reach the child. */
const REBUILT_ENV = ["HOME", "USER", "LOGNAME", "SHELL", "PATH", "NPM_CONFIG_PREFIX", "PWD", "OLDPWD"];

const DEFAULT_CHILD_PATH = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];

/** The daemon's state directory in the image (issue 559). A value that mentions it never reaches a child. */
const DAEMON_STATE_DIR = "/var/lib/actana";

/**
 * Paths that are the daemon's: its state directory, its own HOME and the
 * directories of the state variables it was started with. A second net under the
 * name rule: a variable with an unexpected name (`XDG_STATE_HOME`, a tool's
 * `FOO_CACHE`) that points into the daemon's state is dropped by value.
 */
function daemonPaths(identity: CoreIdentity, ...envs: NodeJS.ProcessEnv[]): string[] {
  const found = new Set<string>([DAEMON_STATE_DIR]);
  for (const env of envs) {
    for (const value of [env.HOME, env.AC_USER_DATA_DIR, env.AC_CORE_MATERIAL_FILE && path.posix.dirname(env.AC_CORE_MATERIAL_FILE)]) {
      if (typeof value === "string" && path.posix.isAbsolute(value)) found.add(value.replace(/\/+$/, ""));
    }
  }
  // A path that is, or contains, core's own home is not the daemon's secret.
  return [...found].filter(
    (dir) => dir.length > 1 && dir !== identity.home && !identity.home.startsWith(`${dir}/`),
  );
}

/**
 * The environment a child gets in container mode.
 *
 * Built from `base` (what the caller meant the child to have, never
 * `process.env` implicitly), and it **fails closed**: the `AC_` namespace is
 * dropped except `AC_HOOK_`, any value that mentions the daemon's state
 * directory, its HOME or its state variables' directories is dropped, and the
 * identity variables are set for `core`: HOME, USER, LOGNAME, SHELL, and a PATH
 * that leads with core's own `~/.local/bin`, where the Harness CLIs are
 * installed. `daemonEnv` is only read to learn which paths are the daemon's.
 */
export function coreChildEnv(
  identity: CoreIdentity,
  base: NodeJS.ProcessEnv = {},
  daemonEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const statePaths = daemonPaths(identity, base, daemonEnv);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value !== "string") continue;
    if (isDaemonNamespace(key) || REBUILT_ENV.includes(key)) continue;
    if (statePaths.some((dir) => value.includes(dir))) continue;
    out[key] = value;
  }
  const localBin = path.posix.join(identity.home, ".local", "bin");
  const inherited = (base.PATH ?? "").split(":").filter(Boolean).filter((entry) => !statePaths.some((dir) => entry.includes(dir)));
  const pathEntries = inherited.length > 0 ? inherited : DEFAULT_CHILD_PATH;
  out.PATH = [localBin, ...pathEntries.filter((entry) => entry !== localBin)].join(":");
  out.HOME = identity.home;
  out.USER = identity.user;
  out.LOGNAME = identity.user;
  out.SHELL = identity.shell;
  out.NPM_CONFIG_PREFIX = path.posix.join(identity.home, ".local");
  return out;
}

// ─── asCore ───────────────────────────────────────────────────────────

/** What a spawn needs: the executable, its argv, and where and with what env. */
export type SpawnSpec = {
  command: string;
  /** A string is node-pty's Windows command line; it only ever passes through unchanged. */
  args: string[] | string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

/** What {@link asCore} hands back: same shape, env fully built when it rewrote. */
export type AsCoreOptions = {
  /** Where the identity comes from. Tests pass a literal; the daemon leaves it. */
  identityEnv?: NodeJS.ProcessEnv;
  /** Existence probe for `setpriv`. Tests stub it. */
  exists?: (file: string) => boolean;
};

/**
 * Where `setpriv` is looked for. **Fixed system directories, never `PATH`**: the
 * daemon runs this with CAP_SETUID and CAP_SETGID, and `core`'s `PATH` starts
 * with `~/.local/bin`, a directory a Session writes to. A `setpriv` found there
 * would run with those two capabilities.
 */
const SETPRIV_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

function findSetpriv(exists: (file: string) => boolean): string {
  for (const dir of SETPRIV_DIRS) {
    const candidate = `${dir}/setpriv`;
    if (exists(candidate)) return candidate;
  }
  throw new CoreSpawnRefusedError(
    `refusing to start a process: setpriv is not in ${SETPRIV_DIRS.join(", ")}, ` +
      "and without it the process would run as the daemon instead of as core",
  );
}

// `$0` is the directory and `"$@"` the command: the `cd` runs after the switch,
// as core, so a home the daemon cannot enter is still enterable. `exec "$@"`
// without `--`: dash's `exec` has no option parsing and would take `--` for the
// command's name.
const CD_THEN_EXEC = 'cd -- "$0" && exec "$@"';

/**
 * Wrap a spawn so the child starts as `core`, with no capabilities.
 *
 * Container mode builds exactly:
 *
 * ```
 * setpriv --reuid=UID --regid=GID --clear-groups --inh-caps=-all
 *         --ambient-caps=-all --no-new-privs --
 *         /bin/sh -c 'cd -- "$0" && exec "$@"' CWD COMMAND ARGS...
 * ```
 *
 * `--clear-groups` drops the daemon's supplementary groups; the two `-all` caps
 * flags and `--no-new-privs` leave the child with none of the daemon's
 * capabilities and no way to gain any. node-pty's and Node's own `uid`/`gid`
 * options are not used anywhere, because they switch the id and keep the
 * capabilities: a child that can still `setuid` back to the daemon's user.
 *
 * The spawn's own `cwd` becomes `/` (the daemon may not be able to enter the
 * real one) and the child `cd`s after the switch. No `cwd` means core's home.
 * The env is rebuilt with {@link coreChildEnv}; it never falls back to the
 * daemon's own.
 *
 * Outside container mode the input is returned as it came. Throws
 * {@link CoreIdentityError} on a half-set identity and
 * {@link CoreSpawnRefusedError} when `setpriv` is missing; a caller that
 * cannot start the child as `core` must not start it at all.
 */
export function asCore(
  spec: SpawnSpec & { args: string[] },
  options?: AsCoreOptions,
): SpawnSpec & { args: string[] };
export function asCore(spec: SpawnSpec, options?: AsCoreOptions): SpawnSpec;
export function asCore(spec: SpawnSpec, options: AsCoreOptions = {}): SpawnSpec {
  const identity = coreIdentity(options.identityEnv ?? process.env);
  if (!identity) return spec;
  if (!spec.command) throw new CoreSpawnRefusedError("refusing to start a process with no command");
  if (typeof spec.args === "string") {
    throw new CoreSpawnRefusedError("refusing to start a process from a command line string as core");
  }

  const setpriv = findSetpriv(options.exists ?? fs.existsSync);
  return {
    command: setpriv,
    args: [
      `--reuid=${identity.uid}`,
      `--regid=${identity.gid}`,
      "--clear-groups",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--no-new-privs",
      "--",
      "/bin/sh",
      "-c",
      CD_THEN_EXEC,
      spec.cwd && spec.cwd.length > 0 ? spec.cwd : identity.home,
      spec.command,
      ...spec.args,
    ],
    cwd: "/",
    env: coreChildEnv(identity, spec.env ?? {}),
  };
}

/** Signals `killAsCore` will send. Names without `SIG`, as `kill -s` spells them. */
const SIGNAL_NAME = /^SIG([A-Z][A-Z0-9]{1,9})$/;

/**
 * The argv that signals `pid` (negative: a process group) as `core`, from a
 * `/bin/sh` builtin so it needs no `PATH` and no `kill` binary.
 *
 * The daemon cannot signal `core`'s processes itself: it is another uid and
 * holds no CAP_KILL, so `kill(2)` says EPERM. Pure; {@link killAsCore} in
 * `packages/core` runs it.
 */
export function coreKillSpec(
  pid: number,
  signal: NodeJS.Signals,
  options: AsCoreOptions = {},
): SpawnSpec & { args: string[] } {
  const match = SIGNAL_NAME.exec(signal);
  if (!match) throw new CoreSpawnRefusedError(`refusing to send ${JSON.stringify(signal)}: not a signal name`);
  // 0 is the caller's own group, 1 is init and -1 is every process the user
  // owns: none of them is ever what a Session stop means.
  if (!Number.isSafeInteger(pid) || Math.abs(pid) <= 1) {
    throw new CoreSpawnRefusedError(`refusing to signal pid ${pid}`);
  }
  return asCore(
    {
      command: "/bin/sh",
      args: ["-c", 'kill -s "$1" -- "$2"', "sh", match[1] as string, String(pid)],
    },
    options,
  );
}
