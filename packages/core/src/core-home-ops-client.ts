// The daemon's side of `core-home-ops` (issue 559, PR 3): ask a `core` process to
// do one short thing in core's home, and read back the answer.
//
// In the container each request is one short-lived child, started through
// `asCore` with the bundled helper (`core-home-ops.cjs`, next to the daemon's own
// bundle): one JSON request on stdin, one JSON answer on stdout. Its environment
// is what `asCore` builds for any child of `core` and nothing the daemon holds;
// the request carries the data it needs and never a path into the daemon's state.
// Outside the container there is no second user, and the same request is handled
// in this process, so nothing about a metal install changes.
//
// **Async only, on purpose.** A sync wait (`spawnSync`) cannot be bounded here:
// its timeout sends a signal and then waits for the child to exit, and the
// helper is another uid with no CAP_KILL on the daemon's side, so a hung helper
// would hold the whole event loop, and every Session's output with it, until it
// chose to exit. Every request has a deadline (`HELPER_TIMEOUT_MS`), and past it
// the helper is signalled through `killAsCore`, not `ChildProcess.kill`: after
// the switch it is another uid, and the daemon has no CAP_KILL.

import { spawn } from "node:child_process";
import * as path from "node:path";
import log from "@actana/shared/log";
import type { SkillInstallEntry } from "@actana/shared/orchestration-skill-install";
import {
  asCore,
  coreHome,
  coreIdentity,
  killAsCoreQuietly,
  type KillAsCoreOptions,
  type SpawnSpec,
} from "./core-identity";
import type { AsCoreOptions } from "@actana/shared/core-home";
import {
  CoreHomeOpFailedError,
  CoreHomeOpRefusedError,
  handleCoreHomeOp,
  parseCoreHomeOpRequest,
  type CoreHomeOpContext,
  type CoreHomeOpRequest,
  type CoreHomeOpResult,
  type CoreHomeOperation,
  type RegistrationCredential,
  type SpawnPathFacts,
} from "./core-home-ops";
import { reportSkillEntries } from "./orchestration-skill";
import type { HookInstallResult } from "./harness-hooks";

export { CoreHomeOpFailedError, CoreHomeOpRefusedError } from "./core-home-ops";
export type { SpawnPathFacts } from "./core-home-ops";

/** The helper's bundle, beside `core-entry.cjs` (`build.mjs` emits both into `dist`). */
export const CORE_HOME_OPS_BUNDLE = "core-home-ops.cjs";
/** A helper that has not answered by now is stuck; nothing it does is this slow. */
export const HELPER_TIMEOUT_MS = 15_000;
/** The most an answer may carry; far above any real one. */
const MAX_ANSWER_BYTES = 16 * 1024 * 1024;
const STDERR_EXCERPT = 500;
/** `MAX_ROOTS` of the operations module, which refuses more. */
const MAX_FACT_ROOTS = 256;

type HelperSpec = SpawnSpec & { args: string[] };

/** What running the helper produced. */
export type HelperOutcome = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type CoreHomeOpsOptions = AsCoreOptions & {
  /** Where the helper bundle is. Tests point it at one they built. */
  helperPath?: string;
  /** Builds the launch spec. Tests pass an identity function, since they cannot `setpriv`. */
  wrap?: typeof asCore;
  /** Async runner for the helper. Tests stub it. */
  run?: (spec: HelperSpec, input: string) => Promise<HelperOutcome>;
  /** How long the helper may take before it is killed. Tests shorten it. */
  timeoutMs?: number;
  /** Options for the kill of a hung helper (`killAsCore`). Tests pass a runner. */
  killOptions?: KillAsCoreOptions;
  /** In-process only (outside the container): the home and env the handler works in. */
  home?: string;
  env?: NodeJS.ProcessEnv;
};

let defaults: CoreHomeOpsOptions = {};

