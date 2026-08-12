// `actana core shell` — the sanctioned escape hatch (#162, #129 D10).
//
// A real interactive shell on the Core, over the PTY transport the Panel
// already uses. F3 is allowed to call path confinement *an accident guard, not
// a security boundary* precisely because this command exists: anybody holding a
// valid blob for a Core already has that machine, and pretending otherwise
// would buy nothing except a worse story for the operator who needs to look at
// a disk that is full.
//
// Four things make it a shell rather than a pipe, and each is a trap this file
// is mostly written to keep out of:
//
//   1. **Raw mode is restored on every exit path.** Not the happy path — every
//      path. A CLI that dies without restoring leaves the operator with no echo
//      and no line editing in the shell they launched it from, and the next
//      thing they type is invisible. So: a `finally` around the whole session,
//      `SIGINT` and `SIGTERM` handled rather than fatal, a dropped link treated
//      as an ending like any other, and — one layer down in `cli-terminal.ts` —
//      a process `exit` hook as the last resort for a route no `finally` covers.
//   2. **`Ctrl-C` reaches the remote process.** Raw mode turns off `ISIG`, so
//      `Ctrl-C` is no longer a signal against this CLI at all: it is the byte
//      `0x03` on stdin, and it is forwarded with every other byte by the same
//      one-line listener. There is no special case for it here, and there must
//      not be — a `Ctrl-C` that killed the CLI while the shell was live would
//      make it impossible to interrupt anything *on the Core*, which is the one
//      thing an escape hatch is for.
//   3. **Resize propagates.** `SIGWINCH` on this side becomes a `resize` frame,
//      so `vim` and `top` on the far side redraw at the size they are actually
//      being painted into.
//   4. **The remote exit status comes back as this process's.** `exit 3` in the
//      remote shell exits `actana core shell` 3; a remote process killed by a
//      signal exits `128 + signal`, the convention every shell already uses.
//
// **All of that is CLI-side (D11).** The SDK is handed no TTY, no signal and no
// raw-mode call: `core-shell-channel.ts` speaks its existing PTY vocabulary and
// `cli-terminal.ts` owns the terminal.
//
// This command holds a Core session for as long as it runs, which is fine now
// that #140 has landed — a Core serves many clients, so a shell left open in
// one window is no longer a connection that evicts the Panel in another.

import { resolveCore } from "./core-resolution.ts";
import { EXIT_FAILURE, EXIT_USAGE } from "./exit-codes.ts";
import type { RegistryPaths } from "./blob-registry.ts";
import type { ActanaCliDeps } from "./cli-deps.ts";
import type { ParsedArgs } from "./cli-args.ts";
import type { CliTerminal, Unsubscribe } from "./cli-terminal.ts";
import type { CoreShellChannel, CoreShellExit } from "./core-shell-channel.ts";

/** How long `core shell` waits for a Core to answer and hand back a shell. */
const SHELL_CONNECT_TIMEOUT_MS = 30_000;

/** The signal numbers behind the two names, for the `128 + n` exit convention. */
const SIGNAL_NUMBERS = { SIGINT: 2, SIGTERM: 15 } as const;

/**
 * How a shell session ended. Exactly one of these settles a run, and every one
 * of them goes through the same `finally` on the way out.
 */
type Ending =
  /** The remote shell exited. The only ending that carries a status worth returning. */
  | { kind: "exit"; exit: CoreShellExit }
  /** The link went away underneath — a Core restart, a network drop. */
  | { kind: "disconnected"; error?: string }
  /** This process was signalled. Not `Ctrl-C`, which never gets this far. */
  | { kind: "signal"; signal: "SIGINT" | "SIGTERM" }
  /** A frame could not be sent. The shell may be fine; this end of it is not. */
  | { kind: "link-error"; message: string };

/**
 * Where the remote shell left the cursor — the one thing this CLI has to know
 * about a byte stream it otherwise passes through untouched.
 */
type PaintState = { endedWithNewline: boolean };

/**
 * Raw mode, with the restore made unmissable.
 *
 * Idempotent in both directions and it never throws on the way out: it is
 * called from a `finally`, from two signal handlers and from an error path, and
 * a restore that threw would replace a usable terminal with an unusable one at
 * the exact moment nothing is left to catch it.
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
 * `actana core shell` — open a shell on the selected Core.
 *
 * Reads like the session it runs: refuse the things that cannot work, dial,
 * *then* take the terminal, and give it back before printing a word.
 */
