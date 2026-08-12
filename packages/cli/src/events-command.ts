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
//     everything up to that marker is counted, not printed. A first run that
//     printed it would be the replay storm, produced deliberately.
//
//   • **Where the cursor lives.** `FileCursorStorage`, so the second run of a
//     command picks up where the first left off. A reconnect *within* a run is
//     already covered by the in-memory cursor; a restart is not, and a CLI is
//     restarted constantly.
//
// Nothing here handles SIGINT, and that is deliberate. Ctrl-C ends this the way
// it ends `tail -f`: the default signal disposition, no handler. There is
// nothing to flush — every line is written as it arrives, and the cursor file is
// written synchronously with it — so a handler could only add a way for the last
// event to be lost.

import { errorText, openCore } from "./core-connection.ts";
import { cursorsDir, FileCursorStorage, pinnedCursorStorage } from "./event-cursor-file.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./exit-codes.ts";
import type { CoreLinkCursorStorage } from "@actana/sdk/core-link-cursor-storage.ts";
import type { CoreLinkEvent } from "@actana/sdk/core-link-frames.ts";
import type { RegistryPaths } from "./blob-registry.ts";
import type { ActanaCliDeps } from "./cli-deps.ts";
import type { ParsedArgs } from "./cli-args.ts";

export const EVENTS_HELP = `actana events tail — follow a Core's event log

Usage
  actana events tail [flags]

Flags
  --core <name>    which Core to follow
  --json           one JSON object per line (NDJSON), and nothing else on stdout
  --since <id>     start after this event id, instead of the stored cursor
  --since start    start at the beginning of the log the Core still holds
  --kind <kind>    only this kind; repeat the flag for more than one
  --limit <n>      stop after n events instead of following
  --verbose        explain the steps, on stderr. Never prints a blob.

Where it starts
  Each Core gets a cursor under the config directory, so a second run carries on
  from where the first stopped. With no cursor and no --since, a tail starts at
  the end of the log — like \`tail -f\`, not like \`cat\`.

  --since does not move the stored cursor: a one-off rewind leaves the
  follow-along stream where it was.

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

  const fileCursor = new FileCursorStorage(cursorsDir(paths));
  const storage: CoreLinkCursorStorage =
    since.value === null ? fileCursor : pinnedCursorStorage(since.value);

  const opened = await openCore(deps, args, paths, "actana events tail", {
    durable: true,
    storage,
  });
  if (!opened.ok) return opened.code;
  const { client, name, endpoint } = opened.core;

  // A first run has nothing on disk to resume from, and "resume from 0" is not
  // what a tail means. `--since` is an explicit answer to the same question and
  // wins over both.
  const fromStart = since.value !== null || fileCursor.hadCursor;
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

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      offEvent();
      offReplayed();
      offDown();
      offUp();
      client.close();
      resolve(code);
    };

    const offEvent = client.onEvent(({ event }) => {
      // Everything reaching here is already past the cursor and already deduped
      // — that is the durable client's contract, and it is what makes a
      // reconnect cost neither a repeat nor a gap. This is a filter, not a
      // second cursor.
      if (!printing) return;
      if (kinds.size > 0 && !kinds.has(event.kind)) return;
      deps.out(args.json ? formatEventJson(event) : formatEventLine(event));
      printed += 1;
      if (limit.value !== null && printed >= limit.value) finish(EXIT_OK);
    });

    // The marker that closes a replay tail — and, on a first run, the moment the
    // Core's tip becomes known. From here the stream is live. Every later
    // connection fires this too; printing is only ever switched on.
    const offReplayed = client.onEventsReplayed(({ lastEventId }) => {
      if (!printing) {
        deps.verbose(`the Core's log ends at #${lastEventId}; following from there`);
        printing = true;
        return;
      }
      deps.verbose(`caught up to #${lastEventId}`);
    });

    const offDown = client.onDisconnected(({ error }) => {
      // stderr, always: on the `--json` path stdout is the event stream, and a
      // consumer parsing it should never have to recognise a status line.
      deps.err(`link to ${name ?? endpoint} dropped${error ? ` — ${error}` : ""}; reconnecting…`);
    });

    const offUp = client.onReady(() => {
      deps.verbose("link re-established; replaying from the cursor");
    });

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
