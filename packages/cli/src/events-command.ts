// `actana events tail` — the Core's event log, as it happens (#129 D10).
//
//   actana events tail [--json] [--since <id|start>] [--kind <k>] [--limit <n>]
//
// This is the CLI's first consumer of the **event cursor**, and the cursor is
// the whole ticket. An event log is a monotonic sequence per Core; a client
// says how far it has got (`subscribe { lastEventId }`) and the Core streams
// everything past that, then pushes live. Get the number wrong and nothing
// errors — a cursor too low replays a log the operator has already read (the
// replay storm), and a cursor too high stops live push entirely, silently,
// because the Core has nothing past it to send.
//
// So the number is not computed here. `DurableCoreClient` owns it (#129 D6): it
// sends the cursor on every connection, dedupes every delivered event against
// it, advances it on each event *and* on the `eventsReplayed` marker that closes
// a replay, and persists it through the store it is handed. What this file adds
// is the two things a *command* has to decide:
//
//   • **Where a first run starts.** With no stored cursor and no `--since`, a
//     tail starts at the end of the log, the way `tail -f` does. The Core has no
//     frame that answers "what is your tip", so the tip is learned the way it is
//     published — subscribe, let the tail stream, read `eventsReplayed` — and
//     everything up to it is counted, not printed. A first run that printed it
//     would be the replay storm, produced deliberately.
//
//     One `eventsReplayed` is *not* enough to conclude the log has ended: the
//     Core caps a replay tail at `EVENT_TAIL_LIMIT` and the marker reports what
//     it sent rather than what it has. `event-tip.ts` is that whole argument and
//     the loop that closes it; this file feeds it the two frames and keeps
//     quiet until it says the log has an end.
//
//   • **Where the cursor lives.** `FileCursorStorage`, so the second run of a
//     command picks up where the first left off. A reconnect *within* a run is
//     already covered by the in-memory cursor; a restart is not, and a CLI is
//     restarted constantly.
//
//   • **Where a `--limit` run ends.** This is #402. On a live Core,
//     `events tail --since 13 --limit 30 --json` printed the nine events past
//     the cursor and then sat until it was killed: the `session:finished` the
//     operator was waiting for was event #22, already in SQLite, already on
//     their screen, and the only way out of the loop was a thirtieth event that
//     nobody was going to append. `--limit` is a ceiling on what gets printed,
//     and it was being waited on as a quota.
//
//     So a run that was given somewhere to start from — `--since`, or a cursor
//     a previous run left — and that **found history there** has read what it
//     was asked for, and ends at the end of that history however few events it
//     turned out to be. The end is found the same way a first run finds the tip
//     and by the same code: `event-tip.ts`, one marker at a time, until one
//     closes an empty tail.
//
//     A run that found *no* history is the case this deliberately leaves alone.
//     Nothing past the cursor is what a follow looks like at the moment it
//     starts — it is `--since start` against a log that has not been written to
//     yet, and `events-tail-cursor.test.ts` is that run, across a Core restart,
//     proving #161's criterion. There was no read to finish, so it follows and
//     stops at n, which is what `--limit` has always meant.
//
//   • **That a stuck subscribe cannot wedge either of them.** A Core that never
//     answers `subscribe` sends no event and no marker, so neither the ceiling
//     nor the end of the log is ever reached and the command has nothing to do
//     but wait — which is the other half of #402's report, a Core under
//     contention. Until the log's end is known, a `--limit` run holds a
//     deadline on its patience; it prints what it did get, says on stderr that
//     the Core stopped answering, and exits.
//
// Nothing here handles SIGINT, and that is deliberate. Ctrl-C ends this the way
// it ends `tail -f`: the default signal disposition, no handler. There is
// nothing to flush — every line is written as it arrives, and the cursor file is
// written synchronously with it — so a handler could only add a way for the last
// event to be lost.

import { errorText, openCore } from "./core-connection.ts";
import { resolveCore } from "./core-resolution.ts";
import {
  cursorsDir,
  FileCursorStorage,
  pinnedCursorStorage,
  storedCursorFor,
} from "./event-cursor-file.ts";
import { trackEventTip } from "./event-tip.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./exit-codes.ts";
import type { CoreLinkCursorStorage } from "@actana/sdk/core-link-cursor-storage.ts";
import type { CoreLinkEvent } from "@actana/sdk/core-link-frames.ts";
import type { RegistryPaths } from "./blob-registry.ts";
import type { ActanaCliDeps } from "./cli-deps.ts";
import type { ParsedArgs } from "./cli-args.ts";

