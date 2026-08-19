// `actana core exec` — one command on a Core, non-interactively (issue 266).
//
//   actana core exec [--cwd <dir>] [--json] -- <cmd> [args...]
//
// The verb this noun was missing. `core shell` hands a human a terminal; a
// maintenance script needs neither a terminal nor a human, and until now its
// only way to run something on a Core was `docker exec` — which works solely
// because these Cores happen to be local containers, bypasses the Core's own
// authentication entirely, and is the exact shape #129 D9 exists to rule out.
// This is that argument one verb further along: the command runs on the *Core*,
// over the core link, authenticated; nothing runs locally, and this file starts
// no process, which is what `__tests__/no-local-escape.test.ts` keeps true.
//
// **It grants no privilege `core shell` does not already grant.** Same
// credential (the registration blob), same transport (mTLS + bearer), same
// class of process — `core-shell.ts`'s own header makes the argument: *anybody
// holding a valid blob for a Core already has that machine.* What changes is
// that the bytes come back structured instead of painted, and that a remote
// Core can log the request, which is a security improvement over the status
// quo rather than a widening of it.
//
// Four properties, and each is a decision this file is written around:
//
//   1. **The command's real exit code comes back as this process's.** `actana
//      core exec -- sh -c 'exit 3'` exits 3. A command killed by a signal exits
//      `128 + n`, the convention every shell shares.
//   2. **stdout and stderr are separate and clean.** No PTY was involved, so a
//      program that colours its output when it sees a terminal did not see one.
//      That is the whole reason this is not `core shell -c`: a PTY merges the
//      two streams by construction and paints with cursor moves.
//   3. **A dropped link is not an exit code.** The command keeps running on the
//      Core — that is what a non-interactive spawn does — and this CLI has no
//      result. It exits {@link EXIT_LINK_LOST} and says the command's fate is
//      unknown. Note the asymmetry with `core shell`, which treats a dropped
//      link as an ordinary ending because a human is watching. Nobody is
//      watching an exec.
//   4. **Output past the Core's bound fails loudly.** A truncated stdout that
//      looks complete ships broken and looks fine.
//
// Buffered, not streamed, and that is the first version on purpose: a buffered
// result is what makes the two streams separable and what makes the `--json`
// document one document. `--stream` is a later, compatible addition —
// interleaved on stderr, the buffered document still on stdout.

import { openCore } from "./core-connection.ts";
import { formatJson } from "./cli-output.ts";
import { EXIT_FAILURE, EXIT_LINK_LOST, EXIT_USAGE } from "./exit-codes.ts";
import type { RegistryPaths } from "./blob-registry.ts";
import type { ActanaCliDeps } from "./cli-deps.ts";
import type { ParsedArgs } from "./cli-args.ts";
import type { CoreLinkResponseFrame } from "@actana/sdk/core-link-frames.ts";

/**
 * How long this CLI waits for a command to finish.
 *
 * Longer than the Core's own 15-minute bound on a child, and deliberately: the
 * Core stopping a runaway command is an *answer* — it comes back as a result
 * carrying `SIGTERM` — and a client that gave up first would turn that answer
 * into "the link is fine but I stopped listening", which is the one outcome
 * this verb must not report.
 */
const EXEC_TIMEOUT_MS = 16 * 60_000;

/** The signal numbers behind the names a Core is likely to report. */
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGABRT: 6,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
};

