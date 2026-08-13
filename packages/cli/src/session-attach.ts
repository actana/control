// `actana session attach <session>` — a terminal on a running Session (#163,
// #129 D10).
//
// The last verb of the `session` noun and the only one that is a *terminal*
// rather than a report: it paints what the harness is painting, and — when it is
// allowed to — types into it. Everything hard about it is one of two things.
//
// **1. It writes to a Session, so it holds the write lock** (ADR 0024 D3–D7,
// #144). That is not a check bolted onto a viewer; it is the first thing this
// command does, in `session-attach-channel.ts`, before a byte reaches the
// operator's terminal:
//
//   - A Session another Core client is writing gives a **read-only view with the
//     reason on it** — not an error, and not a takeover. `forceTakeover` is D7's
//     answer to a hung client and this command never sends it: an attach that
//     stole the lock because somebody typed a session id is precisely the
//     accident the lock exists to prevent.
//   - **Detaching releases it**, and so does this process dying — the Core drops
//     a connection's locks when the connection goes (D7), which is why the
//     release below is skipped rather than retried on a link that is already
//     gone. An attach that assumed it was the only way a lock could end is what
//     strands a Session unwritable.
//   - **Losing the lock mid-session is handled** rather than assumed away. A
//     force takeover from elsewhere makes the next keystroke refused; this
//     command says so, on the terminal, and carries on as a Reader.
//   - A Core that publishes no lock state has no lock to hold, and that attach
//     writes (D11). `supported: false` is not read-only.
//
// **2. The terminal is restored on every exit path**, which is the discipline
// `core shell` landed in #162 and this reuses line for line: a `finally` around
// the whole session, `SIGINT` and `SIGTERM` handled rather than fatal, a dropped
// link treated as an ending like any other, a restore that is idempotent and
// never throws, and — one layer down in `cli-terminal.ts` — a process `exit`
// hook for the route no `finally` covers. The terminal goes back **before** the
// release round trip, so a Core that has stopped answering costs a request
// timeout rather than a request timeout's worth of unusable shell.
//
// **`Ctrl-C` is forwarded, so detaching needs a key of its own.** Raw mode turns
// off `ISIG`; `Ctrl-C` is the byte `0x03` and belongs to the harness, which is
// the whole reason a person attaches instead of reading `session logs`. `Ctrl-]`
// — telnet's escape since 1983 — detaches instead. In a read-only attach there
// is nothing to interrupt on the far side, so `Ctrl-C` detaches there too rather
// than being swallowed.
//
// **An attach that cannot write does not resize the PTY, and `Ctrl-C` detaches
// it.** Both follow the lock as it stands, not the authority the attach opened
// with — a force takeover demotes a holder to a Reader mid-session, and a demoted
// attach that kept the holder's affordances would keep them against somebody
// else's Session. The resize half is the one with teeth: the Core does not gate
// `resize` on the lock (D4 covers `write`, `kill` and task mutations, and a
// Reader has a viewport like anyone else), so this is the CLI's own restraint and
// not a refusal it met — reflowing the terminal of the person actually typing
// because an observer widened a window is interference in the one direction the
// lock cannot see.

import { resolveCore } from "./core-resolution.ts";
import { authorityWrites, SessionWriteRefused } from "./session-attach-channel.ts";
import { SessionGatewayError } from "./session-gateway.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./exit-codes.ts";
import type { RegistryPaths } from "./blob-registry.ts";
import type { ActanaCliDeps } from "./cli-deps.ts";
import type { ParsedArgs } from "./cli-args.ts";
import type { CliTerminal, Unsubscribe } from "./cli-terminal.ts";
import type {
  AttachAuthority,
  SessionAttachExit,
  SessionAttachment,
} from "./session-attach-channel.ts";

/** How long `session attach` waits for a Core to answer and hand back a stream. */
const ATTACH_CONNECT_TIMEOUT_MS = 30_000;

/** The signal numbers behind the two names, for the `128 + n` exit convention. */
const SIGNAL_NUMBERS = { SIGINT: 2, SIGTERM: 15 } as const;

/**
 * `Ctrl-]` — the detach key.
 *
 * Telnet's escape character, which is the closest thing to a convention for
 * "leave, do not send this". It has to be a key the harness will not miss:
 * every other control byte is one a full-screen program on the far side might
 * bind, and the two obvious candidates are exactly the two that must be
 * forwarded — `Ctrl-C` interrupts the harness and `Ctrl-D` ends its input.
 */
const DETACH_KEY = "\u001D";

