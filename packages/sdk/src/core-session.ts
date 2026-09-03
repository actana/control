// `CoreSession` — the second level of the SDK: start a Session, let the Core
// deliver the prompt, read the result (#129 D2, D11; issue 155).
//
// The transport level below this one (`CoreLinkTransport` → `CoreClient`) knows
// frames. It will spawn a PTY and hand you `data` frames, and that is as far as
// it goes: a caller wanting a *Session* has to correlate the spawn with its
// byte stream, filter that stream out of every other PTY on the machine, know
// that a harness's output is a screen rather than a log, and know how a Core
// reports that a harness has finished. This is that, once, so a script is four
// calls:
//
//     const client = CoreClient.fromRegistrationBlob(blob);
//     await client.connect();
//     const session = await CoreSession.start(client, {
//       projectId, cwd, harness: "claude-code", prompt: "…",
//     });
//     await session.waitForIdle();
//     console.log(session.screen());
//
// **No TTY, ever (D11).** Nothing here reads `process.stdin`, sets raw mode,
// opens `/dev/tty` or asks whether one exists. Terminal handling belongs to the
// `actana` CLI, which is a different program with a human in front of it; an SDK
// that touched the process's terminal would be unusable from the cron job, the
// CI runner and the web service that are the reason this package exists.
// `send` takes a string and `screen` returns one.
//
// Three things this layer deliberately does NOT do:
//
//   1. **It does not time the prompt.** The starting prompt is handed to the
//      Core as `initialInput` and the Core delivers it on the harness's own
//      schedule — wait for the TUI to stop painting, answer the blocking dialog
//      by its own numbered option, write the text, send the carriage return as a
//      separate keystroke (ADR 0026, #191). There is no delay, no ready-signal
//      and no retry here to disagree with it, which is what makes a Panel, the
//      CLI and this behave identically on a machine none of them is on.
//   2. **It does not pre-empt the Core's spawn policy.** A Session is spawned
//      against a registered Project: the Core checks that the working directory
//      resolves inside a known Project root, that the command's first token is
//      that harness's canonical binary, and that every flag is allow-listed.
//      Those checks read a database and a filesystem on another machine, so a
//      copy of them here would be a guess — and a guess that says no to a spawn
//      the Core would have accepted is worse than the round trip. {@link start}
//      surfaces the rejection.
//   3. **It does not decide what "done" means from the bytes.** Idleness is the
//      Core's report — the harness's own lifecycle hooks moving the Session's
//      status — read off the event log. Watching the stream go quiet is the
//      450 ms timer that #191 deleted, in a new place. (A status read the link
//      lost is asked again, which is a retry of a *question*: it can only ever
//      report what the Core already decided, never decide it here.)

import type {
  CoreLinkEvent,
  CoreLinkPtySpawnHarness,
  CoreLinkSessionSnapshot,
} from "./core-link-frames.ts";
import type { CoreClient } from "./core-client.ts";
import type { CoreLinkDataFrame, CoreLinkExitFrame } from "./core-link-transport.ts";
import { DEFAULT_COLS, DEFAULT_ROWS, TerminalScreen } from "./terminal-screen.ts";

type Unsubscribe = () => void;

/**
 * The command a fresh Session starts with, per harness, when the caller names
 * none.
 *
 * The first token has to be that harness's canonical binary or the Core refuses
 * the spawn — that is the allow-list, and it is enforced there, not here. What
 * this table adds beyond the binary is the one flag a harness needs for the
 * Core to hear about it at all: `codex` reports its lifecycle through hooks only
 * when started with `--enable hooks`, and a Session that never reports is a
 * Session {@link CoreSession.waitForIdle} waits on forever.
 *
 * A caller wanting anything else — a model, a resumed session id — passes
 * `command` and takes the Core's answer on it.
 */
export const HARNESS_LAUNCH_COMMANDS: Readonly<Record<CoreLinkPtySpawnHarness, string>> = {
  "claude-code": "claude",
  codex: "codex --enable hooks",
  "cursor-cli": "cursor-agent",
  opencode: "opencode",
};

/**
 * Each harness's spelling of "do not stop to ask me", appended to the default
 * command when {@link CoreSessionStartOptions.dangerouslySkipPermissions} is
 * set.
 *
 * The option and the flag are two halves of one gesture and the Core checks
 * both **directions** of it (issue 177 finding 2): a flag with no option is a
 * rejected spawn, and since that issue an option with no flag is one too. It
 * used to be neither — the Core accepted the mismatch, launched an interactive
 * harness, and let a caller that believed itself unattended sit on a permission
 * prompt nobody was watching. So this table is not a convenience: it is the
 * only thing standing between `dangerouslySkipPermissions: true` and a refused
 * spawn, for every caller that does not pass its own `command`.
 *
 * OpenCode has no such flag, and `null` says so. That is a fact about the
 * vendor's CLI rather than a gap here, and the Core reads it the same way — it
 * is the one harness where the option is allowed to arrive with no flag behind
 * it, because there is no flag to send.
 *
 * Exported because it is the answer to "what does auto mode look like for this
 * harness", and a caller building its own command needs the same cell of the
 * same table. Two transcriptions of a vendor fact is one more than can be kept
 * in step; finding 1 of the same issue was that mistake in the binary column.
 */
export const HARNESS_SKIP_PERMISSION_FLAGS: Readonly<
  Record<CoreLinkPtySpawnHarness, string | null>
> = {
  "claude-code": "--dangerously-skip-permissions",
  codex: "--yolo",
  "cursor-cli": "--force",
  opencode: null,
};

/** The flag that puts `harness` in auto mode, or null where it ships none. */
export function harnessAutoModeFlag(
  harness: CoreLinkPtySpawnHarness,
): string | null {
  return HARNESS_SKIP_PERMISSION_FLAGS[harness];
}

/**
 * The statuses that mean the harness has stopped and is waiting on a human.
 *
 * `finished` is a completed turn, `needs-input` a permission prompt or a
 * question, `interrupted` an escape, `terminated` a dead process, and
 * `disconnected` a Core that restarted underneath the Session. Every one of them
 * is a state that does not leave on its own, which is the property
 * {@link CoreSession.waitForIdle} is waiting for — not "finished", which would
 * hang on the question a caller could have answered.
 */
export const SETTLED_SESSION_STATUSES: ReadonlySet<string> = new Set([
  "finished",
  "needs-input",
  "interrupted",
  "terminated",
  "disconnected",
]);

/**
 * Event kinds that may carry a status change for a Session.
 *
 * `task:updated` is the general one and says only that the row moved; the status
 * itself is read back off the Core, which owns it. `session:finished` is
 * appended on the transition into `finished` and nowhere else (see the Core's
 * task writer), so it is the one kind whose meaning needs no round trip.
 */
const STATUS_BEARING_EVENT_KINDS: ReadonlySet<string> = new Set([
  "task:updated",
  "task:statusChanged",
  "session:finished",
]);

/**
 * How a failed status read is re-asked: this many further attempts, this long
 * apart.
 *
 * A retry of a *read*, and only of a read. It re-asks the Core a question whose
 * answer the Core already settled on — it does not retry a prompt, a keystroke
 * or a spawn, and it cannot make a Session look idle sooner than the Core says
 * it is. The reason it has to exist: `needs-input`, `interrupted` and
 * `terminated` reach this layer only as `task:updated`, and that event is
 * appended once. Swallowing the read that failed on it leaves
 * {@link CoreSession.waitForIdle} waiting for a report that will not be made
 * again, and by design there is no deadline to end that wait.
 *
 * Bounded rather than indefinite: a link that is still down after three tries a
 * quarter-second apart is not going to be talked round by a fourth, and a
 * Session that polls forever is the busy-loop version of the timer #191 deleted.
 */
export const STATUS_READ_RETRIES = 3;
export const STATUS_READ_RETRY_MS = 250;

