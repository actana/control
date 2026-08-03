import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_SPAWN_COMMANDS } from "./agent-cli-config";
import { isAiModelId } from "./ai-runtime-defaults";
import type { TaskAgent } from "./domain";
import { buildCmdScriptCommand, isWindowsCommandScript } from "./windows-cmd";

export type TaskAgentSpawn = TaskAgent;

/** @deprecated Import AGENT_SPAWN_COMMANDS from agent-cli-config instead. */
export const AGENT_BINARIES = AGENT_SPAWN_COMMANDS;

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

export type AgentSpawnRequest = BaseSpawnRequest & {
  agent: TaskAgentSpawn;
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
 * Harness's machine, distinct from agent workspaces and project-scoped shells.
 * `shellSession: true` is its own spawn mode: no `agent`, no project-root
 * requirement (a VM shell has no project folder). The Harness skips the
 * project-root validation it applies to agent spawns and starts a login shell
 * at its own home — the renderer never supplies a host filesystem path. Gated
 * by core-link auth (mTLS + bearer), never auto-spawned; opened by an explicit
 * Panel gesture. The "SSH-equivalent" escape hatch.
 *
 * `cwd` is optional/empty from the renderer; the spawn handler
 * ({@link PtyHarnessCore.spawn}) replaces it with its own `os.homedir()`
 * before calling {@link resolveSpawnPlan}, so the plan's `cwd` is the real
 * home path on the Harness machine.
 */
export type ShellSessionSpawnRequest = {
  taskId: string;
  /**
   * Optional cwd on the Harness machine. The renderer never knows a host
   * path, so it sends "" (or omits); the spawn handler
   * ({@link PtyHarnessCore.spawn}) replaces it with its own `os.homedir()`.
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
  | AgentSpawnRequest
  | ShellSpawnRequest
  | ShellSessionSpawnRequest;

export type SpawnPlan =
  | {
      mode: "agent";
      agent: TaskAgentSpawn;
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
      // A VM Shell Session (issue 06): a login shell on the Harness's machine
      // with no project-root containment. cwd is the Harness's own home dir
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
  // terminals (req.home === true). Agent spawns ignore this list and stay
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
  | "empty-command";

const SHELL_META = /[`$();&|<>"'\\\n\r\t*?{}[\]~#!]/;

type AgentArgRule = {
  value: false | { allowed?: readonly string[] };
  requiresDangerouslySkipPermissions?: boolean;
  /** When set, string arg values must start with this prefix (OpenCode session ids). */
  valuePrefix?: string;
};

const AGENT_ARG_RULES: Readonly<Record<TaskAgentSpawn, Readonly<Record<string, AgentArgRule>>>> = {
  "claude-code": {
    "--bare": { value: false },
    "--session-id": { value: {} },
    "--resume": { value: {} },
    "--model": { value: {} },
    "--dangerously-skip-permissions": {
      value: false,
      requiresDangerouslySkipPermissions: true,
    },
  },
  codex: {
    "--model": { value: {} },
    "--enable": { value: { allowed: ["hooks"] } },
    "--yolo": { value: false, requiresDangerouslySkipPermissions: true },
  },
  "cursor-cli": {
    "--resume": { value: {} },
    "--model": { value: {} },
    "--force": { value: false, requiresDangerouslySkipPermissions: true },
  },
  opencode: {
    "--model": { value: {} },
    "--session": { value: {}, valuePrefix: "ses" },
  },
};

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

function tokenizeAgentCommand(cmd: string): string[] {
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
    validateAgentArgv("codex", argv.slice(2), opts);
    return;
  }
  validateAgentArgv("codex", argv, opts);
}

function validateAgentArgv(
  agent: TaskAgentSpawn,
  argv: string[],
  opts: { dangerouslySkipPermissions: boolean },
): void {
  const rules = AGENT_ARG_RULES[agent];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const rule = rules[arg];
    if (!rule) {
      throw new SpawnPolicyError(
        "agent-arg-not-allowed",
        `pty:spawn rejected unsupported ${agent} argument`,
      );
    }
    if (rule.requiresDangerouslySkipPermissions && !opts.dangerouslySkipPermissions) {
      throw new SpawnPolicyError(
        "agent-arg-not-allowed",
        `pty:spawn rejected unsupported ${agent} argument`,
      );
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
}

export function resolveSpawnPlan(req: SpawnRequest, deps: SpawnPolicyDeps): SpawnPlan {
  const cwdExists = deps.cwdExists ?? defaultCwdExists;
  const realpath = deps.realpath ?? defaultRealpath;

  // ─── VM Shell Session (issue 06) ───
  // A `shellSession: true` spawn is a free-form shell on the Harness's machine
  // with NO project-root requirement. It is gated by core-link auth (mTLS +
  // bearer), not by cwd containment, so the project-root check below is
  // skipped entirely. The handler (PtyHarnessCore.spawn) supplies the real
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
  const hasAgent = typeof req.agent === "string" && req.agent.length > 0;

  if (wantsShell && hasAgent) {
    throw new SpawnPolicyError(
      "shell-with-agent",
      "pty:spawn cannot set shell=true and agent at the same time",
    );
  }

  if (!wantsShell && !hasAgent) {
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

  // 5. Agent mode: agent must be in the allow-list.
  const agentKey = req.agent as TaskAgentSpawn;
  const expectedBinary = AGENT_BINARIES[agentKey];
  if (!expectedBinary) {
    throw new SpawnPolicyError(
      "unknown-agent",
      "pty:spawn agent is not in the allow-list",
    );
  }

  // 6. First token of `command` must match the agent's binary; the rest is argv.
  const tokens = tokenizeAgentCommand(req.command ?? "");
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
  if (agentKey === "codex") {
    validateCodexArgv(argv, spawnOpts);
  } else {
    validateAgentArgv(agentKey, argv, spawnOpts);
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
    agent: agentKey,
    binary: resolved,
    argv,
    ...nodePtySpawnTarget(resolved, argv, deps),
    cwd: realCwd,
  };
}