/** `Ctrl-C`. Forwarded when this attach writes; a second detach key when it does not. */
const ETX = "\u0003";

/**
 * How an attach ended. Exactly one of these settles a run, and every one of them
 * goes through the same `finally` on the way out.
 */
type Ending =
  /** The operator pressed the detach key. The Session carries on without them. */
  | { kind: "detach" }
  /** The harness's process exited while somebody was watching it. */
  | { kind: "exit"; exit: SessionAttachExit }
  /** The link went away underneath — a Core restart, a network drop. */
  | { kind: "disconnected"; error?: string }
  /** This process was signalled. Not `Ctrl-C`, which never gets this far. */
  | { kind: "signal"; signal: "SIGINT" | "SIGTERM" }
  /** A frame could not be sent, for a reason that was not the lock. */
  | { kind: "link-error"; message: string };

/** What the session did that the report has to account for afterwards. */
type SessionState = {
  /** Whether the last byte painted ended a line — see {@link report}. */
  endedWithNewline: boolean;
  /** Keystrokes a read-only attach did not forward. Counted, so it can say so. */
  dropped: number;
  /** True once the write lock was taken away mid-session (D7). */
  lockLost: boolean;
};

/**
 * Raw mode, with the restore made unmissable.
 *
 * The same guard `core-shell.ts` uses, and for the same reason: it is called
 * from a `finally`, from two signal handlers and from an error path, and a
 * restore that threw would replace a usable terminal with an unusable one at the
 * exact moment nothing is left to catch it.
 */
class RawModeGuard {
  private entered = false;
  private restored = false;

  constructor(private readonly terminal: CliTerminal) {}

  /** Enter raw mode. Throws if the terminal refuses — the caller must not continue. */
  enter(): void {
    this.terminal.setRawMode(true);
    this.entered = true;
  }

  /** Put the terminal back. Safe to call any number of times, from anywhere. */
  restore(): void {
    if (!this.entered || this.restored) return;
    this.restored = true;
    try {
      this.terminal.setRawMode(false);
    } catch {
      // Nothing above this can do anything useful with the failure, and the
      // caller is on its way to an exit code either way.
    }
  }
}

/**
 * `actana session attach <session>` — take the terminal to a running Session.
 *
 * Reads like the session it runs: refuse what cannot work, settle authority,
 * *then* take the terminal, and give it back before printing a word.
 */