/**
 * How long a wait goes on waiting after the link to the Core drops, before it
 * gives up and says the turn's outcome is unknown (#396).
 *
 * A drop is not a verdict, and the reason there is a grace at all is that on a
 * client that reconnects it is usually not even an interruption: the link comes
 * back, the client re-subscribes from its cursor, and the Core streams the tail
 * it missed — including the status change that ends this wait. Failing on the
 * first blip would report a turn as unobservable while it was being observed
 * again.
 *
 * Thirty seconds because that is several of `DurableCoreClient`'s
 * reconnects: its backoff runs 500 ms, 1 s, 2 s, 4 s and then every 5 s, so a
 * link that is coming back has had six or more attempts by the time this fires.
 * A link that has not come back by then is not a blip, and the wait behind it
 * has nothing left to hear.
 *
 * **It is a grace, not a deadline.** It only ever runs while the link is down,
 * it is cancelled the moment the link returns, and it is not what
 * {@link CoreSessionWaitOptions.timeoutMs} is — a caller that passed no deadline
 * still has none while the Core is reachable.
 *
 * Zero, which {@link CoreSession.start} and {@link CoreSession.attach} use for a
 * client that does not reconnect, means the wait fails the instant the link
 * drops: there is no coming back to wait for.
 */
export const CORE_LINK_LOST_GRACE_MS = 30_000;

export type CoreSessionStartOptions = {
  /**
   * The Project to start this Session in. Either this or {@link taskId}: with a
   * `projectId` a Task row is created on the Core first, because a Session's
   * status lives on that row and a spawn naming a row that does not exist
   * reports nothing back.
   */
  projectId?: string;
  /** An existing Task to start a Session for. Either this or {@link projectId}. */
  taskId?: string;
  /** Title for the Task created from {@link projectId}. Ignored with a `taskId`. */
  title?: string;
  /**
   * The working directory on the **Core's** machine.
   *
   * A machine path, validatable only there: the Core resolves it through
   * `realpath` and refuses it unless it lands inside a registered Project root.
   * Nothing here checks it — this process may not even be on that machine — so a
   * bad path comes back as a rejected {@link start}, which is the design.
   */
  cwd: string;
  /** Which harness to run. */
  harness: CoreLinkPtySpawnHarness;
  /**
   * The starting prompt, handed to the Core as `initialInput`.
   *
   * Text, and no timing with it. The Core waits for the harness's TUI to settle,
   * answers whatever dialog it opened, writes this, and sends the carriage
   * return separately (ADR 0026). Omit it to start a Session with no prompt and
   * drive it with {@link CoreSession.send}.
   */
  prompt?: string;
  /**
   * Override the launch command. Defaults to {@link HARNESS_LAUNCH_COMMANDS}.
   * The Core allow-lists the binary and every flag; a command it does not accept
   * rejects the spawn rather than being trimmed here.
   */
  command?: string;
  /** PTY width. The screen is built at the same size, or the two disagree about wrapping. */
  cols?: number;
  /** PTY height. Same. */
  rows?: number;
  /** How many scrolled-off lines {@link CoreSession.screen} keeps. */
  scrollback?: number;
  /** Start the harness with permission prompts disabled. See {@link HARNESS_SKIP_PERMISSION_FLAGS}. */
  dangerouslySkipPermissions?: boolean;
  /** The Core's theme hint for the harness, so its output matches a Panel's. */
  theme?: "dark" | "light";
  /**
   * Subscribe this client to the Core's event log if nothing has yet, so
   * {@link CoreSession.waitForIdle} and {@link CoreSession.onStatus} have
   * something to work from. Default true.
   *
   * Set it false when the events are already arriving by another route and the
   * replay tail is not wanted — a {@link DurableCoreClient} subscribes itself,
   * and this checks before sending anything, so the flag is for the case where a
   * caller is doing something the check cannot see.
   */
  subscribeToEvents?: boolean;
  /**
   * How long a wait on this Session keeps waiting after the link to the Core
   * drops, before it fails with {@link CoreSessionLinkLostError} (#396).
   *
   * Defaults to {@link CORE_LINK_LOST_GRACE_MS} on a client that reconnects and
   * to **0** on one that does not, because on the second kind there is nothing
   * to wait for. 0 fails the wait the instant the link goes down.
   */
  linkLostGraceMs?: number;
};

export type CoreSessionAttachOptions = {
  /** The Session to join. It must have a live PTY; see {@link CoreSessionAttachError}. */
  taskId: string;
  /** Screen width for the transcript this attachment renders. */
  cols?: number;
  /** Screen height. Same. */
  rows?: number;
  /** How many scrolled-off lines {@link CoreSession.screen} keeps. */
  scrollback?: number;
  /** As {@link CoreSessionStartOptions.subscribeToEvents}. Default true. */
  subscribeToEvents?: boolean;
  /**
   * Paint the Core's replay ring into the screen before returning. Default true.
   *
   * On by default because a caller that attaches to read a turn wants the
   * conversation it lands in the middle of, not the tail of one turn — and the
   * ring belongs to the PTY, so it is readable now and gone when the harness
   * exits. Off is for a caller that wants only what this attachment saw.
   *
   * **It does not turn the PTY subscription off**, which is a separate thing and
   * is unconditional: without one, `onData` and `onExit` never fire against a
   * multi-connection Core, and an attachment that could not hear an exit is one
   * whose wait outlives the process it is about.
   */
  replay?: boolean;
  /** As {@link CoreSessionStartOptions.linkLostGraceMs}. */
  linkLostGraceMs?: number;
};

/** What a Session settled on. */
export type CoreSessionIdle = {
  /** The Core's status for this Session — one of {@link SETTLED_SESSION_STATUSES}. */
  status: string;
  /** True when the harness's process exited rather than settling on a status. */
  exited: boolean;
  /** The process's exit code, when it exited. */
  exitCode?: number;
};

export type CoreSessionWaitOptions = {
  /**
   * Give up after this long, in ms. **No deadline by default**, and that is not
   * an oversight: a turn takes as long as the work takes, and a default that
   * fires would report a healthy Session as broken — the same lie the flat
   * timer #191 deleted used to tell. A caller that needs a deadline knows what
   * its own is.
   */
  timeoutMs?: number;
};

export type CoreSessionTurnWaitOptions = CoreSessionWaitOptions & {
  /**
   * Only a settling status learned at an event id **strictly greater** than this
   * one ends the wait — the id the Core stamped a delivery with
   * ({@link CoreSession.deliver}).
   *
   * 0, the default, is no cursor: any settled status the Session is known to be
   * in ends the wait, which is what {@link CoreSession.waitForIdle} has always
   * done.
   */
  afterEventId?: number;
};

/** The Core refused to start this Session. Carries the Core's own reason. */
export class CoreSessionStartError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CoreSessionStartError";
  }
}

/**
 * There is nothing running to attach to.
 *
 * Its own kind because it is the one failure an attach has that a start does
 * not, and because the alternative is worse than an error: a wait against a
 * Session whose harness has already exited has nothing that will ever report a
 * turn, so it would hang until the caller's deadline and then blame the Core.
 */
export class CoreSessionAttachError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CoreSessionAttachError";
  }
}

/**
 * A wait gave up on the deadline its caller set (#405).
 *
 * Its own kind because the two ways a wait can run out are two different next
 * steps for the operator, and a bare `Error` flattens them. The fields say
 * which one this is without parsing the message: `reportedSinceDelivery` is
 * `false` when the Core said **nothing at all** about this Session after the
 * delivery this wait counts from — no turn ended, and no turn was seen to
 * start. That is what a carriage return landing on a dialog rather than a
 * composer looks like from here.
 *
 * It is still *this side giving up*, never a status (ADR 0033 D4, D5). Nothing here
 * infers a turn from the byte stream, and a Session that ran the deadline out is
 * still running on the Core: `session logs`, another `session wait` and
 * `session kill` all still work.
 */
export class CoreSessionTurnTimeoutError extends Error {
  /** The Session the wait was about. */
  readonly taskId: string;
  /** The deadline that expired, in ms — the caller's own, never a default here. */
  readonly timeoutMs: number;
  /** The delivery stamp this wait counted from, or 0 for an uncursored wait. */
  readonly afterEventId: number;
  /** The last status the Core reported, or null when it has reported none. */
  readonly lastStatus: string | null;
  /**
   * Did the Core report a status for this Session **at an event id above**
   * `afterEventId`?
   *
   * False is the loud half of the seeded-status invariant: a status seeded from
   * the Task row carries event id 0 and can never satisfy a real cursor, so a
   * wait against a Session that is parked and reports nothing would otherwise
   * sit on that comparison forever. It is a fact off the event log — the id the
   * last status was learned at, against the id the delivery was stamped with —
   * and not an inference from the screen.
   *
   * **Read the name literally: it is about event ids, not about the Core having
   * been silent** (#486 review). Only a status carried *by* an event moves
   * `lastStatusEventId` — a `session:finished`, or a `task:updated` that names
   * the status it patched. A status this Session learned by *asking*
   * (`readStatus`, after an event that named none) is recorded with event id 0
   * on purpose, because a read answers "what is it now" and a wait is asking
   * "what happened after event N". So `false` means no turn end was *reported
   * in the log* after the cursor. That is exactly the right thing to gate a wait
   * on, and it is weaker than "the Core said nothing" for a caller branching on
   * it.
   */
  readonly reportedSinceDelivery: boolean;

