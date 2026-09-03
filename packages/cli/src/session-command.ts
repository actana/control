// `actana session` — the Sessions running on a Core (#129 D10, #160).
//
//   actana session start <project> [prompt]  start one; prints its id and exits
//   actana session ls [project]              what is running, and what settled
//   actana session logs <session>            the transcript, rendered
//   actana session resume <session> [prompt] pick a conversation back up
//   actana session send <session> <text>     type into a running Session
//   actana session wait <session>            block until it settles (#289)
//   actana session kill <session>            stop the harness, whoever started it
//   actana session attach <session>          take the terminal (#163)
//
// Three rules this noun is built around. The first two are the ticket's, the
// third is what makes the other two usable from a script.
//
// **`attach` is the one verb that is a terminal**, and it lives in
// `session-attach.ts` because it is built out of things no other verb here needs
// — raw mode, a detach key, signal handling, and the Session write lock held for
// as long as it runs (ADR 0024 D3–D7). Everything below dials, prints and hangs
// up; that one takes the terminal and gives it back.
//
// **The Core delivers prompts (ADR 0026, #129 D3).** `start` hands its prompt to
// the SDK, which hands it to the Core, which waits for the harness's TUI to
// settle, answers whatever dialog it opened, and writes the prompt and the
// carriage return. Nothing in this package waits, retries, or presses Enter on
// a timer: `send` writes the bytes it was given, and — since #404 — the carriage
// return that submits them, as its own write, because the flags the operator
// typed asked for one. What this package never appends is *timing*.
// A prompt that goes missing is a Core bug and must be fixed there, where every
// client benefits; a client that compensated would hide it and would behave
// differently from the Panel doing the same thing.
//
// **A transcript is a screen.** `logs` renders the Core's replay ring through
// the SDK's terminal emulator, because a harness paints with cursor moves and
// repaints one row eighty times a second: the raw stream concatenates into
// spinner soup with the words jammed together. `--raw` hands over the bytes for
// a caller piping into a terminal that will render them itself.
//
// **`--json` means only JSON on stdout.** Every verb here writes exactly one
// JSON document to stdout under `--json` — including when it fails, where the
// document is `{"error": …}` — and every human line, every progress note and
// every warning goes to stderr. Without that rule each consumer has to strip
// prose out of a stream it is trying to parse.
//
// One more, which falls out of the last: **without `--json`, stdout carries the
// Session id and nothing else.** `TASK=$(actana session start web "fix it")` is
// the shape of every script that will ever use this, and it works with `--wait`
// as well as without it because the settled status goes to stderr too.

import { resolveCore } from "./core-resolution.ts";
import { formatJson, formatTable } from "./cli-output.ts";
import { isKnownHarness, KNOWN_HARNESSES } from "./session-gateway.ts";
import { runSessionAttach } from "./session-attach.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./exit-codes.ts";
import type { RegistryPaths } from "./blob-registry.ts";
import type { ActanaCliDeps } from "./cli-deps.ts";
import type { ParsedArgs } from "./cli-args.ts";
import type {
  SessionGateway,
  SessionLogs,
  SessionOutcome,
  SessionRow,
  StartedSession,
} from "./session-gateway.ts";

/** How long a `session` verb waits for a Core to answer one request. */
const SESSION_TIMEOUT_MS = 30_000;

/**
 * The statuses that mean the Session did not end well.
 *
 * `--wait` exits non-zero on these and on a harness that exited non-zero, and
 * zero on everything else — `finished` obviously, but `needs-input` too: a
 * harness that stopped to ask a question did not fail, and a script that treats
 * a question as a failure cannot then answer it with `session send`.
 */
const UNHAPPY_STATUSES: ReadonlySet<string> = new Set(["terminated", "disconnected"]);