/**
 * How long a bounded run waits for a Core that has gone quiet.
 *
 * Armed only on a `--limit` run reading history, re-armed on every event and
 * every marker: what it exists to catch is a subscribe that never answers, and
 * a long log is a Core answering — slowly, and correctly. The same 30s
 * `harness install` gives the same frame, for the same reason.
 *
 * Without it, "read the log and exit" still has one way not to exit, and it is
 * the way #402 was reported: a contended Core, a subscribe that never replays,
 * and a command with nothing to do but wait.
 */
const SUBSCRIBE_ANSWER_MS = 30_000;

export const EVENTS_HELP = `actana events tail — follow a Core's event log

Usage
  actana events tail [flags]

Flags
  --core <name>    which Core to follow
  --json           one JSON object per line (NDJSON), and nothing else on stdout
  --since <id>     start after this event id, instead of the stored cursor
  --since start    start at the beginning of the log the Core still holds
  --kind <kind>    only this kind; repeat the flag for more than one
  --limit <n>      print at most n events, then exit
  --verbose        explain the steps, on stderr. Never prints a blob.

Where it starts
  Each Core gets a cursor under the config directory, so a second run carries on
  from where the first stopped. With no cursor and no --since, a tail starts at
  the end of the log — like \`tail -f\`, not like \`cat\`.

  --since does not move the stored cursor: a one-off rewind leaves the
  follow-along stream where it was.

Where it ends
  --limit is a ceiling, not a quota. A run that starts from --since or a stored
  cursor and finds events already in the log prints them and exits at the end of
  that history, however far short of n it stops. It does not wait for a Core to
  produce the difference.

  With nothing in the log past where it started, there is no history to read, so
  it follows and stops after n events. Without --limit, a tail follows until
  Ctrl-C either way.

Reconnects
  The link re-establishes itself and replays from the cursor, so a Core restart
  or a dropped network costs neither a repeated event nor a missed one. Notices
  about the link go to stderr; stdout carries events only.

  Ctrl-C ends it. Nothing is buffered.`;

/** Dispatch an `events` verb. `args.positionals` still has `events` at [0]. */
export async function runEventsCommand(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
): Promise<number> {
  const [verb, ...rest] = args.positionals.slice(1);

  if (args.help || verb === undefined) {
    deps.out(EVENTS_HELP);
    return verb === undefined && !args.help ? EXIT_USAGE : EXIT_OK;
  }
  if (verb !== "tail") {
    deps.err(`actana events: unknown verb "${verb}".`);
    deps.err("The only verb is `tail`. `actana events --help` explains it.");
    return EXIT_USAGE;
  }
  if (rest.length > 0) {
    deps.err(`actana events tail: unexpected argument "${rest[0]}".`);
    deps.err("It takes flags only — `--since`, `--kind`, `--limit`.");
    return EXIT_USAGE;
  }

  return eventsTail(deps, args, paths);
}

