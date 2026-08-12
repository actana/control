// `actana session` — the Sessions running on a Core (#129 D10, #160).
//
//   actana session start <project> [prompt]  start one; prints its id and exits
//   actana session ls [project]              what is running, and what settled
//   actana session logs <session>            the transcript, rendered
//   actana session resume <session> [prompt] pick a conversation back up
//   actana session send <session> <text>     type into a running Session
//   actana session kill <session>            stop the harness, whoever started it
//   actana session attach                    scaffolded here, built in #163
//
// Three rules this noun is built around. The first two are the ticket's, the
// third is what makes the other two usable from a script.
//
// **The Core delivers prompts (ADR 0026, #129 D3).** `start` hands its prompt to
// the SDK, which hands it to the Core, which waits for the harness's TUI to
// settle, answers whatever dialog it opened, and writes the prompt and the
// carriage return. Nothing in this package waits, retries, or presses Enter on
// a timer — `send` writes exactly the bytes it was given and appends nothing.
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
import { EXIT_FAILURE, EXIT_OK, EXIT_UNIMPLEMENTED, EXIT_USAGE } from "./exit-codes.ts";
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
  actana session kill <session>             stop the harness running for it
  actana session attach <session>           take the terminal (not built — #163)

Flags
  --core <name>       which registered Core to talk to
  --json              machine-readable output. Only JSON reaches stdout.
  --wait              start/resume: block until the Core reports it settled
  --wait-timeout <s>  give up waiting after this many seconds, and say so
  --harness <name>    start: ${KNOWN_HARNESSES.join(", ")}
  --cwd <path>        start: a directory on the Core, inside the Project
  --title <text>      start: what the Session is called in \`ls\`
  --raw               logs: the bytes, escape codes and all, unrendered
  --enter             send: follow the text with a carriage return
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

Who delivers the prompt
  The Core does (ADR 0026). It waits for the harness to settle, answers the
  dialog it opened, and writes the prompt. This CLI adds no timing of its own,
  and \`send\` writes exactly what it is given — a lost prompt is a Core bug.`;

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
    case "kill":
      return sessionKill(deps, args, paths, rest);
    case "attach":
      return sessionAttach(deps);
    default:
      deps.err(`actana session: unknown verb "${verb}".`);
      deps.err("Verbs: start, ls, logs, resume, kill, send, attach. `actana session --help` lists them.");
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
  } finally {
    // Listeners on the client, released. The harness on the Core is untouched —
    // that is `session kill`.
    session.dispose();
  }
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
 * `actana session send <session> <text>` — the equivalent of typing.
 *
 * Verbatim, and nothing appended (ADR 0026, and the module header). `--enter`
 * adds a second write of a carriage return **because the operator asked for
 * one** — no pause between them, no waiting for the harness to look ready, and
 * nothing that decides on its own that Enter is due. A *starting* prompt goes
 * through `session start`, where the Core owns the schedule.
 */
async function sessionSend(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const misused = misusedFlag(args, ["--enter"]);
  if (misused) return usage(deps, "send", misused);

  const [taskId, ...words] = rest;
  if (taskId === undefined) {
    return usage(deps, "send", "a session id is required — `actana session send <session> <text>`");
  }
  const read = await readText(deps, words);
  if (read.error) return usage(deps, "send", read.error);
  if (read.text === null && !args.enter) {
    return usage(
      deps,
      "send",
      "nothing to send — pass text, `-` to read stdin, or --enter for a bare carriage return",
    );
  }

  return withGateway(deps, args, paths, "send", async (gateway) => {
    const text = read.text ?? "";
    let delivered = text.length === 0 ? true : await gateway.send(taskId, text);
    if (delivered && args.enter) delivered = await gateway.send(taskId, "\r");

    if (args.json) {
      deps.out(formatJson({ taskId, characters: text.length, enter: args.enter, delivered }));
    } else if (delivered) {
      const andReturn = args.enter ? " and a carriage return" : "";
      deps.err(`Sent ${text.length} characters to session ${taskId}${andReturn}.`);
    }
    if (!delivered) {
      deps.err(`actana session send: the Core did not accept the write to session ${taskId}.`);
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

/**
 * `actana session attach` — scaffolded, not built.
 *
 * Deliberately a separate ticket: attaching is raw mode, resize forwarding and
 * signal handling on *this* terminal, and none of the rest of this noun needs a
 * terminal at all. It is in the tree and in the help for the reason `core shell`
 * is — the noun's shape is decided in one place — and it exits
 * {@link EXIT_UNIMPLEMENTED} rather than pretending.
 */
function sessionAttach(deps: ActanaCliDeps): number {
  deps.err("actana session attach: not built yet — it is #163, in this phase.");
  deps.err("Until then: `actana session logs <session>` reads the transcript and `session send` types into it.");
  return EXIT_UNIMPLEMENTED;
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
  { name: "--dangerously-skip-permissions", used: (args) => args.skipPermissions },
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
function waitTimeoutMs(args: ParsedArgs): { ms: number | null; error?: string } {
  if (args.waitTimeout === null) return { ms: null };
  if (!args.wait) return { ms: null, error: "--wait-timeout only means something with --wait" };
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
 * second one. `-` is the same stdin convention `core add` uses, and it is what
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

/** The identity fields `start` and `resume` report, in both output modes. */
function startedFields(session: StartedSession): Record<string, unknown> {
  return {
    taskId: session.taskId,
    ptyId: session.ptyId,
    harness: session.harness,
    command: session.command,
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