export async function runCoreShell(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
): Promise<number> {
  // `--json` is a promise this verb cannot keep. Every other command's `--json`
  // means "stdout is a document"; here stdout is a terminal somebody is typing
  // into, and there is no document to emit. Saying so beats emitting the
  // shell's bytes and one JSON object at the end that no parser will reach.
  if (args.json) {
    deps.err("actana core shell: --json means nothing here — this verb hands you a terminal.");
    deps.err("`actana core status --json` is the machine-readable view of a Core.");
    return EXIT_USAGE;
  }

  const terminal = deps.terminal;
  if (!terminal.isTty) {
    deps.err("actana core shell: this is an interactive command and stdin/stdout are not a terminal.");
    deps.err("Run it from a terminal. To script a Core, use a Session rather than a shell.");
    return EXIT_USAGE;
  }

  const resolved = resolveCore({ paths, env: deps.env, home: deps.home, coreFlag: args.core });
  if (!resolved.ok) {
    deps.err(`actana core shell: ${resolved.error}`);
    return EXIT_FAILURE;
  }
  const { name, blob } = resolved.core;
  deps.verbose(`dialling ${blob.endpoint}`);

  // Dial before touching the terminal. A Core that is down, unreachable or
  // holding an expired bearer is the ordinary failure of this command, and it
  // has no business happening while the operator's terminal is in raw mode.
  const { cols, rows } = terminal.size();
  let channel: CoreShellChannel;
  try {
    channel = await deps.openShell(blob, { cols, rows, connectTimeoutMs: SHELL_CONNECT_TIMEOUT_MS });
  } catch (err) {
    deps.err(`actana core shell: ${blob.endpoint} did not open a shell — ${messageOf(err)}`);
    return EXIT_FAILURE;
  }
  deps.verbose(`shell ${channel.ptyId} on ${name ?? blob.endpoint}, ${cols}x${rows}`);

  const guard = new RawModeGuard(terminal);
  try {
    guard.enter();
  } catch (err) {
    // Nothing is in raw mode, so there is nothing to restore — but there is a
    // shell on the Core that was just spawned and would otherwise outlive a
    // command that never showed it to anybody.
    await killQuietly(channel);
    safely(() => channel.close());
    deps.err(`actana core shell: could not put this terminal into raw mode — ${messageOf(err)}`);
    return EXIT_FAILURE;
  }

  let end: Ending;
  const disposers: Unsubscribe[] = [];
  const painted: PaintState = { endedWithNewline: true };

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
    end = await runSession(terminal, channel, disposers, painted);
    // Hand the terminal back before touching the far side. What follows is a
    // round trip to a Core that may already be gone, and every millisecond of
    // it would be a millisecond the operator's terminal was still raw — which
    // on a `SIGTERM` means a request timeout's worth of unusable shell.
    releaseTerminal();
    // An ending that was not the remote shell's own exit leaves a login shell
    // running on the Core with nothing attached to it. Nobody can reattach —
    // the task id was random and is now gone — so it would sit there holding a
    // PTY until the Core restarted.
    if (end.kind === "signal" || end.kind === "link-error") await killQuietly(channel);
  } finally {
    // The guarantee, not the routine case: every path out of the `try` — the
    // remote exiting, a signal, a dropped link, a defect in any of the code
    // above — arrives here, and the terminal is restored before the socket is
    // closed so that even a `close` that throws leaves a usable one behind.
    releaseTerminal();
    safely(() => channel.close());
  }

  // Cooked again from here down, so it is safe to print lines.
  return report(deps, terminal, blob.endpoint, end, painted);
}

/**
 * Wire the terminal to the shell and wait for one of them to end it.
 *
 * Every listener registered here goes into `disposers`, which the caller's
 * `finally` drains — a listener that outlived the session would keep stdin's
 * `data` handler attached, and a process with a live stdin listener does not
 * exit.
 */
