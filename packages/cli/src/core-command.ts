// `actana core` — the Cores this machine can reach (#129 D10).
//
//   actana core add <name> [file]   register a Core from a blob file, or stdin
//   actana core ls [--json]         what this machine knows, without dialling
//   actana core use <name>          point `current` at one of them
//   actana core rm <name>           forget one
//   actana core status [--json]     reach the selected Core and report it back
//   actana core shell               scaffolded here, built in #162
//
// **`add` reads a file or stdin, and there is no third way.** It does not shell
// into a container to fetch the credential for it (#129 D9, and the ticket's
// wording is worth keeping: *a CLI that shells into a container to fetch its
// own credentials is not a CLI*). The reasons are not stylistic. A client that
// reaches a Core by running a command on the Core's host only works when the
// Core is on this machine, which is the one case that matters least; it makes
// the container runtime a dependency of a program whose whole job is to not
// need one; and it turns "paste this once" into a privilege the CLI holds
// forever. `packages/cli` imports nothing that can start a process, and
// `src/__tests__/no-local-escape.test.ts` is what keeps that true.

import {
  clearCurrentCore,
  coreExists,
  coreNameError,
  listCoreNames,
  listUsableCoreNames,
  readCurrentCore,
  readRegistry,
  removeCoreBlob,
  writeCoreBlob,
  writeCurrentCore,
  type RegistryPaths,
} from "./blob-registry.ts";
import { decodeRegistrationBlobText } from "./registration-blob-file.ts";
import { resolveCore } from "./core-resolution.ts";
import { formatJson, formatTable } from "./cli-output.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_UNIMPLEMENTED, EXIT_USAGE } from "./exit-codes.ts";
import type { ActanaCliDeps } from "./cli-deps.ts";
import type { ParsedArgs } from "./cli-args.ts";
import * as fs from "node:fs";

/** How long `core status` waits for a Core to answer. */
const STATUS_TIMEOUT_MS = 15_000;

export const CORE_HELP = `actana core — the Cores this machine can reach

Usage
  actana core add <name> [file]   register a Core from a blob file, or stdin
  actana core ls                  list the Cores this machine knows
  actana core use <name>          point \`current\` at a Core
  actana core rm <name>           forget a Core
  actana core status              reach the selected Core and report what it says
  actana core shell               open a shell on the Core (not built yet — #162)

Flags
  --core <name>   which Core \`status\` (and every later noun) talks to
  --json          machine-readable output — \`ls\` and \`status\`
  --verbose       explain the steps. Never prints a blob.

Registering a Core
  \`actana setup\` prints one blob per Core. Save it, or pipe it:

    actana core add prod ~/blob.txt
    ssh core-host 'actana token' | actana core add prod

  The blob is a credential: it is stored at mode 0600 under
  \${XDG_CONFIG_HOME:-~/.config}/actana/cores/<name>.txt and is never printed
  back, by any command or any flag.`;

/** Dispatch a `core` verb. `argv` is the positionals after `core`. */
export async function runCoreCommand(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
): Promise<number> {
  const [verb, ...rest] = args.positionals.slice(1);

  if (args.help || verb === undefined) {
    deps.out(CORE_HELP);
    return verb === undefined && !args.help ? EXIT_USAGE : EXIT_OK;
  }

  // Only the two verbs with flags of their own take `args`. `add`, `use` and
  // `rm` have none — passing it to them anyway made every verb look like it
  // read the flag set, which is the one thing a reader checks a dispatch for.
  switch (verb) {
    case "add":
      return coreAdd(deps, paths, rest);
    case "ls":
    case "list":
      return coreLs(deps, args, paths);
    case "use":
      return coreUse(deps, paths, rest);
    case "rm":
    case "remove":
      return coreRm(deps, paths, rest);
    case "status":
      return coreStatus(deps, args, paths);
    case "shell":
      return coreShell(deps);
    default:
      deps.err(`actana core: unknown verb "${verb}".`);
      deps.err("Verbs: add, ls, use, rm, status, shell. `actana core --help` lists them.");
      return EXIT_USAGE;
  }
}

/**
 * `actana core add <name> [file]`.
 *
 * The blob arrives from a file path, from `-`, or from a pipe — and the three
 * are one code path with one decoder, so a blob that is rejected is rejected
 * identically however it arrived.
 */
