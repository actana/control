// `actana harness` — the coding agents a Core can run (#129 D10).
//
//   actana harness ls [--json]      what this Core has on its PATH, and what it lacks
//   actana harness install <id>     install one, and report what actually happened
//
// **`install` reports a real exit status, and the definition of success is the
// Core's, not the vendor installer's.** A vendor script that exits 0 while
// leaving nothing on the Core's PATH is a failed install (the Core's
// `harness-install-service.ts` says so in as many words), and this command
// inherits that definition: it exits 0 when the Core reports the Harness
// *available*, and non-zero every other time, including when it gave up
// waiting. Nothing here reads the installer's exit code, because nothing here
// runs the installer.
//
// The wait is what the frame shape forces. `harnessInstall` is answered by an
// **ack** — "this Core validated the id and started" — and never by the
// outcome, because a vendor installer runs for minutes and a request held open
// that long would time out on a healthy install (issue 83). The outcome travels
// on the event log: `agents:availabilityChanged` flipping the Harness to
// `available`, or `harness:installFailed`. So this command subscribes first,
// asks second, and waits for one of those two — with a periodic re-read of the
// availability map as a second, independent answer, so a Core whose event log
// is not wired still reaches a verdict instead of hanging until the deadline.
//
// **Installation is currently failing, and this command says so.** #128 (the
// canary) and #31 (the opencode install path a vendor moved) are open, live
// failures, not history. A CLI that printed "installed" on the strength of an
// ack would be the exact papering-over those two issues describe; a CLI that
// refused to try would be inventing a verdict. This one tries, waits, and when
// the Core says no it names the Harness and links the issue.

import { formatJson, formatTable } from "./cli-output.ts";
import { errorText, openCore, type CoreLinkClient } from "./core-connection.ts";
import { trackEventTip } from "./event-tip.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./exit-codes.ts";
import {
  HARNESS_INSTALL_FAILED_EVENT_KIND,
  HARNESSES_AVAILABILITY_EVENT_KIND,
  type CoreLinkHarnessAvailability,
  type CoreLinkHarnessAvailabilityMap,
  type CoreLinkHarnessInstallFailedPayload,
} from "@actana/sdk/core-link-frames.ts";
import type { RegistryPaths } from "./blob-registry.ts";
import type { ActanaCliDeps } from "./cli-deps.ts";
import type { ParsedArgs } from "./cli-args.ts";

/**
 * How long `install` waits for the Core to report an outcome.
 *
 * Generous, because the thing being waited on is a vendor installer pulling a
 * runtime over somebody's home connection, and a deadline shorter than that
 * turns a slow success into a reported failure — the worst answer this command
 * can give. It is still finite: a command that waits forever cannot be put in a
 * script, and "no outcome in fifteen minutes" is itself a fact worth exiting on.
 */
const INSTALL_TIMEOUT_MS = 15 * 60_000;

/** How often the wait says it is still waiting, and re-reads the Core's map. */
const INSTALL_PROGRESS_MS = 10_000;

/** How long a silent Core has before the event subscription is given up on. */
const SUBSCRIBE_ANSWER_MS = 30_000;

/** Where the live harness-install failures are tracked. */
const CANARY_ISSUE = "https://github.com/actana/control/issues/128";

/**
 * Harnesses with a known-open install failure of their own, so a report can
 * link the specific issue rather than only the canary.
 *
 * A map rather than a sentence per Harness: when #31 closes, the line to delete
 * is one entry, and nothing else in this file mentions opencode.
 */
const KNOWN_INSTALL_FAILURES: Record<string, string> = {
  opencode: "https://github.com/actana/control/issues/31",
};

export const HARNESS_HELP = `actana harness — the coding agents a Core can run

Usage
  actana harness ls               what the selected Core has, and what it lacks
  actana harness install <id>     install one on the Core, and wait for the verdict

Flags
  --core <name>   which Core to talk to
  --json          machine-readable output — \`ls\`, and \`install\`'s verdict
  --verbose       explain the steps, on stderr. Never prints a blob.

What install waits for
  The Core acks the request at once and runs the vendor installer behind it, so
  this command waits for the Core to report the outcome — up to ${INSTALL_TIMEOUT_MS / 60_000} minutes.
  It exits 0 only when the Core reports the Harness available on its own PATH:
  an installer that exits 0 and leaves nothing behind is a failed install.

  Harness installation is currently failing on some paths — ${CANARY_ISSUE}.
  A failure here names the Harness and links the issue rather than guessing.`;