  constructor(opts: {
    taskId: string;
    timeoutMs: number;
    afterEventId: number;
    lastStatus: string | null;
    reportedSinceDelivery: boolean;
  }) {
    super(turnTimeoutMessage(opts));
    this.name = "CoreSessionTurnTimeoutError";
    this.taskId = opts.taskId;
    this.timeoutMs = opts.timeoutMs;
    this.afterEventId = opts.afterEventId;
    this.lastStatus = opts.lastStatus;
    this.reportedSinceDelivery = opts.reportedSinceDelivery;
  }
}

/**
 * What {@link CoreSessionTurnTimeoutError} says, and why there are two of them.
 *
 * A wait that heard a status after its cursor and gave up anyway was waiting on
 * a harness that is *working*, and "still finished" is the honest report — the
 * wording every deadline has used since #289. A wait that heard nothing was
 * waiting on a turn whose end was never reported, and telling that operator the
 * Session is "still finished" points them at a slow harness when the answer may
 * be that their carriage return was eaten.
 *
 * **It names both readings and picks neither** (#486 review). `codex` and
 * `cursor-cli` report nothing between a turn's start and its end, so an ordinary
 * turn that outruns the caller's deadline produces this same silence on a
 * harness that is working perfectly. Choosing between the two would mean either
 * consulting `reportsTurnStart` — which no wait may do (ADR 0033 D2) — or
 * reading the byte stream, which #191 deleted. The sentence says what is true of
 * both and sends the reader to the screen, which is the only place the
 * difference is visible.
 *
 * What is **not** here is what to type next. This is a library: the caller knows
 * whether its user has an `actana` on their path, and the CLI adds that line
 * itself from the fields above.
 */
function turnTimeoutMessage(opts: {
  taskId: string;
  timeoutMs: number;
  afterEventId: number;
  lastStatus: string | null;
  reportedSinceDelivery: boolean;
}): string {
  if (opts.afterEventId > 0 && !opts.reportedSinceDelivery) {
    return (
      `session ${opts.taskId} took the text, but no turn end was reported for it in the ` +
      `${opts.timeoutMs}ms after the delivery stamped at event ${opts.afterEventId}. Either the ` +
      `text started no turn — a carriage return that lands on a dialog rather than a composer ` +
      `submits nothing — or a turn is still running on a harness that reports nothing until it ` +
      `ends, and this side cannot tell those apart. Read the screen to see which. The text was ` +
      `delivered either way, so it must not be sent again`
    );
  }
  return `session ${opts.taskId} was still ${opts.lastStatus ?? "unreported"} after ${opts.timeoutMs}ms`;
}

/**
 * The link to the Core went down while a wait was running, and did not come
 * back (#396).
 *
 * **Its whole reason for existing is that it is not a status.** A wait had three
 * ways to end before this: a settled status, which is the Core reporting a turn
 * ended; a deadline ({@link CoreSessionTurnTimeoutError}), which is this side
 * giving up on a clock it set itself; and — for a link that dropped — nothing at
 * all, which is the bug. The obvious cheap fix is the forbidden one: resolving
 * the wait with whatever status the Session was last seen at would report a turn
 * as ended on the evidence that this side stopped listening. That is a false
 * completion, which is the exact failure ADR 0033 exists to remove, so a lost
 * link rejects and says what it actually knows — **the outcome is unknown**.
 *
 * Distinguishable from both of the other two endings by class, so a caller
 * branches without parsing prose: a resolution is a turn that ended, a
 * {@link CoreSessionTurnTimeoutError} is a deadline the caller set, and this is
 * the link.
 *
 * Nothing here reads the byte stream and nothing here consults
 * `reportsTurnStart` (ADR 0026 D3, ADR 0033 D2). The only facts it carries are
 * the link going down and two event ids.
 *
 * The Session is untouched by any of this. It is running on the Core, which is
 * where its status lives; reconnecting and asking is what answers the question
 * this error leaves open.
 */
export class CoreSessionLinkLostError extends Error {
  /** The Session the wait was about. */
  readonly taskId: string;
  /** The delivery stamp this wait counted from, or 0 for an uncursored wait. */
  readonly afterEventId: number;
  /**
   * The last status the Core reported before the link went, or null when it had
   * reported none.
   *
   * **Context, never the answer.** It is what was true before the drop, and a
   * caller that presents it as the turn's outcome has written the false
   * completion this class exists to prevent.
   */
  readonly lastStatus: string | null;
  /**
   * Did the Core report a status for this Session at an event id above
   * {@link afterEventId} before the link went?
   *
   * Read exactly as its twin on {@link CoreSessionTurnTimeoutError} is read: two
   * event ids compared, and only a status carried *by* an event moves the id it
   * is compared against. `true` here is informative rather than settling — a
   * settling status would have ended the wait, so what it reports is a turn that
   * was seen to be *under way* when the link died. `false` means the log said
   * nothing about this Session after the cursor.
   */
  readonly reportedSinceDelivery: boolean;
  /** How long the wait went on for after the drop before giving up, in ms. */
  readonly graceMs: number;
  /** What the transport said about the drop, when it said anything. */
  readonly reason: string | null;

  constructor(opts: {
    taskId: string;
    afterEventId: number;
    lastStatus: string | null;
    reportedSinceDelivery: boolean;
    graceMs: number;
    reason: string | null;
  }) {
    super(linkLostMessage(opts));
    this.name = "CoreSessionLinkLostError";
    this.taskId = opts.taskId;
    this.afterEventId = opts.afterEventId;
    this.lastStatus = opts.lastStatus;
    this.reportedSinceDelivery = opts.reportedSinceDelivery;
    this.graceMs = opts.graceMs;
    this.reason = opts.reason;
  }
}

/**
 * What {@link CoreSessionLinkLostError} says.
 *
 * One sentence for the fact — the link dropped and stayed down — and one for the
 * consequence, which is the part that has to be unambiguous: the turn's outcome
 * is **unknown**. It deliberately names both readings and settles neither, for
 * the same reason the timeout's message does: the turn may have ended in the
 * silence and it may still be running, and the only place that is known is the
 * Core this side can no longer hear.
 *
 * What is **not** here is what to type next. This is a library; the CLI knows
 * whether its user has an `actana` on their path and adds that line itself.
 */
function linkLostMessage(opts: {
  taskId: string;
  lastStatus: string | null;
  graceMs: number;
  reason: string | null;
}): string {
  const stayedDown =
    opts.graceMs > 0
      ? `and was still down ${opts.graceMs}ms later`
      : "and this client does not reconnect";
  const because = opts.reason ? ` (${opts.reason})` : "";
  return (
    `the link to the Core dropped while waiting for session ${opts.taskId} to end a turn${because}, ` +
    `${stayedDown}. The turn's outcome is unknown: it may have ended while this side was deaf, and ` +
    `it may still be running — the Core is where that is known, and nothing here can stand in for ` +
    `it. This is not a report that the turn finished` +
    (opts.lastStatus
      ? `; ${opts.lastStatus} is only what the Core last said before the link went`
      : "")
  );
}

/**
 * One Session on one Core, driven programmatically.
 *
 * Built by {@link start}. Holds a screen fed from the Session's PTY, the Core's
 * last reported status for it, and the listeners that keep both current — so
 * it must be released with {@link dispose} (or {@link kill}, which disposes)
 * when the caller is done, or those listeners outlive it on the client.
 */