async function coreAdd(
  deps: ActanaCliDeps,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const [name, source, ...extra] = rest;
  if (name === undefined) {
    deps.err("actana core add: a name is required — `actana core add <name> [file]`.");
    return EXIT_USAGE;
  }
  if (extra.length > 0) {
    deps.err(`actana core add: unexpected argument "${extra[0]}".`);
    return EXIT_USAGE;
  }
  const nameError = coreNameError(name);
  if (nameError) {
    deps.err(`actana core add: ${nameError}.`);
    return EXIT_USAGE;
  }

  const fromStdin = source === undefined || source === "-";
  if (fromStdin && deps.stdinIsTty) {
    deps.err("actana core add: no blob file given and nothing is piped in.");
    deps.err("Pass the file `actana setup` wrote, or pipe the blob:");
    deps.err(`  actana core add ${name} ~/blob.txt`);
    deps.err(`  cat blob.txt | actana core add ${name}`);
    return EXIT_USAGE;
  }

  let text: string;
  if (fromStdin) {
    deps.verbose("reading the blob from stdin");
    text = await deps.readStdin();
  } else {
    deps.verbose(`reading the blob from ${source}`);
    try {
      text = fs.readFileSync(source!, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      deps.err(`actana core add: could not read ${source} (${code ?? "unknown error"}).`);
      return EXIT_FAILURE;
    }
  }

  const decoded = decodeRegistrationBlobText(text);
  if (!decoded.ok) {
    // The reason, never the input — see `decodeRegistrationBlobText`.
    deps.err(`actana core add: ${decoded.error}.`);
    return EXIT_FAILURE;
  }

  const replacing = coreExists(paths, name);
  writeCoreBlob(paths, name, text);
  deps.verbose(`stored at ${paths.coresDir}/${name}.txt, mode 0600`);

  // The first Core a machine learns about becomes `current`, because a machine
  // with exactly one Core should not need a second command before anything
  // works. A second Core does not steal the pointer — that is `core use`, and
  // silently repointing it would change what every open terminal on this
  // machine means by "the Core".
  const current = readCurrentCore(paths);
  if (current === null) {
    writeCurrentCore(paths, name);
  }

  const verb = replacing ? "Replaced" : "Added";
  deps.out(`${verb} Core "${name}" → ${decoded.blob.endpoint}`);
  if (current === null) deps.out(`\`current\` now points at "${name}".`);
  else if (current !== name) deps.out(`\`current\` is still "${current}" — \`actana core use ${name}\` to switch.`);
  return EXIT_OK;
}

/** `actana core ls [--json]` — the registry, without dialling anything. */
function coreLs(deps: ActanaCliDeps, args: ParsedArgs, paths: RegistryPaths): number {
  const rows = readRegistry(paths);

  if (args.json) {
    deps.out(
      formatJson(
        rows.map((row) => ({
          name: row.name,
          current: row.current,
          endpoint: row.summary?.endpoint ?? null,
          label: row.summary?.label ?? null,
          insecureMode: row.insecureMode,
          error: row.error,
        })),
      ),
    );
    return EXIT_OK;
  }

  if (rows.length === 0) {
    deps.out("No Cores registered. `actana core add <name> <blob-file>` registers one.");
    return EXIT_OK;
  }

  const table = formatTable(
    ["NAME", "CURRENT", "ENDPOINT", "LABEL"],
    rows.map((row) => [
      row.name,
      row.current ? "*" : "",
      row.summary?.endpoint ?? `(unusable: ${row.error})`,
      row.summary?.label ?? "",
    ]),
  );
  for (const line of table) deps.out(line);

  for (const row of rows.filter((r) => r.insecureMode)) {
    deps.err(
      `warning: the blob for "${row.name}" is readable by more than its owner. ` +
        `chmod 600 ${paths.coresDir}/${row.name}.txt`,
    );
  }
  return EXIT_OK;
}

/** `actana core use <name>` — move the `current` pointer. */
function coreUse(deps: ActanaCliDeps, paths: RegistryPaths, rest: string[]): number {
  const [name] = rest;
  if (name === undefined) {
    deps.err("actana core use: a name is required — `actana core use <name>`.");
    return EXIT_USAGE;
  }
  if (coreNameError(name) !== null || !coreExists(paths, name)) {
    deps.err(`actana core use: no Core named "${name}".`);
    const known = listUsableCoreNames(paths);
    deps.err(known.length > 0 ? `Known: ${known.join(", ")}` : nothingToSelect(paths));
    return EXIT_FAILURE;
  }
  writeCurrentCore(paths, name);
  deps.out(`\`current\` now points at "${name}".`);
  return EXIT_OK;
}

/** `actana core rm <name>` — forget a Core, and the pointer if it named it. */
function coreRm(deps: ActanaCliDeps, paths: RegistryPaths, rest: string[]): number {
  const [name] = rest;
  if (name === undefined) {
    deps.err("actana core rm: a name is required — `actana core rm <name>`.");
    return EXIT_USAGE;
  }
  if (coreNameError(name) !== null) {
    deps.err(`actana core rm: no Core named "${name}".`);
    return EXIT_FAILURE;
  }
  const wasCurrent = readCurrentCore(paths) === name;
  if (!removeCoreBlob(paths, name)) {
    deps.err(`actana core rm: no Core named "${name}".`);
    return EXIT_FAILURE;
  }
  // A pointer at a Core that no longer exists is a pointer that makes the next
  // command fail with the wrong error, so it goes with the blob.
  if (wasCurrent) clearCurrentCore(paths);

  deps.out(`Removed Core "${name}".`);
  if (wasCurrent) {
    const left = listUsableCoreNames(paths);
    deps.out(
      left.length > 0
        ? `Nothing is \`current\` now — \`actana core use <name>\` selects one of: ${left.join(", ")}`
        : `Nothing is \`current\` now, and ${nothingToSelect(paths)}`,
    );
  }
  return EXIT_OK;
}

/**
 * `actana core status [--json]` — reach the selected Core and report it back.
 *
 * The one verb here that leaves the machine. It reports what the Core said
 * about itself on the handshake — its id, the core-link protocol version, and
 * whether this build speaks it — plus the local facts a failure to connect
 * usually turns out to be about: which credential was used and when its bearer
 * expires.
 */
async function coreStatus(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
): Promise<number> {
  const resolved = resolveCore({ paths, env: deps.env, home: deps.home, coreFlag: args.core });
  if (!resolved.ok) {
    if (args.json) deps.out(formatJson({ reachable: false, error: resolved.error }));
    deps.err(`actana core status: ${resolved.error}`);
    return EXIT_FAILURE;
  }

  const { name, source, blob } = resolved.core;
  deps.verbose(`resolved the Core from ${sourceLabel(source)}`);
  deps.verbose(`dialling ${blob.endpoint}`);

  let probe;
  try {
    probe = await deps.probe(blob, { timeoutMs: STATUS_TIMEOUT_MS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (args.json) {
      deps.out(
        formatJson({
          name,
          source,
          endpoint: blob.endpoint,
          reachable: false,
          error: message,
        }),
      );
    }
    deps.err(`actana core status: ${blob.endpoint} did not answer — ${message}`);
    return EXIT_FAILURE;
  }

  const expiresInDays =
    probe.bearerExpiresAt === null
      ? null
      : Math.round((probe.bearerExpiresAt - deps.now()) / 86_400_000);

  if (args.json) {
    deps.out(
      formatJson({
        name,
        source,
        endpoint: blob.endpoint,
        reachable: true,
        coreId: probe.coreId,
        protocolVersion: probe.protocolVersion,
        compatible: probe.compatible,
        multiConnection: probe.multiConnection,
        bearerExpiresAt: probe.bearerExpiresAt,
      }),
    );
    return probe.compatible ? EXIT_OK : EXIT_FAILURE;
  }

  const rows: string[][] = [
    ["Core", name ?? "(unnamed)"],
    ["Credential", sourceLabel(source)],
    ["Endpoint", blob.endpoint],
    ["Core id", probe.coreId ?? "(none reported)"],
    [
      "Protocol",
      `${probe.protocolVersion ?? "(none reported)"}${probe.compatible ? "" : "  — this CLI does not speak it"}`,
    ],
    ["Multi-connection", probe.multiConnection ? "supported" : "not announced"],
    [
      "Bearer",
      probe.bearerExpiresAt === null
        ? "(no expiry reported)"
        : `expires ${new Date(probe.bearerExpiresAt).toISOString()}${expiresInDays === null ? "" : ` (${expiresInDays} days)`}`,
    ],
  ];
  // A headerless two-column table: the labels align, and there is no header row
  // to print because the labels *are* the header, one per line.
  for (const line of formatTable(["", ""], rows).slice(1)) deps.out(line);

  if (!probe.compatible) {
    deps.err(
      "This Core speaks a core-link version this CLI does not. Update whichever of the two is older.",
    );
    return EXIT_FAILURE;
  }
  return EXIT_OK;
}

/**
 * `actana core shell` — scaffolded, not built.
 *
 * It is in the tree, in the help, and in the dispatch because #157 is what
 * defines the `core` noun's shape and a verb added later by a different ticket
 * would be a second place that shape is decided. What it is not is a stub that
 * pretends: it names the ticket that builds it and exits non-zero, so a script
 * that reaches for it fails now rather than appearing to succeed.
 */
function coreShell(deps: ActanaCliDeps): number {
  deps.err("actana core shell: not built yet — it is #162, in this phase.");
  deps.err("A Core shell is a free-form login shell on the Core: no project, no harness.");
  return EXIT_UNIMPLEMENTED;
}

/**
 * What to say when there is no Core a verb could be pointed at.
 *
 * "No Cores are registered" and "nothing in `cores/` has a name a verb will
 * take" are different situations with different fixes, and now that the
 * registry lists an oddly-named file rather than hiding it, saying the first
 * when the second is true would put this line in plain disagreement with the
 * row `actana core ls` prints one command earlier. Registering a Core will not
 * help somebody whose blob is already there under the wrong filename.
 */
function nothingToSelect(paths: RegistryPaths): string {
  return listCoreNames(paths).length > 0
    ? "no Core in the registry has a usable name — `actana core ls` shows what is there."
    : "no Cores are registered.";
}

/** How a credential's provenance is named in output. */
function sourceLabel(source: "flag" | "env" | "current"): string {
  switch (source) {
    case "flag":
      return "--core";
    case "env":
      return "ACTANA_CORE_BLOB";
    case "current":
      return "the `current` pointer";
  }
}
