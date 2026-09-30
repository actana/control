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

import { spawnSync } from "node:child_process";
import {
  coreIdentity,
  coreKillSpec,
  type AsCoreOptions,
  type SpawnSpec,
} from "@actana/shared/core-home";

export {
  asCore,
  coreChildEnv,
  coreHome,
  coreIdentity,
  coreShell,
  coreUsername,
  CoreIdentityError,
  CoreSpawnRefusedError,
  isContainerMode,
  type CoreIdentity,
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

export type KillAsCoreOptions = AsCoreOptions & {
  /** Runs the wrapped kill. Tests stub it; the default is `spawnSync`. */
  run?: (spec: SpawnSpec & { args: string[] }) => { status: number | null; stderr?: string; error?: Error };
};

function runSync(spec: SpawnSpec & { args: string[] }) {
  const result = spawnSync(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
    timeout: KILL_TIMEOUT_MS,
  });
  return { status: result.status, stderr: result.stderr ?? "", error: result.error };
}

/**
 * Signal a Session's process, as `core`.
 *
 * A number is a pid (negative: a process group). An object is a child handle:
 * it is left alone once it has exited, so a recycled pid is never signalled.
 *
 * Outside container mode this is `target.kill(signal)` or `process.kill(pid,
 * signal)`, exactly what the call sites did before. In the container the daemon
 * is another uid with no CAP_KILL, so the signal is sent by a short-lived
 * process that is `core` (see {@link coreKillSpec}).
 *
 * Returns false when there was nothing to signal. Throws when the signal could
 * not be delivered, like `process.kill`.
 */
export function killAsCore(
  target: number | Killable,
  signal: NodeJS.Signals,
  options: KillAsCoreOptions = {},
): boolean {
  const pid = typeof target === "number" ? target : target.pid;
  if (typeof target !== "number" && (target.exitCode != null || target.signalCode != null)) {
    return false;
  }

  if (!coreIdentity(options.identityEnv ?? process.env)) {
    if (typeof target !== "number") return target.kill(signal) !== false;
    process.kill(target, signal);
    return true;
  }

  if (typeof pid !== "number") return false;
  const result = (options.run ?? runSync)(coreKillSpec(pid, signal, options));
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `kill ${signal} ${pid} as core failed (exit ${result.status}): ${(result.stderr ?? "").trim()}`,
    );
  }
  return true;
}
