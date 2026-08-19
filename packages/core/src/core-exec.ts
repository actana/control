// Running one command on this machine, non-interactively (issue 266).
//
// The other way a client runs something here is a PTY — `spawn` and its
// vocabulary, which `actana core shell` and the Panel's VM Shell Session are
// built on. A PTY cannot answer the question this module exists for. It merges
// stdout and stderr into one stream by construction, it paints with cursor
// moves rather than newlines, and the only status it reports is whatever the
// shell chose to print. A script that needs to branch on an exit code and read
// a program's output has no way through that.
//
// So: a plain child process, pipes rather than a terminal, both streams
// captured whole and kept apart, and the child's real status handed back.
//
// **This grants no privilege the PTY path does not already grant.** Same
// credential (the registration blob), same transport (the core link, mTLS +
// bearer), same class of process — a free-form command on this machine, with
// no project root and no harness. Anybody who can open a VM Shell Session can
// already type this command into it. What changes is that the bytes come back
// structured instead of painted, and that the Core sees the request and can
// log it — which is more auditable than the `docker exec` this replaces, not
// less.
//
// Three bounds, and each one refuses loudly rather than lying:
//
//   1. **cwd is validated here, by the machine that owns the disk.** A refusal
//      is the Core's own message, thrown, and it reaches the operator verbatim.
//      No client guesses about a filesystem it cannot see.
//   2. **Output is bounded, and passing the bound is a named failure.** Not a
//      truncated buffer: a stdout that looks complete and is not is the failure
//      that ships broken and looks fine.
//   3. **Time is bounded.** Nothing here is attached to a human who would
//      notice, so a command that never exits would otherwise hold a child
//      process on this machine until the Core restarted.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { sanitizedProcessEnv } from "./shell-env";
import type { CoreExecPortResult } from "./pty-core-link-server";

/**
 * How much stdout+stderr one answer may carry, in bytes of UTF-8.
 *
 * 8 MiB, and the number matters less than the fact that it is stated: the
 * answer travels as one JSON frame over a WebSocket, so it is held whole in
 * memory on both ends, and "whatever the command felt like producing" is not a
 * size. A command that has more to say than this should be writing to a file on
 * the Core, and the refusal says so.
 */
export const EXEC_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * How long a command may run before the Core stops waiting for it.
 *
 * Generous, because the useful thing to run over this is a maintenance script
 * rather than a query. Bounded anyway, because nobody is watching: a `core
 * exec` client that has gone away leaves no one to notice a child that never
 * exits, and an unbounded one would sit here holding a process until the daemon
 * restarted.
 */
export const EXEC_TIMEOUT_MS = 15 * 60_000;

/** How long a timed-out child gets to die politely before SIGKILL. */
const SIGTERM_GRACE_MS = 5_000;

export type CoreExecInput = {
  command: string;
  args: string[];
  /** A directory on this machine. Omitted/blank means this Core's home. */
  cwd?: string | null;
  maxOutputBytes?: number;
  timeoutMs?: number;
};

/**
 * What a run ended as. See {@link CoreExecPortResult} — this module is that
 * port's implementation and the two shapes are deliberately the same one.
 */
export type CoreExecOutcome = CoreExecPortResult;

/** The refusal an over-budget command comes back as, written for the operator. */
export function outputTooLargeMessage(limitBytes: number): string {
  return (
    `The command produced more than ${Math.floor(limitBytes / 1024 / 1024)} MiB of output. ` +
    "Nothing was returned rather than half of it — redirect to a file on the Core and fetch that instead."
  );
}

/**
 * Resolve and check the working directory, or throw the operator's sentence.
 *
 * Blank means this Core's home, for the same reason `dirList` starts there: a
 * client has never seen this machine and cannot compute a sensible default for
 * it.
 */
function resolveCwd(requested: string | null | undefined): string {
  const raw = typeof requested === "string" && requested.trim() ? requested.trim() : os.homedir();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(raw);
  } catch {
    throw new Error(`No such directory on this Core: ${raw}`);
  }
  if (!stat.isDirectory()) throw new Error(`Not a directory on this Core: ${raw}`);
  return raw;
}

/**
 * Run one command and wait for it.
 *
 * Resolves for every command that ran, whatever it did — a non-zero status is
 * an answer, not a failure, and so is "it said too much", which resolves as
 * `output-too-large` carrying nothing. Rejects only when the command could not
 * run at all: no such directory, no such executable, or a run that outlasted
 * {@link EXEC_TIMEOUT_MS}.
 */
// `async` rather than a bare `Promise`, so a refused cwd is a rejection like
// every other failure here. A function that returns a promise and *also*
// throws synchronously makes every caller write two error paths for one
// outcome.
export async function runCoreExec(input: CoreExecInput): Promise<CoreExecOutcome> {
  const cwd = resolveCwd(input.cwd);
  const limit = input.maxOutputBytes ?? EXEC_MAX_OUTPUT_BYTES;
  const timeoutMs = input.timeoutMs ?? EXEC_TIMEOUT_MS;

  return new Promise<CoreExecOutcome>((resolve, reject) => {
    let child;
    try {
      child = spawn(input.command, input.args, {
        cwd,
        env: sanitizedProcessEnv(),
        // No shell, and no inherited stdin: this is an argv the caller chose,
        // and a child that read from a stdin nobody is typing into would hang
        // rather than finish. A caller that wants a shell asks for one by name.
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      fn();
    };

    // SIGTERM first, SIGKILL if it is ignored. A child stopped here is a child
    // whose output nobody is going to read either way, so both callers of this
    // settle the promise themselves and leave the killing to it.
    const stop = (settle: () => void) => {
      finish(() => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), SIGTERM_GRACE_MS);
        killTimer.unref?.();
        settle();
      });
    };

    const timer = setTimeout(
      () =>
        stop(() =>
          reject(
            new Error(
              `The command did not finish within ${Math.round(timeoutMs / 1000)}s on this Core and was stopped.`,
            ),
          ),
        ),
      timeoutMs,
    );

    // The bound is on the total, checked as chunks arrive rather than at the
    // end: buffering 4 GiB and then refusing it would be the same failure with
    // extra steps.
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) {
        // Refused, not truncated, and not thrown: this is an outcome the
        // protocol has a code for, so it travels as one.
        stop(() => resolve({ outcome: "output-too-large", message: outputTooLargeMessage(limit) }));
        return;
      }
      into.push(chunk);
    };

    child.stdout?.on("data", collect(out));
    child.stderr?.on("data", collect(err));

    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code, signal) => {
      finish(() =>
        resolve({
          outcome: "ok",
          // Node hands back exactly one of the two. Passing the pair through
          // rather than folding it into a single number keeps the `128 + n`
          // convention a client-side decision (ADR 0026's shape: the Core
          // reports, the client renders).
          exitCode: signal ? null : (code ?? 0),
          signal: signal ?? null,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        }),
      );
    });
  });
}
