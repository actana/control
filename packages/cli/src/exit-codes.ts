// Exit codes, named once.
//
// Three, because a caller can act on three: it worked, you typed it wrong, or
// it did not work. `EXIT_USAGE` is 2 to match `packages/core/src/actana-cli.ts`
// — one command name (#129 D8) whose two halves disagreed about what 2 means
// would be worse than either choice.

/** It worked. */
export const EXIT_OK = 0;

/** It did not work: a Core refused, a file was unreadable, a blob was bad. */
export const EXIT_FAILURE = 1;

/** The command line was wrong: unknown verb or flag, missing argument. */
export const EXIT_USAGE = 2;

/**
 * The noun or verb exists in the tree and is not built yet.
 *
 * Distinct from {@link EXIT_USAGE} on purpose: "you typed something that is not
 * a command" and "you typed a command this build cannot do yet" are different
 * facts, and a script that reaches for a name this phase has not finished
 * should be able to tell them apart without parsing English off stderr.
 *
 * **Every reserved name in the tree returns this, whether noun or verb.** The
 * `session` / `project` / `harness` / `events` nouns (#160, #161, #163), the
 * `core shell` verb (#162) and `project cp` / `project files` (#168) each
 * returned it until its build landed: they are one fact about one build, and
 * the nouns are what a script written against a later train hits first.
 * Splitting them — 3 for a verb, 2 for a noun — would have meant this comment
 * arguing for a distinction the command tree did not make.
 *
 * **Nothing in this build returns it.** #168 built the last two reservations,
 * so both tables are empty and every name in the tree either works or is a
 * typo. The code stays exported and documented because the mechanism is what
 * makes the *next* reservation cheap — `project rm` is #210 — and because a
 * script that already branches on 3 must keep meaning the same thing by it.
 *
 * What it is *not* for is a verb the protocol cannot carry. `project set-path`
 * exits {@link EXIT_USAGE}, because a Core-owned Project's path is immutable
 * (ADR 0022) and no later build makes that command appear.
 */
export const EXIT_UNIMPLEMENTED = 3;

/**
 * The link to the Core went away while a command was running on it, and this
 * CLI has no result (issue 266, `core exec`).
 *
 * **Never the command's own status, and never `0`.** The command keeps running
 * on the Core — that is what a non-interactive spawn does — so the honest
 * answer is *I do not know what happened*, and a script that read a
 * plausible-looking status would act on an outcome nobody has. Note the
 * asymmetry with `core shell`, which treats a dropped link as an ordinary
 * ending ({@link EXIT_FAILURE}) because a human is watching; nobody is watching
 * an exec.
 *
 * 125, following the one convention that already means exactly this: `docker
 * run` and `git bisect run` both reserve it for *the runner failed, not your
 * command*. The reservation is a convention rather than a proof — a command
 * can exit 125 like it can exit anything else in 0–255, and no POSIX exit
 * status is unreachable by a child process. What IS unambiguous is the
 * structured channel: `--json` reports `outcome: "link-lost"` with a null
 * exitCode, distinct from `outcome: "exited"` with an exitCode of 125, and a
 * script that must tell the two apart with certainty reads that rather than
 * `$?`. The sentence on stderr says which happened either way.
 */
export const EXIT_LINK_LOST = 125;

// ─── `actana task wait` (#953) ──────────────────────────────────────────────
//
// A worker that hands a Task off and then waits on its status URL branches on
// `$?`, so every way the wait can end has its own number. `0` is the Task's
// `done` (`EXIT_OK`) and `1` / `2` keep their usual meanings (`EXIT_FAILURE`
// is "the loop itself could not finish": a bad URL, no good answer for ten
// minutes). The rest are the Task's other endings and the Session states a
// caller can act on. Grouped by tens so a script can test a family: 10s are
// final results, 20s are "the Task is stuck on something", 30s are "this wait
// is over without an answer".

/** The Task finished `failed`. */
export const EXIT_TASK_FAILED = 10;

/** The Task finished `partial`. */
export const EXIT_TASK_PARTIAL = 11;

/** The Session is waiting for a person (`sessionState` `needs-input`). */
export const EXIT_TASK_NEEDS_INPUT = 20;

/** The Session was interrupted (`sessionState` `interrupted`). */
export const EXIT_TASK_INTERRUPTED = 21;

/** The Session went idle with no complete result file (`sessionState` `idle-no-result`). */
export const EXIT_TASK_IDLE_NO_RESULT = 22;

/** The status URL answered `410`: expired, replaced by a new attempt, stopped or deleted. */
export const EXIT_TASK_GONE = 30;

/** `--timeout` ran out while the Task was still running. */
export const EXIT_TASK_TIMEOUT = 31;
