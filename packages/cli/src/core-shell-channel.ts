// The link `actana core shell` runs a shell over (#129 D10, D11).
//
// The second seam in this package after `core-probe.ts`, and the same shape for
// the same reason: one function builds the SDK client, and the command takes it
// as a dependency. That is what lets the terminal half — raw mode, signals,
// resize, the exit status — be exercised without a Core, which matters more
// here than anywhere else in the CLI, because the property this command must
// hold is *the terminal is restored on every exit path* and most of those paths
// are failures nobody can stage against a real machine on demand.
//
// **The SDK is untouched (D11).** Everything below is `@actana/sdk`'s existing
// PTY vocabulary — `spawn`, `write`, `resize`, `kill`, `onData`, `onExit` — with
// no TTY anywhere near it. The shell this opens is the Core's existing VM Shell
// Session spawn mode (`shellSession: true`): a free-form login shell on the
// Core's own machine, with no project root and no harness, which is exactly
// what F3 means by calling `core shell` the sanctioned escape hatch.

import { randomUUID } from "node:crypto";
import { CoreClient } from "@actana/sdk/core-client.ts";
import type { CoreRegistrationBlob } from "@actana/sdk/core-registration-blob.ts";
import type { Unsubscribe } from "./cli-terminal.ts";

/** How a remote shell ended. `signal` is the far side's, not this process's. */
export type CoreShellExit = { exitCode: number; signal?: number };

/**
 * One remote shell, as the command sees it.
 *
 * Narrower than a `CoreClient` on purpose: a shell is a byte stream, a size, an
 * ending and a way to hang up. Handing the command the whole client would let
 * the terminal half reach for Session locks and event subscriptions, and would
 * make the fake this is tested against a re-implementation of the SDK.
 */
export type CoreShellChannel = {
  /** The Core's id for this PTY. Only diagnostics read it. */
  readonly ptyId: string;
  /** Keystrokes to the remote shell, in the order they were typed. */
  write(data: string): Promise<void>;
  /** Tell the remote PTY the terminal's new size. */
  resize(cols: number, rows: number): Promise<void>;
  /** Bytes from the remote shell. */
  onData(cb: (data: string) => void): Unsubscribe;
  /** The remote shell exited — this is where the CLI's exit status comes from. */
  onExit(cb: (exit: CoreShellExit) => void): Unsubscribe;
  /** The link went away underneath. Not fired by {@link close}. */
  onDisconnected(cb: (info: { error?: string }) => void): Unsubscribe;
  /** Best-effort: end the remote shell. For a teardown the far side did not ask for. */
  kill(): Promise<void>;
  /** Hang up. Idempotent, and never throws. */
  close(): void;
};

/** How `core shell` opens a shell. Injected, so the command is testable. */
export type OpenCoreShellFn = (
  blob: CoreRegistrationBlob,
  opts: { cols: number; rows: number; connectTimeoutMs: number },
) => Promise<CoreShellChannel>;

/**
 * The task id a CLI shell spawns under.
 *
 * Fresh per invocation, and deliberately not a real Session: a `shellSession`
 * spawn takes a task id because every PTY on a Core is keyed by one, not
 * because there is a task. A random id also means two `actana core shell`
 * invocations against one Core never collide on the Session write lock (ADR
 * 0024 D6) — each holds its own, which is the whole of this command's
 * interaction with #140's connection model.
 */
export function shellTaskId(): string {
  return `cli_shell_${randomUUID()}`;
}

/**
 * Open a shell on a Core: connect, spawn a login shell, hand back the stream.
 *
 * The failure path closes the client itself. A caller that got a rejection has
 * nothing to hang up, and a half-open client left behind by a spawn that failed
 * is a socket the Core has to time out.
 */
export const openCoreShell: OpenCoreShellFn = async (blob, opts) => {
  const client = CoreClient.fromRegistrationBlob(blob, {
    connectTimeoutMs: opts.connectTimeoutMs,
    requestTimeoutMs: opts.connectTimeoutMs,
  });

  let ptyId: string;
  try {
    await client.connect();
    // `command` omitted is the Core's "interactive login shell" — the operator
    // gets their own shell, rc files and all, rather than something this CLI
    // chose for them.
    ({ ptyId } = await client.spawn({
      shellSession: true,
      taskId: shellTaskId(),
      cols: opts.cols,
      rows: opts.rows,
    }));
  } catch (err) {
    client.close();
    throw err;
  }

  // No `ptySubscribe` here: a Core subscribes the connection that spawned a PTY
  // before it answers the spawn (issue 142), precisely so the first bytes — the
  // shell's prompt — are not lost in the round trip a subscribe would take.
  // Asking again would replay nothing and race the banner.

  const forPty = <T extends { ptyId: string }>(cb: (frame: T) => void) => (frame: T) => {
    if (frame.ptyId === ptyId) cb(frame);
  };

  return {
    ptyId,
    write: (data) => client.write(ptyId, data).then(() => undefined),
    resize: (cols, rows) => client.resize(ptyId, cols, rows).then(() => undefined),
    onData: (cb) => client.onData(forPty((frame) => cb(frame.data))),
    onExit: (cb) =>
      client.onExit(forPty((frame) => cb({ exitCode: frame.exitCode, signal: frame.signal }))),
    onDisconnected: (cb) => client.onDisconnected(cb),
    kill: () => client.kill(ptyId).then(() => undefined),
    close: () => client.close(),
  };
};
