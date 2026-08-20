// The system port's *shape*, on its own so both halves of `actana` can name it.
//
// The implementation is not here and deliberately so: `nodeActanaSystem()`
// lives in `packages/cli/src/actana-system.ts`, where it drives `systemctl`,
// `launchctl`, `loginctl` and vendor Harness installers with a real
// subprocess. What is here is the type those callers agree on, because two
// programs on either side of the daemon/CLI line take one:
//
//   - the `actana` CLI's operator verbs, which pass the real port;
//   - the Core daemon's `HarnessInstallService`, which serves the Panel's
//     "install this Harness" frame and passes its own non-interactive one
//     (`packages/core/src/core-harness-system.ts`).
//
// A type has no runtime, so naming it here puts no subprocess anywhere near
// the daemon's graph or the published CLI's — the split #288 D1 needed.

/** The outcome of a captured command run. */
export type CommandResult = {
  /** Exit status. 127 stands in for "could not be started at all". */
  status: number;
  stdout: string;
  stderr: string;
};

export type ActanaSystem = {
  /**
   * Run a command and capture its output. Never throws: a missing binary
   * comes back as a non-zero status, because "systemd is not on this machine"
   * is a case the CLI reports rather than crashes on.
   */
  run(command: string, args: string[]): CommandResult;
  /** Run a command with the operator's terminal attached; returns its exit code. */
  passthrough(command: string, args: string[]): Promise<number>;
  /** Resolve true once something accepts a TCP connection on the port. */
  waitForPort(port: number, timeoutMs: number): Promise<boolean>;
  /** Ask a yes/no question on the terminal. Only called on a TTY. */
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  /**
   * Signal a process. False when there is no such process, or it is not ours.
   *
   * Used to nudge a running daemon into re-probing agent availability; a false
   * here is a slower refresh, never an error.
   */
  signal(pid: number, signal: NodeJS.Signals): boolean;
};