export async function runSessionAttach(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  // `--json` is a promise this verb cannot keep, for the reason `core shell`
  // cannot either: stdout here is a terminal somebody is looking at, and there
  // is no document to emit. `session logs --json` is the machine-readable view
  // of a Session's output.
  if (args.json) {
    deps.err("actana session attach: --json means nothing here — this verb hands you a terminal.");
    deps.err("`actana session logs <session> --json` is the machine-readable view of one.");
    return EXIT_USAGE;
  }

  const [taskId, ...extra] = rest;
  if (taskId === undefined) {
    deps.err("actana session attach: a session id is required — `actana session attach <session>`.");
    return EXIT_USAGE;
  }
  if (extra.length > 0) {
    deps.err(`actana session attach: unexpected argument "${extra[0]}".`);
    return EXIT_USAGE;
  }

  const terminal = deps.terminal;
  if (!terminal.isTty) {
    deps.err("actana session attach: this is an interactive command and stdin/stdout are not a terminal.");
    deps.err("To read a Session from a script: `actana session logs`. To type into one: `actana session send`.");
    return EXIT_USAGE;
  }

  const resolved = resolveCore({ paths, env: deps.env, home: deps.home, coreFlag: args.core });
  if (!resolved.ok) {
    deps.err(`actana session attach: ${resolved.error}`);
    return EXIT_FAILURE;
  }
  const { name, blob } = resolved.core;
  deps.verbose(`dialling ${blob.endpoint}`);

  // Dial, resolve the Session and settle the lock before touching the terminal.
  // A Session that is not running, a Core that is down and a claim that was
  // refused are all ordinary outcomes of this command, and none of them has any
  // business happening while the operator's terminal is in raw mode.
  const { cols, rows } = terminal.size();
  let attached: SessionAttachment;
  try {
    attached = await deps.openAttach(blob, {
      taskId,
      cols,
      rows,
      connectTimeoutMs: ATTACH_CONNECT_TIMEOUT_MS,
      claimWrite: !args.readOnly,
    });
  } catch (err) {
    deps.err(`actana session attach: ${attachFailure(blob.endpoint, err)}`);
    return EXIT_FAILURE;
  }

  const writes = authorityWrites(attached.authority);
  deps.verbose(`pty ${attached.ptyId} on ${name ?? blob.endpoint}, ${cols}x${rows}`);
  // Said before the screen fills with the harness's output, because a read-only
  // attach that announced itself *after* the scrollback would announce itself
  // where nobody is looking. Both lines go to stderr: stdout is about to become
  // a terminal.
  deps.err(banner(taskId, attached.authority));
  deps.err(detachHint(writes));

  const guard = new RawModeGuard(terminal);
  try {
    guard.enter();
  } catch (err) {
    // Nothing is in raw mode, so there is nothing to restore — but there is a
    // write lock this connection may be holding, and a Session left locked by an
    // attach that never opened is the stranding this ticket is about.
    await releaseQuietly(attached);
    safely(() => attached.close());
    deps.err(`actana session attach: could not put this terminal into raw mode — ${messageOf(err)}`);
    return EXIT_FAILURE;
  }

  let end: Ending;
  const disposers: Unsubscribe[] = [];
  const state: SessionState = { endedWithNewline: true, dropped: 0, lockLost: false };

  /**
   * Give the terminal back. Idempotent in both halves — `disposers` is drained
   * as it is walked and {@link RawModeGuard.restore} is a no-op the second time
   * — so it can be called the moment the session ends *and* from the `finally`
   * that has to run whatever happened.
   */
  const releaseTerminal = () => {
    for (const dispose of disposers.splice(0)) safely(dispose);
    guard.restore();
  };

  try {
    end = await runAttachedSession(terminal, attached, disposers, state, writes);
    // Hand the terminal back before touching the far side, exactly as `core
    // shell` does: what follows is a round trip to a Core that may already be
    // gone, and every millisecond of it would be a millisecond the operator's
    // terminal was still raw.
    releaseTerminal();
    // The lock goes back on every ending except the one that has already
    // returned it. A dropped link releases a connection's locks at the Core
    // (D7), so there is nothing to send and nothing to wait for — and waiting
    // would be waiting on a socket that is gone.
    if (end.kind !== "disconnected") await releaseQuietly(attached);
  } finally {
    // The guarantee, not the routine case: every path out of the `try` — a
    // detach, the harness exiting, a signal, a dropped link, a defect in any of
    // the code above — arrives here, and the terminal is restored before the
    // socket is closed so that even a `close` that throws leaves a usable one
    // behind.
    releaseTerminal();
    safely(() => attached.close());
  }

  // Cooked again from here down, so it is safe to print lines.
  return report(deps, terminal, taskId, blob.endpoint, end, state, attached.authority);
}

/**
 * Wire the terminal to the Session and wait for one of them to end it.
 *
 * Every listener registered here goes into `disposers`, which the caller's
 * `finally` drains — a listener that outlived the session would keep stdin's
 * `data` handler attached, and a process with a live stdin listener does not
 * exit.
 */
