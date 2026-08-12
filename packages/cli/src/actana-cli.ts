// `actana` — the client half (#129 D8, D9, D10).
//
// One command name, split by noun. `actana daemon` runs a Core and lives in
// `packages/core`; `actana core …`, and the `session` / `project` / `harness` /
// `events` nouns the rest of this phase adds, talk to one. **The published
// package carries the client subcommands only** — a `daemon` verb here would
// put a Node daemon, `better-sqlite3` and `node-pty` into the dependency graph
// of a program whose entire job is to need none of them, and it would mean two
// packages both claiming to be able to run a Core.
//
// The credential rule this file exists to hold, stated once:
//
//   **A blob is a credential and never reaches an output sink.** Not stdout,
//   not stderr, not `--verbose`, not an error message quoting the input that
//   failed to parse. The two mechanisms that make it true rather than
//   intended: `registration-blob-file.ts` is the only module that turns bytes
//   into a blob, and it reduces one to a {@link BlobSummary} (endpoint and
//   label — neither secret) for anything that prints; and
//   `src/__tests__/never-logs-a-blob.test.ts` runs every verb, with
//   `--verbose`, against a blob whose PEM material and bearer are known
//   sentinels, and fails if any byte of them appears in any output.
//
// `runActanaCli` takes its side effects as dependencies and returns an exit
// code rather than calling `process.exit` — the same shape as the Core's CLI,
// for the same reason: the whole verb surface is unit-testable.

import { parseArgs } from "./cli-args.ts";
import { registryPaths } from "./blob-registry.ts";
import { runCoreCommand } from "./core-command.ts";
import { CORE_BLOB_ENV } from "./core-resolution.ts";
import { EXIT_OK, EXIT_USAGE } from "./exit-codes.ts";
import type { ActanaCliDeps } from "./cli-deps.ts";
import manifest from "../package.json" with { type: "json" };

/** This CLI's version — the train's, read off the manifest the cut writes (ADR 0023 D3). */
export const CLI_VERSION: string = manifest.version;

/**
 * The nouns this phase reserves but has not built (#129 D10, and phase-3
 * guardrail 3 — *reserve `actana project cp` and `actana project files` in the
 * command tree before `--help` is written*).
 *
 * They are listed here rather than left to fall through to "unknown noun"
 * because the two answers differ in what the reader should do: a reserved noun
 * has a ticket number, and a typo does not.
 */
const RESERVED_NOUNS: Record<string, string> = {
  session: "start, ls, logs, resume, kill, send, attach — #160 and #163",
  project: "ls, add, browse, and later `cp` / `files` — #161 and #168",
  harness: "ls, install — #161",
  events: "tail — #161",
};

export const ROOT_HELP = `actana — drive AI coding agents across your Cores.

Usage
  actana <noun> <verb> [flags]

Nouns
  core      register, select and inspect the Cores this machine can reach

Reserved, landing later in this phase
  session   ${RESERVED_NOUNS.session}
  project   ${RESERVED_NOUNS.project}
  harness   ${RESERVED_NOUNS.harness}
  events    ${RESERVED_NOUNS.events}

Flags
  --core <name>   which registered Core to talk to
  --json          machine-readable output; every list command has it
  --verbose       explain the steps, on stderr. Never prints a blob.
  -h, --help      this text, or a noun's
  -V, --version   print this CLI's version

Which Core a command means, in this order
  1. --core <name>
  2. ${CORE_BLOB_ENV}       the blob itself, or a path to it (single-Core mode)
  3. the \`current\` pointer   what \`actana core use\` last selected

Running a Core is the other half of this command name: \`actana daemon\`, and the
rest of the machine-side lifecycle, ships with the Core itself.`;

/** Run the CLI. Returns the process exit code; never calls `process.exit`. */
export async function runActanaCli(deps: ActanaCliDeps): Promise<number> {
  const args = parseArgs(deps.argv);

  if (args.missingValue) {
    deps.err(`actana: ${args.missingValue} needs a value.`);
    return EXIT_USAGE;
  }
  if (args.unknown.length > 0) {
    deps.err(`actana: unknown flag ${args.unknown[0]}.`);
    deps.err("`actana --help` lists the flags this build knows.");
    return EXIT_USAGE;
  }

  if (args.version) {
    deps.out(`actana ${CLI_VERSION}`);
    return EXIT_OK;
  }

  const [noun] = args.positionals;

  if (noun === undefined) {
    deps.out(ROOT_HELP);
    // `actana` with nothing after it is a question, not a mistake: printing the
    // help and exiting 0 is what `--help` would have done, and there is nothing
    // for a script to have got wrong.
    return EXIT_OK;
  }

  const paths = registryPaths(deps.env, deps.home);

  switch (noun) {
    case "core":
      return runCoreCommand(deps, args, paths);
    case "help":
      deps.out(ROOT_HELP);
      return EXIT_OK;
    case "daemon":
      // Worth its own message rather than "unknown noun": somebody typing this
      // has the right command name and the wrong package, which is exactly the
      // confusion one binary name split by noun (#129 D8) can produce.
      deps.err("actana daemon: running a Core is not this package's half of `actana`.");
      deps.err("It ships with the Core itself — see INSTALL.md.");
      return EXIT_USAGE;
    default: {
      const reserved = RESERVED_NOUNS[noun];
      if (reserved) {
        deps.err(`actana ${noun}: not built yet — ${reserved}.`);
        return EXIT_USAGE;
      }
      deps.err(`actana: unknown noun "${noun}".`);
      deps.err("`actana --help` lists them.");
      return EXIT_USAGE;
    }
  }
}