/**
 * Options every call starts from, for a test that cannot `setpriv`: it swaps the
 * runner or the launch wrapper once and every call site below goes through it.
 * Pass `null` to put the real ones back. Not used by the daemon.
 */
export function configureCoreHomeOps(options: CoreHomeOpsOptions | null): void {
  defaults = options ?? {};
}

function helperSpec(options: CoreHomeOpsOptions): HelperSpec {
  const helper = options.helperPath ?? path.join(__dirname, CORE_HOME_OPS_BUNDLE);
  // `env: {}` on purpose. `asCore` builds the child's environment from it and
  // from nothing else; the daemon's own `process.env` is never the base.
  const spec = { command: process.execPath, args: [helper], env: {} };
  return (options.wrap ? options.wrap(spec, options) : asCore(spec, options)) as HelperSpec;
}

function runHelper(spec: HelperSpec, input: string, options: CoreHomeOpsOptions): Promise<HelperOutcome> {
  const timeoutMs = options.timeoutMs ?? HELPER_TIMEOUT_MS;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (outcome: HelperOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      killAsCoreQuietly(child, "SIGKILL", "core-home-ops.kill", options.killOptions);
      // Let go of the pipes, so a helper that never dies holds no handle here.
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      done({ status: null, stdout, stderr, error: new Error(`no answer within ${timeoutMs} ms`) });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_ANSWER_BYTES) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString();
    });
    child.on("error", (error) => done({ status: null, stdout, stderr, error }));
    child.on("close", (status) => done({ status, stdout, stderr }));
    child.stdin.on("error", () => undefined); // the helper may answer and exit before it reads all of it
    child.stdin.end(input);
  });
}

type HelperAnswer = { ok?: unknown; result?: unknown; code?: unknown; message?: unknown };

/** The helper's stdout, or null when it is not JSON: the exit status and stderr still say what happened. */
function parseAnswer(stdout: string): HelperAnswer | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed === "object" && parsed !== null ? (parsed as HelperAnswer) : null;
  } catch {
    return null;
  }
}

/** Turn what the helper did into the result, or the error it stands for. */
export function decodeHelperOutcome(op: string, outcome: HelperOutcome): unknown {
  const excerpt = outcome.stderr.trim().slice(0, STDERR_EXCERPT);
  if (outcome.error || outcome.status === null) {
    throw new Error(`core-home-ops ${op}: the helper did not finish: ${outcome.error?.message ?? "killed by a signal"} ${excerpt}`.trim());
  }
  const answer = parseAnswer(outcome.stdout);
  const message = typeof answer?.message === "string" ? answer.message : excerpt;
  if (outcome.status === 2) {
    throw new CoreHomeOpRefusedError(
      (typeof answer?.code === "string" ? answer.code : "bad-request") as CoreHomeOpRefusedError["code"],
      message,
    );
  }
  if (outcome.status === 1) throw new CoreHomeOpFailedError(message);
  if (outcome.status !== 0 || answer === null || answer.ok !== true) {
    throw new Error(`core-home-ops ${op}: helper exit ${outcome.status}, unreadable answer: ${excerpt}`);
  }
  return answer.result;
}

function inProcessContext(options: CoreHomeOpsOptions): CoreHomeOpContext {
  return { home: options.home ?? coreHome(), roots: null, env: options.env ?? process.env };
}

/**
 * Run one operation as `core`: in a helper process in the container, in this
 * process outside it. Rejects with {@link CoreHomeOpRefusedError} for a request
 * the helper will not run, {@link CoreHomeOpFailedError} for one that ran and
 * failed, and a plain `Error` when the helper itself could not be run.
 */