function runAttachedSession(
  terminal: CliTerminal,
  attached: SessionAttachment,
  disposers: Unsubscribe[],
  state: SessionState,
  writes: boolean,
): Promise<Ending> {
  return new Promise<Ending>((resolve) => {
    let settled = false;
    const settle = (ending: Ending) => {
      // First ending wins. A harness exiting is routinely followed by the link
      // closing, and a signal by both; "which ending do we report" is exactly
      // the question the exit status answers.
      if (settled) return;
      settled = true;
      resolve(ending);
    };

    const paint = (data: string) => {
      if (data.length > 0) state.endedWithNewline = data.endsWith("\n");
      terminal.write(data);
    };

    // The scrollback first, then the live stream. In that order and with no gap:
    // the Core held this PTY's output until the replay behind `backlog` was
    // served (`catchUp`), and the channel buffered whatever arrived after that
    // until this line, so the terminal shows the Session's history followed by
    // its present with nothing missing in between.
    paint(attached.backlog);
    disposers.push(attached.onData(paint));

    disposers.push(attached.onExit((exit) => settle({ kind: "exit", exit })));
    disposers.push(
      attached.onDisconnected((info) => settle({ kind: "disconnected", error: info.error })),
    );

    // Local → remote. **`Ctrl-C` is in here and has no special case when this
    // attach writes**: in raw mode it is the byte `0x03`, and forwarding it is
    // what lets the operator interrupt whatever the harness is doing.
    disposers.push(
      terminal.onInput((data) => {
        // Current authority, not the authority this attach opened with. A force
        // takeover (D7) demotes a holder to a Reader mid-session, and every key
        // below has to follow the lock rather than the flag it was captured with.
        const canWrite = writes && !state.lockLost;
        const detachAt = data.indexOf(DETACH_KEY);
        // An attach that cannot write has nothing to interrupt on the far side,
        // so `Ctrl-C` means the only thing left it can mean: leave. That has to
        // include an attach that *lost* the lock — otherwise the one key the
        // operator was just told they now have is the one that does nothing:
        // neither forwarded (there is no lock) nor a detach.
        const quitAt = canWrite ? -1 : data.indexOf(ETX);
        const stopAt = firstOf(detachAt, quitAt);

        const forward = stopAt === -1 ? data : data.slice(0, stopAt);
        if (forward.length > 0) {
          if (canWrite) {
            void attached.write(forward).catch((err: unknown) => {
              // A lock taken away underneath is not an ending. The Session is
              // still worth watching, and an attach that quit on it would take
              // the operator's view away as well as their keyboard.
              if (err instanceof SessionWriteRefused) {
                state.lockLost = true;
                // Says the affordance changed as well as the authority: `Ctrl-C`
                // was going to the harness a keystroke ago and detaches from
                // here, which is not something the operator can be left to
                // discover by pressing it.
                paint(
                  `\r\n[actana] ${err.message} — this attach is read-only from here, and Ctrl-C now detaches instead of going to the harness.\r\n`,
                );
                return;
              }
              settle({
                kind: "link-error",
                message: `the Session stopped accepting input — ${messageOf(err)}`,
              });
            });
          } else {
            state.dropped += forward.length;
          }
        }
        if (stopAt !== -1) settle({ kind: "detach" });
      }),
    );

    // `SIGWINCH`, as a resize frame — and only from the attach that writes *now*.
    // See the module header: the Core would accept it from a Reader, and a Reader
    // sending it reflows the writer's terminal. `state.lockLost` is in the guard
    // because a demoted holder is a Reader like any other: the Core does not gate
    // `resize` on the lock, so an attach that kept resizing after a takeover
    // would reflow the *new* holder's PTY — the interference in the one
    // direction the lock cannot see, arriving from the one attach that used to be
    // allowed. A failure is not worth ending a working session over; the harness
    // keeps running and is merely drawing at the old size.
    disposers.push(
      terminal.onResize(() => {
        if (!writes || state.lockLost) return;
        const { cols, rows } = terminal.size();
        void attached.resize(cols, rows).catch(() => {});
      }),
    );

    // The two signals, handled rather than fatal — handled *because* the default
    // action is fatal, and a CLI killed by the default action never reaches its
    // `finally`, never restores the terminal, and never releases the lock.
    // `Ctrl-C` does not arrive here: raw mode means the terminal driver never
    // raises it. What does is `kill` from another window, a supervisor stopping
    // this process, or a terminal closing.
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      disposers.push(terminal.onSignal(signal, () => settle({ kind: "signal", signal })));
    }
  });
}

/**
 * What the operator is told they are looking at, before they are looking at it.
 *
 * The ticket's first criterion is that a Session somebody else is writing gives
 * a read-only view **with a visible reason** — so the reason is in the line, and
 * each of the four authorities has its own. `no-lock-table` is deliberately not
 * a warning: that Core has no lock, so this attach writes.
 */
function banner(taskId: string, authority: AttachAuthority): string {
  switch (authority) {
    case "held":
      return `Attached to session ${taskId}. You hold the write lock — what you type goes to the harness.`;
    case "held-by-another":
      return `Attached to session ${taskId}, READ-ONLY: another Core client holds this Session's write lock, so keystrokes are not forwarded.`;
    case "not-claimed":
      return `Attached to session ${taskId}, READ-ONLY: --read-only, so no claim was sent and keystrokes are not forwarded.`;
    case "no-lock-table":
      return `Attached to session ${taskId}. This Core publishes no Session lock, so nothing arbitrates writes — what you type goes to the harness.`;
  }
}

/** How to leave, which is not obvious and is not `Ctrl-C` when this attach writes. */
function detachHint(writes: boolean): string {
  return writes
    ? "Ctrl-] detaches and releases the lock. Ctrl-C goes to the harness."
    : "Ctrl-] or Ctrl-C detaches.";
}

/**
 * Turn an ending into an exit status, and say what happened.
 *
 * **A harness that exited is not this command's failure.** `core shell` returns
 * the remote status because the remote shell *is* the command; an attach is a
 * terminal onto somebody else's Session, and a script that could not tell "the
 * attach failed" from "the harness you were watching exited 1" would be worse
 * off than one that reads the line.
 */
