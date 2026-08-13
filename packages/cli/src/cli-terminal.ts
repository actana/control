// The operator's terminal, as one injected surface (#129 D11).
//
// **D11 in one file.** *The SDK gets programmatic I/O, never a TTY — raw mode
// and terminal handling belong to the CLI alone.* Everything a real interactive
// shell needs from the local terminal is declared here as {@link CliTerminal}
// and implemented once in {@link terminalFromProcess}; `@actana/sdk` never sees
// a TTY, a signal, a raw-mode call or a `SIGWINCH`, and `core-shell.ts` drives
// this type rather than `process`.
//
// It is a surface rather than direct `process` access for the reason the rest of
// this package takes its side effects as dependencies: raw mode is the one thing
// this CLI does that can leave an operator's terminal unusable if it goes wrong,
// and "is it restored on the path where the connection drops?" has to be a
// question a unit test can answer. A fake terminal answers it in milliseconds; a
// real one cannot be asserted about at all.
//
// {@link terminalFromProcess} takes the process object as an argument rather
// than reading the global, so `actana-cli-entry.ts` stays the only module that
// knows about `process` — and so the real implementation, raw-mode bookkeeping
// and all, is itself testable against a fake.

import { StringDecoder } from "node:string_decoder";

/** Undo a listener registration. */
export type Unsubscribe = () => void;

/** The terminal size a PTY is told about. */
export type TerminalSize = { cols: number; rows: number };

/** The signals a long-running command has to put down its terminal for. */
export type TerminalSignal = "SIGINT" | "SIGTERM";

/**
 * What a command that holds the terminal needs from it.
 *
 * Deliberately small: input, output, size, raw mode, and the two signals that
 * end a session. A command that wants more than this is a command that has
 * started to reimplement a terminal emulator, which is the Panel's job and not
 * this one's.
 */
export type CliTerminal = {
  /** Whether this really is a terminal on both halves — input *and* output. */
  isTty: boolean;
  /** The current size. Read on every resize rather than cached. */
  size(): TerminalSize;
  /**
   * Enter or leave raw mode.
   *
   * Raw mode is what makes a remote shell a shell: it turns off local echo,
   * line buffering and — the point of this whole command — `ISIG`, so `Ctrl-C`
   * arrives as the byte `0x03` on stdin to be forwarded to the remote process
   * instead of raising `SIGINT` against this CLI. See `core-shell.ts`.
   *
   * May throw: a terminal can refuse. Callers treat that as a failure to start,
   * never as something to continue past.
   */
  setRawMode(raw: boolean): void;
  /** Keystrokes, decoded. Never fires before {@link setRawMode} has been called. */
  onInput(cb: (data: string) => void): Unsubscribe;
  /** The terminal was resized. Read the new size from {@link size}. */
  onResize(cb: () => void): Unsubscribe;
  /** A signal arrived. */
  onSignal(signal: TerminalSignal, cb: () => void): Unsubscribe;
  /** Bytes straight to stdout — no newline appended, unlike `deps.out`. */
  write(data: string): void;
};

/**
 * The part of a Node process this module touches.
 *
 * Structural rather than `NodeJS.Process` so a test can pass an object it
 * wrote in ten lines. Methods rather than function-typed properties, because
 * the real streams declare these as overloaded methods and only method syntax
 * is assignable from one.
 */
export type ProcessLike = {
  stdin: {
    isTTY?: boolean | undefined;
    setRawMode?(raw: boolean): unknown;
    resume(): unknown;
    pause(): unknown;
    on(event: "data", cb: (chunk: Buffer | string) => void): unknown;
    off(event: "data", cb: (chunk: Buffer | string) => void): unknown;
  };
  stdout: {
    isTTY?: boolean | undefined;
    columns?: number | undefined;
    rows?: number | undefined;
    write(data: string): unknown;
    on(event: "resize", cb: () => void): unknown;
    off(event: "resize", cb: () => void): unknown;
  };
  on(event: TerminalSignal, cb: () => void): unknown;
  off(event: TerminalSignal, cb: () => void): unknown;
  once(event: "exit", cb: () => void): unknown;
};

