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
import {
  CoreSessionLinkLostError,
  CoreSessionTurnTimeoutError,
} from "@actana/sdk/core-session.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./exit-codes.ts";
import type { RegistryPaths } from "./blob-registry.ts";
import type { ActanaCliDeps } from "./cli-deps.ts";
import type { ParsedArgs } from "./cli-args.ts";
import type {
  PromptDeliveryReport,
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

/**
 * The deadline `actana session send --wait` carries when the operator named none
 * (#405).
 *
 * **Only this verb.** `session wait` and `start --wait` have no default and are
 * not given one: both wait for a turn that is already under way, so the only
 * thing a default could cut short there is honest work (ADR 0033 D4, D5). A `send`
 * is different in the one way that matters — it is waiting for a turn *it* has
 * to start, and a carriage return that lands on a dialog rather than a composer
 * starts none. The Core then has nothing to report, the seeded status the
 * Session is parked at carries event id 0 and can never satisfy the delivery
 * cursor, and the wait is correct, silent and permanent. A deadline is what
 * turns that into an answer.
 *
 * **Seventeen minutes, and the number is chosen against the Core rather than
 * from taste.** The Core's own backstop settles a `running` Session it has heard
 * nothing from after fifteen minutes of silence (`QUIET_SETTLE_MS` in
 * `core-session-backstop.ts`), and its sweep runs once a minute, so that settle
 * can land as late as sixteen. A deadline at fifteen would tie with it and
 * scheduling would decide which of the two answered; at seventeen the Core's
 * mechanism wins, and a caller waiting on a wedged harness gets a **status**
 * rather than this side giving up. It is also comfortably above the 900 seconds
 * the orchestration skill tells callers to pass, so the default never cuts short
 * a wait the skill's own budget expects to finish.
 *
 * None of that helps #405's own case — the backstop skips a Session that is not
 * `running`, and a dialog leaves one parked at `needs-input` or `finished` — so
 * there the deadline is still the only thing that ends the wait. That is what it
 * is for; the tie-break above is about not stealing the answer in the case where
 * the Core does have one.
 *
 * `--wait-timeout <s>` replaces it and `--wait-timeout 0` removes it, for a
 * caller that wants the old unbounded wait back.
 */
const SEND_WAIT_DEFAULT_TIMEOUT_S = 1020;

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
  --wait-timeout <s>  give up waiting after this many seconds, and say so.
                      0 means no deadline. send --wait defaults to ${SEND_WAIT_DEFAULT_TIMEOUT_S}
  --await-prompt      start/resume: block only until the Core reports the
                      starting prompt delivered, so a \`send\` can follow safely
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

Running, and ready to be sent to, are different facts (#395)
  A Session is *running* the moment the Core has spawned its harness, which is
  what \`start\` returns on. It is *ready for a send* only once the harness has
  taken the starting prompt — the composer painted, the trust dialog answered,
  the text in and submitted — and that happens on the harness's clock, after
  this process has exited. Between the two there is a terminal that is not
  reading yet, and anything typed into it is discarded:

    SID=$(actana session start web "fix it")
    actana session send $SID continue        # ← can lose both messages

  \`--await-prompt\` is the gate. It blocks until the Core reports the starting
  prompt delivered, prints the id as usual, and exits zero; if the Core gave up
  instead (#483) it says what stopped it and exits non-zero, so a script never
  reads a lost prompt as a started Session. The wait is the Core's — nothing
  here polls, retries or watches the screen go quiet — and it is bounded by that
  harness's own ceiling for a composer that never appears, which is why it takes
  no \`--wait-timeout\` of its own.

  Without it, \`start\` says so on stderr rather than implying otherwise, and
  \`--json\` carries \`promptDelivered: null\` — not \`false\`, which would be a
  verdict nobody reached.

  \`--wait\` is the longer wait and the two are refused together. They do not
  report quite the same fact: \`--wait\` reports a prompt the Core **gave up on**
  and infers the rest from a turn that ended, while \`--await-prompt\` waits for
  the Core to say positively that the prompt went into a composer it saw. On a
  harness whose composer the Core cannot recognise — none of the four this build
  ships, since #277 gave \`codex\` the last readiness row, but the next harness
  added arrives that way — \`--await-prompt\` says so and exits non-zero rather
  than calling a prompt typed on the quiet gap a delivery.

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
  message says this side gave up — never a status the Core did not send. \`wait\`
  has no deadline unless you set one: a turn takes as long as the work takes.

  **\`send --wait\` is the exception, and it defaults to
  ${SEND_WAIT_DEFAULT_TIMEOUT_S} seconds.** It is the one wait for a turn that has
  not started yet, and a carriage return that lands on a dialog rather than a
  composer starts none at all — so the Core has nothing to report and the wait
  would never end (#405). When it runs out with no turn end reported since the
  text went in, it says so, names both readings — a return that submitted nothing,
  or a harness that reports nothing until a turn ends — and says the text was
  delivered so you do not send it twice. \`--wait-timeout 0\` waits with no
  deadline.

  **\`wait\` is not how you resume that wait.** It is uncursored: it answers from
  the status the Session is parked at, so on a Session whose turn never started it
  returns at once with the status from *before* your text and exits zero. To carry
  on waiting for the turn a send started, follow the log from the delivery instead
  — \`actana events tail --since <event id>\`, the id the timeout message names.

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
  the failure this default exists to end. **It cannot be combined with
  \`--wait\`**, which is refused before anything is written (#405): a send that
  submits nothing has no turn to await, so the wait would either never end or
  end on a turn some earlier send started and report it as this one's. Type with
  \`--no-enter\`, then \`actana session wait\` when a turn is actually running.

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
  is a Core bug.

  When the Core cannot deliver it, it says so rather than typing into a harness
  that is not listening and calling it done (#483). \`--wait\` then prints a line
  naming what stopped it, exits non-zero, and sets \`promptDelivered: false\` on
  the \`--json\` object. That is not \`needs-input\` in the ordinary sense: the
  harness is running and has never seen the text, no turn was started, and the
  fix is to \`send\` the prompt once the harness is up — not to answer a question
  it never asked. Without \`--wait\` or \`--await-prompt\` this process has already
  exited by the time the Core decides, so the Session's status is where the
  answer is.`;

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
    "--await-prompt",
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

  const flagged = awaitPromptFlagRefusal(args);
  if (flagged) return usage(deps, "start", flagged);

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

  const readiness = awaitPromptTextRefusal(args, prompt.text);
  if (readiness) return usage(deps, "start", readiness);

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
    return reportStartedSession(deps, args, session, timeout.ms, deliversText(prompt.text));
  });
}