function runSession(
  terminal: CliTerminal,
  channel: CoreShellChannel,
  disposers: Unsubscribe[],
  painted: PaintState,
): Promise<Ending> {
  return new Promise<Ending>((resolve) => {
    let settled = false;
    const settle = (ending: Ending) => {
      // First ending wins. A remote exit is routinely followed by the link
      // closing, and a signal by both; re-resolving would be harmless here and
      // is guarded anyway, because "which ending do we report" is exactly the
      // question the exit status answers.
      if (settled) return;
      settled = true;
      resolve(ending);
    };

    // Remote → local. Straight to stdout, unmodified: this is a terminal
    // stream, and anything that re-wrapped or line-buffered it would break
    // every full-screen program on the far side.
    disposers.push(
      channel.onData((data) => {
        if (data.length > 0) painted.endedWithNewline = data.endsWith("\n");
        terminal.write(data);
      }),
    );
    disposers.push(channel.onExit((exit) => settle({ kind: "exit", exit })));
    disposers.push(channel.onDisconnected((info) => settle({ kind: "disconnected", error: info.error })));

    // Local → remote. **`Ctrl-C` is in here and has no special case.** In raw
    // mode it is the byte 0x03 like any other, and forwarding it is what lets
    // the operator interrupt a runaway process on the Core.
    disposers.push(
      terminal.onInput((data) => {
        void channel.write(data).catch((err: unknown) => {
          settle({ kind: "link-error", message: `the shell stopped accepting input — ${messageOf(err)}` });
        });
      }),
    );

    // `SIGWINCH`, as a resize frame. A failure here is not worth ending a
    // working session over: the shell keeps running, it is merely drawing at
    // the old size, and the next resize tries again.
    disposers.push(
      terminal.onResize(() => {
        const { cols, rows } = terminal.size();
        void channel.resize(cols, rows).catch(() => {});
      }),
    );

    // The two signals, handled rather than fatal — handled *because* the
    // default action is fatal, and a CLI killed by the default action never
    // reaches its `finally`. `Ctrl-C` does not arrive here: raw mode means the
    // terminal driver never raises it. What does is `kill` from another window,
    // a supervisor stopping this process, or a terminal closing.
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      disposers.push(terminal.onSignal(signal, () => settle({ kind: "signal", signal })));
    }
  });
}

/**
 * Turn an ending into an exit status, and say what happened when it was not the
 * shell's own doing.
 */
function report(
  deps: ActanaCliDeps,
  terminal: CliTerminal,
  endpoint: string,
  end: Ending,
  painted: PaintState,
): number {
  // A shell that ended mid-line — a dropped link lands wherever the last byte
  // fell, and a killed full-screen program leaves the cursor anywhere — would
  // otherwise have the operator's next prompt painted on top of it. Only when
  // it is needed: a clean `exit` ends with a newline already, and a blank line
  // after every session is its own small papercut.
  if (!painted.endedWithNewline) terminal.write("\r\n");

  switch (end.kind) {
    case "exit": {
      const { exitCode, signal } = end.exit;
      deps.verbose(
        signal ? `remote shell killed by signal ${signal}` : `remote shell exited ${exitCode}`,
      );
      // The status the ticket asks for, and the convention every shell shares:
      // a process killed by a signal reports `128 + n`. A status this CLI
      // cannot represent — nothing on the wire guarantees 0–255 — becomes a
      // plain failure rather than a number that means something else here.
      if (signal !== undefined && signal > 0) return clampStatus(128 + signal);
      return clampStatus(exitCode);
    }
    case "disconnected":
      deps.err(
        `actana core shell: the link to ${endpoint} dropped${end.error ? ` — ${end.error}` : ""}.`,
      );
      return EXIT_FAILURE;
    case "signal":
      // Reported on stderr because it is not the shell's own ending, and the
      // status says which signal — `130` for `SIGINT`, `143` for `SIGTERM`.
      deps.err(`actana core shell: ${end.signal} — closed the shell on ${endpoint}.`);
      return 128 + SIGNAL_NUMBERS[end.signal];
    case "link-error":
      deps.err(`actana core shell: ${end.message}`);
      return EXIT_FAILURE;
  }
}

/**
 * A remote exit status, as a status this process can actually exit with.
 *
 * Anything outside 0–255 is not a status a process can carry, and silently
 * truncating it would report a number the remote shell never chose.
 */
function clampStatus(code: number): number {
  if (!Number.isInteger(code) || code < 0 || code > 255) return EXIT_FAILURE;
  return code;
}

/** End the remote shell, best effort. A teardown must not fail on the way out. */
async function killQuietly(channel: CoreShellChannel): Promise<void> {
  try {
    await channel.kill();
  } catch {
    // The link is already gone, or the shell already exited. Either way the
    // PTY is not this process's problem any more.
  }
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