export const SESSION_HELP = `actana session — the Sessions running on a Core

Usage
  actana session start <project> [prompt]   start a Session; prints its id
  actana session ls [project]               list Sessions on this Core
  actana session logs <session>             print the transcript, rendered
  actana session resume <session> [prompt]  start a Session that continues one
  actana session send <session> <text>      write text into a running Session
  actana session wait <session>             block until the Core reports it settled
  actana session kill <session>             stop the harness running for it
  actana session attach <session>           watch a Session live, and type into it

Flags
  --core <name>       which registered Core to talk to
  --json              machine-readable output. Only JSON reaches stdout.
  --wait              start/resume: block until the Core reports it settled
                      send: block until the turn that text starts has ended
  --wait-timeout <s>  give up waiting after this many seconds, and say so
  --harness <name>    start: ${KNOWN_HARNESSES.join(", ")}
  --cwd <path>        start: a directory on the Core, inside the Project
  --title <text>      start: what the Session is called in \`ls\`
  --raw               logs: the bytes, escape codes and all, unrendered
  --enter             send: only meaningful with no text — a bare carriage return
  --no-enter          send: type the text and send no return. This starts no turn
  --read-only         attach: watch without claiming the Session's write lock
  --dangerously-skip-permissions
                      start/resume: run the harness without permission prompts
  --verbose           explain the steps, on stderr. Never prints a blob.

A prompt or a text argument of \`-\` is read from stdin, so a long prompt can be
piped in:  cat brief.md | actana session start web -

Sessions are the Core's, not this command's
  \`start\` exits as soon as the Core has the Session running, printing its id —
  the harness keeps going without this process (#129 D6). \`kill\`, \`send\` and
  \`logs\` name a Session by that id and work on any Session on the Core,
  including ones a Panel or another terminal started.

What \`logs\` can show you
  The Core's replay ring, which belongs to the harness's PTY — so a Session that
  has already exited has no transcript left to print, and the way to keep one is
  \`start --wait --json\`, whose object carries the screen as it settled.

Attaching, and who is allowed to type
  \`attach\` claims the Session's write lock. If another Core client already holds
  it — a Panel, an automation, a second terminal — you get a read-only view and
  a line saying so, never an error and never a takeover. Detaching gives the lock
  back, and so does this process dying: the Core releases a dropped connection's
  locks. Ctrl-] detaches; Ctrl-C goes to the harness.

Awaiting a turn
  \`wait\` blocks until the Core reports the Session settled — \`finished\`,
  \`needs-input\`, \`interrupted\`, \`terminated\` or \`disconnected\`, because every
  one of those is a turn that ended. On a Session that is already settled it says
  so at once.

  \`send <session> <text> --wait\` writes and then waits for **the turn that write
  starts**: the Core stamps the delivery in its event log and the wait resolves on
  the first settling status after that stamp, so it can never answer with the
  status the Session was already sitting at. With \`--json\` it prints the same
  object \`start --wait --json\` prints.

  **Sending into a turn that is already running resolves on that turn's end.** A
  keystroke into a busy harness is not a new turn, so if the Session is mid-turn
  when the text lands, the wait ends when the *current* turn ends — possibly
  before the harness has read a character of what you sent. Nothing on this side
  can tell those apart, and nothing here guesses.

  A harness that reports nothing at all runs out the \`--wait-timeout\` and the
  message says this side gave up — never a status the Core did not send. Without
  \`--wait-timeout\` there is no deadline: a turn takes as long as the work takes.

Sending text, and what submits it
  \`send <session> <text>\` **presses Enter** — that is, the text goes out and a
  carriage return follows it as its own separate write, never glued onto the
  text, and what the harness does with that return is the harness's. That is the
  default because it is what the words mean: a send that left the characters in
  the composer with no turn started looked delivered and was not (#404).

  Separate is necessary and not sufficient. ADR 0026's second observed failure
  is a return that was already its own write, 150 ms later, absorbed anyway by a
  harness rendering the text as a paste; what answers that is the length-scaled
  pause and the quiet gate on the **Core's** delivery path (ADR 0026 D6), which
  a \`send\` does not have and does not grow one here. A long enough \`send\` can
  still be pasted with its return eaten. A *starting* prompt, which does go
  through that gate, is \`session start\`.

  \`--no-enter\` is the opt-out, for typing without submitting: filling a
  composer, or answering a numbered dialog before the return that confirms it.
  It says so on the way out, every time, because a send that started no turn is
  the failure this default exists to end. **A \`--wait\` after it is not waiting
  for your text.** On an idle Session no turn ends, so the wait runs out the
  \`--wait-timeout\` — or, with none given, does not return. On a Session already
  mid-turn it resolves on *that* turn's end and reports it as this send's, for a
  turn this send did not start. Both are #405's and neither is fixed here.

  \`--json\` on a plain send says all of this in fields: \`enter\` is the return
  that was **asked** for, \`submitted\` is the return that was **accepted**, and
  they differ in exactly one case — the text landed and the return did not, where
  \`failed\` then names the half that went missing so a script knows a resend
  would submit the text twice. Those keys are **not** on the \`--wait\` document,
  which prints \`start --wait --json\`'s keys and no others so one parser reads
  every verb (#289) — there the line on stderr is the only signal.

  \`--enter\` is still accepted and does nothing on a send that carries text, so
  a script written against the old default keeps working. On a send with no text
  it is not a no-op: it is still the way to say a bare carriage return is the
  whole message, which is what this verb's \`--no-enter\` warning and its
  refusals of an empty send both point you at.

Who delivers the prompt
  The Core does (ADR 0026). It waits for the harness to settle, answers the
  dialog it opened, and writes the prompt. This CLI adds no timing of its own —
  no pause, no waiting for the harness to look ready, no retry — and \`send\`
  adds nothing but the carriage return the flags above asked for. A lost prompt
  is a Core bug.`;