export class CoreSession {
  /** The Task this Session belongs to. Its status is the Session's status. */
  readonly taskId: string;
  /** The Core's id for this Session's PTY. */
  readonly ptyId: string;
  /**
   * The harness running in it, or `null` on a Session this process did not
   * start — {@link attach} joins a PTY that is already running, and the Core
   * publishes no harness for one. A caller that needs the name reads it off the
   * Task row, which is where it lives.
   */
  readonly harness: CoreLinkPtySpawnHarness | null;
  /**
   * The command the Core was asked to start, after defaulting, or `null` on an
   * {@link attach} — the command was decided by whoever spawned the PTY and the
   * Core does not publish it afterwards. Null is "this side does not know",
   * never "there was none".
   */
  readonly command: string | null;
  /**
   * Will anything move this Session to `running` when a turn begins (issue 84,
   * issue 177 finding 4)?
   *
   * The Core's answer for this Session and not a property of the harness
   * family: it depends on which hooks actually landed on that machine and on
   * whether the vendor fires them. `false` today for `cursor-cli` — the Core
   * writes `.cursor/hooks.json` and cursor-agent never fires
   * `beforeSubmitPrompt` — and for `codex` until an operator reviews the newly
   * installed hooks with `/hooks`. Both still report a turn's *end*.
   *
   * What that means for a caller: {@link waitForIdle} is unaffected, because it
   * waits for a settled status and turn *end* is reported. What is missing is
   * everything in between. A Session with `reportsTurnStart === false` will sit
   * at its pre-turn status for the whole of a turn that is genuinely running,
   * which is indistinguishable from a Session that never started — so a caller
   * that shows progress, or that treats "not running" as "stuck", has to read
   * this and say so rather than infer activity from a status that will not
   * move. The Panel's answer is a terminal-input fallback; the `actana` CLI's
   * is to print the asymmetry.
   *
   * `false` on a Core too old to answer, which is the safe direction: a
   * redundant caveat, never a silently statusless Session.
   *
   * `null` on an {@link attach}, which is a different thing again: the Core
   * answers this question on a **spawn**, so a Session joined after the fact has
   * no answer rather than a negative one. **No wait consults this field** (#289
   * A) — turn *end* is reported by every harness family, and that is what every
   * wait here is waiting for.
   */
  readonly reportsTurnStart: boolean | null;

  private readonly client: CoreClient;
  private readonly terminal: TerminalScreen;
  private readonly unsubscribes: Unsubscribe[] = [];

  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly exitListeners = new Set<(exit: { exitCode: number; signal?: number }) => void>();
  private readonly statusListeners = new Set<(status: string) => void>();
  /**
   * Everyone waiting for a turn to end, each with the event id it counts from.
   * A waiter with `afterEventId: 0` takes any settled status; one carrying a
   * delivery stamp takes only a status learned after it.
   */
  private readonly idleWaiters = new Set<{
    afterEventId: number;
    notify: (idle: CoreSessionIdle) => void;
    /**
     * End this wait with a failure rather than an outcome — the route a lost
     * link takes (#396), and the only one that can say "unknown".
     */
    fail: (err: Error) => void;
  }>();

  /**
   * This Session asked the Core for its PTY's stream, so {@link dispose} owes it
   * a matching `ptyUnsubscribe`. False for a spawned Session: the Core
   * subscribes the connection that spawned a PTY, inside the spawn, and nothing
   * here asked for that.
   */
  private subscribedToPty = false;

  /**
   * The Core's last reported status, or null before one has been *observed*.
   *
   * Null rather than the status the Task carried when this Session started, and
   * the distinction is what makes {@link waitForIdle} correct: a caller starting
   * a Session on a Task that was already `finished` is waiting for the next turn
   * to end, not being told about the last one. Only a status learned from an
   * event after {@link start} lands here.
   */
  private lastStatus: string | null = null;
  /**
   * The event id {@link lastStatus} was learned at, or 0 when it was not learned
   * from an event — the status {@link attach} seeded from the Task row.
   *
   * This is what makes a cursored wait possible (#289 A). "Has this Session
   * settled?" answers with whatever it is sitting at, including last turn's
   * answer; "has this Session settled **since event N**?" is the question a
   * caller that just delivered a prompt is actually asking, and it needs a
   * *where* as well as a *what*. A seeded status carries 0 on purpose: 0 is
   * greater than nothing, so it can never satisfy a real cursor.
   */
  private lastStatusEventId = 0;
  /**
   * How long a wait on this Session survives a dropped link before it fails —
   * {@link CORE_LINK_LOST_GRACE_MS}, 0 on a client that will not reconnect, or
   * whatever the caller asked for.
   */
  private readonly linkLostGraceMs: number;
  /** True between the link going down and it coming back. */
  private linkDown = false;
  /** What the transport said about the current drop, when it said anything. */
  private linkLostReason: string | null = null;
  /** The grace running against the current drop, armed only while one is. */
  private linkLostTimer: ReturnType<typeof setTimeout> | null = null;
  private exit: { exitCode: number; signal?: number } | null = null;
  private disposed = false;
  /** A status read is in flight; another event arrived while it was. */
  private statusReadInFlight = false;
  private statusReadAgain = false;
  /** Re-asks left for the read that failed, and the timer carrying the next. */
  private statusReadRetriesLeft = STATUS_READ_RETRIES;
  private statusRetryTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(opts: {
    client: CoreClient;
    taskId: string;
    ptyId: string;
    harness: CoreLinkPtySpawnHarness | null;
    command: string | null;
    reportsTurnStart: boolean | null;
    terminal: TerminalScreen;
    linkLostGraceMs: number;
  }) {
    this.client = opts.client;
    this.taskId = opts.taskId;
    this.ptyId = opts.ptyId;
    this.harness = opts.harness;
    this.command = opts.command;
    this.reportsTurnStart = opts.reportsTurnStart;
    this.terminal = opts.terminal;
    this.linkLostGraceMs = Math.max(0, opts.linkLostGraceMs);
  }