/** Dispatch a `harness` verb. `args.positionals` still has `harness` at [0]. */
export async function runHarnessCommand(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
): Promise<number> {
  const [verb, ...rest] = args.positionals.slice(1);

  if (args.help || verb === undefined) {
    deps.out(HARNESS_HELP);
    return verb === undefined && !args.help ? EXIT_USAGE : EXIT_OK;
  }

  switch (verb) {
    case "ls":
    case "list":
      return harnessLs(deps, args, paths);
    case "install":
      return harnessInstall(deps, args, paths, rest);
    default:
      deps.err(`actana harness: unknown verb "${verb}".`);
      deps.err("Verbs: ls, install. `actana harness --help` lists them.");
      return EXIT_USAGE;
  }
}

/** `actana harness ls [--json]` — the Core's availability map, as it last probed. */
async function harnessLs(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
): Promise<number> {
  const opened = await openCore(deps, args, paths, "actana harness ls");
  if (!opened.ok) return opened.code;
  const { client } = opened.core;

  let availability: CoreLinkHarnessAvailabilityMap;
  try {
    availability = await client.agentsAvailabilityList();
  } catch (err) {
    deps.err(`actana harness ls: ${errorText(err)}`);
    return EXIT_FAILURE;
  } finally {
    client.close();
  }

  const rows = harnessRows(availability);

  if (args.json) {
    deps.out(formatJson(rows));
    return EXIT_OK;
  }

  if (rows.length === 0) {
    deps.out("This Core reports no Harnesses — it has no availability probe wired.");
    return EXIT_OK;
  }

  const table = formatTable(
    ["HARNESS", "STATUS", "VERSION", "PATH"],
    rows.map((row) => [row.id, row.status, row.version ?? "", row.path ?? row.reason ?? ""]),
  );
  for (const line of table) deps.out(line);
  return EXIT_OK;
}

/** One row of `harness ls`, in both renderings. Sorted by id, so output is stable. */
function harnessRows(availability: CoreLinkHarnessAvailabilityMap): Array<
  { id: string } & CoreLinkHarnessAvailability