export async function coreHomeOp<Op extends CoreHomeOperation>(
  request: Extract<CoreHomeOpRequest, { op: Op }>,
  callOptions: CoreHomeOpsOptions = {},
): Promise<CoreHomeOpResult[Op]> {
  const options = { ...defaults, ...callOptions };
  if (!coreIdentity(options.identityEnv ?? process.env)) {
    return handleCoreHomeOp(parseCoreHomeOpRequest(request) as typeof request, inProcessContext(options));
  }
  // Checked here too, so a malformed request is refused without a process; the
  // helper checks it again, since it cannot trust who sent it.
  parseCoreHomeOpRequest(request);
  const outcome = await (options.run ?? ((spec, input) => runHelper(spec, input, options)))(helperSpec(options), JSON.stringify(request));
  return decodeHelperOutcome((request as CoreHomeOpRequest).op, outcome) as CoreHomeOpResult[Op];
}

// ─── the daemon's operations ─────────────────────────────────────────
//
// One function per thing the daemon used to do to core's home itself. Each keeps
// the failure contract of the code it replaces: what was best-effort stays
// best-effort (and now says so in the log when it fails), and what threw still
// throws the same sentence.

/** Claude Code's Shift+Enter flag, best-effort: a failure is a log line, never a boot failure. */
export async function ensureClaudeShiftEnterBindingViaCore(options: CoreHomeOpsOptions = {}): Promise<void> {
  try {
    await coreHomeOp({ op: "ensureClaudeShiftEnterBinding" }, options);
  } catch (err) {
    log.warn("core-home-ops.shift-enter.failed", { error: String(err) });
  }
}

/** The statusline tap for a Claude Code workspace, best-effort. */
export async function ensureStatuslineTapViaCore(cwd: string, options: CoreHomeOpsOptions = {}): Promise<void> {
  try {
    await coreHomeOp({ op: "ensureStatuslineTap", cwd }, options);
  } catch (err) {
    log.warn("core-home-ops.statusline-tap.failed", { cwd, error: String(err) });
  }
}

const NO_HOOKS: HookInstallResult = { installed: false, reportsTurnStart: false, hookTrustBypassEarned: false };

/**
 * Install the lifecycle hooks into `cwd`. A failure, of the helper or of the
 * write, reports the same as an unsupported harness (`installed: false`): that is
 * `installHarnessHooks`'s own contract, and what keeps the Panel's fallback armed.
 */
export async function installHarnessHooksViaCore(
  harness: string | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: CoreHomeOpsOptions = {},
): Promise<HookInstallResult> {
  if (!harness || !cwd) return NO_HOOKS;
  try {
    return await coreHomeOp(
      { op: "installHarnessHooks", harness, cwd, piAgentDir: env.PI_CODING_AGENT_DIR?.trim() || null },
      options,
    );
  } catch (err) {
    log.warn("core-home-ops.hooks.failed", { harness, cwd, error: String(err) });
    return NO_HOOKS;
  }
}

