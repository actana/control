// What the CLI needs from the world, as one injected bag.
//
// The same shape `packages/core/src/actana-cli.ts` uses, and for the same
// reason: `runActanaCli` takes every side effect as a dependency and returns an
// exit code instead of calling `process.exit`, so dispatch, flag validation,
// output and exit codes are all exercised by unit tests rather than by a
// subprocess. `actana-cli-entry.ts` is the only file that knows about
// `process`.

import type { CoreProbeFn } from "./core-probe.ts";
import type { CliTerminal } from "./cli-terminal.ts";
import type { OpenCoreShellFn } from "./core-shell-channel.ts";
import type { CoreConnectFn } from "./core-connection.ts";
import type { OpenSessionGateway } from "./session-gateway.ts";
import type { OpenSessionAttachFn } from "./session-attach-channel.ts";

export type ActanaCliDeps = {
  /** `process.argv.slice(2)`. */
  argv: string[];
  env: NodeJS.ProcessEnv;
  home: string;
  /** Where ordinary output goes. One call per line; the line has no newline on it. */
  out: (line: string) => void;
  /** Where errors and diagnostics go. */
  err: (line: string) => void;
  /**
   * Where `--verbose` goes, when it is on.
   *
   * A separate sink rather than a boolean on {@link out} because verbose output
   * is a diagnostic — it belongs on stderr, where it cannot corrupt the stdout
   * a `--json` consumer is parsing. **Nothing that reaches here has ever held a
   * credential**: see the module header of `actana-cli.ts`.
   */
  verbose: (line: string) => void;
  /** Read stdin to end. Only called when a verb was actually told to read it. */
  readStdin: () => Promise<string>;
  /**
   * Whether stdin is a terminal. `actana core add <name>` with no file and no
   * pipe would otherwise sit waiting for a paste with no prompt, which reads as
   * a hang.
   */
  stdinIsTty: boolean;
  /** How `core status` reaches a Core. See `core-probe.ts`. */
  probe: CoreProbeFn;
  /**
   * How every other noun reaches a Core: dial, and hand back a connected
   * client. See `core-connection.ts`.
   *
   * Separate from {@link probe} rather than replacing it. `core status` asks one
   * question of the handshake and sends no request frames at all, and a verb
   * that reports whether a Core is reachable should not be built on a helper
   * that refuses to hand it a client when the Core is on another train.
   */
  connect: CoreConnectFn;
  /** How the `session` noun reaches a Core. See `session-gateway.ts`. */
  openSessions: OpenSessionGateway;
  /** Epoch ms. Only the bearer-expiry line reads it. */
  now: () => number;
  /**
   * The operator's terminal — raw mode, keystrokes, size, signals.
   *
   * Injected for the same reason as everything above it, and with more riding
   * on it: `core shell` must restore raw mode on every exit path, and a fake
   * terminal is the only way a test can assert that about a dropped connection
   * or a signal. Commands that only print lines never touch it. See
   * `cli-terminal.ts` (#129 D11).
   */
  terminal: CliTerminal;
  /** How `core shell` opens a shell on a Core. See `core-shell-channel.ts`. */
  openShell: OpenCoreShellFn;
  /**
   * How `session attach` reaches a running Session — and claims its write lock
   * on the way in. See `session-attach-channel.ts` (#163, ADR 0024 D3–D7).
   *
   * Separate from {@link openSessions} rather than a verb on the gateway,
   * because the two are different lifetimes: a gateway is opened per verb, hands
   * back plain data and is closed on the way out, while an attach is a live
   * stream *and* a lock held for exactly as long as one connection is open.
   */
  openAttach: OpenSessionAttachFn;
};
