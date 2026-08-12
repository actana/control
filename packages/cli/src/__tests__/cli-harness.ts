// A CLI run, in memory.
//
// `runActanaCli` takes every side effect as a dependency, so a test is a bag of
// fakes and an exit code — no subprocess, no build, no Core. What it does need
// is a real filesystem, because the blob registry's whole subject is one: file
// modes, a directory that may not exist, and `XDG_CONFIG_HOME` are not things a
// stub filesystem would test.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runActanaCli } from "../actana-cli.ts";
import { registryPaths, type RegistryPaths } from "../blob-registry.ts";
import type { CoreProbe, CoreProbeFn } from "../core-probe.ts";
import { nonInteractiveTerminal, type CliTerminal, type TerminalSignal } from "../cli-terminal.ts";
import type { OpenCoreShellFn } from "../core-shell-channel.ts";

/** One run's captured output, plus the exit code. */
export type CliRun = {
  code: number;
  /** stdout, one entry per line. */
  out: string[];
  /** stderr, one entry per line — errors and `--verbose` alike. */
  err: string[];
  /** Everything either stream saw, joined. What the "never logs a blob" sweep reads. */
  all: string;
};

export type CliFixture = {
  /** `XDG_CONFIG_HOME`, a fresh temporary directory per fixture. */
  configHome: string;
  /** A home directory that is deliberately *not* where the registry lands. */
  home: string;
  paths: RegistryPaths;
  /** Run `actana` with these arguments. */
  run: (argv: string[], opts?: RunOptions) => Promise<CliRun>;
  cleanup: () => void;
};

export type RunOptions = {
  /** Extra environment on top of `XDG_CONFIG_HOME`. */
  env?: NodeJS.ProcessEnv;
  /** What `readStdin` resolves to. Setting it also makes stdin not a TTY. */
  stdin?: string;
  /** Force the TTY answer. Defaults to false when `stdin` is set, true otherwise. */
  stdinIsTty?: boolean;
  /** What `core status` gets back, or a throw. */
  probe?: CoreProbeFn;
  now?: number;
  /**
   * The terminal `core shell` is handed. Defaults to one that is not a TTY, so
   * every other verb's test runs against the same terminal a pipe would give it.
   */
  terminal?: CliTerminal;
  /** What `core shell` gets back, or a throw. */
  openShell?: OpenCoreShellFn;
};

/** A probe that answers like a healthy Core on the current protocol. */
export function healthyProbe(overrides: Partial<CoreProbe> = {}): CoreProbeFn {
  return async () => ({
    coreId: "core_test",
    protocolVersion: "1.0.0",
    compatible: true,
    multiConnection: true,
    bearerExpiresAt: Date.UTC(2030, 0, 1),
    ...overrides,
  });
}

export function makeCliFixture(): CliFixture {
  const root = mkdtempSync(path.join(tmpdir(), "actana-cli-"));
  const configHome = path.join(root, "xdg");
  const home = path.join(root, "home");
  const paths = registryPaths({ XDG_CONFIG_HOME: configHome }, home);

  return {
    configHome,
    home,
    paths,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    run: async (argv, opts = {}) => {
      const out: string[] = [];
      const err: string[] = [];
      const verboseOn = argv.includes("--verbose");
      const code = await runActanaCli({
        argv,
        env: { XDG_CONFIG_HOME: configHome, ...opts.env },
        home,
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        verbose: verboseOn ? (line) => err.push(`actana: ${line}`) : () => {},
        readStdin: async () => opts.stdin ?? "",
        stdinIsTty: opts.stdinIsTty ?? opts.stdin === undefined,
        probe:
          opts.probe ??
          (async () => {
            throw new Error("this test did not expect to dial a Core");
          }),
        now: () => opts.now ?? Date.UTC(2026, 7, 12),
        // Terminal bytes are swept for credentials alongside the line sinks, so
        // a `core shell` that ever echoed a blob back would fail the same test
        // every other verb does.
        terminal: opts.terminal ?? nonInteractiveTerminal((data) => out.push(data)),
        openShell:
          opts.openShell ??
          (async () => {
            throw new Error("this test did not expect to open a shell");
          }),
      });
      return { code, out, err, all: [...out, ...err].join("\n") };
    },
  };
}

/**
 * A registration blob whose every secret field is a sentinel.
 *
 * The strings are unmistakable in a haystack and share no substring with
 * anything the CLI legitimately prints, which is what lets
 * `never-logs-a-blob.test.ts` assert absence rather than assert a format.
 */