/** `actana session resume <session> [prompt]` — a new harness on an old conversation. */
async function sessionResume(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const misused = misusedFlag(args, [
    "--wait",
    "--wait-timeout",
    "--await-prompt",
    "--dangerously-skip-permissions",
  ]);
  if (misused) return usage(deps, "resume", misused);

  const [taskId, ...promptWords] = rest;
  if (taskId === undefined) {
    return usage(deps, "resume", "a session id is required — `actana session resume <session> [prompt]`");
  }

  const flagged = awaitPromptFlagRefusal(args);
  if (flagged) return usage(deps, "resume", flagged);

  const timeout = waitTimeoutMs(args);
  if (timeout.error) return usage(deps, "resume", timeout.error);

  const prompt = await readText(deps, promptWords);
  if (prompt.error) return usage(deps, "resume", prompt.error);

  const readiness = awaitPromptTextRefusal(args, prompt.text);
  if (readiness) return usage(deps, "resume", readiness);

  return withGateway(deps, args, paths, "resume", async (gateway) => {
    deps.verbose(`resuming session ${taskId}`);
    const session = await gateway.resume({
      taskId,
      ...(prompt.text === null ? {} : { prompt: prompt.text }),
      dangerouslySkipPermissions: args.skipPermissions,
    });
    return reportStartedSession(deps, args, session, timeout.ms, deliversText(prompt.text));
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
  hasPrompt: boolean,
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

    if (args.awaitPrompt) return await awaitPromptDelivered(deps, args, session);

    if (!args.wait) {
      // The one-shot default (#129 D6). The id is the whole of stdout, so it can
      // be captured; everything a person reads went to stderr above.
      //
      // The socket closes on the way out of `withGateway`, and the prompt has
      // almost certainly not been delivered yet — the Core waits for the
      // harness's screen to settle first. That is not a race this side has to
      // win: `initialInput` travelled with the spawn and delivery runs inside
      // the Core (ADR 0026 D2), which is exactly why a client can hang up.
      //
      // What it *is* is a race the caller has to be told about (#395). Hanging
      // up is fine for the prompt and not fine for the next thing the caller
      // does: a `session send` typed the moment this exits lands in a terminal
      // that is not reading yet, and the harness discards it along with the
      // starting prompt sitting in the same buffer.
      if (hasPrompt) deps.err(promptNotYetLine());
      if (args.json) {
        deps.out(
          formatJson({
            ...startedFields(session),
            waited: false,
            // Three-valued, and `null` is the honest one here: not "the prompt
            // was lost" but "this command exited before the Core decided". A
            // `false` would be a report nobody made, which is the same false
            // certainty as the `true` this used to imply by saying nothing.
            promptDelivered: null,
          }),
        );
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
 * `--await-prompt`: block until the Core says what became of the starting
 * prompt, and report it (#395).
 *
 * **The gap this closes.** `session start` returned as soon as the Core had the
 * Session running, which is before the harness can take a keystroke — the
 * composer is not painted, a trust dialog may still be up, and the Core has not
 * begun typing. `SID=$(actana session start web "fix it")` followed immediately
 * by `actana session send $SID continue` therefore wrote into a terminal that
 * was not reading, and the harness discarded the send *and* the starting prompt
 * queued behind it. Nothing in the exit code said so, because nothing had gone
 * wrong yet.
 *
 * **What is waited for, and what is not.** The Core's own verdict, off the
 * event log this command is already connected to: `session:promptDelivered`, or
 * `session:promptAbandoned` if it gave up (#483). Not a pause, not a poll, not
 * a screen going quiet — #191 deleted the last client-side timer that guessed
 * at this, only the Core sees the harness's screen (ADR 0026 D3), and a
 * readiness this side invented would be exactly the false success this train
 * exists to remove. There is no clock here at all: the wait is bounded by the
 * Core's own per-harness composer ceiling, and by the connection going down.
 *
 * **Why delivery is the readiness signal rather than a proxy for it.** A
 * delivered prompt is a composer that was observed on screen, written into, and
 * — on the harnesses that confirm echo — seen to hold the text. That is the
 * strongest statement anybody in this system can make about a harness being
 * able to take input, and it is a report rather than an inference.
 *
 * Shorter than `--wait`, and a different question: `--wait` waits for the turn
 * to end, which can be an hour. This waits for the Session to become sendable,
 * which is seconds on a warm harness.
 */
async function awaitPromptDelivered(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  session: StartedSession,
): Promise<number> {
  deps.err("Waiting for the Core to report the starting prompt delivered…");
  const report = await session.awaitPromptDelivery();

  if (args.json) {
    deps.out(
      formatJson({
        ...startedFields(session),
        // No turn was waited for, and the key keeps meaning that across every
        // verb — one parser, as #289 asks. `--await-prompt` is a wait for the
        // Session to become sendable, not for it to settle.
        waited: false,
        awaitedPrompt: true,
        // The same three-valued field the other two paths print, and `null`
        // means the same thing in all three: nobody established it.
        promptDelivered: promptDeliveredField(report),
        ...(report.outcome === "abandoned" ? { promptAbandonedReason: report.reason } : {}),
        ...(report.outcome === "delivered" || report.outcome === "unverified"
          ? // The Core typed either way; this is the half a script needs to
            // tell "into a composer somebody saw" from "into whatever was on
            // screen when it went quiet" without parsing English.
            { composerObserved: report.outcome === "delivered" }
          : {}),
        ...(report.outcome === "unverified" || report.outcome === "unavailable"
          ? { promptUnknownReason: report.reason }
          : {}),
      }),
    );
  } else {
    deps.out(session.taskId);
    if (report.outcome === "delivered") {
      deps.err(
        `The Core delivered the starting prompt. This session can take an ` +
          `\`actana session send ${session.taskId} …\` now.`,
      );
    } else if (report.outcome === "abandoned") {
      deps.err(promptAbandonedLine(session.taskId, report.reason));
    } else if (report.outcome === "unverified") {
      deps.err(promptUnverifiedLine(session.taskId, session.harness, report.reason));
    } else {
      deps.err(promptUnknownLine(session.taskId, report.reason));
    }
  }
  return report.outcome === "delivered" ? EXIT_OK : EXIT_FAILURE;
}

/**
 * The three-valued `promptDelivered`, from one report (#395).
 *
 * `true` only for the one outcome that establishes it. `false` only for the one
 * the Core adjudicated against. Everything else is `null` — nobody reached a
 * verdict — and that includes the Core typing without seeing a composer, which
 * is neither a delivery to a listening harness nor a Core that gave up.
 */
function promptDeliveredField(report: PromptDeliveryReport): boolean | null {
  if (report.outcome === "delivered") return true;
  if (report.outcome === "abandoned") return false;
  return null;
}

/**
 * What a caller is told when the Core typed and never saw a composer (#395,
 * and the review of #494 that found this reported as success).
 *
 * The prompt went out on the quiet gap, into whatever the harness had on screen
 * when it stopped repainting. That is #483's generic backstop and it is a
 * reasonable way to *deliver*; it is not a statement that a harness took the
 * text, because a screen that has stopped repainting is as easily a dialog.
 * That was codex's failure exactly until #277 measured it — the quiet gap
 * expiring one millisecond after codex cleared the screen for `Do you trust the
 * contents of this directory?` — and codex has a readiness row now, so all four
 * shipped harnesses are vouched for and this line is what the next harness
 * added gets until it has one too.
 *
 * So it exits non-zero and says which of the two happened, rather than letting
 * a script read the zero exit as "the harness is listening".
 */
function promptUnverifiedLine(taskId: string, harness: string | null, reason: string): string {
  return (
    `The Core typed the starting prompt into session ${taskId}, but cannot vouch for where it ` +
    `landed: ${reason}. Until ${harness ?? "this harness"} has a composer the Core can ` +
    `recognise, a start cannot establish that it is ready for a send — ` +
    `\`actana session logs ${taskId}\` shows what is on screen.`
  );
}

/**
 * What a bare `start` says about the prompt it has just handed over (#395).
 *
 * Printed rather than left to be discovered, and not under `--verbose`, for the
 * reason {@link noTurnStartLine} is not: the operator who needs this sentence is
 * precisely the one who did not pass `-v`, and the thing they would otherwise
 * learn it from is a Session that quietly did nothing.
 *
 * It states a fact and does not apologise for it. Hanging up before delivery is
 * the design (#129 D6) and it is right — delivery runs on the harness's clock
 * and can take ninety seconds on a cold opencode. What was wrong was letting
 * the silence read as readiness.
 */
function promptNotYetLine(): string {
  return (
    `Note: the prompt has not been delivered yet. The Core types it once the harness's ` +
    `composer is up, which is after this command exits — a \`session send\` before then can be ` +
    `discarded along with it. \`--await-prompt\` waits for the Core to report it delivered.`
  );
}

/**
 * What a caller is told when this side stopped being able to hear the verdict.
 *
 * Deliberately **not** phrased as a failed delivery. The prompt may have landed
 * a second later; what failed is this command's ability to find out. Reporting
 * that as a loss would be #483's false report pointed the other way, and it
 * would send an operator to re-send text that is already in the composer.
 */
function promptUnknownLine(taskId: string, reason: string): string {
  return (
    `The Core did not report what became of the starting prompt for session ${taskId}: ` +
    `${reason}. The session is running and the prompt may still have landed — ` +
    `\`actana session logs ${taskId}\` shows what is on screen before you send it again.`
  );
}

/**
 * Why `--await-prompt` cannot be carried out as asked, or null (#395).
 *
 * Refusals rather than silent reinterpretations, because every one of these
 * spellings is asking for a report that does not exist, and a zero exit on a
 * report nobody made is how a caller comes to trust one.
 *
 * Split in two only because of where each can be answered: the flags are known
 * before anything is read, and whether there is a prompt is not — a prompt may
 * be arriving on stdin. Both are checked before a Core is dialled.
 */
function awaitPromptFlagRefusal(args: ParsedArgs): string | null {
  if (!args.awaitPrompt) return null;
  if (args.wait) {
    return (
      "--await-prompt and --wait are two lengths of one wait, and --wait is the longer: it " +
      "blocks until the turn ends, and reports a prompt the Core gave up on. It does not " +
      "positively confirm one that landed, which is what --await-prompt is for. Pick one"
    );
  }
  if (args.waitTimeout !== null) {
    return (
      "--wait-timeout bounds --wait, not --await-prompt. This wait is already bounded on the " +
      "Core, by that harness's own ceiling for a composer that never appears (#483), and a " +
      "second deadline here could only end it early — with nothing to report but the fact that " +
      "it did"
    );
  }
  return null;
}

/**
 * {@link awaitPromptFlagRefusal}'s other half, once the prompt is known.
 *
 * **"Has a prompt" is the Core's test, not `!== null`** (#494 review, blocker
 * 2). `session start web ""` and `session start web "   "` both look like a
 * prompt here and are not one there: the empty string is dropped by the gateway
 * before the spawn frame, and a whitespace-or-control string is trimmed away by
 * `sanitizeInitialInput`, so no `HarnessPromptDelivery` is built, no row is ever
 * appended, and the PTY-exit reason row is guarded on the delivery existing too.
 * A wait for that verdict is a wait for nothing, for as long as the operator
 * lets it run.
 */
function awaitPromptTextRefusal(args: ParsedArgs, prompt: string | null): string | null {
  if (!args.awaitPrompt || deliversText(prompt)) return null;
  return (
    "--await-prompt waits for the Core to report *this* start's prompt delivered, and this " +
    "start delivers none — a prompt that is empty, or only spaces and control characters, is " +
    "dropped before the harness sees it. Give a prompt with something in it, or drop the flag"
  );
}

/**
 * Would this text reach the harness as a prompt at all?
 *
 * Mirrors `sanitizeInitialInput` in `packages/core/src/pty-manager.ts`, which is
 * the function that actually decides: characters below 32 and 127 are dropped,
 * and what is left is trimmed — an empty result means the Core builds no
 * delivery. Mirrored rather than imported because `packages/cli` may not reach
 * into `@actana/core` (`no-local-escape.test.ts`); named here so the next person
 * to change one finds the other.
 */
function deliversText(prompt: string | null): boolean {
  if (prompt === null) return false;
  return (
    Array.from(prompt)
      .filter((ch) => {
        const code = ch.charCodeAt(0);
        return code >= 32 && code !== 127;
      })
      .join("")
      .trim() !== ""
  );
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
    // Two things reach here, and neither is a status: the deadline the operator
    // asked for (#405), and the link to the Core dropping out from under the
    // wait (#396). Both are reported as what they are — this side gave up, or
    // this side went deaf — because the Core never said anything either way.
    const message = messageOf(err);
    if (args.json) deps.out(formatJson({ ...startedFields(session), waited: true, error: message }));
    deps.err(`actana session: ${message}`);
    // What to type next, added here rather than in the SDK: the library states
    // the fact, and the command that has an `actana` on the path says what to do
    // with it (#405).
    //
    // **Gated on the same two facts the message itself is** — a delivery cursor,
    // and nothing heard since it. `start --wait`, `resume --wait` and `session
    // wait` all wait uncursored, so their expiry gets the generic "was still
    // <status>" wording, and advice about a write that never happened would sit
    // under it contradicting it.
    //
    // **And it must not offer `session wait`** (#486 review). That verb is
    // uncursored by design: it answers from the status the Session is already
    // parked at (`sessionWait` below; `settledSince(0)` in the SDK). In *this*
    // state — nothing reported since the write, the Session still on the
    // `needs-input` or `finished` it carried before it — `session wait` returns
    // immediately, prints that status and exits **zero**. An operator would read
    // that as the turn completing, and an orchestrating agent reading the exit
    // code would record it as a finished turn. That is the false completion
    // #405 exists to remove, and recommending it here would have reintroduced
    // the bug one layer up.
    //
    // What is offered instead is cursored and cannot lie: `events tail --since`
    // the delivery's own event id follows the log from the write, so it prints
    // what the Core reports next and nothing that came before. The error carries
    // that id, which is why the line can name it.
    if (
      err instanceof CoreSessionTurnTimeoutError &&
      err.afterEventId > 0 &&
      !err.reportedSinceDelivery
    ) {
      deps.err(
        `actana session send: no turn end was reported after the text went in. ` +
          `\`actana session logs ${session.taskId}\` shows what is on screen — a dialog waiting ` +
          `for an answer looks like one there, and so does a harness still working. To keep ` +
          `waiting, follow the log from the delivery: ` +
          `\`actana events tail --since ${err.afterEventId}\`. Not \`session wait\`: that verb ` +
          `answers at once with the status this Session was already parked at and exits zero, ` +
          `which is last turn's answer, not this one's.`,
      );
    }
    // The lost link's next step (#396), and it is a different one: nothing here
    // gave up on a clock, so there is no "keep waiting" to offer against a Core
    // this invocation can no longer reach. What it can say is where the answer
    // is — the Core, once it is reachable — and, when there is a delivery cursor
    // to name, the one command that reads the log from the write rather than
    // from whatever status the row is parked at.
    //
    // **`session wait` is warned off here for the same reason it is above.**
    // After a drop the Session may well be sitting at the status it carried
    // before this turn, and an uncursored wait would print that and exit zero —
    // a turn reported as finished on the strength of a network failure, which is
    // exactly what the SDK refused to do a moment earlier.
    if (err instanceof CoreSessionLinkLostError) {
      const followOn =
        err.afterEventId > 0
          ? `To pick the wait up where it stopped, follow the log from the delivery: ` +
            `\`actana events tail --since ${err.afterEventId}\`. Not \`session wait\`: it answers ` +
            `from the status this Session is parked at and exits zero, which after a drop is as ` +
            `likely to be last turn's answer as this one's.`
          : `\`actana session ls\` says whether it is still live, and ` +
            `\`actana session logs ${session.taskId}\` shows what is on screen.`;
      deps.err(
        `actana session: the turn's outcome is unknown — the Core never reported it ending, and ` +
          `this side stopped listening. The Session is on the Core, not in this process, so it is ` +
          `still running there. ${followOn}`,
      );
    }
    return EXIT_FAILURE;
  }

  // Read while the Session is alive: a full-screen harness restores the main
  // buffer when it quits, and the main buffer is where nothing was printed.
  const screen = session.screen();

  // The Core gave up delivering the starting prompt (#483). This outranks the
  // status, and it has to: the status it produces is `needs-input`, which is a
  // settled status and a zero exit, and a Session that never received its
  // prompt reported as a clean settle is the false success the issue is about.
  const abandoned = session.promptAbandoned();

  if (args.json) {
    deps.out(
      formatJson({
        ...startedFields(session),
        waited: true,
        status: outcome.status,
        exited: outcome.exited,
        ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
        // A field and not only a sentence, for the same reason
        // `reportsTurnStart` is one: a script deciding whether to re-send has
        // to read this rather than parse English off stderr.
        promptDelivered: abandoned === null,
        ...(abandoned === null || abandoned.reason === ""
          ? {}
          : { promptAbandonedReason: abandoned.reason }),
        // The transcript rides along because a `--json` caller has no second
        // chance at it: the Core's replay ring lives with the PTY, so a
        // harness that exited takes its output with it and a later
        // `session logs` has nothing to answer with.
        screen,
      }),
    );
  } else {
    deps.out(session.taskId);
    if (abandoned) deps.err(promptAbandonedLine(session.taskId, abandoned.reason));
    deps.err(settledLine(outcome));
    deps.err(`\`actana session logs ${session.taskId}\` prints the transcript while the harness is running.`);
  }
  if (abandoned) return EXIT_FAILURE;
  return settledWell(outcome) ? EXIT_OK : EXIT_FAILURE;
}

/**
 * What a caller is told when the prompt never reached the harness (#483).
 *
 * It names the one thing the status cannot. `needs-input` is the Core's honest
 * report of a harness waiting on a human, and it is the *same* status a harness
 * that stopped to ask a permission question produces — but the two call for
 * opposite next steps. There, the answer is `session send`. Here there is no
 * question and no turn: the prompt is not in the composer, so the text has to
 * go again, and a script that read the zero exit as success would never know.
 */
function promptAbandonedLine(taskId: string, reason: string): string {
  const because = reason === "" ? "" : ` (${reason})`;
  return (
    `The Core did not deliver the starting prompt to session ${taskId}${because}. ` +
    `The harness is running and has not seen it — no turn was started. ` +
    `Send the text with \`actana session send ${taskId} …\` once the harness is ready.`
  );
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

  // **A send that submits nothing has nothing to wait for** (#405). `--no-enter`
  // sends no carriage return, so no turn starts, and the wait paired with it is
  // not waiting for this send: on an idle Session nothing ever ends it, and on a
  // Session that was already mid-turn it ends on *that* turn and reports it as
  // this send's. One hangs and one lies, and neither is a reading this command
  // can pick between — so the pair is refused here, before a byte is written,
  // rather than carried out and warned about afterwards.
  if (args.noEnter && args.wait) {
    return usage(
      deps,
      "send",
      "--no-enter starts no turn, so --wait would have nothing to wait for — drop --no-enter to " +
        "submit and wait, or drop --wait and run `actana session wait` when the turn is under way",
    );
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
      // Always with the return: `--no-enter --wait` was refused above, so a
      // wait on this path is always a wait for a turn this send actually asked
      // for. `submit` is read anyway rather than assumed, so the two halves of
      // that decision cannot drift apart.
      const andReturn = submit ? " and a carriage return" : "";
      // The deadline this verb carries when the operator named none (#405). The
      // wait itself is the SDK's and counts nothing here; this only decides how
      // long the CLI is willing to sit on it.
      const deadlineMs =
        args.waitTimeout === null ? SEND_WAIT_DEFAULT_TIMEOUT_S * 1000 : timeout.ms;
      deps.verbose(
        `sending ${text.length} characters to session ${taskId}${andReturn}, then waiting` +
          (deadlineMs === null ? " with no deadline" : ` up to ${Math.round(deadlineMs / 1000)}s`),
      );
      const session = await gateway.sendAndWait(taskId, text, { enter: submit });
      deps.err(`Sent ${text.length} characters to session ${taskId}${andReturn}.`);
      // Stderr is the *only* signal on this path, and deliberately: the wait's
      // document is `start --wait --json`'s key set and nothing else, because
      // #289 requires one parser to read all three verbs (#289 B).
      return awaitAttachedTurn(deps, args, session, deadlineMs);
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
  { name: "--await-prompt", used: (args) => args.awaitPrompt },
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
 * `--wait-timeout <seconds>`, in milliseconds. `null` is "no deadline".
 *
 * Only with `--wait`, because on its own it is an instruction that cannot be
 * carried out — and a deadline somebody believes they set is worse than no
 * deadline at all. The wait it bounds is the SDK's; nothing here counts time.
 *
 * **`0` is no deadline, spelled out** (#405). It is the opt-out from the default
 * `send --wait` carries, and it is accepted on every verb that takes the flag so
 * that one spelling means one thing: a caller that writes `--wait-timeout 0` is
 * asking to wait as long as the work takes. Anything non-numeric or negative is
 * still a refusal rather than a silently ignored instruction.
 *
 * **This is a behaviour change on every verb, and worth knowing before you
 * compute one** (#486 review). `0` used to be `EXIT_USAGE`, so a script writing
 * `--wait-timeout $(( deadline - $(date +%s) ))` was told its budget had run out
 * and now waits instead. `-1` is still a refusal, so the discontinuity is at
 * exactly one value; a script that computes a budget should clamp it to a
 * positive number itself, because "no time left" and "no deadline" are opposite
 * instructions and only the caller knows which it meant.
 *
 * Only an exact `0` opts out. A positive number that rounds below a millisecond
 * is a deadline the caller asked for, and it clamps to 1 ms rather than becoming
 * an unbounded wait — the one direction a rounding error must never take.
 */
function waitTimeoutMs(
  args: ParsedArgs,
  waiting: boolean = args.wait,
): { ms: number | null; error?: string } {
  if (args.waitTimeout === null) return { ms: null };
  // `waiting` is for the one verb that *is* a wait: `session wait` takes no
  // `--wait` (the verb says it), so its deadline cannot be gated on the flag.
  if (!waiting) return { ms: null, error: "--wait-timeout only means something with --wait" };
  const seconds = args.waitTimeout.trim() === "" ? Number.NaN : Number(args.waitTimeout);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return { ms: null, error: `--wait-timeout wants a number of seconds, not "${args.waitTimeout}"` };
  }
  // Exactly zero is the opt-out. Anything above it is a deadline that was asked
  // for, floored at a millisecond so a small number cannot round its way into an
  // unbounded wait — that is the one direction this must never round.
  if (seconds === 0) return { ms: null };
  return { ms: Math.max(1, Math.round(seconds * 1000)) };
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
