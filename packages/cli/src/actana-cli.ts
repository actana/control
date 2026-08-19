// `actana` — the client half (#129 D8, D9, D10).
//
// One command name, split by noun. `actana daemon` runs a Core and lives in
// `packages/core`; `actana core …`, `project …`, `harness …`, `events …`, and
// the `session` noun the rest of this phase adds, talk to one. **The published
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
import { runProjectCommand } from "./project-command.ts";
import { runHarnessCommand } from "./harness-command.ts";
import { runEventsCommand } from "./events-command.ts";
import { runSessionCommand } from "./session-command.ts";
import { CORE_BLOB_ENV } from "./core-resolution.ts";
import { ensureOrchestrationSkillQuietly } from "./orchestration-skill.ts";
import { EXIT_OK, EXIT_UNIMPLEMENTED, EXIT_USAGE } from "./exit-codes.ts";
import type { ActanaCliDeps } from "./cli-deps.ts";
import manifest from "../package.json" with { type: "json" };

/** This CLI's version — the train's, read off the manifest the cut writes (ADR 0023 D3). */
export const CLI_VERSION: string = manifest.version;

/**
 * The nouns this phase reserves but has not built (#129 D10).
 *
 * A reserved noun is listed here rather than left to fall through to "unknown
 * noun" because the two answers differ in what the reader should do: a reserved
 * noun has a ticket number, and a typo does not. They exit
 * {@link EXIT_UNIMPLEMENTED} rather than {@link EXIT_USAGE} for the same reason
 * `core shell` does — the difference is a fact about this build, and a script
 * should not have to read English off stderr to find it.
 *
 * **Empty on this train**, which is what a reservation is supposed to end as:
 * #160 built `session`, #161 built `project`, `harness` and `events`, and each
 * row left as its noun landed. The table stays because the distinction it draws
 * has not gone anywhere — a noun a later phase adds owes the reader a ticket
 * number, and a row here is the whole of saying so.
 *
 * As of #168 the *verb*-level table in `project-command.ts` is empty too:
 * `project cp` and `project files` were the last two reservations in the tree,
 * and building them is what took them out of it. Nothing in this build answers
 * {@link EXIT_UNIMPLEMENTED} any more — which is a fact about this train, not a
 * reason to delete the mechanism, since #210 (`project rm`) and #211
 * (`--model`) are the next things that will need it.
 */
const RESERVED_NOUNS: Record<string, string> = {};

export const ROOT_HELP = `actana — drive AI coding agents across your Cores.

Usage
  actana <noun> <verb> [flags]

Nouns
  core      register, select and inspect the Cores this machine can reach
  project   the Projects a Core owns: ls, add, browse, files, cp
  harness   the coding agents a Core can run: ls, install, skills
  events    follow a Core's event log: tail
  session   start, ls, logs, resume, kill and send to Sessions on one

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

  // ADR 0031 D6: there is no npm lifecycle hook to install the product's own
  // skill from — this package has no `postinstall`, `preinstall` or `prepare`
  // and gains none — so "installed with the CLI" is delivered here instead, in
  // front of the first verb the operator runs. It is a no-op when the copies are
  // current, it writes nothing on a machine where no Harness has a directory of
  // its own, and it cannot fail: nothing it does reaches the exit code or either
  // output stream. `actana harness skills` is the same work with a report.
  //
  // After the `--version` and no-noun branches on purpose. Those two answer a
  // question about this binary and touch nothing; a `--version` that wrote files
  // into a home directory would be a surprise, and it is not what "followed by
  // any actana command" means.
  //
  // `actana harness skills` is the one verb it does not run in front of: that
  // verb does the same work and reports it, and an ensure that had already
  // repaired the copy would leave the explicit path with nothing to say but
  // "current" — a repair verb that can never report a repair.
  if (!(noun === "harness" && args.positionals[1] === "skills")) {
    ensureOrchestrationSkillQuietly(deps.home);
  }

  const paths = registryPaths(deps.env, deps.home);

  switch (noun) {
    case "core":
      return runCoreCommand(deps, args, paths);
    case "project":
      return runProjectCommand(deps, args, paths);
    case "harness":
      return runHarnessCommand(deps, args, paths);
    case "events":
      return runEventsCommand(deps, args, paths);
    case "session":
      return runSessionCommand(deps, args, paths);
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
        return EXIT_UNIMPLEMENTED;
      }
      deps.err(`actana: unknown noun "${noun}".`);
      deps.err("`actana --help` lists them.");
      return EXIT_USAGE;
    }
  }
}
