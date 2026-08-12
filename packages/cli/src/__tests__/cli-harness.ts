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
