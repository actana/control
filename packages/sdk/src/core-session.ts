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
//      450 ms timer that #191 deleted, in a new place.

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
 * command when {@link CoreSessionOptions.dangerouslySkipPermissions} is set.
 *
 * The option and the flag are two halves of one gesture and the Core checks
 * both: the flag is allow-listed only for a spawn that also set the option, so
 * setting one without the other is a rejected spawn rather than a quiet
 * downgrade. OpenCode has no such flag, and gets none.
 */
const HARNESS_SKIP_PERMISSION_FLAGS: Readonly<Record<CoreLinkPtySpawnHarness, string | null>> = {
  "claude-code": "--dangerously-skip-permissions",
  codex: "--yolo",
  "cursor-cli": "--force",
  opencode: null,
};

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

/** The Core refused to start this Session. Carries the Core's own reason. */
export class CoreSessionStartError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CoreSessionStartError";
  }
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
  /** The harness running in it. */
  readonly harness: CoreLinkPtySpawnHarness;
  /** The command the Core was asked to start, after defaulting. */
  readonly command: string;

  private readonly client: CoreClient;
  private readonly terminal: TerminalScreen;
  private readonly unsubscribes: Unsubscribe[] = [];

  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly exitListeners = new Set<(exit: { exitCode: number; signal?: number }) => void>();
  private readonly statusListeners = new Set<(status: string) => void>();
  private readonly idleWaiters = new Set<(idle: CoreSessionIdle) => void>();

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
  private exit: { exitCode: number; signal?: number } | null = null;
  private disposed = false;
  /** A status read is in flight; another event arrived while it was. */
  private statusReadInFlight = false;
  private statusReadAgain = false;

  private constructor(opts: {
    client: CoreClient;
    taskId: string;
    ptyId: string;
    harness: CoreLinkPtySpawnHarness;
    command: string;
    terminal: TerminalScreen;
  }) {
    this.client = opts.client;
    this.taskId = opts.taskId;
    this.ptyId = opts.ptyId;
    this.harness = opts.harness;
    this.command = opts.command;
    this.terminal = opts.terminal;
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
    const command = opts.command ?? defaultLaunchCommand(opts.harness, opts.dangerouslySkipPermissions === true);

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
    let heldExit: CoreLinkExitFrame | null = null;
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
        if (!heldExit) heldExit = frame;
        return;
      }
      if (frame.ptyId !== ptyId) return;
      session?.ingestExit(frame);
    });

    let spawned: { ptyId: string };
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
      terminal,
    });
    session.unsubscribes.push(stopData, stopExit);
    session.unsubscribes.push(client.onEvent(({ event }) => session?.onCoreEvent(event)));

    for (const frame of held) {
      if (frame.ptyId === ptyId) session.ingest(frame.data);
    }
    if (heldExit !== null && (heldExit as CoreLinkExitFrame).ptyId === ptyId) {
      session.ingestExit(heldExit as CoreLinkExitFrame);
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
   * Resolves false when the Core did not accept the write — a PTY that has
   * exited. Rejects when another Core client holds this Session's lock.
   */
  send(text: string): Promise<boolean> {
    return this.client.write(this.ptyId, text);
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
   */
  waitForIdle(opts: CoreSessionWaitOptions = {}): Promise<CoreSessionIdle> {
    const settled = this.settledNow();
    if (settled) return Promise.resolve(settled);
    return new Promise<CoreSessionIdle>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const waiter = (idle: CoreSessionIdle): void => {
        this.idleWaiters.delete(waiter);
        if (timer) clearTimeout(timer);
        resolve(idle);
      };
      this.idleWaiters.add(waiter);
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          this.idleWaiters.delete(waiter);
          reject(
            new Error(
              `session ${this.taskId} was still ${this.lastStatus ?? "unreported"} after ${opts.timeoutMs}ms`,
            ),
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

  private onCoreEvent(event: CoreLinkEvent): void {
    if (event.taskId !== this.taskId) return;
    if (!STATUS_BEARING_EVENT_KINDS.has(event.kind)) return;
    // `session:finished` is appended on the transition into `finished` and on
    // nothing else, so it is the one kind that already says what happened.
    if (event.kind === "session:finished") {
      this.noteStatus("finished");
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
   */
  private async readStatus(): Promise<void> {
    if (this.disposed) return;
    if (this.statusReadInFlight) {
      this.statusReadAgain = true;
      return;
    }
    this.statusReadInFlight = true;
    try {
      const sessions = await this.client.sessionsList();
      const mine = sessions.find((s: CoreLinkSessionSnapshot) => s.taskId === this.taskId);
      if (mine) this.noteStatus(mine.status);
    } catch {
      // A read that failed is a link that dropped or a Core that is busy. The
      // next event asks again, and an exit resolves the wait regardless.
    } finally {
      this.statusReadInFlight = false;
      if (this.statusReadAgain && !this.disposed) {
        this.statusReadAgain = false;
        void this.readStatus();
      }
    }
  }

  private noteStatus(status: string): void {
    if (status === this.lastStatus) return;
    this.lastStatus = status;
    for (const cb of this.statusListeners) {
      try {
        cb(status);
      } catch {
        /* same */
      }
    }
    this.releaseWaiters();
  }

  /** What {@link waitForIdle} would answer right now, or null if it must wait. */
  private settledNow(): CoreSessionIdle | null {
    if (this.exit) {
      return {
        status: this.lastStatus ?? "terminated",
        exited: true,
        ...(this.exit.exitCode === undefined ? {} : { exitCode: this.exit.exitCode }),
      };
    }
    if (this.lastStatus && SETTLED_SESSION_STATUSES.has(this.lastStatus)) {
      return { status: this.lastStatus, exited: false };
    }
    return null;
  }

  private releaseWaiters(): void {
    const settled = this.settledNow();
    if (!settled) return;
    for (const waiter of [...this.idleWaiters]) waiter(settled);
  }
}

/** The launch command for a harness nobody named one for. */
function defaultLaunchCommand(
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