  /**
   * Start a Session and return once the Core has one running.
   *
   * What happens, in order: a Task row is created when the caller named a
   * Project rather than a Task; the client is subscribed to the Core's event log
   * if nothing has done that yet; the PTY's byte stream is wired up *before* the
   * spawn goes out; and the spawn carries the prompt as `initialInput` for the
   * Core to deliver.
   *
   * The stream is wired first on purpose. A harness starts printing its banner
   * immediately, and on a Core that fans output out by subscription the
   * connection that spawned a PTY is subscribed to it before the answer is even
   * written — so the first bytes can be on the wire before this side knows the
   * PTY's id. They are held and replayed into the screen once it is known, which
   * is the difference between a transcript that starts at the beginning and one
   * that starts wherever the round trip happened to end.
   *
   * Rejects with the Core's own message when the Core refuses: a working
   * directory outside every registered Project root, a command whose binary is
   * not that harness's, a flag that is not allow-listed, a harness that is not
   * installed on that machine.
   */
  static async start(client: CoreClient, opts: CoreSessionStartOptions): Promise<CoreSession> {
    if (!opts.taskId && !opts.projectId) {
      throw new CoreSessionStartError(
        "CoreSession.start needs a taskId or a projectId to start a Session against",
      );
    }
    const cols = opts.cols ?? DEFAULT_COLS;
    const rows = opts.rows ?? DEFAULT_ROWS;
    const command =
      opts.command ??
      harnessLaunchCommand(opts.harness, opts.dangerouslySkipPermissions === true);

    // The event log first: a subscribe sent after the spawn could miss the
    // status change of a harness that answered before this side asked.
    if (opts.subscribeToEvents !== false && !client.isSubscribedToEvents()) {
      client.subscribeEvents();
    }

    const taskId = opts.taskId ?? (await createTask(client, opts));

    // Held until the spawn answers with the id these belong to. Every PTY on a
    // single-connection Core arrives on this listener, so nothing can be routed
    // by anything but the id, and the id is what has not come back yet.
    const held: CoreLinkDataFrame[] = [];
    const heldEvents: CoreLinkEvent[] = [];
    const heldExits: CoreLinkExitFrame[] = [];
    let ptyId: string | null = null;
    const terminal = new TerminalScreen({ cols, rows, scrollback: opts.scrollback });
    let session: CoreSession | null = null;

    const stopData = client.onData((frame) => {
      if (ptyId === null) {
        held.push(frame);
        return;
      }
      if (frame.ptyId !== ptyId) return;
      session?.ingest(frame.data);
    });
    const stopExit = client.onExit((frame) => {
      if (ptyId === null) {
        // Every exit, not the first: this listener hears the whole Core, so a
        // co-tenant PTY exiting inside the spawn's round trip would otherwise
        // take the one slot and this Session's own exit frame would be dropped
        // — `onExit` silent, and `waitForIdle` short an exit route. Held like
        // the bytes above and filtered by id for the same reason.
        heldExits.push(frame);
        return;
      }
      if (frame.ptyId !== ptyId) return;
      session?.ingestExit(frame);
    });
    // Held for the same reason the bytes are, and with a sharper consequence:
    // a status change is not a stream, and the one event saying the harness
    // finished is the only one that will ever say it. Dropped in the window
    // between the spawn going out and its answer landing, `waitForIdle` waits
    // for a report that has already been made.
    const stopEvents = client.onEvent(({ event }) => {
      if (session === null) {
        heldEvents.push(event);
        return;
      }
      session.onCoreEvent(event);
    });
    // The link itself, because a wait that cannot hear the Core is a wait
    // nothing will ever end (#396). Not held like the three above: a drop before
    // the spawn is answered fails the spawn, which is the `catch` below.
    const stopDown = client.onDisconnected(({ error }) => session?.onLinkLost(error));
    const stopUp = client.onReady(() => session?.onLinkBack());

    let spawned: { ptyId: string; hooksReportTurnStart: boolean };
    try {
      spawned = await client.spawn({
        taskId,
        cwd: opts.cwd,
        command,
        agent: opts.harness,
        cols,
        rows,
        ...(opts.dangerouslySkipPermissions === true
          ? { dangerouslySkipPermissions: true }
          : {}),
        ...(opts.theme ? { missionControlTheme: opts.theme } : {}),
        // Text, and no timing with it. See this module's header.
        ...(opts.prompt === undefined ? {} : { initialInput: opts.prompt }),
      });
    } catch (err) {
      stopData();
      stopExit();
      stopEvents();
      stopDown();
      stopUp();
      throw new CoreSessionStartError(
        `the Core refused to start a ${opts.harness} Session in ${opts.cwd}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }

    ptyId = spawned.ptyId;
    session = new CoreSession({
      client,
      taskId,
      ptyId: spawned.ptyId,
      harness: opts.harness,
      command,
      reportsTurnStart: spawned.hooksReportTurnStart,
      terminal,
      linkLostGraceMs: linkLostGraceFor(client, opts.linkLostGraceMs),
    });
    session.unsubscribes.push(stopData, stopExit, stopEvents, stopDown, stopUp);

    for (const event of heldEvents) session.onCoreEvent(event);
    for (const frame of held) {
      if (frame.ptyId === ptyId) session.ingest(frame.data);
    }
    const mineExit = heldExits.find((frame) => frame.ptyId === ptyId);
    if (mineExit) session.ingestExit(mineExit);

    return session;
  }

  /**
   * Join a Session that is **already running**, for the length of a turn (#289).
   *
   * The gap this closes: {@link start} is the only way into a `CoreSession`, and
   * it spawns. Everything this class offers a caller after the first turn — the
   * screen, the status, the wait — was unreachable for a Session somebody else
   * started, or that this process started and hung up on. Awaiting a follow-up
   * turn is therefore SDK work rather than a flag on a command, and this is it.
   *
   * What it does, in order, and the order is the point:
   *
   *   1. subscribe to the event log, if nothing has, so a status change that
   *      lands during the rest of this is heard rather than missed;
   *   2. resolve the Task's live PTY — **once**, and every write and wait made
   *      through the returned Session uses that resolution, so there is no
   *      window between delivering text and starting to wait for it;
   *   3. wire the byte stream, the exit and the events **before** subscribing;
   *   4. subscribe to that PTY, which is what makes the Core send this
   *      connection its bytes and its exit at all;
   *   5. seed the screen from the Core's replay ring, and the last known status
   *      from the Session snapshot.
   *
   * **The seeded status carries event id 0**, which is what keeps it honest.
   * `waitForIdle` will answer from it — that is `actana session wait` on a
   * Session already sitting at `needs-input`, and answering immediately is
   * right, because no turn was asked for. {@link waitForTurnEnd} with a delivery
   * stamp will not: 0 can never be greater than a real cursor, so a wait for the
   * turn a write starts cannot be answered by the turn before it.
   *
   * Rejects with {@link CoreSessionAttachError} when the Task has no live PTY —
   * a harness that exited, or a Session id that is not one. **Only that.** A
   * link that blinked during the subscribe, the replay or the status read
   * rejects with an ordinary `Error`: the two are different next steps, and
   * reporting a busy Core as a dead harness sends a caller to `resume` for a
   * Session that is running perfectly well.
   */
  static async attach(client: CoreClient, opts: CoreSessionAttachOptions): Promise<CoreSession> {
    if (opts.subscribeToEvents !== false && !client.isSubscribedToEvents()) {
      client.subscribeEvents();
    }

    const { ptyId } = await client.findByTask(opts.taskId);
    if (ptyId === null) {
      throw new CoreSessionAttachError(
        `session ${opts.taskId} has no harness running — there is nothing to attach a wait to`,
      );
    }

    const cols = opts.cols ?? DEFAULT_COLS;
    const rows = opts.rows ?? DEFAULT_ROWS;
    const terminal = new TerminalScreen({ cols, rows, scrollback: opts.scrollback });
    const session = new CoreSession({
      client,
      taskId: opts.taskId,
      ptyId,
      // Three facts about a spawn, and this is not one. The Task row carries the
      // harness for a caller that needs the name; the command and the turn-start
      // answer were the Core's answer to a `spawn` frame that happened before
      // this process was involved, and inventing either would be worse than null.
      harness: null,
      command: null,
      reportsTurnStart: null,
      terminal,
      linkLostGraceMs: linkLostGraceFor(client, opts.linkLostGraceMs),
    });

    session.unsubscribes.push(
      client.onData((frame) => {
        if (frame.ptyId === ptyId) session.ingest(frame.data);
      }),
      client.onExit((frame) => {
        if (frame.ptyId === ptyId) session.ingestExit(frame);
      }),
      client.onEvent(({ event }) => session.onCoreEvent(event)),
      // The link, for the same reason `start` wires it: an attached wait is the
      // one `session wait` and `send --wait` are built on, and a dropped link
      // used to leave it pending with nothing left that could ever end it
      // (#396).
      client.onDisconnected(({ error }) => session.onLinkLost(error)),
      client.onReady(() => session.onLinkBack()),
    );

    const replay = opts.replay !== false;
    try {
      // **The subscribe is not part of the replay.** Until a connection
      // subscribes, a multi-connection Core fans this PTY's output to somebody
      // else and `onData` / `onExit` never fire here — so an attachment that
      // skipped it would have an empty screen *and* a dead exit route, and the
      // "an exit answers every wait" case in `settledSince` would never run. A
      // caller that turns the replay off wants to skip the scrollback, not to
      // be deaf.
      //
      // `catchUp` says a replay follows and the Core must hold the live stream
      // until it has been served; it is set exactly when one does, because a
      // hold nobody redeems strands the Session's output on the Core.
      await client.ptySubscribe(ptyId, { catchUp: replay });
      // Recorded the moment it is owed, not once the rest succeeded: a replay
      // that throws still leaves this connection subscribed, and the `dispose`
      // in the catch below is the only thing that will ever give it back.
      session.subscribedToPty = true;
      if (replay) {
        const { data } = await client.replay(ptyId);
        terminal.write(data);
      }
      await session.seedStatus();
    } catch (err) {
      session.dispose();
      // **Only "nothing is running" is an attach error.** A link that blinked
      // during the subscribe, the replay or the status read is a retry, and
      // reporting it as a harness that has exited sends the operator to
      // `resume` for a Session that is running perfectly well. The one genuine
      // case was decided above, before any of this ran.
      if (err instanceof CoreSessionAttachError) throw err;
      throw new Error(
        `could not attach to session ${opts.taskId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }

    return session;
  }

  // ─── Programmatic I/O ──────────────────────────────────────────────────────

  /**
   * Write to the Session, exactly these bytes and nothing else.
   *
   * The equivalent of typing, not of prompting. Nothing is appended: no carriage
   * return, no delay, no waiting for the harness to look ready. That restraint
   * is the rule rather than a gap — a client that decided when to press Enter
   * would be doing prompt delivery, which is the Core's (ADR 0026), and would do
   * it differently from every other client. A *starting* prompt goes through
   * {@link CoreSessionStartOptions.prompt}, where the Core owns the schedule.
   *
   * What this is for is everything after: answering the numbered option of a
   * question the harness asked (`send("2")` then `send("\r")`), an escape
   * (`send("\u001B")`), a follow-up typed into a harness already at its prompt.
   *
   * **A follow-up that is meant to start a turn needs the return, and it is the
   * caller who writes it** — `send(text)` then `send("\r")`, two writes, never
   * `send(text + "\r")`. A harness that treats a paste as one unit swallows a
   * glued return with the characters and starts nothing. This is the primitive
   * `actana session send` is built on, and since #404 that command writes the
   * second call by default rather than only under `--enter`: the default moved
   * in the CLI, where a verb means "send a message", and not here, where the
   * method means "type these bytes" and is what the Panel and every other
   * client type through.
   *
   * Resolves false when the Core did not accept the write — a PTY that has
   * exited. Rejects when another Core client holds this Session's lock.
   */
  send(text: string): Promise<boolean> {
    return this.client.write(this.ptyId, text);
  }

  /**
   * {@link send}, with the Core stamping the delivery in its event log and
   * answering with the id — the cursor {@link waitForTurnEnd} counts from
   * (#289 A).
   *
   * Exactly the same bytes and exactly as little timing as `send`: the stamp is
   * a fact recorded about a write that already happened, not a schedule imposed
   * on one. A caller wanting to await the turn its text starts writes with this
   * and waits from what it returns, and the two are one round trip apart with no
   * window between them in which the Session could settle unobserved.
   *
   * `deliveryEventId` is 0 when the Core did not stamp — a write the PTY
   * refused, a Core that predates the stamp, a PTY with no Task behind it. 0 is
   * not a cursor: a caller that waits from it is waiting with none.
   */
  deliver(text: string): Promise<{ ok: boolean; deliveryEventId: number }> {
    return this.client.deliver(this.ptyId, text);
  }

  /**
   * Every chunk of this Session's output, as it arrives.
   *
   * Raw PTY bytes, escape sequences included — the same stream the screen is
   * built from. A caller wanting the rendered text wants {@link screen}; this is
   * for one that is streaming somewhere else.
   */
  onData(cb: (chunk: string) => void): Unsubscribe {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }

  /** The harness's process exited. Fires once. */
  onExit(cb: (exit: { exitCode: number; signal?: number }) => void): Unsubscribe {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  /** The Core reported a new status for this Session. */
  onStatus(cb: (status: string) => void): Unsubscribe {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  /**
   * What a terminal would be showing for this Session, **including the lines
   * that have scrolled off the top of it**.
   *
   * The scrolled-off part is not a bonus: a harness's conversation left the
   * screen long ago, so the transcript is the scrollback and a caller reading
   * only the visible rows reads a status bar. See `terminal-screen.ts` for what
   * is emulated and what an erase costs.
   *
   * **Read it while the Session is alive.** A harness that runs full-screen
   * leaves the alternate screen when it quits, and what a terminal shows after
   * that is the main buffer — which is where nothing was ever printed. Reading
   * before {@link kill}, not after, is the difference between the transcript and
   * an empty string. (Claude Code 2.1.228 runs full-screen, so this is the
   * ordinary case rather than an exotic one.)
   */
  screen(): string {
    return this.terminal.text();
  }

  /** Only the rows on screen right now — for reading a dialog rather than a transcript. */
  viewport(): string {
    return this.terminal.viewportText();
  }

  /** The screen as an array of lines, scrollback first. */
  lines(): string[] {
    return this.terminal.lines();
  }

  /** The Core's last reported status, or null before one has been observed. */
  status(): string | null {
    return this.lastStatus;
  }

  /** How the harness's process ended, or null while it is running. */
  exitStatus(): { exitCode: number; signal?: number } | null {
    return this.exit;
  }

  // ─── Waiting ───────────────────────────────────────────────────────────────

  /**
   * Wait until the Core reports this Session settled — the harness finished its
   * turn, asked a question, was interrupted, or died.
   *
   * **The Core's report, not a guess from the byte stream.** The harness's own
   * lifecycle hooks move the Session's status on the Core, the change lands in
   * the event log, and this is watching for it. Nothing here inspects output for
   * quietness: that is a timing decision, it belongs to the Core, and the flat
   * timer that used to make it here is what #191 deleted.
   *
   * Only statuses observed *after* this Session started count, so starting one
   * on a Task that was already `finished` waits for this turn rather than
   * returning last turn's answer. An exit resolves it too — a harness that died
   * is not going to report anything else.
   *
   * Resolves as soon as it can: if the Session has already settled by the time
   * this is called, it answers from what it saw.
   *
   * With no {@link CoreSessionWaitOptions.timeoutMs} this waits indefinitely, on
   * purpose. A status read that fails is re-asked, so a link that blinks does
   * not cost the report; a link that stays down does, and nothing here invents a
   * status the Core never sent. A caller that must not hang on a broken Core
   * passes a deadline it chose itself.
   */
  waitForIdle(opts: CoreSessionWaitOptions = {}): Promise<CoreSessionIdle> {
    return this.waitForTurnEnd(opts);
  }

  /**
   * Wait for the end of the turn that follows event `afterEventId` — the wait
   * `session send --wait` is built on (#289 A, B).
   *
   * **Why a cursor.** {@link waitForIdle} answers from the status the Session is
   * already sitting at, and for a Session that was started here that is right:
   * it has observed no status yet, so anything it hears is this turn's. For a
   * Session that was **already running** it is a lie waiting to be told — a
   * harness parked on `needs-input` is settled, so a wait attached to it and
   * started after a write would return before the harness had read a character,
   * reporting the previous turn's answer as this one's. Passing the id the Core
   * stamped the delivery with turns "is it settled?" into "has it settled since
   * the thing I sent?", and only the second question has a truthful answer.
   *
   * `afterEventId: 0` (the default) is no cursor and is {@link waitForIdle}.
   *
   * Resolves on **any** of {@link SETTLED_SESSION_STATUSES}, not on `finished`
   * alone: a turn that ended on a permission prompt, an escape or a dead harness
   * ended, and a caller waiting for `finished` there waits forever on exactly the
   * cases it most needs to hear about. A process exit resolves it too.
   *
   * Nothing here reads the byte stream, and nothing here consults
   * {@link reportsTurnStart}. Turn end is reported by every harness family; turn
   * *start* is not, which is why no wait is keyed on it.
   *
   * **A cursored wait can be waiting for a turn that never started** (#405): a
   * carriage return that lands on a dialog rather than a composer submits
   * nothing, so the Core has nothing to report and the seeded status the Session
   * is parked at carries event id 0, which no real cursor can be satisfied by.
   * That is correct and it is silent, which is the whole complaint. It is
   * answered here by making the deadline **loud** rather than by guessing at a
   * turn: expiry rejects with {@link CoreSessionTurnTimeoutError}, whose
   * `reportedSinceDelivery` says whether the Core reported anything at all after
   * the write. Bounding the wait is still the caller's — `timeoutMs` is theirs,
   * and with none this waits as long as the work takes.
   *
   * **A wait cannot outlive the link it is listening on** (#396). Everything
   * that ends a wait well — a status change, an exit — reaches this side down
   * the core link, so a link that drops takes every one of them with it and the
   * wait goes quiet rather than ending: on a caller with no `timeoutMs`, or on
   * the `--wait-timeout 0` that removes one, quiet is forever. A drop is
   * therefore an ending in its own right: the wait keeps going for
   * {@link CORE_LINK_LOST_GRACE_MS} in case the link comes back — on a client
   * that reconnects it usually does, and the replay past its cursor carries the
   * status this wait was missing — and then rejects with
   * {@link CoreSessionLinkLostError}.
   *
   * **It rejects rather than resolving**, and that is the whole of the design:
   * this side stopped hearing from the Core, which is evidence about the link
   * and none at all about the turn. Resolving with the last status seen would
   * report a turn as ended because the network failed, and a false completion is
   * worse than either a hang or an error (ADR 0033 D6).
   */
  waitForTurnEnd(opts: CoreSessionTurnWaitOptions = {}): Promise<CoreSessionIdle> {
    const afterEventId = opts.afterEventId ?? 0;
    const settled = this.settledSince(afterEventId);
    if (settled) return Promise.resolve(settled);
    return new Promise<CoreSessionIdle>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const waiter = {
        afterEventId,
        notify: (idle: CoreSessionIdle): void => {
          this.idleWaiters.delete(waiter);
          if (timer) clearTimeout(timer);
          this.releaseLinkLostGrace();
          resolve(idle);
        },
        fail: (err: Error): void => {
          this.idleWaiters.delete(waiter);
          if (timer) clearTimeout(timer);
          this.releaseLinkLostGrace();
          reject(err);
        },
      };
      this.idleWaiters.add(waiter);
      // A wait started while the link is already down is the same wait as one
      // that was running when it went (#396) — it has just as little chance of
      // hearing anything — so the grace is armed for it too, from here.
      if (this.linkDown) this.armLinkLostGrace();
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        const timeoutMs = opts.timeoutMs;
        timer = setTimeout(() => {
          this.idleWaiters.delete(waiter);
          // **Named rather than bare** (#405). The one thing this deadline knows
          // that its caller does not is whether the Core reported *anything*
          // after the delivery: `lastStatusEventId` still at or below the cursor
          // means no status has been learned since the write, which is the shape
          // of a return that started no turn. It is a comparison of two event
          // ids and nothing else — no screen is read, and no turn is inferred
          // from the bytes (ADR 0033 D4).
          reject(
            new CoreSessionTurnTimeoutError({
              taskId: this.taskId,
              timeoutMs,
              afterEventId,
              lastStatus: this.lastStatus,
              reportedSinceDelivery: this.lastStatusEventId > afterEventId,
            }),
          );
        }, opts.timeoutMs);
      }
    });
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /** Resize the PTY and the screen together, so both agree about wrapping. */
  async resize(cols: number, rows: number): Promise<boolean> {
    const ok = await this.client.resize(this.ptyId, cols, rows);
    this.terminal.resize(cols, rows);
    return ok;
  }

  /** Kill the harness's process, then release this Session's listeners. */
  async kill(): Promise<boolean> {
    try {
      return await this.client.kill(this.ptyId);
    } finally {
      this.dispose();
    }
  }

  /**
   * Release the listeners this Session holds on the client, leaving the harness
   * running. The screen stops advancing; the Core carries on.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
    if (this.subscribedToPty) {
      this.subscribedToPty = false;
      // The stream this attachment asked for, given back. Removing the listener
      // stops this process reading the bytes; it does not stop the Core sending
      // them, and an orchestrator that attaches to and disposes many Sessions on
      // one long-lived client would otherwise leave every one of those streams
      // running at it for the life of the client. Fire and forget on purpose:
      // `dispose` is synchronous, nothing waits on the answer, and a link that
      // is already gone has released the subscription by going.
      void this.client.ptyUnsubscribe(this.ptyId).catch(() => {});
    }
    if (this.statusRetryTimer) {
      clearTimeout(this.statusRetryTimer);
      this.statusRetryTimer = null;
    }
    if (this.linkLostTimer) {
      clearTimeout(this.linkLostTimer);
      this.linkLostTimer = null;
    }
    // Anyone still waiting is waiting on a report this Session will no longer
    // hear, so they are settled on the way out rather than left pending
    // forever. `kill()` disposes, and `await session.kill()` after starting a
    // `waitForIdle()` is an ordinary thing to write.
    for (const waiter of [...this.idleWaiters]) {
      waiter.notify(
        this.settledSince(waiter.afterEventId) ?? {
          status: this.lastStatus ?? "disposed",
          exited: false,
        },
      );
    }
    this.dataListeners.clear();
    this.exitListeners.clear();
    this.statusListeners.clear();
    this.idleWaiters.clear();
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private ingest(chunk: string): void {
    this.terminal.write(chunk);
    for (const cb of this.dataListeners) {
      try {
        cb(chunk);
      } catch {
        /* a listener's failure is not this Session's failure */
      }
    }
  }

  /**
   * @internal — the client's link to the Core went down (#396).
   *
   * Nothing is decided here. The link being down is a fact about this side, and
   * the wait it endangers is given {@link linkLostGraceMs} to see whether it
   * comes back: on a client that reconnects it usually does, and the replay past
   * its cursor delivers whatever the Core reported in the gap, so the wait ends
   * on the Core's own report exactly as it would have.
   */
  private onLinkLost(reason?: string): void {
    if (this.disposed || this.linkDown) return;
    this.linkDown = true;
    this.linkLostReason = reason ?? null;
    this.armLinkLostGrace();
  }

  /**
   * @internal — a connection came up. Whatever the grace was about is over.
   *
   * The wait carries on from here with nothing changed: this restores the state
   * a wait is supposed to be in, and does not resolve, fail or advance anything.
   * A turn that ended while the link was down is reported by the replay the
   * client asks for on its new connection, through the ordinary event path.
   */
  private onLinkBack(): void {
    this.linkDown = false;
    this.linkLostReason = null;
    if (this.linkLostTimer) {
      clearTimeout(this.linkLostTimer);
      this.linkLostTimer = null;
    }
  }

  /**
   * Start the clock on the current drop, or fail the waiters now if this client
   * has no reconnect for the clock to be about.
   *
   * One timer for the Session rather than one per waiter: the link is a property
   * of the client, so every wait on this Session went deaf at the same instant
   * and there is nothing for two clocks to disagree about.
   *
   * **Not `unref`ed**, unlike the status-read retry. That retry is a nice-to-have
   * a finished script may exit through; this one is the only thing left that will
   * ever settle a pending wait, and a process that exited around it would leave
   * that promise unsettled — which is the hang this exists to remove, wearing an
   * exit code of 0.
   */
  private armLinkLostGrace(): void {
    if (this.disposed || !this.linkDown) return;
    if (this.idleWaiters.size === 0) return;
    if (this.linkLostGraceMs === 0) {
      this.failWaitersLinkLost();
      return;
    }
    if (this.linkLostTimer) return;
    this.linkLostTimer = setTimeout(() => {
      this.linkLostTimer = null;
      if (this.disposed || !this.linkDown) return;
      this.failWaitersLinkLost();
    }, this.linkLostGraceMs);
  }

  /** The grace is only ever about a wait; with none left there is nothing to time. */
  private releaseLinkLostGrace(): void {
    if (this.idleWaiters.size > 0) return;
    if (this.linkLostTimer) {
      clearTimeout(this.linkLostTimer);
      this.linkLostTimer = null;
    }
  }

  /**
   * End every pending wait as *unknown* — the link went and did not come back.
   *
   * `fail`, never `notify`. The waiters are holding cursors and last-known
   * statuses that would make a plausible-looking resolution, and every one of
   * them would be a turn reported as ended on the strength of a network failure.
   */
  private failWaitersLinkLost(): void {
    for (const waiter of [...this.idleWaiters]) {
      waiter.fail(
        new CoreSessionLinkLostError({
          taskId: this.taskId,
          afterEventId: waiter.afterEventId,
          lastStatus: this.lastStatus,
          reportedSinceDelivery: this.lastStatusEventId > waiter.afterEventId,
          graceMs: this.linkLostGraceMs,
          reason: this.linkLostReason,
        }),
      );
    }
  }

  private ingestExit(frame: CoreLinkExitFrame): void {
    if (this.exit) return;
    this.exit = {
      exitCode: frame.exitCode,
      ...(frame.signal === undefined ? {} : { signal: frame.signal }),
    };
    for (const cb of this.exitListeners) {
      try {
        cb(this.exit);
      } catch {
        /* same */
      }
    }
    this.releaseWaiters();
  }

  /** @internal — called by {@link start} for events held during the spawn. */
  private onCoreEvent(event: CoreLinkEvent): void {
    if (event.taskId !== this.taskId) return;
    if (!STATUS_BEARING_EVENT_KINDS.has(event.kind)) return;
    // `session:finished` is appended on the transition into `finished` and on
    // nothing else, so it is the one kind that already says what happened.
    if (event.kind === "session:finished") {
      this.noteStatus("finished", event.eventId);
      return;
    }
    // A `task:updated` whose payload names the status the mutation **patched**
    // is a report about a turn, and it is exact: it needs no round trip, and it
    // cannot be confused with a rename or an archive of a Session that happens
    // to be sitting at a settled status. Anything else moves the last known
    // status but never the cursor — see {@link readStatus}.
    const patched = patchedStatusOf(event);
    if (patched !== null) {
      this.noteStatus(patched, event.eventId);
      return;
    }
    void this.readStatus();
  }

  /**
   * Read this Session's status back off the Core.
   *
   * The `task:updated` event says a row moved, not what it moved to, and the
   * Core owns the answer — so it is asked. Coalesced, because a turn's worth of
   * hook events arrives in a burst and each one would otherwise be its own round
   * trip: a read already in flight is re-run once at the end rather than queued
   * behind itself.
   *
   * A read that fails is re-asked ({@link STATUS_READ_RETRIES}), because on
   * `needs-input`, `interrupted` and `terminated` there is no second event to
   * carry the news.
   *
   * **What it reads never advances the wait cursor** (#289 A). This path is
   * reached for an event that did not say what it changed — a rename, an
   * archive, a Core too old to name the patched status — and the row it reads
   * back may be carrying the status of a turn that ended long before. Answering
   * a cursored wait from that is the early resolution the cursor exists to
   * prevent, so a read updates `lastStatus` and leaves the cursor where it was.
   */
  private async readStatus(): Promise<void> {
    if (this.disposed) return;
    if (this.statusReadInFlight) {
      this.statusReadAgain = true;
      return;
    }
    this.statusReadInFlight = true;
    let failed = false;
    try {
      const sessions = await this.client.sessionsList();
      const mine = sessions.find((s: CoreLinkSessionSnapshot) => s.taskId === this.taskId);
      if (mine) this.noteStatus(mine.status);
      this.statusReadRetriesLeft = STATUS_READ_RETRIES;
    } catch {
      // A read that failed is a link that dropped or a Core that is busy. It is
      // re-asked below rather than swallowed: on the transitions that reach this
      // layer as a bare `task:updated` there is no later event to ask on, so a
      // dropped read is the difference between a caller learning the harness is
      // waiting for an answer and a caller waiting forever for one.
      failed = true;
    } finally {
      this.statusReadInFlight = false;
      if (this.statusReadAgain && !this.disposed) {
        // An event that arrived mid-read is the re-ask, and a fresher one.
        this.statusReadAgain = false;
        void this.readStatus();
      } else if (failed && !this.disposed && this.statusReadRetriesLeft > 0) {
        this.statusReadRetriesLeft -= 1;
        this.scheduleStatusRetry();
      }
    }
  }

  /**
   * Read the Core's current status for this Session once, at attach, at event
   * id 0 — "what it is sitting at", never "what it did".
   *
   * A missing row is not an error here: the Session has a live PTY (the attach
   * proved it), and a Core that does not list it yet will report its status like
   * any other, through the event log this attachment is already listening to.
   */
  private async seedStatus(): Promise<void> {
    const sessions = await this.client.sessionsList();
    const mine = sessions.find((s: CoreLinkSessionSnapshot) => s.taskId === this.taskId);
    if (mine) this.noteStatus(mine.status, 0);
  }

  /** The next re-ask of a read that failed. Cleared by {@link dispose}. */
  private scheduleStatusRetry(): void {
    if (this.statusRetryTimer) return;
    this.statusRetryTimer = setTimeout(() => {
      this.statusRetryTimer = null;
      if (!this.disposed) void this.readStatus();
    }, STATUS_READ_RETRY_MS);
    // A pending re-ask is not a reason for a script that is otherwise done to
    // stay alive.
    this.statusRetryTimer.unref?.();
  }

  /**
   * Record a status the Core reported, and where in the log it was reported.
   *
   * **A repeated status is still news**, which is why the cursor moves even when
   * the string does not (#289 A). A harness that never moved its Session to
   * `running` ends its second turn by patching `finished` onto a row that
   * already said `finished`; the value did not change, but a turn ended, and a
   * waiter counting from a delivery stamp is waiting for exactly that. What
   * stays gated on a change is {@link onStatus}, which is about the value.
   */
  private noteStatus(status: string, eventId = 0): void {
    const changed = status !== this.lastStatus;
    this.lastStatus = status;
    if (eventId > this.lastStatusEventId) this.lastStatusEventId = eventId;
    if (changed) {
      for (const cb of this.statusListeners) {
        try {
          cb(status);
        } catch {
          /* same */
        }
      }
    }
    this.releaseWaiters();
  }

  /** What {@link waitForIdle} would answer right now, or null if it must wait. */
  private settledNow(): CoreSessionIdle | null {
    return this.settledSince(0);
  }

  /**
   * What a wait counting from `afterEventId` would answer right now, or null.
   *
   * An **exit** answers every wait, cursor or none: a harness whose process is
   * gone will not report anything else, and a caller left waiting for a status
   * after that waits forever. A status answers a cursored wait only when it was
   * learned after the cursor — a seeded status (event id 0) never does.
   */
  private settledSince(afterEventId: number): CoreSessionIdle | null {
    if (this.exit) {
      return {
        status: this.lastStatus ?? "terminated",
        exited: true,
        ...(this.exit.exitCode === undefined ? {} : { exitCode: this.exit.exitCode }),
      };
    }
    if (!this.lastStatus || !SETTLED_SESSION_STATUSES.has(this.lastStatus)) return null;
    if (afterEventId > 0 && this.lastStatusEventId <= afterEventId) return null;
    return { status: this.lastStatus, exited: false };
  }

  private releaseWaiters(): void {
    for (const waiter of [...this.idleWaiters]) {
      const settled = this.settledSince(waiter.afterEventId);
      if (settled) waiter.notify(settled);
    }
  }
}