/** `actana core exec` — run `argv` on the selected Core and report it back. */
export async function runCoreExec(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const [command, ...commandArgs] = rest;
  if (command === undefined) {
    deps.err("actana core exec: a command is required — `actana core exec -- <cmd> [args...]`.");
    deps.err("The `--` matters: it is what stops this CLI reading the command's own flags.");
    return EXIT_USAGE;
  }

  // Core selection is `openCore`'s, which is `resolveCore`'s: `--core`, then
  // ACTANA_CORE_BLOB, then the `current` pointer. Identical to every other
  // verb because it is literally the same function.
  const opened = await openCore(deps, args, paths, "actana core exec", {
    timeoutMs: EXEC_TIMEOUT_MS,
  });
  if (!opened.ok) {
    if (args.json) deps.out(formatJson({ outcome: "unreachable" }));
    return opened.code;
  }
  const { client, endpoint } = opened.core;
  deps.verbose(`running ${command} on ${endpoint}`);

  // A link that goes away mid-command is its own outcome and must never be
  // mistaken for the command's. Watched explicitly rather than left to the
  // request's rejection, because a rejection cannot say *why*: "the Core did
  // not answer in time" and "the socket died under us" are different sentences
  // and only one of them means the command is still running over there.
  // A mutable holder rather than a bare `let`: the assignment happens in a
  // callback, so narrowing at the read below would otherwise see only the
  // initialiser.
  const link: { lost: { error?: string } | null } = { lost: null };
  const unwatch = client.onDisconnected((info) => {
    link.lost ??= info;
  });

  let answer: CoreLinkResponseFrame;
  try {
    answer = await client.request(
      {
        type: "exec",
        reqId: "",
        command,
        args: commandArgs,
        ...(args.cwd === null ? {} : { cwd: args.cwd }),
      },
      EXEC_TIMEOUT_MS,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return link.lost
      ? reportLinkLost(deps, args, endpoint, link.lost.error ?? detail)
      : reportFailure(deps, args, `actana core exec: ${endpoint} — ${detail}`);
  } finally {
    unwatch();
    client.close();
  }

  // The Core refused before or instead of running it: a cwd it will not accept,
  // an executable it cannot find, output past its bound. `code` distinguishes
  // the last of those, which is the one whose fix is different — redirect to a
  // file rather than retry.
  if (answer.type === "error") {
    return reportFailure(deps, args, `actana core exec: ${answer.message}`, answer.code);
  }
  if (answer.type !== "execResult") {
    return reportFailure(
      deps,
      args,
      `actana core exec: ${endpoint} answered with a "${answer.type}" frame, which is not an answer to this.`,
    );
  }

  // A link that dropped *after* the answer landed is not this verb's problem:
  // the command finished and the result is in hand.
  const { exitCode, signal, stdout, stderr } = answer;
  const status = statusFor(exitCode, signal);

  if (args.json) {
    // One document on stdout, here and on every failure path above — the rule
    // `session-command.ts` sets for this package.
    deps.out(formatJson({ outcome: "exited", exitCode, signal, status, stdout, stderr }));
    return status;
  }

  // Without `--json`, the command's own streams *are* this process's streams,
  // written through untouched. `deps.out`/`deps.err` are line sinks, so the
  // trailing newline a program ends with must not become a blank line.
  writeStream(deps.out, stdout);
  writeStream(deps.err, stderr);
  if (signal) deps.verbose(`remote command killed by ${signal}`);
  return status;
}

/**
 * A remote ending, as a status this process can exit with.
 *
 * `128 + n` for a signal, the command's own code otherwise. A code outside
 * 0–255 is not a status a process can carry, and exiting with a truncated one
 * would report a number the command never chose — so it becomes a plain
 * failure, exactly as `core shell` does with the same problem.
 */
function statusFor(exitCode: number | null, signal: string | null): number {
  if (signal) {
    const n = SIGNAL_NUMBERS[signal];
    return n === undefined ? EXIT_FAILURE : 128 + n;
  }
  if (exitCode === null) return EXIT_FAILURE;
  if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) return EXIT_FAILURE;
  return exitCode;
}

/** Write a captured stream out line by line, without inventing a trailing one. */
function writeStream(sink: (line: string) => void, text: string): void {
  if (!text) return;
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  for (const line of body.split("\n")) sink(line);
}

/** The Core said no. One document under `--json`, one sentence on stderr always. */
function reportFailure(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  sentence: string,
  code?: string,
): number {
  if (args.json) deps.out(formatJson({ outcome: "refused", error: sentence, code: code ?? null }));
  deps.err(sentence);
  return EXIT_FAILURE;
}

/**
 * The link went away with the command still running on the far side.
 *
 * Its own exit code, never `0` and never the command's, because the honest
 * answer here is *I do not know what happened* — and a script that read a
 * plausible-looking status would act on a command whose outcome nobody has.
 */
function reportLinkLost(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  endpoint: string,
  detail: string,
): number {
  const sentence =
    `actana core exec: the link to ${endpoint} went away — ${detail}. ` +
    "The command may still be running on the Core; its outcome is unknown.";
  if (args.json) {
    deps.out(formatJson({ outcome: "link-lost", error: sentence, exitCode: null }));
  }
  deps.err(sentence);
  return EXIT_LINK_LOST;
}
