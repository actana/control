// What the CLI needs from the world, as one injected bag.
//
// The same shape `packages/core/src/actana-cli.ts` uses, and for the same
// reason: `runActanaCli` takes every side effect as a dependency and returns an
// exit code instead of calling `process.exit`, so dispatch, flag validation,
// output and exit codes are all exercised by unit tests rather than by a
// subprocess. `actana-cli-entry.ts` is the only file that knows about
// `process`.

import type { CoreProbeFn } from "./core-probe.ts";
import type { OpenSessionGateway } from "./session-gateway.ts";

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
  /** How the `session` noun reaches a Core. See `session-gateway.ts`. */
  openSessions: OpenSessionGateway;
  /** Epoch ms. Only the bearer-expiry line reads it. */
  now: () => number;
};