/**
 * How long a Session's waits survive a dropped link, given what the caller asked
 * for and what kind of client it handed over (#396).
 *
 * The caller's number wins outright, 0 included. With none, the answer comes off
 * the client: one that dials again gets {@link CORE_LINK_LOST_GRACE_MS} to do
 * it in, and one that does not gets **0**, because a grace is time given to a
 * reconnect and a one-shot client has none coming. That is the `actana` CLI's
 * case — its drop is permanent, and a wait that sat out thirty seconds before
 * saying so would be thirty seconds of the hang this fixes.
 */
function linkLostGraceFor(client: CoreClient, asked: number | undefined): number {
  if (asked !== undefined) return asked;
  return client.willReconnect() ? CORE_LINK_LOST_GRACE_MS : 0;
}

/**
 * The status a `task:updated` event says its mutation **patched**, or null when
 * the event does not say (#289 A).
 *
 * Null is not "no status": it is "this event did not report a turn". A Core that
 * names the patched status makes every turn end legible without a round trip; a
 * Core that does not leaves the caller with `readStatus`, which is a fresher
 * answer to a different question.
 */
function patchedStatusOf(event: CoreLinkEvent): string | null {
  try {
    const payload = JSON.parse(event.payload) as { status?: unknown };
    return typeof payload.status === "string" ? payload.status : null;
  } catch {
    // A payload this side cannot parse is a payload this side knows nothing
    // about — the read path below covers it, which is what it is there for.
    return null;
  }
}