> {
  return Object.entries(availability)
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * `actana harness install <id>` — ask the Core to install one, and wait.
 *
 * The order below is load-bearing. The event subscription goes out *before* the
 * install request, and the replay tail it produces is discarded up to the
 * `eventsReplayed` marker: an install that failed an hour ago is still in the
 * Core's log, and a command that read it as this install's outcome would report
 * a failure that had already happened.
 */
async function harnessInstall(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const [harness, ...extra] = rest;
  if (harness === undefined) {
    deps.err("actana harness install: a Harness id is required —");
    deps.err("  actana harness install <id>");
    deps.err("`actana harness ls` lists the ids this Core knows.");
    return EXIT_USAGE;
  }
  if (extra.length > 0) {
    deps.err(`actana harness install: unexpected argument "${extra[0]}".`);
    deps.err("One Harness per run — the Core installs them one at a time.");
    return EXIT_USAGE;
  }

  const opened = await openCore(deps, args, paths, "actana harness install");
  if (!opened.ok) return opened.code;
  const { client, name: coreName } = opened.core;
  const core = coreName ?? opened.core.endpoint;

  try {
    // Already there? Then there is nothing to install, and saying so is a
    // different answer from having installed it. Exit 0 either way: the
    // operator asked for a Harness to be present on that Core, and it is.
    const before = await client.agentsAvailabilityList();
    if (before[harness]?.status === "available") {
      return reportInstall(deps, args, {
        harness,
        core,
        ok: true,
        alreadyPresent: true,
        entry: before[harness],
      });
    }

    const tip = await establishEventTip(deps, client);
    deps.verbose(`watching the Core's event log past #${tip}`);

    const ack = await sendInstall(client, harness);
    if (!ack.accepted) {
      // A refusal to start: an id this Core cannot install, or a Core with no
      // install path wired. The Core wrote the sentence; it is the operator's.
      return reportInstall(deps, args, {
        harness,
        core,
        ok: false,
        message: ack.message ?? "the Core refused the request and gave no reason",
        refused: true,
      });
    }

    deps.err(`Installing ${harness} on ${core}. The Core is running the vendor installer —`);
    deps.err("this takes minutes, and the verdict is whether it lands on that Core's PATH.");

    const outcome = await awaitInstallOutcome(deps, client, harness, tip);
    return reportInstall(deps, args, { harness, core, ...outcome });
  } catch (err) {
    deps.err(`actana harness install: ${errorText(err)}`);
    return EXIT_FAILURE;
  } finally {
    client.close();
  }
}

/**
 * Subscribe to the event log and return the id everything past which belongs to
 * this command.
 *
 * The Core has no "current tip" frame, so the tip is learned the one way it is
 * published: subscribe, let the tail stream, and read the `eventsReplayed`
 * markers that close it. The tail is discarded rather than read, which buys the
 * guarantee that no earlier install's outcome can be mistaken for this one's.
 *
 * **Markers, plural.** A single one is a receipt for what the Core sent, not a
 * statement about where its log ends — it caps a replay at `EVENT_TAIL_LIMIT`,
 * and a tip taken from a capped marker sits in the middle of the history, with
 * an hour-old `harness:installFailed` above it waiting to be read as this
 * install's verdict. {@link trackEventTip} is that argument in full and owns the
 * asking-again; this holds the deadline around it.
 *
 * The deadline is re-armed on every marker rather than run against the whole
 * hunt: what it exists to catch is a Core that has gone quiet, and a long log is
 * a Core answering — slowly, and correctly.
 *
 * **The cost this pays is a subscribe from `0` on every run**, which drags the
 * Core's whole event log over the wire to learn one number. That is inherent
 * while the tip is only knowable by walking to it: a cursor guessed high stops
 * live push silently (the Core sends only what is past it), and a cursor
 * remembered from a previous run is not this command's tip. What removes it is
 * the true tip travelling on `subscribeAck` beside `fromEventId`, where no
 * client cursor consumes it — a protocol change, and #161 is not where the wire
 * format moves.
 */
function establishEventTip(deps: ActanaCliDeps, client: CoreLinkClient): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const stop = () => {
      settled = true;
      clearTimeout(timer);
      offEvent();
      offReplayed();
    };
    const fail = (message: string) => {
      if (settled) return;
      stop();
      reject(new Error(message));
    };
    const wait = (message: string) => {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(() => fail(message), SUBSCRIBE_ANSWER_MS);
    };

    const tip = trackEventTip(client, deps, {
      onSendFailed: () => fail("the link dropped while reading the Core's event log"),
    });
    const offEvent = client.onEvent(({ event }) => tip.saw(event.eventId));
    const offReplayed = client.onEventsReplayed(({ lastEventId }) => {
      const end = tip.tipFrom(lastEventId);
      if (end === null) {
        wait("the Core stopped answering the event subscription");
        return;
      }
      if (settled) return;
      stop();
      resolve(end);
    });

    wait("the Core did not answer the event subscription");
    if (!client.subscribeEvents(0)) {
      fail("the link dropped before the event subscription went out");
    }
  });
}

/** Send `harnessInstall` and read its ack — a frame with no arm in `unwrapResponse`. */
async function sendInstall(
  client: CoreLinkClient,
  harness: string,
): Promise<{ accepted: boolean; message?: string }> {
  const frame = await client.request({ type: "harnessInstall", reqId: "", harness });
  if (frame.type === "harnessInstallAck") {
    return frame.message === undefined
      ? { accepted: frame.accepted }
      : { accepted: frame.accepted, message: frame.message };
  }
  if (frame.type === "error") throw new Error(frame.message);
  throw new Error(`the Core answered a harnessInstall with a ${frame.type} frame`);
}

/** What one install ended as, before it is rendered. */
type InstallOutcome = {
  ok: boolean;
  message?: string;
  entry?: CoreLinkHarnessAvailability;
  /** True when the deadline ended the wait rather than the Core answering. */
  timedOut?: boolean;
};

/**
 * Wait for the Core's verdict on one install.
 *
 * Three things can end this wait, and all three are the Core's own report:
 * the availability event flipping this Harness to `available`, the
 * `harness:installFailed` event, or a periodic re-read of the availability map
 * agreeing that it is there. The third exists because the first two ride the
 * event log, and a Core with no event log wired would otherwise sit here until
 * the deadline for an install that in fact succeeded — it is a second route to
 * the same fact, never a different definition of success.
 *
 * Progress goes to stderr, unconditionally: it is a diagnostic, and on the
 * `--json` path stdout carries the verdict object and nothing else.
 */