function report(
  deps: ActanaCliDeps,
  terminal: CliTerminal,
  taskId: string,
  endpoint: string,
  end: Ending,
  state: SessionState,
  authority: AttachAuthority,
): number {
  // A Session that ended mid-line — a dropped link lands wherever the last byte
  // fell, and a full-screen harness leaves the cursor anywhere — would otherwise
  // have the operator's next prompt painted on top of it.
  if (!state.endedWithNewline) terminal.write("\r\n");

  // Said once, at the end, rather than on every keystroke: a read-only attach
  // that answered every key with a line would repaint the Session's screen out
  // from under the person reading it.
  if (state.dropped > 0) {
    // "This attach was read-only" is true of an attach that opened read-only and
    // misleading about one that opened holding the lock and had it taken: the
    // operator typed those keys at a terminal that *was* writing, and being told
    // it was read-only reads as though it never was.
    deps.err(
      state.lockLost
        ? `${state.dropped} keystrokes were not forwarded — this attach lost the write lock partway through.`
        : `${state.dropped} keystrokes were not forwarded — this attach was read-only.`,
    );
  }

  switch (end.kind) {
    case "detach":
      deps.err(`Detached from session ${taskId}. The harness keeps running.`);
      return EXIT_OK;
    case "exit": {
      const { exitCode, signal } = end.exit;
      deps.err(
        signal !== undefined && signal > 0
          ? `The harness for session ${taskId} was killed by signal ${signal}.`
          : `The harness for session ${taskId} exited with code ${exitCode}.`,
      );
      return EXIT_OK;
    }
    case "disconnected":
      // Worth saying explicitly, because it is the one ending where this process
      // did not hand the lock back itself — and an operator who did not know
      // that would reasonably assume the Session was now stuck.
      deps.err(
        `actana session attach: the link to ${endpoint} dropped${end.error ? ` — ${end.error}` : ""}.`,
      );
      {
        const note = lockNoteOnDrop(authority, state);
        if (note !== undefined) deps.err(note);
      }
      return EXIT_FAILURE;
    case "signal":
      deps.err(`actana session attach: ${end.signal} — detached from session ${taskId}.`);
      return 128 + SIGNAL_NUMBERS[end.signal];
    case "link-error":
      deps.err(`actana session attach: ${end.message}`);
      return EXIT_FAILURE;
  }
}

/**
 * What a dropped link meant for *this* Session's lock — which depends entirely
 * on whether this connection was the one holding it.
 *
 * D7's release-on-drop is about the locks the dropped connection held, so an
 * attach that held none has nothing to report as freed. Saying it anyway is
 * wrong twice over in the operator's favour: this connection released nothing,
 * and the Session is still held by whoever actually has it. `no-lock-table` gets
 * no line at all — that Core arbitrates no writes, so a drop changes nothing
 * there is a word for.
 */
function lockNoteOnDrop(authority: AttachAuthority, state: SessionState): string | undefined {
  if (state.lockLost) {
    return "This attach had already lost the write lock, so the Session stays held by the client that took it.";
  }
  switch (authority) {
    case "held":
      return "The Core releases a dropped connection's Session locks, so this one is claimable again.";
    case "held-by-another":
      return "This attach never held the write lock, so the Session stays held by the client that does.";
    case "not-claimed":
      return "This attach never claimed the write lock (--read-only), so the drop leaves the Session's lock as it was.";
    case "no-lock-table":
      return undefined;
  }
}

/** Whichever of two indices comes first, ignoring the ones that are not there. */
function firstOf(a: number, b: number): number {
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

/**
 * Give the lock back, best effort. A teardown must not fail on the way out, and
 * a release that failed has been performed by the Core anyway the moment this
 * connection closes (D7).
 */
async function releaseQuietly(attached: SessionAttachment): Promise<void> {
  try {
    await attached.release();
  } catch {
    // The link is already gone, or the lock already moved. Either way this
    // Session is not this process's to hold any more.
  }
}

/** Why an attach never opened, in the vocabulary the gateway already speaks. */
function attachFailure(endpoint: string, err: unknown): string {
  if (err instanceof SessionGatewayError) return err.message;
  return `${endpoint} did not attach — ${messageOf(err)}`;
}

/** Run a teardown step that has no business throwing, and survive it if it does. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // A disposer or a socket close that throws must not skip the ones after it
    // — one of those is the raw-mode restore.
  }
}

/** An error's message, never its inputs — see the header of `actana-cli.ts`. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