/**
 * What a PTY is told when the local terminal will not say.
 *
 * 80×24 is the VT100 default every program on the far side already copes with,
 * and it is only reachable when `isTty` is true but `columns` is not set —
 * which is a terminal misreporting itself, not an ordinary pipe.
 */
export const FALLBACK_SIZE: TerminalSize = { cols: 80, rows: 24 };

/**
 * The real terminal, bound to a process.
 *
 * The one piece of state it keeps is the last-resort restore: the *first* time
 * raw mode is entered, an `exit` hook goes on the process that puts the
 * terminal back. Nothing above it is allowed to rely on that hook — the command
 * restores in a `finally`, on both signals and on a dropped link — but a
 * process can still die by a route no `finally` covers (an uncaught throw in a
 * stray listener, a bug in this file), and the cost of that is an operator
 * staring at a shell with no echo and no line editing. It is a synchronous hook
 * with a single `try`, which is all an exit handler is allowed to be.
 */
export function terminalFromProcess(proc: ProcessLike): CliTerminal {
  let lastResortInstalled = false;

  const restoreQuietly = () => {
    try {
      proc.stdin.setRawMode?.(false);
    } catch {
      // Nothing useful is left to do about it: the process is on its way out,
      // and a throw from an exit hook replaces one bad outcome with a worse one.
    }
  };

  return {
    // Both halves, because a shell needs to read keystrokes *and* paint. A
    // piped stdin with a TTY stdout has no raw mode to enter, and a TTY stdin
    // redirected into a file has no size to propagate.
    isTty: Boolean(proc.stdin.isTTY) && Boolean(proc.stdout.isTTY),

    size: () => ({
      cols: proc.stdout.columns ?? FALLBACK_SIZE.cols,
      rows: proc.stdout.rows ?? FALLBACK_SIZE.rows,
    }),

    setRawMode: (raw) => {
      if (raw && !lastResortInstalled) {
        lastResortInstalled = true;
        proc.once("exit", restoreQuietly);
      }
      proc.stdin.setRawMode?.(raw);
      // Resuming is what starts delivery; pausing on the way out is what lets
      // the process end — an stdin with a live `data` listener holds the event
      // loop open, and a CLI that has printed its last line and will not exit
      // reads exactly like the hang this command must not produce.
      if (raw) proc.stdin.resume();
      else proc.stdin.pause();
    },

    onInput: (cb) => {
      // A keystroke is bytes, and a multi-byte character can arrive split
      // across two chunks — an accented letter, a CJK character, an emoji.
      // Decoding per chunk with `toString()` would send the far side two
      // replacement characters instead of the letter that was typed, so the
      // decoder holds the tail of a partial sequence until the rest lands.
      const decoder = new StringDecoder("utf8");
      const listener = (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
        if (text.length > 0) cb(text);
      };
      proc.stdin.on("data", listener);
      return () => proc.stdin.off("data", listener);
    },

    onResize: (cb) => {
      proc.stdout.on("resize", cb);
      return () => proc.stdout.off("resize", cb);
    },

    onSignal: (signal, cb) => {
      proc.on(signal, cb);
      return () => proc.off(signal, cb);
    },

    write: (data) => {
      proc.stdout.write(data);
    },
  };
}

/**
 * A terminal that is not one — for every command that does not hold a TTY.
 *
 * `runActanaCli` takes one terminal for the whole run, so the nouns that only
 * print lines need something to be handed. This refuses raw mode rather than
 * silently accepting it: a command that reached for raw mode through this
 * object has a bug, and the throw says so at the call site instead of leaving
 * an operator to discover it.
 */
export function nonInteractiveTerminal(write: (data: string) => void = () => {}): CliTerminal {
  const noop: Unsubscribe = () => {};
  return {
    isTty: false,
    size: () => FALLBACK_SIZE,
    setRawMode: () => {
      throw new Error("this terminal is not interactive");
    },
    onInput: () => noop,
    onResize: () => noop,
    onSignal: () => noop,
    write,
  };
}
