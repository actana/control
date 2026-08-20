// The machine half of a CLI run, in memory.
//
// `actana` is one program with one dependency bag (#288), so every test that
// builds one has to fill both halves — the streams and the Core dial, and the
// system port, the release fetcher and the daemon loader. This file is the
// second half, so that a suite about the client nouns does not have to invent a
// fake `systemctl`, and a suite about `setup` does not have to invent a fake
// terminal.
//
// Both directions refuse rather than answer. A `passthrough` that returned 0 to
// a suite that never meant to run anything would be a test passing against a
// stub that said yes; every stub here that a suite has not deliberately
// replaced throws with the name of what it was asked to do.

import { spawnSync } from "node:child_process";
import type { ActanaCliDeps } from "../cli-deps.ts";
import type { ActanaSystem, CommandResult } from "../actana-system.ts";
import type { ReleaseFetcher } from "../actana-release.ts";
import { nonInteractiveTerminal } from "../cli-terminal.ts";

/** The `ActanaSystem` a suite drives `systemctl` and `tar` through. */
export type FakeSystem = ActanaSystem & {
  /** Every `run`/`passthrough` this system was asked for, in order. */
  calls: string[][];
  signals: Array<[number, string]>;
  /** Answers `confirm` in order; the last answer repeats. */
  answers: boolean[];
  /** Exit code for `passthrough` when the command line contains the key. */
  passthroughFailures: Record<string, number>;
  /** True when `waitForPort` should say the daemon came up. */
  listening: boolean;
};

/**
 * A system port with a scripted answer table.
 *
 * `overrides` is keyed by a command-line prefix so a test can say what
 * `systemctl show` reports without having to model the rest of systemd.
 * `tar` is faked by nobody — see the note at the call site in
 * `actana-machine-cli.test.ts`: the update path unpacks a real archive.
 */
export function fakeSystem(
  overrides: Record<string, CommandResult> = {},
  realRun?: (command: string, args: string[]) => CommandResult,
): FakeSystem {
  const calls: string[][] = [];
  const signals: Array<[number, string]> = [];
  const system: FakeSystem = {
    calls,
    signals,
    answers: [],
    passthroughFailures: {},
    listening: true,
    run(command, args) {
      calls.push([command, ...args]);
      const key = [command, ...args].join(" ");
      for (const [prefix, result] of Object.entries(overrides)) {
        if (key.startsWith(prefix)) return result;
      }
      if (realRun) {
        const real = realRun(command, args);
        if (real) return real;
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    async passthrough(command, args) {
      calls.push([command, ...args]);
      const line = args.join(" ");
      for (const [needle, code] of Object.entries(system.passthroughFailures)) {
        if (line.includes(needle)) return code;
      }
      return 0;
    },
    async waitForPort() {
      return system.listening;
    },
    async confirm() {
      return system.answers.length > 1 ? (system.answers.shift() ?? true) : (system.answers[0] ?? true);
    },
    signal(pid, sig) {
      signals.push([pid, sig]);
      return true;
    },
  };
  return system;
}

/**
 * A `realRun` that runs `tar` for real and fakes everything else.
 *
 * `tar` is faked by nobody: the install and update paths unpack a tarball built
 * moments ago by `release-fixture.ts`, so the archive handling under test is
 * the archive handling that runs on an operator's machine. `systemctl` is a
 * different matter — there is none on a test runner.
 */
export function realTar(command: string, args: string[]): CommandResult {
  if (command !== "tar") return null as unknown as CommandResult;
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status ?? 127,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** A release fetcher no test asked for. Reaching it is the failure. */
export function refusingFetcher(): ReleaseFetcher {
  return {
    async fetchText(url) {
      throw new Error(`this test did not expect to fetch ${url}`);
    },
    async download(url) {
      throw new Error(`this test did not expect to download ${url}`);
    },
  };
}

/** The machine half of {@link ActanaCliDeps}, inert unless a suite replaces it. */
export type MachineHalf = Pick<
  ActanaCliDeps,
  | "hostname"
  | "networkInterfaces"
  | "platform"
  | "arch"
  | "user"
  | "uid"
  | "installRoot"
  | "interactive"
  | "system"
  | "fetcher"
  | "debug"
  | "probeHarnesses"
  | "runDaemon"
>;

/** The machine half, filled with fakes that refuse to do anything real. */
export function stubMachineHalf(over: Partial<MachineHalf> = {}): MachineHalf {
  return {
    hostname: "vm-1",
    networkInterfaces: { eth0: [{ address: "10.0.0.5", family: "IPv4", internal: false }] },
    platform: "linux",
    arch: "x64",
    user: "op",
    uid: 501,
    // Deliberately a path that is not an extracted tarball: a client-noun suite
    // that reached `setup` would otherwise install something.
    installRoot: "",
    interactive: false,
    system: fakeSystem(),
    fetcher: refusingFetcher(),
    debug: () => {},
    probeHarnesses: () => ({ "claude-code": { status: "available", version: "2.1.0" } }),
    runDaemon: async () => {
      throw new Error("this test did not expect to start a daemon");
    },
    ...over,
  };
}

/** The client half of {@link ActanaCliDeps}, for a suite about machine verbs. */
export type ClientHalf = Pick<
  ActanaCliDeps,
  | "outBytes"
  | "errBytes"
  | "verbose"
  | "readStdin"
  | "stdinIsTty"
  | "probe"
  | "connect"
  | "openSessions"
  | "openFiles"
  | "now"
  | "terminal"
  | "openShell"
  | "openAttach"
>;

/** The client half, filled with fakes that refuse to reach a Core. */
export function stubClientHalf(
  now: () => number = () => Date.UTC(2026, 7, 12),
): ClientHalf {
  const refuse = (what: string) => async () => {
    throw new Error(`this test did not expect to ${what}`);
  };
  return {
    outBytes: () => {},
    errBytes: () => {},
    verbose: () => {},
    readStdin: async () => "",
    stdinIsTty: false,
    probe: refuse("dial a Core"),
    connect: refuse("dial a Core"),
    openSessions: refuse("open a session gateway"),
    openFiles: refuse("open a file gateway"),
    now,
    terminal: nonInteractiveTerminal(),
    openShell: refuse("open a shell"),
    openAttach: refuse("attach to a session"),
  };
}
