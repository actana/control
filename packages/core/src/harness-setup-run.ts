// Starting a Harness once, with no prompt, for the setup check (#685).
//
// The same launch as a Session's (`asCore` into a PTY, `core`'s home as cwd,
// the sanitized environment), minus everything that makes it a Session: no
// hooks, no prompt, no flags. It reads what the Harness paints until the output
// has been quiet for {@link QUIET_MS} or {@link MAX_MS} has passed, and then
// tears it down. A Harness waiting at a dialog stays quiet at it; one that
// reached its composer stays quiet there, which the dialog table does not match.

import { sanitizedProcessEnv } from "@actana/shared/shell-env";
import { applyHarnessPtyEnv } from "@actana/shared/harness-pty-env";
import { asCore } from "./core-identity";
import { disposePty } from "./pty-manager";
import type { SetupRun } from "./harness-setup";

/** Quiet this long after the first output means the screen has settled. */
export const QUIET_MS = 2_500;
/** A Harness that is still painting after this is not going to show a dialog we can read. */
export const MAX_MS = 15_000;
const COLS = 120;
const ROWS = 40;

export function runHarnessOnce(run: SetupRun): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require("node-pty") as typeof import("node-pty");
  const env: Record<string, string> = sanitizedProcessEnv() as Record<string, string>;
  delete env.TERM_PROGRAM;
  delete env.TERM_PROGRAM_VERSION;
  env.COLORFGBG = "15;0";
  applyHarnessPtyEnv(env, run.harness);
  const launch = asCore({ command: run.binary, args: [], cwd: run.cwd, env });
  return new Promise<string>((resolve, reject) => {
    let proc: import("node-pty").IPty;
    try {
      proc = pty.spawn(launch.command, launch.args, {
        name: "xterm-256color",
        cols: COLS,
        rows: ROWS,
        cwd: launch.cwd,
        env: launch.env as Record<string, string>,
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let screen = "";
    let quiet: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (quiet) clearTimeout(quiet);
      clearTimeout(cap);
      disposePty(proc);
      resolve(screen);
    };
    const cap = setTimeout(finish, MAX_MS);
    proc.onData((data) => {
      screen += data;
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(finish, QUIET_MS);
    });
    proc.onExit(() => finish());
  });
}