/** Dispatch a `session` verb. `args.positionals` still has the noun on the front. */
export async function runSessionCommand(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
): Promise<number> {
  const [verb, ...rest] = args.positionals.slice(1);

  if (args.help || verb === undefined) {
    deps.out(SESSION_HELP);
    return verb === undefined && !args.help ? EXIT_USAGE : EXIT_OK;
  }

  switch (verb) {
    case "start":
      return sessionStart(deps, args, paths, rest);
    case "ls":
    case "list":
      return sessionLs(deps, args, paths, rest);
    case "logs":
      return sessionLogs(deps, args, paths, rest);
    case "resume":
      return sessionResume(deps, args, paths, rest);
    case "send":
      return sessionSend(deps, args, paths, rest);
    case "wait":
      return sessionWait(deps, args, paths, rest);
    case "kill":
      return sessionKill(deps, args, paths, rest);
    case "attach": {
      // The flag check every other verb makes, made here rather than inside
      // `session-attach.ts`: the table of this noun's flags lives in this file,
      // and a second copy of it in the one verb that is a terminal is how the
      // two drift.
      const misused = misusedFlag(args, ["--read-only"]);
      if (misused) return usage(deps, "attach", misused);
      return runSessionAttach(deps, args, paths, rest);
    }
    default:
      deps.err(`actana session: unknown verb "${verb}".`);
      deps.err(
        "Verbs: start, ls, logs, resume, kill, send, wait, attach. `actana session --help` lists them.",
      );
      return EXIT_USAGE;
  }
}

// ─── The verbs ───────────────────────────────────────────────────────────────

/**
 * `actana session start <project> [prompt]`.
 *
 * **Exits once the Core has the Session running** (#129 D6): the id goes to
 * stdout, the harness carries on without this process, and the socket closes.
 * `--wait` keeps the connection open until the Core reports the Session settled
 * — which is the Core's report off its event log, never a guess made here from
 * how quiet the output went.
 */
async function sessionStart(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const misused = misusedFlag(args, [
    "--wait",
    "--wait-timeout",
    "--harness",
    "--cwd",
    "--title",
    "--dangerously-skip-permissions",
  ]);
  if (misused) return usage(deps, "start", misused);

  const [project, ...promptWords] = rest;
  if (project === undefined) {
    return usage(deps, "start", "a project is required — `actana session start <project> [prompt]`");
  }

  const timeout = waitTimeoutMs(args);
  if (timeout.error) return usage(deps, "start", timeout.error);

  const harness = args.harness;
  if (harness !== null && !isKnownHarness(harness)) {
    return usage(
      deps,
      "start",
      `unknown harness "${harness}". This build knows: ${KNOWN_HARNESSES.join(", ")}`,
    );
  }

  const prompt = await readText(deps, promptWords);
  if (prompt.error) return usage(deps, "start", prompt.error);

  return withGateway(deps, args, paths, "start", async (gateway) => {
    deps.verbose(`starting a session in ${project}`);
    const session = await gateway.start({
      project,
      ...(prompt.text === null ? {} : { prompt: prompt.text }),
      ...(args.title === null ? {} : { title: args.title }),
      harness,
      cwd: args.cwd,
      dangerouslySkipPermissions: args.skipPermissions,
    });
    return reportStartedSession(deps, args, session, timeout.ms);
  });
}

/** `actana session resume <session> [prompt]` — a new harness on an old conversation. */
async function sessionResume(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const misused = misusedFlag(args, ["--wait", "--wait-timeout", "--dangerously-skip-permissions"]);
  if (misused) return usage(deps, "resume", misused);

  const [taskId, ...promptWords] = rest;
  if (taskId === undefined) {
    return usage(deps, "resume", "a session id is required — `actana session resume <session> [prompt]`");
  }

  const timeout = waitTimeoutMs(args);
  if (timeout.error) return usage(deps, "resume", timeout.error);

  const prompt = await readText(deps, promptWords);
  if (prompt.error) return usage(deps, "resume", prompt.error);

  return withGateway(deps, args, paths, "resume", async (gateway) => {
    deps.verbose(`resuming session ${taskId}`);
    const session = await gateway.resume({
      taskId,
      ...(prompt.text === null ? {} : { prompt: prompt.text }),
      dangerouslySkipPermissions: args.skipPermissions,
    });
    return reportStartedSession(deps, args, session, timeout.ms);
  });
}

/**
 * What `start` and `resume` print, which is the same thing because they produce
 * the same thing: a running Session, and a decision about whether to wait for it.
 */
async function reportStartedSession(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  session: StartedSession,
  timeoutMs: number | null,
): Promise<number> {
  try {
    const where = session.project ?? session.projectId;
    deps.err(`Started ${session.harness} in ${where} — session ${session.taskId}, pty ${session.ptyId}.`);
    deps.verbose(`command: ${session.command}`);
    // Issue 177 finding 4, said out loud rather than left to be discovered.
    // Not `verbose`: an operator who has to know this is precisely one who has
    // not passed `-v`, and the line they would otherwise read is a `session
    // ls` that has not moved.
    if (!session.reportsTurnStart) deps.err(noTurnStartLine(session.harness));

    if (!args.wait) {
      // The one-shot default (#129 D6). The id is the whole of stdout, so it can
      // be captured; everything a person reads went to stderr above.
      //
      // The socket closes on the way out of `withGateway`, and the prompt has
      // almost certainly not been delivered yet — the Core waits for the
      // harness's screen to settle first. That is not a race this side has to
      // win: `initialInput` travelled with the spawn and delivery runs inside
      // the Core (ADR 0026 D2), which is exactly why a client can hang up.
      if (args.json) {
        deps.out(formatJson({ ...startedFields(session), waited: false }));
      } else {
        deps.out(session.taskId);
      }
      return EXIT_OK;
    }

    return await awaitTurn(deps, args, session, timeoutMs);
  } finally {
    // Listeners on the client, released. The harness on the Core is untouched —
    // that is `session kill`.
    session.dispose();
  }
}