async function eventsTail(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
): Promise<number> {
  const since = parseSince(args.since);
  if (!since.ok) {
    deps.err(`actana events tail: ${since.error}`);
    return EXIT_USAGE;
  }
  const limit = parseLimit(args.limit);
  if (!limit.ok) {
    deps.err(`actana events tail: ${limit.error}`);
    return EXIT_USAGE;
  }

  const dir = cursorsDir(paths);
  const storage: CoreLinkCursorStorage =
    since.value === null
      ? new FileCursorStorage(dir, deps.verbose)
      : pinnedCursorStorage(since.value);

  // Resolved here rather than inside `openCore`, and read off disk before
  // anything dials: a durable client advances this very cursor as soon as its
  // link comes up, so "was there a cursor here?" is a question with a shelf
  // life. Asked afterwards, this run's own first replay would answer it.
  const resolved = resolveCore({ paths, env: deps.env, home: deps.home, coreFlag: args.core });
  const stored = resolved.ok ? storedCursorFor(dir, resolved.core.blob.endpoint) : null;

  const opened = await openCore(deps, args, paths, "actana events tail", {
    durable: true,
    storage,
    resolved,
  });
  if (!opened.ok) return opened.code;
  const { client, name, endpoint } = opened.core;

  // A first run has nothing on disk to resume from, and "resume from 0" is not
  // what a tail means. `--since` is an explicit answer to the same question and
  // wins over both.
  const fromStart = since.value !== null || stored !== null;
  let printing = fromStart;
  const kinds = new Set(args.kind);

  deps.verbose(
    printing
      ? `following ${name ?? endpoint} from the stored cursor`
      : `following ${name ?? endpoint} from the end of the log`,
  );

  return new Promise<number>((resolve) => {
    let printed = 0;
    let settled = false;
    // Only consulted while `printing` is off — once the log's end is known
    // there is nothing left to learn, and every later marker is just a
    // reconnect catching up.
    const tip = trackEventTip(client, deps);
    // The same walk, on the other side of the switch. A first run walks the log
    // to find its tip and prints none of it; a `--limit` run walks it to find
    // its end and prints all of it. The question asked of each marker is the
    // same one — did this close an empty tail, or is the Core capping a replay
    // — so it is asked with the same tracker rather than with a second opinion.
    //
    // Retired once the end is known: after that every marker is a reconnect
    // catching up, exactly as on the other side, and there is nothing left to
    // ask.
    let history = limit.value !== null && fromStart ? trackEventTip(client, deps) : null;
    let idle: ReturnType<typeof setTimeout> | null = null;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (idle !== null) clearTimeout(idle);
      offEvent();
      offReplayed();
      offDown();
      offUp();
      client.close();
      resolve(code);
    };

    /**
     * Re-arm the deadline on the Core's answer to `subscribe`.
     *
     * Re-armed on every frame that *is* an answer, so the clock only ever runs
     * while the Core is silent — a long log is a Core answering, slowly and
     * correctly. Disarmed for good once the end of the log is known, because
     * past that point silence is a Core with nothing to say and waiting through
     * it is the whole of what a follow does.
     *
     * When it fires, what was printed is what the subscribe gave up: a
     * truncated read still succeeded, and a subscribe that answered nothing at
     * all is a failure with a reason on stderr rather than a hang.
     */
    const waitForAnswer = () => {
      if (history === null || settled) return;
      if (idle !== null) clearTimeout(idle);
      idle = setTimeout(() => {
        deps.err(
          `actana events tail: ${name ?? endpoint} stopped answering the event ` +
            `subscription; stopping with ${printed} event(s).`,
        );
        finish(printed > 0 ? EXIT_OK : EXIT_FAILURE);
      }, SUBSCRIBE_ANSWER_MS);
    };

    /** Stop watching for the end of the log, and stop timing the Core. */
    const stopReading = () => {
      history = null;
      if (idle !== null) clearTimeout(idle);
      idle = null;
    };

    const offEvent = client.onEvent(({ event }) => {
      // Everything reaching here is already past the cursor and already deduped
      // — that is the durable client's contract, and it is what makes a
      // reconnect cost neither a repeat nor a gap. This is a filter, not a
      // second cursor.
      if (!printing) {
        // The tail this run is walking to find the end of the log. Counted
        // rather than dropped: a marker that closes a tail with events in it is
        // a receipt for what the Core sent, not a statement that it has no more
        // (`event-tip.ts`).
        tip.saw(event.eventId);
        return;
      }
      // Counted before the filter, and before the ceiling: this is history the
      // Core sent, and how much of it the operator asked to see changes nothing
      // about whether there is more of it to come.
      history?.saw(event.eventId);
      waitForAnswer();
      if (kinds.size > 0 && !kinds.has(event.kind)) return;
      deps.out(args.json ? formatEventJson(event) : formatEventLine(event));
      printed += 1;
      if (limit.value !== null && printed >= limit.value) finish(EXIT_OK);
    });

    // The marker that closes a replay tail. On a first run it is also how the
    // end of the log is found — but only once one of them closes a tail the
    // Core did not have to cut short, which is what `tipFrom` decides. Every
    // later connection fires this too; printing is only ever switched on.
    const offReplayed = client.onEventsReplayed(({ lastEventId }) => {
      if (!printing) {
        const end = tip.tipFrom(lastEventId);
        // A capped replay: the rest has been asked for and another marker is
        // coming. Printing stays off, which is the whole point — this is the
        // history the operator did not ask to see.
        if (end === null) return;
        deps.verbose(`the Core's log ends at #${end}; following from there`);
        printing = true;
        return;
      }
      deps.verbose(`caught up to #${lastEventId}`);
      if (history === null) return;

      // Everything the Core holds past this run's cursor has now been sent —
      // unless this marker closed a capped tail, in which case the tracker has
      // already asked again and another marker is coming.
      const end = history.tipFrom(lastEventId);
      if (end === null) {
        waitForAnswer();
        return;
      }
      stopReading();

      // Nothing was there to read: this is a follow that has just been told the
      // log is empty past where it started, and a follow waits. `--limit` keeps
      // the meaning it has always had for it — stop after n.
      if (printed === 0) {
        deps.verbose(`the Core's log ends at #${end}; nothing to read, following from there`);
        return;
      }
      deps.verbose(
        `the Core's log ends at #${end}; --limit is a ceiling, and ${printed} event(s) is the log`,
      );
      finish(EXIT_OK);
    });

    const offDown = client.onDisconnected(({ error }) => {
      // stderr, always: on the `--json` path stdout is the event stream, and a
      // consumer parsing it should never have to recognise a status line.
      deps.err(`link to ${name ?? endpoint} dropped${error ? ` — ${error}` : ""}; reconnecting…`);
    });

    const offUp = client.onReady(() => {
      deps.verbose("link re-established; replaying from the cursor");
    });

    waitForAnswer();
    if (limit.value === 0) finish(EXIT_OK);
  }).catch((err: unknown) => {
    deps.err(`actana events tail: ${errorText(err)}`);
    return EXIT_FAILURE;
  });
}

