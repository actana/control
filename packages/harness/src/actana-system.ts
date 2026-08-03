// The system port — everything the `actana` CLI does that is not the
// filesystem: running `systemctl` / `loginctl` / `journalctl`, waiting for the
// daemon's port to answer, and asking the operator a yes/no question.
//
// It exists so the setup and lifecycle flows can be exercised on a machine
// with no systemd and no daemon. Filesystem work is NOT behind this port —
// tests run those against a temp home, which is both simpler and a stronger
// assertion than a fake.

import * as net from "node:net";
import * as readline from "node:readline";
import { spawnSync, spawn } from "node:child_process";

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

/** How often {@link ActanaSystem.waitForPort} retries. */
const PORT_POLL_MS = 250;

/** Per-attempt connect timeout — shorter than the poll interval's patience. */
const PORT_CONNECT_TIMEOUT_MS = 1_000;

/** The real system port. */
export function nodeActanaSystem(): ActanaSystem {
  return {
    run(command, args) {
      const result = spawnSync(command, args, { encoding: "utf8" });
      if (result.error || result.status === null) {
        return {
          status: 127,
          stdout: result.stdout ?? "",
          stderr: result.error?.message ?? result.stderr ?? "",
        };
      }
      return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },

    passthrough(command, args) {
      return new Promise((resolve) => {
        const child = spawn(command, args, { stdio: "inherit" });
        child.on("error", (err) => {
          console.error(`[actana] could not run ${command}: ${err.message}`);
          resolve(127);
        });
        // A signalled exit (Ctrl-C out of `journalctl -f`) is the operator
        // ending it deliberately, not a failure.
        child.on("exit", (code, signal) => resolve(signal ? 0 : (code ?? 1)));
      });
    },

    async waitForPort(port, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (await tryConnect(port)) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, PORT_POLL_MS));
      }
    },

    confirm(question, defaultYes) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      return new Promise((resolve) => {
        rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `, (answer) => {
          rl.close();
          const trimmed = answer.trim().toLowerCase();
          if (trimmed === "") resolve(defaultYes);
          else resolve(trimmed === "y" || trimmed === "yes");
        });
      });
    },

    signal(pid, signal) {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        // ESRCH (gone) and EPERM (someone else's) are both "cannot nudge it",
        // and the caller's fallback — waiting for the next probe tick — is the
        // same answer to either.
        return false;
      }
    },
  };
}

/** One connect attempt against the loopback interface. */
function tryConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PORT_CONNECT_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}