export const SENTINEL_CA = "-----BEGIN CERTIFICATE-----CA-SENTINEL-QQQ-----END CERTIFICATE-----";
export const SENTINEL_CERT = "-----BEGIN CERTIFICATE-----CLIENT-SENTINEL-ZZZ-----END CERTIFICATE-----";
export const SENTINEL_KEY = "-----BEGIN PRIVATE KEY-----KEY-SENTINEL-WWW-----END PRIVATE KEY-----";
export const SENTINEL_BEARER = "bearer-SENTINEL-YYY.signature-SENTINEL-XXX";

/** Every secret the sentinel blob carries, for an absence sweep. */
export const SENTINELS = [SENTINEL_CA, SENTINEL_CERT, SENTINEL_KEY, SENTINEL_BEARER];

/**
 * A terminal that behaves like one, without being one.
 *
 * What `core shell` must be tested against: raw mode is recorded rather than
 * performed, keystrokes and resizes and signals are things a test *does*, and
 * the promise says when the command has finished wiring itself up — which is
 * the only moment from which sending it a `SIGINT` proves anything.
 */
export type FakeTerminal = CliTerminal & {
  /** Every `setRawMode` call, in order. `[true, false]` is a session done right. */
  rawModeCalls: boolean[];
  /** Whether the terminal is in raw mode *now*. False after a restore. */
  isRaw: () => boolean;
  /** Everything written to it, joined — the remote shell's bytes. */
  painted: () => string;
  /** Type at it. */
  type: (data: string) => void;
  /** Resize it, then fire the resize listeners. */
  resizeTo: (cols: number, rows: number) => void;
  /** Deliver a signal. */
  raise: (signal: TerminalSignal) => void;
  /** Resolves once the command has registered its signal handlers. */
  wired: Promise<void>;
  /** Make the next `setRawMode` throw — a terminal that refuses. */
  breakRawMode: (err: Error) => void;
};

export function fakeTerminal(opts: { isTty?: boolean; cols?: number; rows?: number } = {}): FakeTerminal {
  const rawModeCalls: boolean[] = [];
  const written: string[] = [];
  const input = new Set<(data: string) => void>();
  const resized = new Set<() => void>();
  const signalled = new Map<TerminalSignal, Set<() => void>>();
  let size = { cols: opts.cols ?? 80, rows: opts.rows ?? 24 };
  let rawModeError: Error | null = null;

  // The last thing `core shell` wires is its two signal handlers, so a test
  // that awaits this is guaranteed the whole session is live — not sleeping and
  // hoping, which is how this kind of test goes flaky.
  let announceWired = () => {};
  const wired = new Promise<void>((resolve) => {
    announceWired = resolve;
  });

  return {
    isTty: opts.isTty ?? true,
    rawModeCalls,
    wired,
    isRaw: () => rawModeCalls.at(-1) === true,
    painted: () => written.join(""),
    breakRawMode: (err) => {
      rawModeError = err;
    },
    size: () => ({ ...size }),
    setRawMode: (raw) => {
      if (rawModeError) throw rawModeError;
      rawModeCalls.push(raw);
    },
    onInput: (cb) => {
      input.add(cb);
      return () => input.delete(cb);
    },
    onResize: (cb) => {
      resized.add(cb);
      return () => resized.delete(cb);
    },
    onSignal: (signal, cb) => {
      const set = signalled.get(signal) ?? new Set();
      set.add(cb);
      signalled.set(signal, set);
      if (signalled.size === 2) announceWired();
      return () => set.delete(cb);
    },
    write: (data) => {
      written.push(data);
    },
    type: (data) => {
      for (const cb of [...input]) cb(data);
    },
    resizeTo: (cols, rows) => {
      size = { cols, rows };
      for (const cb of [...resized]) cb();
    },
    raise: (signal) => {
      for (const cb of [...(signalled.get(signal) ?? [])]) cb();
    },
  };
}

/** A base64 blob with the sentinel credentials in it. */
export function sentinelBlobText(endpoint = "wss://core.test:9444", label = "the-test-core"): string {
  return Buffer.from(
    JSON.stringify({
      endpoint,
      label,
      caCert: SENTINEL_CA,
      clientCert: SENTINEL_CERT,
      clientKey: SENTINEL_KEY,
      bearer: SENTINEL_BEARER,
    }),
    "utf8",
  ).toString("base64");
}