/**
 * Wait for a turn to end and print how it ended — the half `start`, `resume`,
 * `wait` and `send --wait` all share (#289 B).
 *
 * Shared on purpose, and it is what makes the promise "one result shape across
 * the commands" true rather than aspirational: there is one place that decides
 * what a settled Session prints, so a caller's parser cannot need a branch for
 * which verb produced the object.
 */
async function awaitTurn(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  session: StartedSession,
  timeoutMs: number | null,
): Promise<number> {
  deps.err("Waiting for the Core to report this session settled…");
  let outcome: SessionOutcome;
  try {
    outcome = await session.wait(timeoutMs === null ? {} : { timeoutMs });
  } catch (err) {
    // The only thing that reaches here is the deadline the operator asked for.
    // It is reported as what it is — this side gave up — rather than as a
    // status, because the Core never said one.
    const message = messageOf(err);
    if (args.json) deps.out(formatJson({ ...startedFields(session), waited: true, error: message }));
    deps.err(`actana session: ${message}`);
    return EXIT_FAILURE;
  }

  // Read while the Session is alive: a full-screen harness restores the main
  // buffer when it quits, and the main buffer is where nothing was printed.
  const screen = session.screen();

  if (args.json) {
    deps.out(
      formatJson({
        ...startedFields(session),
        waited: true,
        status: outcome.status,
        exited: outcome.exited,
        ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
        // The transcript rides along because a `--json` caller has no second
        // chance at it: the Core's replay ring lives with the PTY, so a
        // harness that exited takes its output with it and a later
        // `session logs` has nothing to answer with.
        screen,
      }),
    );
  } else {
    deps.out(session.taskId);
    deps.err(settledLine(outcome));
    deps.err(`\`actana session logs ${session.taskId}\` prints the transcript while the harness is running.`);
  }
  return settledWell(outcome) ? EXIT_OK : EXIT_FAILURE;
}

/** {@link awaitTurn}, releasing the attachment's listeners on the way out. */
async function awaitAttachedTurn(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  session: StartedSession,
  timeoutMs: number | null,
): Promise<number> {
  try {
    return await awaitTurn(deps, args, session, timeoutMs);
  } finally {
    // The listeners this attachment holds, released. The harness on the Core is
    // untouched — waiting for a Session is not owning it.
    session.dispose();
  }
}

/**
 * `actana session wait <session>` — block until the Core reports it settled.
 *
 * **The primitive, and it ships as one** (#289 B). `send --wait` is this with a
 * write in front of it, and the reason the verb exists rather than only the flag
 * is ADR 0026 D1: a client sends text and no timing, so timing gets its own verb
 * instead of being folded into the one that writes.
 *
 * With no text delivered there is no cursor to count from, so this answers from
 * the Session's current status when it is already settled and otherwise on the
 * next settling status. That is the question the verb asks — "tell me when this
 * Session is not working" — and it is not the question `send --wait` asks.
 */
async function sessionWait(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const misused = misusedFlag(args, ["--wait-timeout"]);
  if (misused) return usage(deps, "wait", misused);

  const [taskId, ...extra] = rest;
  if (taskId === undefined) {
    return usage(deps, "wait", "a session id is required — `actana session wait <session>`");
  }
  if (extra.length > 0) return usage(deps, "wait", `unexpected argument "${extra[0]}"`);

  // The verb *is* the wait, so `--wait-timeout` needs no `--wait` beside it —
  // and `--wait` is refused above rather than accepted as a synonym for the
  // verb's own name.
  const timeout = waitTimeoutMs(args, true);
  if (timeout.error) return usage(deps, "wait", timeout.error);

  return withGateway(deps, args, paths, "wait", async (gateway) => {
    deps.verbose(`attaching to session ${taskId} to wait for it to settle`);
    const session = await gateway.wait(taskId);
    return awaitAttachedTurn(deps, args, session, timeout.ms);
  });
}

