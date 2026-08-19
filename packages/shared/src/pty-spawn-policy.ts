import * as fs from "node:fs";
import * as path from "node:path";
import { HARNESS_AUTO_MODE_FLAGS, HARNESS_SPAWN_COMMANDS } from "./harness-cli-config";
import { isAiModelId } from "./ai-runtime-defaults";
import type { Harness } from "./domain";
import { buildCmdScriptCommand, isWindowsCommandScript } from "./windows-cmd";

export type HarnessSpawn = Harness;

/** @deprecated Import HARNESS_SPAWN_COMMANDS from harness-cli-config instead. */
export const HARNESS_BINARIES = HARNESS_SPAWN_COMMANDS;

export type BaseSpawnRequest = {
  taskId: string;
  cwd: string;
  command: string;
  args?: string[];
  cols?: number;
  rows?: number;
  mcEnv?: { apiUrl?: string; token?: string };
  /** Actana Control UI theme so agent skills can match diagram styling. */
  missionControlTheme?: "dark" | "light";
  /**
   * Discriminant for the VM Shell Session mode (issue 06). `never` here keeps
   * agent/shell spawns out of that branch; {@link ShellSessionSpawnRequest}
   * sets it to `true`. Declared on the base so `req.shellSession` is readable
   * on the whole {@link SpawnRequest} union for a discriminated narrow.
   */
  shellSession?: never;
};

export type HarnessSpawnRequest = BaseSpawnRequest & {
  agent: HarnessSpawn;
  dangerouslySkipPermissions?: boolean;
  shell?: never;
  // Optional programmatic starting prompt written to the agent's stdin once
  // its TUI is ready. This is input DATA, not part of the spawn command — it
  // never passes through the argv allow-list, exactly like a user typing into
  // the terminal.
  initialInput?: string;
};

export type ShellSpawnRequest = BaseSpawnRequest & {
  // Renderer must set shell: true for a free-form user shell terminal (agent
  // undefined). Forces every spawn callsite to declare which boundary it's
  // on — agent allow-list vs. user-driven shell — so a briefly-compromised
  // renderer can't slip an arbitrary command through the "agent" branch.
  shell: true;
  agent?: never;
  dangerouslySkipPermissions?: never;
  // Project-less "home" shell terminal (the dashboard terminals). When set, the
  // spawn HANDLER — not this pure policy — replaces cwd with its own
  // os.homedir() and passes that dir through `homeShellRoots` so the cwd-root
  // check accepts it. This lets a dashboard terminal open at ~ on whichever
  // runtime it lands on (local host or remote agent) without the renderer ever
  // learning or supplying a host filesystem path.
  home?: boolean;
};

/**
 * A VM Shell Session spawn (issue 06) — a free-form interactive shell on the
 * Core's machine, distinct from agent workspaces and project-scoped shells.
 * `shellSession: true` is its own spawn mode: no `agent`, no project-root
 * requirement (a VM shell has no project folder). The Core skips the
 * project-root validation it applies to agent spawns and starts a login shell
 * at its own home — the renderer never supplies a host filesystem path. Gated
 * by core-link auth (mTLS + bearer), never auto-spawned; opened by an explicit
 * Panel gesture. The "SSH-equivalent" escape hatch.
 *
 * `cwd` is optional/empty from the renderer; the spawn handler
 * ({@link PtyCore.spawn}) replaces it with its own `os.homedir()`
 * before calling {@link resolveSpawnPlan}, so the plan's `cwd` is the real
 * home path on the Core machine.
 *
 * **Not every process a Core runs comes through here.** `actana core exec`
 * (issue 266) starts a plain child with pipes and no terminal, so it is not a
 * spawn mode in this union and no plan below describes it; its own cwd check
 * lives in `packages/core/src/core-exec.ts`. It grants nothing this mode does
 * not — same blob, same link, same free-form command on the Core's machine —
 * so nothing here needed relaxing for it.
 */
export type ShellSessionSpawnRequest = {
  taskId: string;
  /**
   * Optional cwd on the Core machine. The renderer never knows a host
   * path, so it sends "" (or omits); the spawn handler
   * ({@link PtyCore.spawn}) replaces it with its own `os.homedir()`.
   * A non-empty value (e.g. handler-supplied home) is passed through verbatim
   * — the project-root check is skipped for VM shells regardless.
   */
  cwd?: string;
  /** Optional starting command; empty (or omitted) → interactive login shell. */
  command?: string;
  shellSession: true;
  agent?: never;
  shell?: never;
  dangerouslySkipPermissions?: never;
  home?: never;
  initialInput?: never;
  cols?: number;
  rows?: number;
  mcEnv?: never;
  missionControlTheme?: "dark" | "light";
};