/** The product's orchestration skill into core's Harness skill folders; logs as the local install does. */
export async function ensureOrchestrationSkillViaCore(options: CoreHomeOpsOptions = {}): Promise<SkillInstallEntry[]> {
  let entries: SkillInstallEntry[];
  try {
    entries = await coreHomeOp({ op: "ensureOrchestrationSkill" }, options);
  } catch (err) {
    log.warn("core-skill.install-failed", { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
  reportSkillEntries(entries);
  return entries;
}

/** Write this Core's own registry entry. Throws; `registerSelfWithLocalCli` turns that into its `ok: false`. */
export function wireLocalCoreViaCore(
  label: string,
  credential: RegistrationCredential,
  options: CoreHomeOpsOptions = {},
) {
  return coreHomeOp({ op: "wireLocalCore", label, credential }, options);
}

/** The spawn policy's two filesystem questions, answered once for a spawn (see `pty-manager`). */
export function spawnPathFactsViaCore(
  cwd: string,
  roots: string[],
  options: CoreHomeOpsOptions = {},
): Promise<SpawnPathFacts> {
  // Only roots the helper will accept: one registered root that is malformed, or
  // the 256th, must not fail every spawn. A root left out is one the policy cannot
  // resolve, and it drops it, which is the safe direction.
  const usable = roots.filter((r) => typeof r === "string" && r.length > 0 && r.length <= 4096 && !r.includes("\0"));
  return coreHomeOp({ op: "spawnPathFacts", cwd, roots: usable.slice(0, MAX_FACT_ROOTS) }, options);
}

/** `core exec`'s working directory, checked by the user that will run there. */
export async function resolveExecCwdViaCore(
  requested: string | null | undefined,
  options: CoreHomeOpsOptions = {},
): Promise<string> {
  // Blank is "this Core's home", and is said as null: the helper takes no empty strings.
  const { cwd } = await coreHomeOp({ op: "resolveExecCwd", cwd: requested?.trim() ? requested : null }, options);
  return cwd;
}

/**
 * Every executable match for a Harness CLI on `searchPath`, found by `core`: the
 * Harness CLIs are in `~/.local/bin`, which the daemon cannot read. The daemon
 * still picks among them by version (its probes start as `core` already).
 */
export async function resolveCommandViaCore(
  command: string,
  searchPath: string | null,
  options: CoreHomeOpsOptions = {},
): Promise<string[]> {
  const answer = await coreHomeOp({ op: "resolveCommand", command, path: searchPath }, options);
  const candidates = (answer as { candidates?: unknown } | null)?.candidates;
  // An answer that is not a list of paths finds nothing (the policy says binary-not-found)
  // rather than a TypeError in the middle of a spawn.
  return Array.isArray(candidates) ? candidates.filter((c): c is string => typeof c === "string" && c.length > 0) : [];
}

/**
 * Find a Harness CLI and check its version, both done by `core` in the helper. The
 * helper is bounded by {@link HELPER_TIMEOUT_MS} and killed through `killAsCore`, which
 * a `spawnSync` of a file core controls in the daemon is not (no CAP_KILL on another
 * uid): a `--version` that never returns costs one helper, not the daemon's event loop.
 * Rejects like any op, so a helper that hangs or dies is the caller's to record.
 */
export async function probeHarnessCliViaCore(
  command: string,
  searchPath: string | null,
  options: CoreHomeOpsOptions = {},
): Promise<CoreHomeOpResult["probeHarnessCli"]> {
  return coreHomeOp({ op: "probeHarnessCli", command, path: searchPath }, options);
}

/**
 * Ask the installed codex whether it hashes this Core's hooks as `harness-pretrust.ts` does (#703), as `core`:
 * the check writes a throwaway workspace in the home and starts codex there. `searchPath` is the PATH the
 * availability probe searches, so the codex asked is the one a Session gets. Rejects like any op; the setup
 * round records a failure and does not ask again for the same binary and version.
 */
export async function verifyCodexHookTrustViaCore(
  searchPath: string | null,
  options: CoreHomeOpsOptions = {},
): Promise<CoreHomeOpResult["verifyCodexHookTrust"]> {
  return coreHomeOp({ op: "verifyCodexHookTrust", path: searchPath }, options);
}

/**
 * Record trust for `dirs` in each of `harnesses`' own config, as `core` (#685).
 * Never rejects: a Harness that could not be pre-trusted is reported by the
 * setup check when its dialog still shows, and a refusal here must not stop a
 * probe round or a spawn. A writer that reports `failed` is logged here, since callers drop the results.
 */
export async function pretrustWorkspacesViaCore(
  harnesses: readonly string[],
  dirs: readonly string[],
  options: CoreHomeOpsOptions = {},
): Promise<CoreHomeOpResult["pretrustWorkspaces"]> {
  if (harnesses.length === 0 || dirs.length === 0) return [];
  try {
    const results = await coreHomeOp({ op: "pretrustWorkspaces", harnesses: [...harnesses], dirs: [...dirs] }, options);
    for (const r of results) {
      if (r.outcome === "failed") log.warn("core-home-ops.pretrust.harness-failed", { harness: r.harness, detail: r.detail });
    }
    return results;
  } catch (err) {
    log.warn("core-home-ops.pretrust.failed", { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}