/** `actana session ls [project]` — every Session on the Core, newest first. */
async function sessionLs(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const misused = misusedFlag(args, []);
  if (misused) return usage(deps, "ls", misused);

  const [project, ...extra] = rest;
  if (extra.length > 0) return usage(deps, "ls", `unexpected argument "${extra[0]}"`);

  return withGateway(deps, args, paths, "ls", async (gateway) => {
    const rows = await gateway.list(project ?? null);

    if (args.json) {
      deps.out(formatJson(rows));
      return EXIT_OK;
    }
    if (rows.length === 0) {
      deps.out(project === undefined ? "No sessions on this Core." : `No sessions in ${project}.`);
      return EXIT_OK;
    }

    // The lock column appears only when the Core publishes lock state (ADR
    // 0024). A Core that predates it has no lock table, and a column of dashes
    // would read as "nobody may write" rather than "this Core does not answer
    // that question".
    const locks = rows.some((row) => row.lock !== null);
    const header = [
      ...["SESSION", "STATUS", "LIVE", "HARNESS", "PROJECT"],
      ...(locks ? ["LOCK"] : []),
      ...["AGE", "TITLE"],
    ];
    const table = formatTable(
      header,
      rows.map((row) => [
        row.taskId,
        row.status,
        row.live ? "yes" : "",
        row.harness,
        row.project ?? row.projectId,
        ...(locks ? [lockCell(row)] : []),
        age(deps.now(), row.updatedAt),
        row.title,
      ]),
    );
    for (const line of table) deps.out(line);
    return EXIT_OK;
  });
}

/**
 * `actana session logs <session>` — the transcript, as a terminal would show it.
 *
 * Rendered, not raw: see the module header. What it can print is what the Core
 * still holds, and the Core holds a Session's output in a ring that belongs to
 * the PTY — so a harness that has already exited has no logs to give, which is
 * what `not-running` says.
 */
async function sessionLogs(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const misused = misusedFlag(args, ["--raw"]);
  if (misused) return usage(deps, "logs", misused);

  const [taskId, ...extra] = rest;
  if (taskId === undefined) {
    return usage(deps, "logs", "a session id is required — `actana session logs <session>`");
  }
  if (extra.length > 0) return usage(deps, "logs", `unexpected argument "${extra[0]}"`);

  return withGateway(deps, args, paths, "logs", async (gateway) => {
    const logs: SessionLogs = await gateway.logs(taskId);
    deps.verbose(`read the replay ring of pty ${logs.ptyId}`);

    if (args.json) {
      deps.out(
        formatJson({
          taskId: logs.taskId,
          ptyId: logs.ptyId,
          rendered: !args.raw,
          screen: args.raw ? logs.raw : logs.screen,
        }),
      );
      return EXIT_OK;
    }
    const body = args.raw ? logs.raw : logs.screen;
    for (const line of body.split("\n")) deps.out(line);
    return EXIT_OK;
  });
}

/**
 * What `--no-enter` says on the way out, on every path that takes it.
 *
 * The second half of #404's acceptance: a send that submits nothing is allowed,
 * and it is never quiet. It names the flag that caused it, says what was left
 * out, and gives the command that sends it — because the operator this was
 * written for is the one staring at a Session that looks sent to and has not
 * moved.
 *
 * It claims nothing it cannot see. Where the text ended up is the harness's
 * business and this side never observes it, and whether a carriage return
 * submits anything is the harness's too — so this says what *this process did*:
 * no return went out, and no turn was started by this send.
 */
const NOT_SUBMITTED_WARNING = (taskId: string): string =>
  `actana session send: --no-enter, so no carriage return followed the text — this send ` +
  `started no turn. \`actana session send ${taskId} --enter\` sends the carriage return.`;

/**
 * `actana session send <session> <text>` — the equivalent of typing.
 *
 * **A send submits the turn** (#404). The text goes first, verbatim, and a
 * carriage return follows it as a **second write to the same PTY** — never
 * glued onto the text, because a glued return is one a harness rendering the
 * write as a paste absorbs along with the characters.
 *
 * Separate is necessary and **not sufficient**: ADR 0026's second observed
 * failure is a return that was already its own write, sent 150 ms later,
 * absorbed anyway. What answers that is D6's
 * length-scaled pause and quiet gate on the *Core's* delivery path, which this
 * one has not got and must not grow — a client that timed its own submit would
 * be doing prompt delivery. A long enough `send` can therefore still land as a
 * paste with its return eaten; the prompt that does go through the gate is
 * `session start`'s. What changed in #404 is only which of the two spellings
 * needs a flag: sending text and starting no turn was the surprising default,
 * and an operator who typed `session send $SID "continue"` watched the
 * characters sit in a composer with nothing to await.
 *
 * `--no-enter` is the opt-out for typing without submitting, and the exit path
 * says so out loud every time, because a delivery that started no turn is
 * exactly the thing this stopped being silent about.
 *
 * `--enter` survives as a no-op on a send that carries text: orchestration
 * scripts pass it, they are asking for what now happens anyway, and rejecting
 * them would break working callers to make a point. On a send with **no** text
 * it is not a no-op — it is still the way to say "a bare carriage return is the
 * whole message".
 *
 * What did *not* change is the timing (ADR 0026, and the module header): no
 * pause between the writes, no waiting for the harness to look ready, no timer
 * anywhere. Both writes go to one PTY resolved once, so the harness cannot move
 * between them. A *starting* prompt still goes through `session start`, where
 * the Core owns the schedule.
 *
 * `--wait` adds no timing either (#289): it asks the Core to stamp the delivery
 * in its event log and then waits for the first settling status *after* that
 * stamp. The text is the same text, written at the same moment, followed by the
 * same return under the same rules — what `--wait` changes is when this process
 * hangs up, not what the harness receives.
 */