export type SpawnRequest =
  | HarnessSpawnRequest
  | ShellSpawnRequest
  | ShellSessionSpawnRequest;

export type SpawnPlan =
  | {
      mode: "agent";
      agent: HarnessSpawn;
      binary: string;       // resolved agent binary/shim
      argv: string[];        // already-tokenized agent arguments, no shell parsing
      spawnTarget: string;  // executable passed to node-pty
      spawnArgs: string[] | string;  // argv/command line passed to node-pty
      cwd: string;          // canonical (realpath'd) cwd — pass this to spawn, not the original request
    }
  | {
      mode: "shell";
      shellPath: string;     // absolute path to the user's login shell
      shellArgs: string[];   // argv passed to that shell
      command: string;       // the user-supplied shell command (may be empty)
      cwd: string;          // canonical (realpath'd) cwd — pass this to spawn, not the original request
    }
  | {
      // A VM Shell Session (issue 06): a login shell on the Core's machine
      // with no project-root containment. cwd is the Core's own home dir
      // (handler-supplied); the command is passed to the login shell verbatim.
      // See CONTEXT.md "VM Shell Session".
      mode: "shell-session";
      shellPath: string;
      shellArgs: string[];
      command: string;
      cwd: string;
    };

export type SpawnPolicyDeps = {
  // Real fs check by default; tests inject doubles.
  cwdExists?: (cwd: string) => boolean;
  // Resolve a cwd to its canonical absolute path. Tests inject identity.
  realpath?: (p: string) => string;
  // Snapshot of registered project roots. Already canonicalized by caller.
  projectRoots: () => string[];
  // Extra roots a *shell* terminal may start in beyond the project roots —
  // currently just the host's home directory, which enables project-less "home"
  // terminals (req.home === true). Harness spawns ignore this list and stay
  // confined to project roots. Resolved through realpath like project roots.
  homeShellRoots?: () => string[];
  // Resolve a command name (claude/codex/cursor-agent) to an absolute path on PATH.
  resolveCommand: (name: string) => string | null;
  // Returns the user's login shell and its argv for the given command.
  resolveShell: () => { shell: string; shellArgs: (cmd: string | undefined) => string[] };
  platform?: NodeJS.Platform;
  windowsSystemRoot?: () => string | undefined;
};

export class SpawnPolicyError extends Error {
  readonly code: SpawnPolicyErrorCode;
  constructor(code: SpawnPolicyErrorCode, message: string) {
    super(message);
    this.name = "SpawnPolicyError";
    this.code = code;
  }
}

export type SpawnPolicyErrorCode =
  | "invalid-cwd"
  | "cwd-outside-project-roots"
  | "missing-agent-or-shell-flag"
  | "unknown-agent"
  | "command-not-on-allowlist"
  | "binary-not-found"
  | "shell-with-agent"
  | "shell-meta-in-args"
  | "agent-arg-not-allowed"
  | "auto-mode-flag-missing"
  | "empty-command";