/**
 * The launch command a Session gets when its caller named none — the whole of
 * it, auto-mode flag included.
 *
 * Exported because it is the one answer to "what will `start` actually run",
 * and issue 177 is what happens when that question has two answers. Both
 * halves of the command come out of the same tables the Core validates against
 * ({@link HARNESS_LAUNCH_COMMANDS} for the binary, which is `cursor-agent` and
 * not `cursor-cli`; {@link HARNESS_SKIP_PERMISSION_FLAGS} for the flag), so a
 * test can put this straight through the Core's `resolveSpawnPlan` and find
 * out rather than reason about it.
 *
 * `skipPermissions` is the caller's request, not a promise about the result:
 * OpenCode has no such flag and so gets none, which the Core accepts, and
 * every other harness gets the one it spells auto mode with, which the Core
 * now *requires* whenever the option is set.
 */
export function harnessLaunchCommand(
  harness: CoreLinkPtySpawnHarness,
  skipPermissions: boolean,
): string {
  const base = HARNESS_LAUNCH_COMMANDS[harness];
  if (!skipPermissions) return base;
  const flag = HARNESS_SKIP_PERMISSION_FLAGS[harness];
  return flag ? `${base} ${flag}` : base;
}

/**
 * Create the Task a Session hangs off, in the Project the caller named.
 *
 * A Session's status is a column on this row: the Core's hook pipeline patches
 * it, the patch appends the event, and the event is what {@link
 * CoreSession.waitForIdle} is waiting for. A spawn naming a row that does not
 * exist runs a harness that reports to nowhere — so the row comes first, and a
 * Core that will not create it (an unknown Project) fails the start here rather
 * than producing a Session nothing can observe.
 */
async function createTask(client: CoreClient, opts: CoreSessionStartOptions): Promise<string> {
  const projectId = opts.projectId!;
  let created;
  try {
    created = await client.tasksMutate({
      op: "create",
      projectId,
      title: opts.title ?? "SDK session",
      agent: opts.harness,
    });
  } catch (err) {
    throw new CoreSessionStartError(
      `the Core refused to create a Session in project ${projectId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  if (!created) {
    throw new CoreSessionStartError(
      `the Core has no project ${projectId} to start a Session in`,
    );
  }
  return created.taskId;
}