async function sessionSend(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const misused = misusedFlag(args, ["--enter", "--no-enter", "--wait", "--wait-timeout"]);
  if (misused) return usage(deps, "send", misused);

  // Both spellings at once is not a preference this command can guess at: one
  // asks for the return and the other refuses it, and picking a winner would
  // carry out half of what was typed without saying which half.
  if (args.enter && args.noEnter) {
    return usage(deps, "send", "--enter and --no-enter contradict each other — pass one");
  }

  const [taskId, ...words] = rest;
  if (taskId === undefined) {
    return usage(deps, "send", "a session id is required — `actana session send <session> <text>`");
  }
  const timeout = waitTimeoutMs(args);
  if (timeout.error) return usage(deps, "send", timeout.error);
  const read = await readText(deps, words);
  if (read.error) return usage(deps, "send", read.error);
  if (read.text === null && !args.enter) {
    return usage(
      deps,
      "send",
      "nothing to send — pass text, `-` to read stdin, or --enter for a bare carriage return",
    );
  }
  if (read.text === "" && !args.enter) {
    // Empty stdin, and nothing else asked for. Reporting a delivery here would
    // be a lie in the one direction that matters: no Core was contacted, no
    // Session was proved to exist, and nothing was written.
    return usage(
      deps,
      "send",
      "nothing to send — stdin was empty; pass --enter to send a bare carriage return",
    );
  }

  // The one decision this verb makes about the return, made once and named, so
  // the wait path and the plain path cannot answer it differently: Enter unless
  // it was refused (#404). `--enter` is not consulted — a send that carries
  // text submits either way, and a send with no text got past the checks above
  // only because `--enter` asked for the bare return.
  const submit = !args.noEnter;

  return withGateway(deps, args, paths, "send", async (gateway) => {
    const text = read.text ?? "";

    if (args.wait) {
      // Send-then-wait with **no gap** (#289 B): one attachment resolves the
      // PTY, writes through it, and waits from the id the Core stamped that
      // write with. The alternative — send, then attach, then wait — is the
      // design the issue's landmine is about: the attach would find a Session
      // sitting at a settled status and answer with last turn's outcome.
      const andReturn = submit ? " and a carriage return" : "";
      deps.verbose(`sending ${text.length} characters to session ${taskId}${andReturn}, then waiting`);
      const session = await gateway.sendAndWait(taskId, text, { enter: submit });
      deps.err(`Sent ${text.length} characters to session ${taskId}${andReturn}.`);
      // Stderr is the *only* signal on this path, and deliberately: the wait's
      // document is `start --wait --json`'s key set and nothing else, because
      // #289 requires one parser to read all three verbs. A `submitted` field
      // here would buy this warning a machine-readable form at the price of
      // that, so the help text names the exception instead.
      if (!submit) deps.err(NOT_SUBMITTED_WARNING(taskId));
      return awaitAttachedTurn(deps, args, session, timeout.ms);
    }

    // One call, one PTY resolution, both writes (#204 review). The command has
    // decided whether there is a return; the gateway decides nothing and only
    // writes what it was handed.
    const sent = await gateway.send(taskId, text, { enter: submit });

    if (args.json) {
      // Two keys for the request and two for the outcome, kept apart on purpose.
      //
      // `enter` is the **request**, which is what it has always been — the flag
      // as the command resolved it — so a parser built on it keeps reading the
      // same fact. `submitted` is the **outcome**: a carriage return that was
      // asked for *and accepted*. They differ in exactly one case, and it is the
      // case worth knowing about — the text landed and the return did not.
      //
      // `failed` appears only on a failure and says which half went missing, so
      // a script can tell a safe resend from one that would submit the text
      // twice. All three are on **this** document only; the `--wait` path's
      // shape is #289's and is not extended here.
      deps.out(
        formatJson({
          taskId,
          characters: text.length,
          enter: submit,
          submitted: submit && sent.ok,
          delivered: sent.ok,
          ...(sent.ok ? {} : { failed: sent.failed }),
        }),
      );
    } else if (sent.ok) {
      const andReturn = submit ? " and a carriage return" : "";
      deps.err(`Sent ${text.length} characters to session ${taskId}${andReturn}.`);
    }
    // **On stderr even under `--json`**, and after the document rather than
    // instead of it: a send that started no turn is the failure this ticket
    // exists to stop being quiet about, and a script that only reads stdout
    // still gets the fact in the `submitted` field.
    if (sent.ok && !submit) deps.err(NOT_SUBMITTED_WARNING(taskId));
    if (!sent.ok) {
      // Two failures, two messages, because the operator's next move differs.
      // The `--wait` path has drawn this line since #289 and gives its own
      // reason for it; #404 put the second write on the default path, so the
      // plain path draws it too rather than flattening both into "refused".
      if (sent.failed === "text") {
        deps.err(
          `actana session send: the Core did not accept the write to session ${taskId}. ` +
            `Nothing was written, so sending it again is safe.`,
        );
      } else if (text.length === 0) {
        // A bare `--enter`, whose whole message was the return. Nothing landed,
        // so this is the simple failure and the "do not resend" below would be
        // advice about text that does not exist.
        deps.err(
          `actana session send: the Core did not accept the carriage return for session ` +
            `${taskId}. Nothing was written, so sending it again is safe.`,
        );
      } else {
        deps.err(
          `actana session send: session ${taskId} took the text, but the Core did not accept ` +
            `the carriage return — so no turn was started. The text was delivered: do not send ` +
            `it again, or the harness gets it twice. \`actana session send ${taskId} --enter\` ` +
            `sends the return on its own.`,
        );
      }
      return EXIT_FAILURE;
    }
    return EXIT_OK;
  });
}

