// The daemon's door to the Core identity (issue 559, PR 2).
//
// The identity itself — who `core` is, the env a child gets, the `setpriv` argv
// — is `@actana/shared/core-home`, because the two shared modules that spawn
// (`harness-cli-version`, `npm-install-prefix`) cannot import from this package.
// What is daemon-only lives here: signalling a Session's process.
//
// Every child the daemon starts goes through `asCore`, every signal it sends to
// one goes through `killAsCore`. Both are the identity function outside the
// container, so nothing changes on metal.

import { spawn } from "node:child_process";
import log from "@actana/shared/log";
import {
  coreIdentity,
  coreKillSpec,
  type AsCoreOptions,
  type SpawnSpec,
} from "@actana/shared/core-home";

export {
  asCore,
  coreHome,
  coreIdentity,
  isContainerMode,
  type SpawnSpec,
} from "@actana/shared/core-home";

const KILL_TIMEOUT_MS = 5_000;

/** A `ChildProcess`, a node-pty `IPty`, or anything else with a pid and a `kill`. */
export type Killable = {
  pid?: number;
  exitCode?: number | null;
  signalCode?: string | null;
  kill: (signal?: NodeJS.Signals) => unknown;
};

type WrappedKill = { status: number | null; stderr?: string; error?: Error };

export type KillAsCoreOptions = AsCoreOptions & {
  /** Runs the wrapped kill. Tests stub it; the default is an async `spawn`. */
  run?: (spec: SpawnSpec & { args: string[] }) => Promise<WrappedKill>;
};

/**
 * One short-lived child, awaited. Async on purpose: the daemon's event loop also
 * carries every Session's output, and a stop that signals many processes (a port
 * kill) must not freeze it for seconds.
 */
function runWrappedKill(spec: SpawnSpec & { args: string[] }): Promise<WrappedKill> {
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    const done = (result: WrappedKill) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ status: null, stderr, error: new Error(`timed out after ${KILL_TIMEOUT_MS} ms`) });
    }, KILL_TIMEOUT_MS);
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString();
    });
    child.on("error", (error) => done({ status: null, stderr, error }));
    child.on("close", (status) => done({ status, stderr }));
  });
}

/**
 * Signal a Session's process, as `core`.
 *
 * A number is a pid (negative: a process group). An object is a child handle:
 * it is left alone once it has exited, so a recycled pid is never signalled.
 * `signal` omitted means the handle's own default (SIGHUP for node-pty).
 *
 * Outside container mode this is `target.kill(signal)` or `process.kill(pid,
 * signal)`, made synchronously, exactly what the call sites did before. In the
 * container the daemon is another uid with no CAP_KILL, so the signal is sent by
 * a short-lived process that is `core` (see {@link coreKillSpec}).
 *
 * Resolves false when there was nothing to signal. **Rejects** when the signal
 * could not be delivered (a refused wrapper, a timeout, ESRCH) and never throws
 * synchronously: a caller on a timer or in a handler must use
 * {@link killAsCoreQuietly}, or await it inside a try.
 */
export async function killAsCore(
  target: number | Killable,
  signal?: NodeJS.Signals,
  options: KillAsCoreOptions = {},
): Promise<boolean> {
  const pid = typeof target === "number" ? target : target.pid;
  if (typeof target !== "number" && (target.exitCode != null || target.signalCode != null)) {
    return false;
  }

  if (!coreIdentity(options.identityEnv ?? process.env)) {
    if (typeof target !== "number") return target.kill(signal) !== false;
    process.kill(target, signal ?? "SIGTERM");
    return true;
  }

  if (typeof pid !== "number") return false;
  const sent = signal ?? "SIGHUP";
  const result = await (options.run ?? runWrappedKill)(coreKillSpec(pid, sent, options));
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `kill ${sent} ${pid} as core failed (exit ${result.status}): ${(result.stderr ?? "").trim()}`,
    );
  }
  return true;
}

/**
 * {@link killAsCore} for a caller that cannot do anything about a failure: a
 * timer, an exit handler, a teardown. It never throws and never leaves a
 * rejection behind; the failure is a log line (`<context>.failed`).
 */
export function killAsCoreQuietly(
  target: number | Killable,
  signal: NodeJS.Signals | undefined,
  context: string,
  options: KillAsCoreOptions = {},
): void {
  killAsCore(target, signal, options).catch((err: unknown) => {
    log.warn(`${context}.failed`, {
      pid: typeof target === "number" ? target : target.pid,
      signal,
      error: String(err),
    });
  });
}