const SHELL_META = /[`$();&|<>"'\\\n\r\t*?{}[\]~#!]/;

type HarnessArgRule = {
  value: false | { allowed?: readonly string[] };
  /**
   * This flag IS the harness's auto-mode flag, so it travels with the
   * `dangerouslySkipPermissions` spawn option — in **both** directions. See
   * {@link validateHarnessArgv}.
   */
  requiresDangerouslySkipPermissions?: boolean;
  /** When set, string arg values must start with this prefix (OpenCode session ids). */
  valuePrefix?: string;
};

/**
 * Everything a harness may be launched with **except** its auto-mode flag.
 *
 * That one flag is not written here on purpose (issue 177 finding 2). It used
 * to be, once per harness, which made this table the fourth transcription of a
 * vendor fact the registry already held — and the id/binary coincidence that
 * hid finding 1 for so long was the same shape of mistake one column over.
 * {@link withAutoModeFlags} splices it in from
 * {@link HARNESS_AUTO_MODE_FLAGS}, so a harness whose flag changes changes it
 * in one place and a harness that has none (OpenCode) grows no entry at all.
 */
const HARNESS_ARG_RULES_BASE: Readonly<
  Record<HarnessSpawn, Readonly<Record<string, HarnessArgRule>>>
> = {
  "claude-code": {
    "--bare": { value: false },
    "--session-id": { value: {} },
    "--resume": { value: {} },
    "--model": { value: {} },
  },
  codex: {
    "--model": { value: {} },
    "--enable": { value: { allowed: ["hooks"] } },
  },
  "cursor-cli": {
    "--resume": { value: {} },
    "--model": { value: {} },
  },
  opencode: {
    "--model": { value: {} },
    "--session": { value: {}, valuePrefix: "ses" },
  },
};

function withAutoModeFlags(
  base: Readonly<Record<HarnessSpawn, Readonly<Record<string, HarnessArgRule>>>>,
): Readonly<Record<HarnessSpawn, Readonly<Record<string, HarnessArgRule>>>> {
  return Object.fromEntries(
    Object.entries(base).map(([agent, rules]) => {
      const flag = HARNESS_AUTO_MODE_FLAGS[agent as HarnessSpawn];
      if (flag === null) return [agent, rules];
      return [
        agent,
        { ...rules, [flag]: { value: false, requiresDangerouslySkipPermissions: true } },
      ];
    }),
  ) as Readonly<Record<HarnessSpawn, Readonly<Record<string, HarnessArgRule>>>>;
}

const HARNESS_ARG_RULES = withAutoModeFlags(HARNESS_ARG_RULES_BASE);

/**
 * The flag that puts `agent` into auto mode, or null where the vendor ships
 * none.
 *
 * Re-exported from the harness registry so a caller building a spawn command
 * and the policy validating it are reading the same cell of the same table.
 */
export function autoModeFlagForSpawn(agent: HarnessSpawn): string | null {
  return HARNESS_AUTO_MODE_FLAGS[agent];
}

function windowsCmdExe(deps: SpawnPolicyDeps): string {
  const root = deps.windowsSystemRoot?.() ?? process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  return path.win32.join(root, "System32", "cmd.exe");
}

function nodePtySpawnTarget(
  binary: string,
  argv: string[],
  deps: SpawnPolicyDeps,
): { spawnTarget: string; spawnArgs: string[] | string } {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32" && isWindowsCommandScript(binary)) {
    const command = buildCmdScriptCommand(binary, argv);
    return {
      spawnTarget: windowsCmdExe(deps),
      spawnArgs: `/d /s /c ${command}`,
    };
  }
  return { spawnTarget: binary, spawnArgs: argv };
}

function withinRoot(real: string, root: string): boolean {
  if (real === root) return true;
  return real.startsWith(root + path.sep);
}

function tokenizeHarnessCommand(cmd: string): string[] {
  return cmd.trim().split(/\s+/).filter(Boolean);
}

function defaultCwdExists(cwd: string): boolean {
  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) return false;
    fs.accessSync(cwd, fs.constants.R_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

const CODEX_RESUME_SUBCOMMAND = "resume";

function validateCodexArgv(
  argv: string[],
  opts: { dangerouslySkipPermissions: boolean },
): void {
  if (argv[0] === CODEX_RESUME_SUBCOMMAND) {
    const sessionId = argv[1];
    if (
      !sessionId ||
      sessionId.startsWith("-") ||
      !isAiModelId(sessionId)
    ) {
      throw new SpawnPolicyError(
        "agent-arg-not-allowed",
        "pty:spawn rejected invalid value for codex resume session id",
      );
    }
    validateHarnessArgv("codex", argv.slice(2), opts);
    return;
  }
  validateHarnessArgv("codex", argv, opts);
}

/**
 * Check one harness's argv against its allow-list, in **both** directions of
 * the auto-mode gesture.
 *
 * The option (`dangerouslySkipPermissions`) and the flag (`--force`, `--yolo`,
 * `--dangerously-skip-permissions`) are two halves of one request, and until
 * issue 177 only one half was checked: a flag with no option was rejected, an
 * option with no flag passed. That asymmetry is what made finding 2 invisible.
 * A caller that set the option and built its command string from a
 * Claude-shaped template got a Core that accepted the spawn, launched an
 * *interactive* cursor-agent, and reported nothing unusual — the session then
 * parked on a permission prompt that the caller, believing itself unattended,
 * was not watching for. A rejected spawn says so in one line at the point of
 * the mistake.
 *
 * The one harness this cannot be asked of is OpenCode, which ships no such
 * flag: {@link HARNESS_AUTO_MODE_FLAGS} holds `null` for it, and asking for
 * auto mode there is asking for something that does not exist rather than
 * something that was dropped on the way. Refusing that launch would break the
 * harness over a flag no version of it has ever had, so the option is allowed
 * to be a no-op there and *only* there — which is a fact of the table, not a
 * special case in this function.
 *
 * `argv` here is the flags only. `validateCodexArgv` strips the `resume <id>`
 * subcommand before calling in, and the auto-mode flag is a flag either way, so
 * a resumed Codex session is checked exactly like a fresh one.
 */
function validateHarnessArgv(
  agent: HarnessSpawn,
  argv: string[],
  opts: { dangerouslySkipPermissions: boolean },
): void {
  const rules = HARNESS_ARG_RULES[agent];
  // Collected as the loop consumes argv rather than scanned for afterwards: a
  // flag token and a flag-shaped *value* are different things, and only the
  // loop knows which is which.
  let sawAutoModeFlag = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const rule = rules[arg];
    if (!rule) {
      throw new SpawnPolicyError(
        "agent-arg-not-allowed",
        `pty:spawn rejected unsupported ${agent} argument`,
      );
    }
    if (rule.requiresDangerouslySkipPermissions) {
      if (!opts.dangerouslySkipPermissions) {
        throw new SpawnPolicyError(
          "agent-arg-not-allowed",
          `pty:spawn rejected unsupported ${agent} argument`,
        );
      }
      sawAutoModeFlag = true;
    }
    if (rule.value === false) continue;

    const value = argv[i + 1];
    if (
      !value ||
      value.startsWith("-") ||
      !isAiModelId(value) ||
      (rule.value.allowed && !rule.value.allowed.includes(value)) ||
      (rule.valuePrefix && !value.startsWith(rule.valuePrefix))
    ) {
      throw new SpawnPolicyError(
        "agent-arg-not-allowed",
        `pty:spawn rejected invalid value for ${agent} argument`,
      );
    }
    i += 1;
  }

  // The other direction, and the reason this function exists in the shape it
  // does. The message names the flag because the caller's next move is to add
  // it, and a code that only said "not allowed" would send them looking at the
  // args they *did* send.
  const autoModeFlag = HARNESS_AUTO_MODE_FLAGS[agent];
  if (opts.dangerouslySkipPermissions && autoModeFlag !== null && !sawAutoModeFlag) {
    throw new SpawnPolicyError(
      "auto-mode-flag-missing",
      `pty:spawn asked for ${agent} auto mode without ${autoModeFlag} in the command`,
    );
  }
}

export function resolveSpawnPlan(req: SpawnRequest, deps: SpawnPolicyDeps): SpawnPlan {
  const cwdExists = deps.cwdExists ?? defaultCwdExists;
  const realpath = deps.realpath ?? defaultRealpath;

  // ─── VM Shell Session (issue 06) ───
  // A `shellSession: true` spawn is a free-form shell on the Core's machine
  // with NO project-root requirement. It is gated by core-link auth (mTLS +
  // bearer), not by cwd containment, so the project-root check below is
  // skipped entirely. The handler (PtyCore.spawn) supplies the real
  // cwd (its own os.homedir()); the renderer never sends a host path.
  if (req.shellSession === true) {
    // Mutually exclusive with the agent and shell modes — forces every
    // callsite to declare which boundary it's on, mirroring the shell/agent
    // exclusivity above. `agent`/`shell` are `never` on this variant, so cast
    // to read them (the check is defensive — a misbuilt request that sets
    // both is rejected with a clear error rather than silently misrouting).
    const agent = (req as { agent?: string }).agent;
    if (typeof agent === "string" && agent.length > 0) {
      throw new SpawnPolicyError(
        "shell-with-agent",
        "pty:spawn cannot set shellSession=true and agent at the same time",
      );
    }
    if ((req as { shell?: boolean }).shell === true) {
      throw new SpawnPolicyError(
        "shell-with-agent",
        "pty:spawn cannot set shellSession=true and shell=true at the same time",
      );
    }
    // When the handler pre-fills cwd with its own home, the plan carries it
    // through; an empty renderer-supplied cwd is passed to the login shell
    // (the handler always overrides it before spawning, so the empty value
    // never reaches node-pty — kept here only so the plan typechecks).
    const realCwd = req.cwd ? realpath(req.cwd) : "";
    const { shell, shellArgs } = deps.resolveShell();
    const command = (req.command ?? "").trim();
    return {
      mode: "shell-session",
      shellPath: shell,
      shellArgs: shellArgs(command.length > 0 ? command : undefined),
      command,
      cwd: realCwd,
    };
  }

  // 1. cwd must be a readable directory.
  if (!req.cwd) {
    throw new SpawnPolicyError("invalid-cwd", "cwd is required");
  }
  if (!cwdExists(req.cwd)) {
    throw new SpawnPolicyError("invalid-cwd", "cwd is not an accessible directory");
  }

  // 2. cwd must resolve into one of the registered project roots. Resolving
  //    both sides through realpath prevents symlink escapes (cwd=/tmp/link →
  //    /etc, root=/Users/me/proj).
  const realCwd = realpath(req.cwd);
  const roots = deps.projectRoots().map((r) => {
    try {
      return realpath(r);
    } catch {
      return null;
    }
  }).filter((r): r is string => !!r);

  // An explicit project-less "home" shell terminal (shell + home) may also start
  // in an allowed home root. Gated on req.home so ordinary shell terminals stay
  // confined to project roots, and on req.shell so agent spawns never qualify.
  if (req.shell === true && req.home === true && deps.homeShellRoots) {
    for (const r of deps.homeShellRoots()) {
      try {
        roots.push(realpath(r));
      } catch {
        /* unresolvable home root — skip it rather than widen the check */
      }
    }
  }

  if (!roots.some((root) => withinRoot(realCwd, root))) {
    throw new SpawnPolicyError(
      "cwd-outside-project-roots",
      "cwd is not within any registered project root",
    );
  }

  // 3. Branch: shell terminal vs. agent terminal. Exactly one must be true.
  const wantsShell = req.shell === true;
  const hasHarness = typeof req.agent === "string" && req.agent.length > 0;

  if (wantsShell && hasHarness) {
    throw new SpawnPolicyError(
      "shell-with-agent",
      "pty:spawn cannot set shell=true and agent at the same time",
    );
  }

  if (!wantsShell && !hasHarness) {
    throw new SpawnPolicyError(
      "missing-agent-or-shell-flag",
      "pty:spawn requires either a known agent or shell=true",
    );
  }

  // 4. Shell mode: the command is user-supplied and intentionally goes through
  //    the login shell. Cwd was already pinned to a project root above.
  if (wantsShell) {
    const { shell, shellArgs } = deps.resolveShell();
    const command = (req.command ?? "").trim();
    return {
      mode: "shell",
      shellPath: shell,
      shellArgs: shellArgs(command.length > 0 ? command : undefined),
      command,
      cwd: realCwd,
    };
  }

  // 5. Harness mode: agent must be in the allow-list.
  const harnessKey = req.agent as HarnessSpawn;
  const expectedBinary = HARNESS_BINARIES[harnessKey];
  if (!expectedBinary) {
    throw new SpawnPolicyError(
      "unknown-agent",
      "pty:spawn agent is not in the allow-list",
    );
  }

  // 6. First token of `command` must match the agent's binary; the rest is argv.
  const tokens = tokenizeHarnessCommand(req.command ?? "");
  if (tokens.length === 0) {
    throw new SpawnPolicyError(
      "empty-command",
      "pty:spawn agent requires a non-empty command",
    );
  }
  if (tokens[0] !== expectedBinary) {
    throw new SpawnPolicyError(
      "command-not-on-allowlist",
      "pty:spawn agent command is not allow-listed",
    );
  }
  const argv = [...tokens.slice(1), ...(req.args ?? [])];

  // 7. Reject shell metacharacters in argv. With direct argv spawn there's no
  //    shell to re-parse them, but a stray `;` or `$()` in an arg is never a
  //    legitimate agent invocation and almost certainly an injection attempt.
  for (const arg of argv) {
    if (SHELL_META.test(arg)) {
      throw new SpawnPolicyError(
        "shell-meta-in-args",
        "pty:spawn rejected shell metacharacter in arg",
      );
    }
  }

  const spawnOpts = { dangerouslySkipPermissions: req.dangerouslySkipPermissions === true };
  if (harnessKey === "codex") {
    validateCodexArgv(argv, spawnOpts);
  } else {
    validateHarnessArgv(harnessKey, argv, spawnOpts);
  }

  const resolved = deps.resolveCommand(expectedBinary);
  if (!resolved) {
    throw new SpawnPolicyError(
      "binary-not-found",
      "pty:spawn could not find agent binary on PATH",
    );
  }

  return {
    mode: "agent",
    agent: harnessKey,
    binary: resolved,
    argv,
    ...nodePtySpawnTarget(resolved, argv, deps),
    cwd: realCwd,
  };
}