function awaitInstallOutcome(
  deps: ActanaCliDeps,
  client: CoreLinkClient,
  harness: string,
  tip: number,
): Promise<InstallOutcome> {
  return new Promise<InstallOutcome>((resolve) => {
    const startedAt = deps.now();
    let settled = false;

    const finish = (outcome: InstallOutcome) => {
      if (settled) return;
      settled = true;
      clearInterval(ticker);
      clearTimeout(deadline);
      offEvent();
      resolve(outcome);
    };

    const offEvent = client.onEvent(({ event }) => {
      // Past the tip only: everything at or below it happened before this
      // command asked for anything.
      if (event.eventId <= tip) return;
      if (event.kind === HARNESSES_AVAILABILITY_EVENT_KIND) {
        const entry = parseAvailability(event.payload)?.[harness];
        if (entry?.status === "available") finish({ ok: true, entry });
        return;
      }
      if (event.kind === HARNESS_INSTALL_FAILED_EVENT_KIND) {
        const payload = parseInstallFailure(event.payload);
        if (payload?.harness !== harness) return;
        finish({ ok: false, message: payload.message });
      }
    });

    const ticker = setInterval(() => {
      const seconds = Math.round((deps.now() - startedAt) / 1000);
      deps.err(`  still installing ${harness} — ${seconds}s elapsed`);
      // The second route to the same fact. A failure to answer is not a
      // failure of the install: the next tick asks again.
      void client
        .agentsAvailabilityList()
        .then((map) => {
          const entry = map[harness];
          if (entry?.status === "available") finish({ ok: true, entry });
        })
        .catch(() => {});
    }, INSTALL_PROGRESS_MS);

    const deadline = setTimeout(() => {
      finish({
        ok: false,
        timedOut: true,
        message: `the Core reported no outcome within ${INSTALL_TIMEOUT_MS / 60_000} minutes. The install may still be running there.`,
      });
    }, INSTALL_TIMEOUT_MS);
  });
}

function parseAvailability(payload: string): CoreLinkHarnessAvailabilityMap | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed && typeof parsed === "object" ? (parsed as CoreLinkHarnessAvailabilityMap) : null;
  } catch {
    // A payload this build cannot parse is a Core saying something in a shape
    // this one does not know. It is not this install's outcome, so the wait
    // goes on rather than resolving on a guess.
    return null;
  }
}

function parseInstallFailure(payload: string): CoreLinkHarnessInstallFailedPayload | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object") return null;
    const { harness, message } = parsed as Partial<CoreLinkHarnessInstallFailedPayload>;
    if (typeof harness !== "string") return null;
    return { harness, message: typeof message === "string" ? message : "" };
  } catch {
    return null;
  }
}

/** Everything one install run has to say, in both renderings. */
type InstallReport = InstallOutcome & {
  harness: string;
  core: string;
  /** It was already on the Core; nothing was installed. */
  alreadyPresent?: boolean;
  /** The Core declined to start at all. */
  refused?: boolean;
};

/**
 * Render one install's verdict and pick the exit code.
 *
 * The failure branch is where the ticket's instruction lands: name the Harness,
 * say which Core, quote what the Core said, and link the open issue. No branch
 * here can print a success line without `ok` — which is set by the Core
 * reporting the Harness available, and by nothing else.
 */
function reportInstall(deps: ActanaCliDeps, args: ParsedArgs, report: InstallReport): number {
  if (args.json) {
    deps.out(
      formatJson({
        harness: report.harness,
        core: report.core,
        installed: report.ok,
        alreadyPresent: report.alreadyPresent === true,
        accepted: report.refused !== true,
        timedOut: report.timedOut === true,
        status: report.entry?.status ?? null,
        version: report.entry?.version ?? null,
        path: report.entry?.path ?? null,
        message: report.message ?? null,
        issue: report.ok ? null : issueFor(report.harness),
      }),
    );
    return report.ok ? EXIT_OK : EXIT_FAILURE;
  }

  if (report.ok) {
    const where = report.entry?.path ? ` at ${report.entry.path}` : "";
    const version = report.entry?.version ? ` ${report.entry.version}` : "";
    deps.out(
      report.alreadyPresent
        ? `${report.harness}${version} is already on ${report.core}${where}.`
        : `Installed ${report.harness}${version} on ${report.core}${where}.`,
    );
    return EXIT_OK;
  }

  deps.err(`actana harness install: ${report.harness} is not installed on ${report.core}.`);
  if (report.message) deps.err(`  ${report.message}`);
  const specific = KNOWN_INSTALL_FAILURES[report.harness];
  if (specific) {
    deps.err(`  ${report.harness} has an open install-path failure of its own: ${specific}`);
  }
  deps.err(`  Harness installation is failing on this train — ${CANARY_ISSUE}`);
  return EXIT_FAILURE;
}

/** The issue a failed install should be read alongside, most specific first. */
function issueFor(harness: string): string {
  return KNOWN_INSTALL_FAILURES[harness] ?? CANARY_ISSUE;
}
