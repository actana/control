// `actana core` — the Cores this machine can reach (#129 D10).
//
//   actana core pair <name> <address> <code>   enroll this machine on a Core
//   actana core ls [--json]         what this machine knows, without dialling
//   actana core use <name>          point `current` at one of them
//   actana core rm <name>           forget one
//   actana core status [--json]     reach the selected Core and report it back
//   actana core shell               an interactive shell on the Core (#162)
//   actana core exec -- <cmd>       one command on the Core, no terminal (#266)
//
// **`pair` is how a machine comes by a credential, and there is no second way
// (#280, #287).** The operator types an address and an eight-character code
// somebody read out to them, the SDK generates a key pair here and gets a
// certificate signed, and what lands is a 0600 file in the registry — so every
// verb below reads exactly what it always read. It runs on the *client*;
// `actana pair new`, which mints the code, runs on the Core. `core-pair.ts` has
// the reasoning.
//
// **What used to be here was `core add`, and its removal is the point of #287.**
// It took the base64 blob `actana setup` printed, from a file, from `-` or from
// a pipe, and wrote it into the registry — the hand-carry the short code
// replaced. There is no deprecation and no `--legacy-blob`: a second way to
// become a Core client, with its own security properties and nobody testing it,
// is the thing #280 removed rather than kept.
//
// **Nothing here shells into a container to fetch a credential** (#129 D9, and
// the ticket's wording is worth keeping: *a CLI that shells into a container to
// fetch its own credentials is not a CLI*). A client that reaches a Core by
// running a command on the Core's host only works when the Core is on this
// machine, which is the one case that matters least; it makes the container
// runtime a dependency of a program whose whole job is to not need one.
// `packages/cli` imports nothing that can start a process, and
// `src/__tests__/no-local-escape.test.ts` is what keeps that true.
//
// **`exec` is the same argument one verb further along (#266).** A maintenance
// script that needs to run something on a Core used to have to reach for
// `docker exec` too. It runs on the *Core*, over the core link, authenticated
// — so it works against a remote Core, and this package still starts no
// process. `core-exec.ts` has the reasoning in full.

import {
  clearCurrentCore,
  coreExists,
  coreNameError,
  listCoreNames,
  listUsableCoreNames,
  readCurrentCore,
  readRegistry,
  removeCoreBlob,
  writeCurrentCore,
  type RegistryPaths,
} from "./blob-registry.ts";
import { runCorePair } from "./core-pair.ts";
import { resolveCore } from "./core-resolution.ts";
import { runCoreShell } from "./core-shell.ts";
import { runCoreExec } from "./core-exec.ts";
import { formatJson, formatTable } from "./cli-output.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./exit-codes.ts";
import type { ActanaCliDeps } from "./cli-deps.ts";
import type { ParsedArgs } from "./cli-args.ts";

/** How long `core status` waits for a Core to answer. */
const STATUS_TIMEOUT_MS = 15_000;

export const CORE_HELP = `actana core — the Cores this machine can reach

Usage
  actana core pair <name> <address> <code>
                                  enroll THIS machine on a Core
  actana core ls                  list the Cores this machine knows
  actana core use <name>          point \`current\` at a Core
  actana core rm <name>           forget a Core
  actana core status              reach the selected Core and report what it says
  actana core shell               open an interactive shell on the Core
  actana core exec -- <cmd>       run one command on the Core, no terminal

Flags
  --core <name>   which Core \`status\` (and every later noun) talks to
  --cwd <dir>     a directory on the **Core's** machine — \`exec\`
  --json          machine-readable output — \`ls\`, \`status\` and \`exec\`
  --verbose       explain the steps. Never prints a blob, a code or a key.
  --fingerprint <sha256>   the Core's CA fingerprint — \`pair\`
  --session <id>  the pairing session the code belongs to — \`pair\`
  --label <name>  what to call this machine on the Core — \`pair\`

Pairing with a Core
  \`pair\` runs on the machine being paired — **this one**. On the Core, an
  operator runs \`actana pair new\`, which prints a code, that Core's CA
  fingerprint and the pairing session. Then, here:

    actana core pair prod core.example:8443 ABCD-2345 \\
      --session 0f6d… --fingerprint AA:BB:CC:…

  The fingerprint is not optional. Without \`--fingerprint\` this prints the
  fingerprint the Core presents and asks you to compare it with the one on the
  Core's terminal; with no terminal to ask on, it refuses. Either way the code
  is never sent to a certificate authority nobody confirmed.

  The code is one-time, expires, and is spent by a wrong guess. A fresh one is
  \`actana pair new\` again — it cannot be recovered, only re-minted.

  What lands is a credential file at mode 0600 under
  \${XDG_CONFIG_HOME:-~/.config}/actana/cores/<name>.txt. It is never printed
  back, by any command or any flag, and \`ls\`, \`use\`, \`rm\`, \`status\`,
  \`shell\` and \`exec\` all read it.

Running one command
  \`exec\` is the non-interactive half of \`shell\`: no terminal, stdout and
  stderr kept apart and free of escape sequences, and the command's own exit
  code as this process's. Everything after \`--\` is the command.

    actana core exec -- df -h /
    actana core exec --cwd /srv/app -- git pull
    actana core exec --json -- systemctl is-active actana

  A dropped link exits 125 and says so: the command keeps running on the Core
  and its outcome is unknown. That is never the command's own status.
`;

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

  // Only the verbs with flags of their own take `args`. `use` and `rm`
  // have none — passing it to them anyway made every verb look like it read the
  // flag set, which is the one thing a reader checks a dispatch for. `pair`
  // does: `--fingerprint`, `--session` and `--label` are all its.
  switch (verb) {
    case "pair":
      return runCorePair(deps, args, paths, rest);
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
      return runCoreShell(deps, args, paths);
    case "exec":
      return runCoreExec(deps, args, paths, rest);
    default:
      deps.err(`actana core: unknown verb "${verb}".`);
      deps.err("Verbs: pair, ls, use, rm, status, shell, exec. `actana core --help` lists them.");
      return EXIT_USAGE;
  }
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
    deps.out("No Cores registered. `actana core pair <name> <address> <code>` registers one.");
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
