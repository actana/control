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
// Sync and async both exist because the call sites are both. The async form is
// the default and the one a Session's spawn uses, since the event loop also
// carries every Session's output; the sync form is for a boot step and for
// `registerSelfWithLocalCli`, whose callers have nothing to await.
//
// A helper that hangs is signalled through `killAsCore`, not `ChildProcess.kill`:
// after the switch it is another uid, and the daemon has no CAP_KILL.

import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import log from "@actana/shared/log";
import type { CoreLinkDirListing } from "@actana/sdk/core";
import type { SkillInstallEntry } from "@actana/shared/orchestration-skill-install";
import {
  asCore,
  coreHome,
  coreIdentity,
  killAsCoreQuietly,
  type SpawnSpec,
} from "./core-identity";
import type { AsCoreOptions } from "@actana/shared/core-home";
import {
  CoreHomeOpFailedError,
  CoreHomeOpRefusedError,
  handleCoreHomeOp,
  handleCoreHomeOpSync,
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

/** The helper's bundle, beside `core-entry.cjs` (`build.mjs` emits both into `dist`). */
export const CORE_HOME_OPS_BUNDLE = "core-home-ops.cjs";
/** A helper that has not answered by now is stuck; nothing it does is this slow. */
const HELPER_TIMEOUT_MS = 15_000;
/** A directory listing is the largest answer; this is far above it. */
const MAX_ANSWER_BYTES = 16 * 1024 * 1024;
const STDERR_EXCERPT = 500;

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
  /** Sync runner for the helper. Tests stub it. */
  runSync?: (spec: HelperSpec, input: string) => HelperOutcome;
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
  return (options.wrap ?? asCore)({ command: process.execPath, args: [helper], env: {} }, options) as HelperSpec;
}

function runHelper(spec: HelperSpec, input: string): Promise<HelperOutcome> {
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
      killAsCoreQuietly(child, "SIGKILL", "core-home-ops.kill");
      done({ status: null, stdout, stderr, error: new Error(`no answer within ${HELPER_TIMEOUT_MS} ms`) });
    }, HELPER_TIMEOUT_MS);
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

function runHelperSync(spec: HelperSpec, input: string): HelperOutcome {
  const result = spawnSync(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    input,
    encoding: "utf8",
    timeout: HELPER_TIMEOUT_MS,
    maxBuffer: MAX_ANSWER_BYTES,
  });
  if (result.error && typeof result.pid === "number" && result.pid > 1) {
    // spawnSync's own kill cannot reach a process that is now `core`'s.
    killAsCoreQuietly(result.pid, "SIGKILL", "core-home-ops.kill");
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
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
  const outcome = await (options.run ?? runHelper)(helperSpec(options), JSON.stringify(request));
  return decodeHelperOutcome((request as CoreHomeOpRequest).op, outcome) as CoreHomeOpResult[Op];
}

/** {@link coreHomeOp} for the operations that need no `await`, for a caller that cannot await. */
export function coreHomeOpSync<Op extends Exclude<CoreHomeOperation, "dirList">>(
  request: Extract<CoreHomeOpRequest, { op: Op }>,
  callOptions: CoreHomeOpsOptions = {},
): CoreHomeOpResult[Op] {
  const options = { ...defaults, ...callOptions };
  if (!coreIdentity(options.identityEnv ?? process.env)) {
    return handleCoreHomeOpSync(parseCoreHomeOpRequest(request) as typeof request, inProcessContext(options));
  }
  parseCoreHomeOpRequest(request);
  const outcome = (options.runSync ?? runHelperSync)(helperSpec(options), JSON.stringify(request));
  return decodeHelperOutcome((request as CoreHomeOpRequest).op, outcome) as CoreHomeOpResult[Op];
}

// ─── the daemon's operations ─────────────────────────────────────────
//
// One function per thing the daemon used to do to core's home itself. Each keeps
// the failure contract of the code it replaces: what was best-effort stays
// best-effort (and now says so in the log when it fails), and what threw still
// throws the same sentence.

/** Claude Code's Shift+Enter flag, best-effort: a failure is a log line, never a boot failure. */
export function ensureClaudeShiftEnterBindingViaCore(options: CoreHomeOpsOptions = {}): void {
  try {
    coreHomeOpSync({ op: "ensureClaudeShiftEnterBinding" }, options);
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
export function ensureOrchestrationSkillViaCore(options: CoreHomeOpsOptions = {}): SkillInstallEntry[] {
  let entries: SkillInstallEntry[];
  try {
    entries = coreHomeOpSync({ op: "ensureOrchestrationSkill" }, options);
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
  return coreHomeOpSync({ op: "wireLocalCore", label, credential }, options);
}

/** The spawn policy's two filesystem questions, answered once for a spawn (see `pty-manager`). */
export function spawnPathFactsViaCore(
  cwd: string,
  roots: string[],
  options: CoreHomeOpsOptions = {},
): Promise<SpawnPathFacts> {
  return coreHomeOp({ op: "spawnPathFacts", cwd, roots }, options);
}

/** `core exec`'s working directory, checked by the user that will run there. */
export async function resolveExecCwdViaCore(
  requested: string | null | undefined,
  options: CoreHomeOpsOptions = {},
): Promise<string> {
  const { cwd } = await coreHomeOp({ op: "resolveExecCwd", cwd: requested ?? null }, options);
  return cwd;
}

/** The folder picker's listing, read by the user whose folders they are. */
export function listDirectoryViaCore(
  requested: string | null | undefined,
  options: CoreHomeOpsOptions = {},
): Promise<CoreLinkDirListing> {
  return coreHomeOp({ op: "dirList", path: requested ?? null }, options);
}