/**
 * `actana session kill <session>`.
 *
 * **Works on a Session this CLI did not start**, which is the point of naming
 * Sessions by Task id: the PTY belongs to the Core, and a Panel, a cron job and
 * this command all name it the same way. Nothing about having started a Session
 * is remembered locally, so there is nothing here that could fail to recognise
 * one.
 */
async function sessionKill(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const misused = misusedFlag(args, []);
  if (misused) return usage(deps, "kill", misused);

  const [taskId, ...extra] = rest;
  if (taskId === undefined) {
    return usage(deps, "kill", "a session id is required — `actana session kill <session>`");
  }
  if (extra.length > 0) return usage(deps, "kill", `unexpected argument "${extra[0]}"`);

  return withGateway(deps, args, paths, "kill", async (gateway) => {
    const { ptyId, killed } = await gateway.kill(taskId);
    if (args.json) {
      deps.out(formatJson({ taskId, ptyId, killed }));
    } else if (killed) {
      deps.err(`Killed session ${taskId} (pty ${ptyId}).`);
    }
    if (!killed) {
      deps.err(`actana session kill: the Core did not kill session ${taskId}.`);
      return EXIT_FAILURE;
    }
    return EXIT_OK;
  });
}

// ─── The plumbing every verb shares ──────────────────────────────────────────

/**
 * Resolve the Core, open one connection, run the verb, and always hang up.
 *
 * Also the single place a {@link SessionGatewayError} becomes a message and an
 * exit code, so no verb writes its own version of "the Core refused" and every
 * one of them obeys the `--json` rule on the failure path as well as the happy
 * one — which is the path that usually forgets.
 */
async function withGateway(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  verb: string,
  run: (gateway: SessionGateway) => Promise<number>,
): Promise<number> {
  const resolved = resolveCore({ paths, env: deps.env, home: deps.home, coreFlag: args.core });
  if (!resolved.ok) return failed(deps, args, verb, resolved.error);

  deps.verbose(`dialling ${resolved.core.blob.endpoint}`);
  let gateway: SessionGateway;
  try {
    gateway = await deps.openSessions(resolved.core.blob, { timeoutMs: SESSION_TIMEOUT_MS });
  } catch (err) {
    return failed(deps, args, verb, `${resolved.core.blob.endpoint} did not answer — ${messageOf(err)}`);
  }

  try {
    return await run(gateway);
  } catch (err) {
    // Every failure here, not only the gateway's own kinds: a Core that answers
    // a frame with an error, or a link that drops mid-command, arrives as the
    // SDK's plain `Error`. Letting those through would exit on the entry file's
    // last-resort handler — which prints a message, but after `--json` has
    // already promised a document and produced none.
    return failed(deps, args, verb, messageOf(err));
  } finally {
    gateway.close();
  }
}

/** One failure, reported the same way every time: JSON on stdout, prose on stderr. */
function failed(deps: ActanaCliDeps, args: ParsedArgs, verb: string, message: string): number {
  if (args.json) deps.out(formatJson({ error: message }));
  deps.err(`actana session ${verb}: ${message}`);
  return EXIT_FAILURE;
}

/** A command line this verb cannot act on. Never dials, so `--json` gets no document. */
function usage(deps: ActanaCliDeps, verb: string, message: string): number {
  deps.err(`actana session ${verb}: ${message}.`);
  return EXIT_USAGE;
}

/** The session flags, and how to tell whether one was used. */
const SESSION_FLAGS: ReadonlyArray<{ name: string; used: (args: ParsedArgs) => boolean }> = [
  { name: "--wait", used: (args) => args.wait },
  { name: "--wait-timeout", used: (args) => args.waitTimeout !== null },
  { name: "--harness", used: (args) => args.harness !== null },
  { name: "--cwd", used: (args) => args.cwd !== null },
  { name: "--title", used: (args) => args.title !== null },
  { name: "--raw", used: (args) => args.raw },
  { name: "--enter", used: (args) => args.enter },
  { name: "--no-enter", used: (args) => args.noEnter },
  { name: "--dangerously-skip-permissions", used: (args) => args.skipPermissions },
  { name: "--read-only", used: (args) => args.readOnly },
];