/**
 * One event as a line a person reads.
 *
 * The payload is kind-specific JSON of no fixed shape, so it is printed as it
 * arrived and clipped: a line is a line, and an operator watching a stream for
 * the one event they care about is reading the kind and the id. `--json` is
 * where the whole payload lives, uncut.
 */
function formatEventLine(event: CoreLinkEvent): string {
  const subject = event.taskId ? `task=${event.taskId}` : event.ptyId ? `pty=${event.ptyId}` : "";
  const head = `#${event.eventId}  ${new Date(event.ts).toISOString()}  ${event.kind}`;
  const payload = event.payload.replace(/\s+/g, " ").trim();
  const tail = [subject, clip(payload, 100)].filter(Boolean).join("  ");
  return tail ? `${head}  ${tail}` : head;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * One event as one line of JSON — NDJSON, because this is a stream.
 *
 * A single JSON array cannot be emitted by a command that may never end, and a
 * consumer of a `tail` wants each event as it lands rather than at the close of
 * a bracket that never comes. Every line is a complete JSON value and stdout
 * carries nothing else, which is what `--json` promises.
 *
 * `payload` stays the string the Core sent. It is JSON *inside* a field whose
 * shape depends on `kind`; parsing it here would either lose that or force this
 * command to have an opinion about every kind a Core can emit.
 */
function formatEventJson(event: CoreLinkEvent): string {
  return JSON.stringify({
    eventId: event.eventId,
    ts: event.ts,
    kind: event.kind,
    ptyId: event.ptyId,
    taskId: event.taskId,
    payload: event.payload,
  });
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * `--since <id>` / `--since start`, or null for "use the stored cursor".
 *
 * `start` is a word rather than a bare `0` for the reader's sake — both work,
 * and `--since 0` is only obvious to somebody who already knows the log is
 * 1-based. It asks for everything the Core still holds, which is a bounded tail
 * and not necessarily the whole history.
 */
function parseSince(raw: string | null): Parsed<number | null> {
  if (raw === null) return { ok: true, value: null };
  if (raw === "start") return { ok: true, value: 0 };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    return { ok: false, error: `--since takes an event id or \`start\`, not "${raw}".` };
  }
  return { ok: true, value: n };
}

function parseLimit(raw: string | null): Parsed<number | null> {
  if (raw === null) return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    return { ok: false, error: `--limit takes a whole number of events, not "${raw}".` };
  }
  return { ok: true, value: n };
}