/**
 * The first flag that was passed to a verb that does not take it, or null.
 *
 * Rejected rather than ignored, because every one of these flags changes what
 * the operator expects to happen: `--wait` on `kill`, or `--harness` on
 * `resume` (whose harness is a fact about the conversation being resumed, not a
 * choice), read as instructions that were silently dropped.
 */
function misusedFlag(args: ParsedArgs, accepted: readonly string[]): string | null {
  for (const flag of SESSION_FLAGS) {
    if (flag.used(args) && !accepted.includes(flag.name)) {
      return `${flag.name} does not apply here`;
    }
  }
  return null;
}

/**
 * `--wait-timeout <seconds>`, in milliseconds.
 *
 * Only with `--wait`, because on its own it is an instruction that cannot be
 * carried out — and a deadline somebody believes they set is worse than no
 * deadline at all. The wait it bounds is the SDK's; nothing here counts time.
 */
function waitTimeoutMs(
  args: ParsedArgs,
  waiting: boolean = args.wait,
): { ms: number | null; error?: string } {
  if (args.waitTimeout === null) return { ms: null };
  // `waiting` is for the one verb that *is* a wait: `session wait` takes no
  // `--wait` (the verb says it), so its deadline cannot be gated on the flag.
  if (!waiting) return { ms: null, error: "--wait-timeout only means something with --wait" };
  const seconds = Number(args.waitTimeout);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { ms: null, error: `--wait-timeout wants a number of seconds, not "${args.waitTimeout}"` };
  }
  return { ms: Math.round(seconds * 1000) };
}

/**
 * A prompt or a `send` text: the words as typed, or stdin when it is `-`.
 *
 * Words are joined with single spaces, which is what a shell has already done
 * to anything unquoted — so `session send s1 yes please` sends `yes please`
 * rather than failing over an argument the operator did not think of as a
 * second one. `-` is the conventional stdin marker, and it is what
 * a prompt longer than a command line arrives by.
 */
async function readText(
  deps: ActanaCliDeps,
  words: string[],
): Promise<{ text: string | null; error?: string }> {
  if (words.length === 0) return { text: null };
  if (words.length === 1 && words[0] === "-") {
    if (deps.stdinIsTty) {
      return { text: null, error: "`-` reads stdin, and nothing is piped in" };
    }
    deps.verbose("reading the text from stdin");
    return { text: await deps.readStdin() };
  }
  return { text: words.join(" ") };
}

/**
 * What a caller is told when nothing will report this Session's turn starting.
 *
 * The Panel answers the same gap with a terminal-input fallback — it watches
 * the keystrokes going into the pane and calls an Enter the start of a turn.
 * A CLI has no equivalent: `start` hands the prompt to the Core and hangs up
 * (#129 D6), so there is no keystroke stream here to watch and inventing a
 * `running` this side never observed would be a status the Core did not say.
 *
 * So the asymmetry is printed instead. The sentence names what still works,
 * because the failure this prevents is an operator reading a stalled `session
 * ls` as a stalled harness and killing a Session that was working.
 */
function noTurnStartLine(harness: string | null): string {
  return (
    `Note: ${harness ?? "this harness"} does not report the start of a turn, so this session ` +
    `will not show as running until it stops. \`--wait\` and \`session logs\` ` +
    `are unaffected.`
  );
}

/** The identity fields `start` and `resume` report, in both output modes. */
function startedFields(session: StartedSession): Record<string, unknown> {
  return {
    taskId: session.taskId,
    ptyId: session.ptyId,
    harness: session.harness,
    command: session.command,
    // In `--json` too, and unconditionally: a script deciding whether a quiet
    // status means "still working" or "never started" needs the answer as a
    // field, not as a sentence on stderr it would have to parse.
    reportsTurnStart: session.reportsTurnStart,
    projectId: session.projectId,
    project: session.project,
  };
}

/** Did the Session settle in a way a script should call success? */
function settledWell(outcome: SessionOutcome): boolean {
  if (UNHAPPY_STATUSES.has(outcome.status)) return false;
  return !outcome.exited || (outcome.exitCode ?? 0) === 0;
}

function settledLine(outcome: SessionOutcome): string {
  if (outcome.exited) {
    return `The harness exited with code ${outcome.exitCode ?? 0} (status: ${outcome.status}).`;
  }
  return `The Core reports this session ${outcome.status}.`;
}

/** How a Session's lock reads in a table cell. */
function lockCell(row: SessionRow): string {
  switch (row.lock) {
    case "held-by-you":
      return "you";
    case "held-by-another":
      return "other";
    case "unlocked":
      return "free";
    default:
      return "";
  }
}

/**
 * How long ago, in the shortest unit that still says something.
 *
 * A table is read by eye and `2h` is what the eye wants; the exact epoch stays
 * on the `--json` row for anything that is going to compute with it.
 */
function age(now: number, updatedAt: number): string {
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
