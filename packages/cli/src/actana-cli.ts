// `actana` — one command, one program: the Core manager and the client.
//
//   Machine-side verbs — what this machine's own Core is and does
//     actana install   fetch a release, verify it, install and start a Core
//     actana place     place an extracted bundle and stop — install, no setup
//     actana setup     install from an extracted tarball, or fetch one first
//     actana status    daemon state, versions, endpoint, Harness availability
//     actana token regenerate   mint fresh credentials, invalidating the old ones
//     actana pair      enroll a client on this Core: pair new | ls | revoke
//     actana update    fetch, verify and swap in a release, then restart
//     actana start|stop|restart|logs
//     actana harnesses install <id>   install a Harness, the vendor's way
//     actana uninstall remove the service and the install
//     actana daemon    run the Core in the foreground (what the unit execs)
//
//   Client nouns — what Cores, near or far, are asked to do
//     actana core | project | harness | events | session
//
// **There is one `actana` and this is it (#288).** Until 0.4.0 there were two
// different programs under this name — the operator CLI inside the Core
// tarball and the client CLI on npm — and which one answered on a machine that
// had both was decided by `PATH` ordering rather than by anything an operator
// could see. The split was the defect: the Core installs a skill that teaches
// the client nouns onto the very machine whose `actana` did not have them. So
// the two halves are one program, one help text and one version answer, and
// the `PATH` question stops being able to decide anything because both entries
// resolve to the same program. ADR 0032 records it.
//
// `runActanaCli` takes every side effect as a dependency and returns an exit
// code instead of calling `process.exit`, so the whole surface — dispatch, flag
// validation, output, exit codes — is exercised in unit tests rather than by a
// subprocess. `actana-cli-entry.ts` is the only file that knows about
// `process`, and the one that binds the real streams, the real system port and
// the real Core dial.
//
// Two rules this file holds, stated once each:
//
//   **A credential never reaches an output sink.** Not stdout, not stderr, not
//   `--verbose`, not an error message quoting the input that failed to parse.
//   `registration-blob-file.ts` is the only module that turns registry bytes
//   into a credential and it reduces one to a {@link BlobSummary} for anything
//   that prints; `src/__tests__/never-logs-a-blob.test.ts` runs every verb,
//   with `--verbose`, against a credential whose material is a known sentinel
//   and fails if any byte of it appears in any output. Since #287 there is also
//   nothing left that *would* print one: the hand-carried blob `setup` and
//   `token` emitted is gone, and enrollment is a short code that grants a
//   certificate rather than an artifact that carries one.
//
//   **Context-sensitivity stays.** The same binary ships inside the Core
//   image, where the machine lifecycle belongs to the container runtime
//   instead: `setup`, `install`, `start`, `stop`, `restart`, `update`,
//   `uninstall` and `logs` refuse and name the Docker command that does the
//   job, driven by `ACTANA_CONTAINER` and never by sniffing `/.dockerenv`
//   (ADR 0016 D13/D15/D16). The client nouns are never refused: talking to a
//   Core is the one thing that works identically everywhere.
//
// **"Pairing code" is the short code, and nothing else is a "token".** Until
// #287 operator-facing strings called the hand-carried blob "the pairing
// token"; that artifact is gone and the phrase now belongs to the eight
// characters `actana pair new` prints. The domain name for what a paired client
// holds is still **Registration blob** — see CONTEXT.md.


import * as fs from "node:fs";
import {
  loadMaterialFromFile,
  materialFilePath,
  mintFreshMaterial,
  persistMaterialToFile,
} from "@actana/shared/core-material-store";
import {
  CONTAINER_LABEL_ENV,
  CONTAINER_PORT_ENV,
  CONTAINER_PUBLIC_HOST_ENV,
  containerRefusal,
  DEFAULT_CONTAINER_PORT,
  inContainer,
  readContainerContract,
  refusedContainerVerbs,
} from "./actana-container.ts";
import { endpointFor, readActanaConfig, type ActanaConfig } from "./actana-config.ts";
import {
  binDirOnPath,
  resolveActanaLayout,
  updateCheckCachePath,
  type ActanaLayout,
} from "./actana-layout.ts";
import {
  checkForUpdate,
  updateCheckEnabled,
  type UpdateCheck,
} from "@actana/shared/actana-update-check";
import { readCoreManifest, type CoreManifest } from "./actana-manifest.ts";
import { releaseChannel } from "./actana-release.ts";
import {
  createServiceManager,
  type ActanaServiceManager,
  type ServiceVerb,
} from "./actana-service.ts";
import {
  choosePublicHost,
  placeCoreBundle,
  planCorePlacement,
  runActanaSetup,
  setupCommandFor,
  type PlacementPlan,
} from "./actana-setup.ts";
import {
  harnessFlagNames,
  harnessFromFlagName,
  installAgentsNow,
  offerableHarnessIds,
  resolveHarnessId,
  summarizeHarnessInstalls,
  supportedHarnessIdsSentence,
} from "./actana-harnesses.ts";
import type { Harness } from "@actana/shared/domain";
import { formatActanaStatus, summarizeHealth, type ActanaStatusReport } from "./actana-status.ts";
import { runActanaUninstall } from "./actana-uninstall.ts";
import { runActanaUpdate } from "./actana-update.ts";
import { parseArgs } from "./cli-args.ts";
import { registryPaths } from "./blob-registry.ts";
import { runCoreCommand } from "./core-command.ts";
import { runPairCommand } from "./actana-pair.ts";
import { runProjectCommand } from "./project-command.ts";
import { runHarnessCommand } from "./harness-command.ts";
import { runEventsCommand } from "./events-command.ts";
import { runSessionCommand } from "./session-command.ts";
import { CORE_BLOB_ENV } from "./core-resolution.ts";
import { ensureOrchestrationSkillQuietly } from "./orchestration-skill.ts";
import { EXIT_OK, EXIT_UNIMPLEMENTED, EXIT_USAGE } from "./exit-codes.ts";
import { runActanaInstall } from "./actana-install.ts";
import type { ActanaCliDeps } from "./cli-deps.ts";
import manifest from "../package.json" with { type: "json" };

/** This CLI's own version — the train's, read off the manifest the cut writes (ADR 0023 D3). */
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
 * **Empty on this train**, which is what a reservation is supposed to end as.
 * The table stays because the distinction it draws has not gone anywhere — a
 * noun a later phase adds owes the reader a ticket number, and a row here is
 * the whole of saying so.
 */
const RESERVED_NOUNS: Record<string, string> = {};

/** The nouns that talk to a Core. Never refused in a container. */
const CLIENT_NOUNS = ["core", "project", "harness", "events", "session"] as const;


/** Default core-link port. Matches the port the docs and install script use. */
const DEFAULT_PORT = 8443;

/** How long a verb that restarts the daemon waits for its port to answer. */
const LISTEN_TIMEOUT_MS = 30_000;

const USAGE = `actana — drive AI coding agents across your Cores, and run one here.

Usage:
  actana <command> [options]
  actana <noun> <verb> [flags]

Cores this machine can reach
  core       Pair with a Core, register, select and inspect them
  project    The Projects a Core owns: ls, add, browse, files, cp
  harness    The coding agents a Core can run: ls, install, skills
  events     Follow a Core's event log: tail
  session    Start, ls, logs, resume, attach, kill and send to Sessions on one

This machine's own Core
  install    Fetch a release, verify it, install the Core and start it
  place      Put the extracted bundle here and link the launcher, and stop.
             Installing is not activating: nothing is started, no identity is
             minted, no service is written. This is what \`install.sh\` runs, and
             \`actana setup\` is the command that follows it
  setup      Install from an extracted tarball — or fetch one when there is none
  status     Show daemon state, versions, endpoint, and Harness availability
  token regenerate
             Rotate this Core's own identity — a new CA, new certificates and a
             new bearer secret. Every client paired with it is locked out and
             has to pair again. There is no \`token\` on its own: nothing is
             reprinted, because a credential is issued to one client by
             \`pair new\` and never handed out as an artifact
  pair       Enroll a client on this Core — \`pair new\`, \`pair ls\`, \`pair revoke\`.
             This is the Core end: \`actana core pair\` is the client end
  update     Install the latest release and restart the daemon
  start      Start the Core daemon
  stop       Stop the Core daemon
  restart    Restart the Core daemon
  logs       Show the daemon's log output
  harnesses  Manage the Harnesses this Core runs — \`harnesses install <id>\`
  uninstall  Stop the daemon and remove the service and the install

Client flags:
  --core <name>         Which registered Core to talk to
  --json                Machine-readable output; every list command has it
  --verbose             Explain the steps, on stderr. Never prints a credential.

Which Core a client command means, in this order:
  1. --core <name>
  2. ${CORE_BLOB_ENV}       the blob itself, or a path to it (single-Core mode)
  3. the \`current\` pointer, which \`actana core use\` sets — and which a Core
     installed on this machine is pointed at automatically

Install and setup options:
  --port <n>            Port the daemon listens on (default ${DEFAULT_PORT})
  --host <addr>         Address the daemon binds (default 0.0.0.0)
  --public-host <addr>  Address your Panel dials (default: this machine's IP)
  --label <name>        Alias shown in your Panel (default: the hostname)
  --with-<harness>      Install this Harness without asking (repeatable)
  --no-harnesses        Do not install or offer any Harness
  --yes                 Take the recommended answer to every prompt, which
                        includes installing every missing Harness

Missing Harnesses are offered one at a time on a terminal. With no terminal
and none of the three flags above, nothing is installed and nothing is asked.
Harness ids: ${offerableHarnessIds().join(", ")}.

Install and update options:
  --version <v>         Install this exact release (default: the latest)
  --repo <slug>         GitHub repository to fetch releases from
  --base-url <url>      Fetch releases from here instead of GitHub (testing)

Uninstall options:
  --purge-data          Also delete your sessions and this Core's credentials
  --yes                 Do not ask for confirmation

Log options:
  -f, --follow          Keep printing new lines as they arrive
  -n, --lines <n>       Show only the last n lines

Global options:
  -h, --help            Show this help
  -V, --version         Show this CLI's version, and the Core it manages

\`actana status\` exits non-zero when the Core is not healthy, so it works
as a health check in scripts.
`;

/**
 * The extra page `actana --help` prints inside the Core image.
 *
 * It replaces nothing: the verbs that still work are the same verbs, and an
 * operator reading this has usually just been refused by one of the others.
 * The three variables are the whole operator-facing contract (ADR 0016 D15) —
 * everything else the image sets is a private constant, and documenting it
 * here would invite operators to override it.
 */
const CONTAINER_USAGE = `This Core is a container, so its lifecycle belongs to Docker:

  ${refusedContainerVerbs().join(", ")}
                        not available here — run the Docker command each one
                        names (\`docker compose up -d\`, \`docker compose logs -f\`, …)

The image reads three variables:
  ${CONTAINER_PUBLIC_HOST_ENV}    required — the address your Panel dials. Never guessed:
                        it is baked into this Core's certificate and the endpoint
                        a pairing hands out
  ${CONTAINER_PORT_ENV}           port the daemon listens on (default ${DEFAULT_CONTAINER_PORT})
  ${CONTAINER_LABEL_ENV}          alias shown in your Panel (default: the public host)
`;


// ─── flag parsing ───────────────────────────────────────────────────────────

type FlagType = "string" | "boolean";
type FlagSpec = Record<string, { type: FlagType; alias?: string }>;
type ParsedFlags =
  | { values: Record<string, string | true> }
  /** `unknownOption` is set when the token was a flag the spec has no entry
   *  for, so a caller can add its own hint without matching on the message. */
  | { error: string; unknownOption?: string };

/**
 * Parse a verb's flags against its spec.
 *
 * Unknown flags are an error rather than ignored: a typo'd `--porto 9000`
 * silently installing on the default port is exactly the kind of quiet wrong
 * that shows up days later as "my Panel cannot reach the Core."
 */
function parseFlags(argv: string[], spec: FlagSpec): ParsedFlags {
  const byAlias = new Map<string, string>();
  for (const [name, def] of Object.entries(spec)) {
    if (def.alias) byAlias.set(def.alias, name);
  }

  const values: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    let name: string;
    let inlineValue: string | undefined;

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      name = eq >= 0 ? token.slice(2, eq) : token.slice(2);
      if (eq >= 0) inlineValue = token.slice(eq + 1);
    } else if (token.startsWith("-") && token.length > 1) {
      name = byAlias.get(token.slice(1)) ?? token.slice(1);
    } else {
      return { error: `unexpected argument: ${token}` };
    }

    const def = spec[name];
    if (!def) return { error: `unknown option: ${token}`, unknownOption: name };

    if (def.type === "boolean") {
      if (inlineValue !== undefined) return { error: `--${name} takes no value` };
      values[name] = true;
      continue;
    }
    const value = inlineValue ?? argv[++i];
    if (value === undefined || value.startsWith("-")) {
      return { error: `--${name} needs a value` };
    }
    values[name] = value;
  }
  return { values };
}

/** Read a flag as a positive integer, or report why it is not one. */
function intFlag(
  values: Record<string, string | true>,
  name: string,
  fallback: number,
): number | { error: string } {
  const raw = values[name];
  if (raw === undefined) return fallback;
  if (raw === true) return { error: `--${name} needs a value` };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { error: `--${name} must be a positive whole number, got ${JSON.stringify(raw)}` };
  }
  return parsed;
}

function stringFlag(
  values: Record<string, string | true>,
  name: string,
  fallback: string,
): string {
  const raw = values[name];
  return typeof raw === "string" ? raw : fallback;
}

// ─── shared lookups ─────────────────────────────────────────────────────────

/** What every post-setup verb needs: the layout plus what setup recorded. */
type InstalledCore = { layout: ActanaLayout; config: ActanaConfig };

function findInstall(deps: ActanaCliDeps): InstalledCore | null {
  const layout = resolveActanaLayout(deps.env, deps.home, deps.platform);
  const config = readActanaConfig(layout.configDir);
  return config ? { layout, config } : null;
}

/**
 * This machine's init system, or null after saying why there is not one.
 *
 * Every verb that touches the daemon needs it, and on a platform with neither
 * systemd nor launchd there is no partial `actana` worth offering — the answer
 * is the same sentence in all of them.
 */
function requireService(
  deps: ActanaCliDeps,
  layout: ActanaLayout,
): ActanaServiceManager | null {
  try {
    return createServiceManager({
      platform: deps.platform,
      layout,
      system: deps.system,
      user: deps.user,
      uid: deps.uid,
    });
  } catch (err) {
    // The factory owns the sentence about which platforms are supported, so
    // there is one copy of it rather than one per caller.
    deps.err(err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * The container's equivalent of what setup recorded, or null after saying what
 * is wrong with the environment.
 *
 * There is no `actana.json` in the image and there never will be — nothing ran
 * setup to write one. The three variables the operator sets are the whole of
 * it, and the rest is either the image's own private constants or a fact of
 * the running tree.
 */
function containerInstall(deps: ActanaCliDeps): InstalledCore | null {
  const contract = readContainerContract(deps.env);
  if ("error" in contract) {
    deps.err(contract.error);
    return null;
  }
  const layout = resolveActanaLayout(deps.env, deps.home, deps.platform);
  return {
    layout,
    config: {
      version: readCoreManifest(deps.installRoot)?.version ?? "unknown",
      port: contract.port,
      host: deps.env.AC_CORE_LINK_HOST ?? "0.0.0.0",
      publicHost: contract.publicHost,
      label: contract.label,
      installDir: deps.installRoot,
      dataDir: deps.env.AC_USER_DATA_DIR ?? layout.dataDir,
    },
  };
}

function requireInstall(deps: ActanaCliDeps): InstalledCore | null {
  if (inContainer(deps.env)) return containerInstall(deps);
  const installed = findInstall(deps);
  if (!installed) {
    deps.err("No Core is installed for this user. Run `actana setup` first.");
  }
  return installed;
}

/**
 * Where this Core's material lives.
 *
 * In the image it is in the mounted volume, named by the same
 * `AC_CORE_MATERIAL_FILE` the daemon loads from — so the CLI and the daemon
 * cannot end up disagreeing about which identity this Core has.
 */
function materialPathFor(deps: ActanaCliDeps, layout: ActanaLayout): string {
  const fromImage = inContainer(deps.env) ? deps.env.AC_CORE_MATERIAL_FILE : undefined;
  return fromImage || materialFilePath(layout.configDir);
}

/** Read the manifest of the installed tree, falling back to the running tree. */
function manifestFor(deps: ActanaCliDeps, config: ActanaConfig | null): CoreManifest | null {
  return (
    (config ? readCoreManifest(config.installDir) : null) ??
    readCoreManifest(deps.installRoot)
  );
}

// ─── verbs ──────────────────────────────────────────────────────────────────

const SETUP_FLAGS: FlagSpec = {
  port: { type: "string" },
  host: { type: "string" },
  "public-host": { type: "string" },
  label: { type: "string" },
  yes: { type: "boolean", alias: "y" },
  "no-harnesses": { type: "boolean" },
  // Only the download path reads these three. They are on the one flag spec
  // rather than a second because `setup` *is* the download path on a machine
  // with no tarball around it (#288 D8), and a flag that existed on `install`
  // and not on `setup` would be a distinction an operator has to know the
  // provenance of their CLI to predict.
  version: { type: "string" },
  repo: { type: "string" },
  "base-url": { type: "string" },
  // `--with-<harness>` is one boolean flag per agent rather than a repeatable
  // `--with <id>`: the flags come from the registry, so a typo is caught by
  // the same "unknown option" path as every other flag instead of failing
  // later with an id nobody recognises.
  ...Object.fromEntries(harnessFlagNames().map((name) => [name, { type: "boolean" } as const])),
};

/** The agents `--with-<harness>` named, deduplicated in registry order. */
function requestedHarnesses(values: Record<string, string | true>): Harness[] {
  const named = new Set<Harness>();
  for (const key of Object.keys(values)) {
    const agent = harnessFromFlagName(key);
    if (agent) named.add(agent);
  }
  return offerableHarnessIds().filter((agent) => named.has(agent));
}

/**
 * `actana install`, and `actana setup` when there is no tarball to set up from.
 *
 * One function because they are one job that starts at two different points
 * (#288 D8). `setup` inside an extracted tarball installs the tree it is
 * standing in — that is all it has ever done. `install`, and a `setup` run by a
 * CLI that arrived through npm, fetch that tree first: resolve the release,
 * download it, verify it against the release's own `SHA256SUMS`, unpack it,
 * and then do exactly what setup does.
 *
 * `download` is decided by the caller for `install` and by the presence of a
 * manifest for `setup`, and the operator is told which happened.
 */
async function cmdSetup(
  deps: ActanaCliDeps,
  argv: string[],
  { forceDownload = false }: { forceDownload?: boolean } = {},
): Promise<number> {
  const parsed = parseFlags(argv, SETUP_FLAGS);
  if ("error" in parsed) {
    deps.err(parsed.error);
    // A mistyped agent gets the list rather than a bare "unknown option",
    // because `--with-claude-cli` is a guess about naming, not a typo.
    if (parsed.unknownOption?.startsWith("with-")) deps.err(supportedHarnessIdsSentence());
    return EXIT_USAGE;
  }
  const agents = requestedHarnesses(parsed.values);
  if (parsed.values["no-harnesses"] === true && agents.length > 0) {
    deps.err("--no-harnesses cannot be combined with --with-<harness>.");
    return EXIT_USAGE;
  }
  const port = intFlag(parsed.values, "port", DEFAULT_PORT);
  if (typeof port !== "number") {
    deps.err(port.error);
    return EXIT_USAGE;
  }
  if (port > 65535) {
    deps.err(`--port must be below 65536, got ${port}`);
    return EXIT_USAGE;
  }

  // The tarball this CLI is standing in, when it is standing in one. An
  // `npm i -g @actana/cli` is not, and that is the case the download path
  // exists for — it is not an error and it does not print like one.
  const localManifest = forceDownload ? null : readCoreManifest(deps.installRoot);

  const layout = resolveActanaLayout(deps.env, deps.home, deps.platform);
  const service = requireService(deps, layout);
  if (!service) return 1;

  const publicHost = stringFlag(
    parsed.values,
    "public-host",
    choosePublicHost(deps.networkInterfaces, deps.hostname),
  );

  const common = {
    layout,
    registry: registryPaths(deps.env, deps.home),
    env: deps.env,
    port,
    host: stringFlag(parsed.values, "host", "0.0.0.0"),
    publicHost,
    label: stringFlag(parsed.values, "label", deps.hostname),
    platform: deps.platform,
    arch: deps.arch,
    assumeYes: parsed.values.yes === true,
    interactive: deps.interactive,
    requestedHarnesses: agents,
    noHarnesses: parsed.values["no-harnesses"] === true,
    probeHarnesses: deps.probeHarnesses,
    system: deps.system,
    service,
    out: deps.out,
  };

  let result;
  try {
    result = localManifest
      ? await runActanaSetup({
          ...common,
          sourceRoot: deps.installRoot,
          manifest: localManifest,
        })
      : await runActanaInstall({
          ...common,
          fetcher: deps.fetcher,
          channel: channelFrom(parsed.values),
          requestedVersion: stringFlag(parsed.values, "version", "") || undefined,
        });
  } catch (err) {
    deps.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
  deps.out("");
  deps.out(`Core installed at ${result.installDir}`);
  deps.out(`  Version    ${result.version}`);
  deps.out(`  Endpoint   wss://${publicHost}:${port}`);
  deps.out(`  Service    ${result.serviceName} (${result.serviceSummary})`);
  const harnessSummary = summarizeHarnessInstalls(result.agents);
  if (harnessSummary) deps.out(`  ${harnessSummary}`);
  // #288 D9: this Core is already in this machine's own registry. Saying which
  // name and whether it is selected is the whole of what an operator needs —
  // the blob itself went into a 0600 file and is not repeated here.
  deps.out(
    result.wiring.selected
      ? `  Registered as \`${result.wiring.name}\` and selected — \`actana session ls\` ` +
          "on this machine now means this Core."
      : `  Registered as \`${result.wiring.name}\`. \`actana core use ${result.wiring.name}\` ` +
          `selects it; \`${result.wiring.keptSelection}\` is still the one selected.`,
  );
  if (!binDirOnPath(layout.binDir, deps.env.PATH)) {
    deps.out("");
    deps.out(
      `Note: ${layout.binDir} is not on your PATH, so \`actana\` will not be found in a ` +
        `new shell. Add it:\n  export PATH="${layout.binDir}:$PATH"`,
    );
  }
  deps.out("");
  if (result.materialOutcome === "reissued") {
    // The identity survived the move (ADR 0016 D18) but the address did not,
    // and the address is the half the Panel holds — so re-pairing is the fix
    // here, not just an option.
    deps.out(
      "This Core's pairing credentials are unchanged — a paired Panel still " +
        `trusts this Core, but it is dialling the address it paired with. Point it at ` +
        `${publicHost}, or run \`actana pair new\` here and pair it again.`,
    );
  } else if (result.materialOutcome === "reused") {
    deps.out(
      "This Core's pairing credentials are unchanged — a Panel already paired " +
        "with it stays paired. To add another client, run `actana pair new` here.",
    );
  } else {
    deps.out(
      "To pair a client — a Panel, or another machine's `actana` — run `actana pair new` " +
        "here. It prints a one-time code, this Core's CA fingerprint and when the code " +
        "expires; you read all three out to whoever is pairing.",
    );
  }
  deps.out("");

  if (!result.listening) {
    deps.err(
      `The unit started but nothing is listening on port ${port} yet. ` +
        "Check `actana logs` for why the daemon did not start.",
    );
    return 1;
  }
  return 0;
}

/**
 * `actana place` — the install half of the install, and nothing after it.
 *
 * The verb `install.sh` hands placement to (#316, ADR 0036 C2). The script has
 * verified and unpacked a bundle into a temporary directory its own EXIT trap
 * is about to delete; this is what makes any of it survive. It writes
 * `versions/<v>`, points `current` at it, links `<binDir>/actana` unless
 * somebody else owns that name — and then stops, because the mTLS material,
 * the service unit, lingering and this machine's registration are `actana
 * setup`'s to write and the operator's to ask for.
 *
 * **This is why the script does not learn the layout.** `ACTANA_HOME`,
 * `ACTANA_CONFIG_DIR`, `ACTANA_DATA_DIR`, `ACTANA_BIN_DIR`, `XDG_DATA_HOME`
 * and `XDG_CONFIG_HOME` resolve here, through `resolveActanaLayout`, against
 * the same rules and the same unit tests every other verb resolves against. A
 * second copy of them in POSIX sh would be a second front door.
 *
 * It takes no flags. Every flag the old tail forwarded belonged to `setup`,
 * and `setup` is a separate command now.
 *
 * **Two things it does touch that are not strictly placement**, both because
 * the alternative is worse and neither is activation:
 *
 * - *It stops a daemon whose own tree it is about to delete.* Placement only
 *   ever destroys a directory that is already at `installDir`, which means a
 *   re-place of a version that is already installed — the documented "paste
 *   both again" upgrade, when the version has not moved. `runActanaSetup`
 *   stops the service first for exactly that case, and `installTree` would
 *   otherwise rename a fresh tree over the one a live daemon is executing out
 *   of, leaving every lazy `require` and asset read in the window until
 *   `setup` restarts it pointing at nothing. So `place` stops it too, says so,
 *   and the `setup` line it prints is what brings it back. The service is
 *   consulted **only** when there is an existing tree at that path to
 *   destroy — a fresh machine, which is the ordinary case, asks the init
 *   system nothing at all — and a machine with no supported init system just
 *   places, because refusing there would break the one job this verb has.
 * - *It says when `current` has moved ahead of what is set up.* `current` is
 *   what the unit's `ExecStart` resolves through, so on a machine that is
 *   already a Core a placement that is never followed by `setup` leaves a
 *   reboot starting a version `actana.json` does not describe. That is a
 *   sentence in the output, not a refusal: the fix is the command already
 *   printed below it.
 */
function cmdPlace(deps: ActanaCliDeps, argv: string[]): number {
  const parsed = parseFlags(argv, {});
  if ("error" in parsed) {
    deps.err(parsed.error);
    // The flags an operator is most likely to try here are setup's, and they
    // have not been deleted — they moved to the command that uses them.
    deps.err("`actana place` takes no options — `actana setup` is where the install's choices are made.");
    return EXIT_USAGE;
  }

  // A CLI from `npm i -g @actana/cli` is not standing in a bundle, and there is
  // nothing for it to place. That is not a broken install, it is the other
  // door: `actana install` fetches a release and sets it up in one go.
  const manifest = readCoreManifest(deps.installRoot);
  if (!manifest) {
    deps.err(
      "there is no extracted Core bundle here to place. `actana place` runs from inside " +
        "an unpacked release — `actana install` fetches one and sets it up instead.",
    );
    return 1;
  }

  const layout = resolveActanaLayout(deps.env, deps.home, deps.platform);
  const placing = {
    layout,
    env: deps.env,
    sourceRoot: deps.installRoot,
    manifest,
    platform: deps.platform,
    arch: deps.arch,
    out: deps.out,
  };

  // What was already here, read before anything moves: an activated install
  // records itself in `actana.json`, and that is what makes the difference
  // between "nothing is running yet" and "something is running, on the version
  // this is about to move `current` off".
  const existing = readActanaConfig(layout.configDir);

  let placed;
  try {
    const plan = planCorePlacement(placing);
    stopDaemonBeingReplaced(deps, layout, plan);
    placed = placeCoreBundle(placing, plan);
  } catch (err) {
    deps.err(err instanceof Error ? err.message : String(err));
    return 1;
  }

  deps.out("");
  deps.out(`Core ${placed.version} installed at ${placed.installDir}`);
  // Only when one was actually written. `claimLauncher` leaves `binLink`
  // untouched — often absent entirely — when somebody else answers to
  // `actana`, and a `Launcher` row naming a path with nothing at it would
  // contradict the note it printed three lines earlier.
  deps.out(
    placed.launcher.outcome === "linked"
      ? `  Launcher   ${placed.launcher.binLink}`
      : `  Launcher   left alone — ${placed.launcher.foreignPath} owns \`actana\` here`,
  );
  deps.out(`  Current    ${layout.currentLink}`);
  deps.out("");
  if (existing) {
    // The unit's `ExecStart` runs through `current`, which now points at the
    // tree just placed. Until `setup` runs, `actana status` and `actana.json`
    // still describe the old version, and a restart or a reboot would start
    // the new one with none of its work done.
    deps.out(
      `This machine is already set up as a Core on ${existing.version}, and \`current\` now ` +
        `points at ${placed.version}. Nothing has restarted, so it is still running ` +
        `${existing.version} — finish the upgrade with:`,
    );
  } else {
    // Installing is not activating, and an operator who is not told that has a
    // machine they believe is a Core and a Panel that will never reach it.
    deps.out("Nothing is running yet: this machine is not a Core until you set it up.");
  }
  deps.out("");
  deps.out("  " + setupCommandFor(layout, placed.launcher, deps.env));
  deps.out("");
  deps.out(
    existing
      ? "That restarts the daemon on the version just placed. This Core's identity, its " +
          "service and every client paired with it are kept."
      : "That writes this Core's identity, its auto-start service and its registration, and " +
          "starts the daemon. `actana --help` lists its port, host, label and Harness options.",
  );
  return 0;
}

/**
 * Stop a daemon whose own install directory is about to be replaced.
 *
 * The narrow case, and the only one placement can corrupt: `installTree`
 * renames a fresh tree over `installDir`, so a daemon executing out of *that*
 * directory loses the files behind it. Placing a different version writes a
 * different directory and touches nothing running, which is why this asks the
 * init system nothing on the ordinary path — a fresh machine has no tree there
 * at all.
 *
 * Best effort in both directions. A platform with neither systemd nor launchd
 * has no daemon to stop and must still be able to place a bundle, so a service
 * manager that cannot be built is not an error here; and a `stop` that fails
 * is reported rather than fatal, because the placement is still the better
 * outcome than leaving the bundle in a temporary directory about to be
 * deleted.
 */
function stopDaemonBeingReplaced(
  deps: ActanaCliDeps,
  layout: ActanaLayout,
  plan: PlacementPlan,
): void {
  if (!plan.replacingTree) return;
  if (!fs.existsSync(plan.installDir)) return;

  let service: ActanaServiceManager;
  try {
    service = createServiceManager({
      platform: deps.platform,
      layout,
      system: deps.system,
      user: deps.user,
      uid: deps.uid,
    });
  } catch {
    return;
  }

  try {
    if (!service.isActive()) return;
    deps.out(
      `Stopping the running Core: this install replaces ${plan.installDir}, which is the ` +
        "tree it is executing from. The command printed below starts it again.",
    );
    service.stop();
  } catch (err) {
    deps.out(
      `Could not stop the running Core (${err instanceof Error ? err.message : String(err)}). ` +
        "Continuing — restart it with the command printed below.",
    );
  }
}

/** `actana install` — always the download path, even inside a tarball. */
async function cmdInstall(deps: ActanaCliDeps, argv: string[]): Promise<number> {
  return cmdSetup(deps, argv, { forceDownload: true });
}

/**
 * Ask whether a newer release exists, for the availability line `status` prints.
 *
 * Returns null rather than propagating anything: `actana status` is a health
 * check with a documented exit code, so the update check is allowed to be
 * unavailable and is never allowed to be the reason the command failed.
 * `checkForUpdate` already swallows its own failures — the catch here is for
 * the one thing it cannot promise, which is that it will keep doing so.
 */
async function updateCheckFor(
  deps: ActanaCliDeps,
  dataDir: string,
  current: string | null,
): Promise<UpdateCheck | null> {
  // An install whose manifest could not be read has no version to compare, and
  // guessing one would be how a Core alerts about a release it already runs.
  if (!current || !updateCheckEnabled(deps.env)) return null;
  try {
    return await checkForUpdate({
      current,
      fetcher: deps.fetcher,
      cachePath: updateCheckCachePath(dataDir),
      now: deps.now,
      env: deps.env,
      debug: deps.debug,
    });
  } catch (err) {
    deps.debug(`update check failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * `actana status` inside the image.
 *
 * Same report, two rows answered differently: there is no unit to ask whether
 * the daemon is up, so the core-link port is asked instead, and there is no
 * unit to name as the auto-start mechanism, so the report says what actually
 * restarts this Core (ADR 0016 D16). The image is the install, so `installed`
 * is true by construction — a container running this binary at all is one.
 */
async function containerStatus(deps: ActanaCliDeps): Promise<number> {
  const installed = containerInstall(deps);
  if (!installed) return 1;
  const { layout, config } = installed;
  const manifest = readCoreManifest(deps.installRoot);

  // A zero timeout is one connect attempt: `status` reports what is true now,
  // and the daemon it is asking about is a process in the same container.
  const listening = await deps.system.waitForPort(config.port, 0);

  const report: ActanaStatusReport = {
    installed: true,
    version: manifest?.version ?? null,
    cliVersion: CLI_VERSION,
    protocolVersion: manifest?.protocolVersion ?? null,
    target: manifest?.target ?? null,
    endpoint: endpointFor(config),
    serviceName: null,
    service: null,
    persistence: null,
    container: { listening, port: config.port },
    paired: fs.existsSync(materialPathFor(deps, layout)),
    agents: deps.probeHarnesses(),
    update: await updateCheckFor(deps, config.dataDir, manifest?.version ?? null),
  };

  deps.out(formatActanaStatus(report).trimEnd());
  return summarizeHealth(report) === "healthy" ? 0 : 1;
}

async function cmdStatus(deps: ActanaCliDeps, argv: string[]): Promise<number> {
  const parsed = parseFlags(argv, {});
  if ("error" in parsed) {
    deps.err(parsed.error);
    return EXIT_USAGE;
  }
  if (inContainer(deps.env)) return containerStatus(deps);

  const installed = findInstall(deps);
  const layout = installed?.layout ?? resolveActanaLayout(deps.env, deps.home, deps.platform);
  const config = installed?.config ?? null;
  const manifest = manifestFor(deps, config);
  const service = requireService(deps, layout);
  if (!service) return 1;

  const version = manifest?.version ?? config?.version ?? null;
  const report: ActanaStatusReport = {
    installed: config !== null,
    version,
    cliVersion: CLI_VERSION,
    protocolVersion: manifest?.protocolVersion ?? null,
    target: manifest?.target ?? null,
    endpoint: config ? endpointFor(config) : null,
    serviceName: service.name,
    service: service.state(),
    persistence: service.persistence(),
    container: null,
    paired: fs.existsSync(materialFilePath(layout.configDir)),
    agents: config ? deps.probeHarnesses() : {},
    // Only for an install there is something to update: before `actana setup`
    // the report is a single "run setup" line and a release number would be an
    // answer to a question nobody asked.
    update: config ? await updateCheckFor(deps, config.dataDir, version) : null,
  };

  deps.out(formatActanaStatus(report).trimEnd());
  return summarizeHealth(report) === "healthy" ? 0 : 1;
}

/**
 * `actana pair` — mint, list and revoke this Core's pairing codes (#283).
 *
 * Thin here on purpose. The verb belongs to the machine half and needs exactly
 * one thing from the install — where `material.json` is — so that is what this
 * resolves and hands over; `actana-pair.ts` holds every decision about codes,
 * fingerprints, expiry and revocation, and is driven directly by its own tests
 * without a fake install underneath it.
 *
 * **Not refused in a container.** `pair` is not a lifecycle verb that Docker
 * owns (ADR 0016 D13) — it is how an operator enrolls a client on the Core in
 * front of them, and a containerised Core is the case where that matters most.
 * `actana-container.ts`'s refusal table is what decides this, and `pair` is
 * deliberately not on it.
 */
function cmdPair(deps: ActanaCliDeps, argv: string[]): number {
  // The install is resolved on demand rather than up front, so that `actana
  // pair --help` answers on a machine that has never run `actana setup` — the
  // help is a question about this program, not about this box.
  return runPairCommand(deps, argv, {
    materialPath: () => {
      const installed = requireInstall(deps);
      return installed ? materialPathFor(deps, installed.layout) : null;
    },
  });
}

/**
 * `actana token` — one verb deep, and only `regenerate` under it.
 *
 * Bare `actana token` used to reprint the hand-carried blob. #287 deleted that
 * artifact outright, so there is nothing to reprint and deliberately no way to
 * ask for one: a credential is issued to exactly one client, by that client
 * redeeming a code, and a command that handed out a second copy would be the
 * hand-carry back under a different name.
 *
 * It refuses rather than silently doing `regenerate`'s job. Rotation locks out
 * every paired client, and an operator whose muscle memory still types `actana
 * token` must not discover that by having it happen.
 */
async function cmdToken(deps: ActanaCliDeps, argv: string[]): Promise<number> {
  if (argv[0] === "regenerate") return cmdTokenRegenerate(deps, argv.slice(1));

  if (argv.length > 0) {
    deps.err(`actana token: unknown verb "${argv[0]}". The only one is \`regenerate\`.`);
    return EXIT_USAGE;
  }
  deps.err(
    "There is no pairing token to print. A client enrolls with a one-time code: run " +
      "`actana pair new` here, read the code and CA fingerprint it prints out to the " +
      "machine being paired, and spend them there — in your Panel's Add Core, or with " +
      "`actana core pair`.",
  );
  deps.err(
    "`actana pair ls` shows the codes still pending and the clients already paired. " +
      "`actana token regenerate` rotates this Core's own identity and locks all of them out.",
  );
  return EXIT_USAGE;
}

const REGENERATE_FLAGS: FlagSpec = { yes: { type: "boolean", alias: "y" } };

/**
 * How each kind of client comes back after this Core's identity is rotated.
 *
 * The two halves genuinely differ, and saying only "pair it again" is wrong for
 * one of them. `actana core pair` replaces a registry entry in place, so the
 * client end is one command. A Panel refuses before it spends the code — the
 * endpoint has not moved, so `refuseIfAlreadyRegistered` in
 * `packages/panel/src/server/services/core-pairing.ts` still finds the row and
 * throws "already registered", burning nothing but wasting a one-time code the
 * operator has to mint again. Forgetting the Core first is the missing step,
 * and it is missing from nowhere else: this is the only place the product tells
 * an operator to pair something that is already paired.
 */
const REPAIR_NOTE =
  "  In a Panel, remove the Core first (Settings → Cores → Remove Core) — pairing refuses " +
  "while a Core is still registered at that address, and it refuses *before* it spends " +
  "your code.\n  With `actana core pair`, no such step: it replaces the stored " +
  "credential in place.";

/**
 * `actana token regenerate` — the one-command answer to a leaked credential.
 *
 * Fresh material means a new CA, new certs, a new bearer secret and a new
 * coreId, so every credential this Core ever issued stops working: an old
 * client cert is no longer signed by the CA the daemon presents, and an old
 * bearer no longer verifies. That is the point, and it is also why the daemon
 * must be restarted before the operator is told it is done — until it reloads
 * `material.json` it is still serving the old identity from memory, and
 * "invalidated" would be a lie.
 *
 * **It rotates; it does not hand anything out.** Nothing is printed for an
 * operator to carry, because nothing is carried any more (#287): every client
 * locked out by this comes back by pairing again, which is `actana pair new`
 * here and a code spent there. `pair revoke` is the narrower instrument — it
 * takes back one client without touching the rest.
 */
async function cmdTokenRegenerate(deps: ActanaCliDeps, argv: string[]): Promise<number> {
  const parsed = parseFlags(argv, REGENERATE_FLAGS);
  if ("error" in parsed) {
    deps.err(parsed.error);
    return EXIT_USAGE;
  }
  const installed = requireInstall(deps);
  if (!installed) return 1;
  const { layout, config } = installed;
  const materialPath = materialPathFor(deps, layout);
  // A container has no unit to restart and this CLI is not the daemon's
  // parent, so the restart below is the operator's to make. Everything up to
  // it is identical.
  const container = inContainer(deps.env);
  const service = container ? null : requireService(deps, layout);
  if (!container && !service) return 1;

  if (deps.interactive && parsed.values.yes !== true) {
    const yes = await deps.system.confirm(
      "Issue fresh pairing credentials? Every Panel paired with this Core will be " +
        (container
          ? "locked out — as soon as you restart the container — until you re-pair it."
          : "locked out until you re-pair it."),
      false,
    );
    if (!yes) {
      deps.err("Left this Core's credentials alone.");
      return 1;
    }
  }

  persistMaterialToFile(materialPath, await mintFreshMaterial(config.publicHost));

  if (container) {
    if (!loadMaterialFromFile(materialPath)) {
      deps.err(`The new pairing material could not be read back from ${materialPath}.`);
      return 1;
    }
    // Said as a restart the operator still owes: the daemon holds the old
    // identity in memory until the container comes back, so "invalidated" is
    // not true yet and must not be printed as if it were.
    deps.err(
      "New pairing credentials are written. This Core is still serving the old ones " +
        "until you restart the container — `docker compose restart`. After that, " +
        "pair every client again: `actana pair new` here, and spend the code it prints " +
        `on the client.\n${REPAIR_NOTE}`,
    );
    return 0;
  }
  // Already handled above — `requireService` either answered or returned.
  if (!service) return 1;

  const restarted = service.verb("restart");
  if (restarted.status !== 0) {
    deps.err(
      `New credentials were written but ${service.name} would not restart: ` +
        `${(restarted.stderr || restarted.stdout).trim() || `exit ${restarted.status}`}. ` +
        "The daemon is still serving the old credentials until it restarts — run " +
        "`actana restart`.",
    );
    return restarted.status || 1;
  }
  const listening = await deps.system.waitForPort(config.port, LISTEN_TIMEOUT_MS);

  if (!loadMaterialFromFile(materialPath)) {
    deps.err("The new pairing material could not be read back. Re-run `actana setup`.");
    return 1;
  }

  deps.err(
    "This Core has a new identity, and every client paired with it is locked out. " +
      "Pair each one again: `actana pair new` here, then spend the code it prints on " +
      `the client.\n${REPAIR_NOTE}`,
  );

  if (!listening) {
    deps.err(
      `The daemon restarted but nothing is listening on port ${config.port} yet. ` +
        "Check `actana logs`.",
    );
    return 1;
  }
  return 0;
}

/**
 * The release channel a run was pointed at.
 *
 * `--repo` and `--base-url` are how `scripts/__tests__` and the rehearsal
 * scripts aim a real CLI at a fixture release server, and both the install
 * path and the update path take them — one release channel, read one way.
 */
function channelFrom(values: Record<string, string | true>) {
  return releaseChannel({
    repo: stringFlag(values, "repo", ""),
    baseUrl: stringFlag(values, "base-url", ""),
  });
}

const UPDATE_FLAGS: FlagSpec = {
  version: { type: "string" },
  repo: { type: "string" },
  "base-url": { type: "string" },
};

async function cmdUpdate(deps: ActanaCliDeps, argv: string[]): Promise<number> {
  const parsed = parseFlags(argv, UPDATE_FLAGS);
  if ("error" in parsed) {
    deps.err(parsed.error);
    return EXIT_USAGE;
  }
  const installed = requireInstall(deps);
  if (!installed) return 1;
  const service = requireService(deps, installed.layout);
  if (!service) return 1;

  const requestedVersion = parsed.values.version;
  if (requestedVersion === true) {
    deps.err("--version needs a value");
    return EXIT_USAGE;
  }

  let result;
  try {
    result = await runActanaUpdate({
      layout: installed.layout,
      env: deps.env,
      config: installed.config,
      service,
      system: deps.system,
      fetcher: deps.fetcher,
      channel: channelFrom(parsed.values),
      requestedVersion,
      platform: deps.platform,
      arch: deps.arch,
      out: deps.out,
    });
  } catch (err) {
    deps.err(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (!result.updated) return 0;

  deps.out("");
  deps.out(`Updated ${result.previousVersion} → ${result.version}`);
  deps.out(`  Installed at  ${result.installDir}`);
  deps.out(`  Endpoint      ${endpointFor(installed.config)}`);
  deps.out("");
  // The material is untouched, so the Panel that was paired still is — worth
  // saying, because "I just replaced the whole install" reads otherwise.
  deps.out("Your pairing credentials are unchanged — paired Panels stay paired.");

  if (!result.listening) {
    deps.err(
      `The daemon restarted but nothing is listening on port ${installed.config.port} yet. ` +
        "Check `actana logs` for why the new version did not start, or go back with " +
        `\`actana update --version ${result.previousVersion}\`.`,
    );
    return 1;
  }
  return 0;
}

const UNINSTALL_FLAGS: FlagSpec = {
  "purge-data": { type: "boolean" },
  yes: { type: "boolean", alias: "y" },
};

async function cmdUninstall(deps: ActanaCliDeps, argv: string[]): Promise<number> {
  const parsed = parseFlags(argv, UNINSTALL_FLAGS);
  if ("error" in parsed) {
    deps.err(parsed.error);
    return EXIT_USAGE;
  }
  const purgeData = parsed.values["purge-data"] === true;

  // No `requireInstall` here: an interrupted install, or one an operator half
  // deleted by hand, is exactly when uninstall has work to do.
  const layout = resolveActanaLayout(deps.env, deps.home, deps.platform);
  const service = requireService(deps, layout);
  if (!service) return 1;

  if (deps.interactive && parsed.values.yes !== true) {
    const yes = await deps.system.confirm(
      purgeData
        ? `Remove the Core, your sessions in ${layout.dataDir}, and this Core's pairing ` +
            "credentials? This cannot be undone."
        : "Stop the Core and remove it from this machine?",
      !purgeData,
    );
    if (!yes) {
      deps.err("Left this machine's Core in place.");
      return 1;
    }
  }

  const result = runActanaUninstall({ layout, service, purgeData, out: deps.out });
  if (result.removed.length === 0 && result.kept.length === 0) {
    deps.out("There was no Core installed for this user.");
  }
  return 0;
}

function cmdServiceVerb(deps: ActanaCliDeps, verb: ServiceVerb, argv: string[]): number {
  const parsed = parseFlags(argv, {});
  if ("error" in parsed) {
    deps.err(parsed.error);
    return EXIT_USAGE;
  }
  const installed = requireInstall(deps);
  if (!installed) return 1;
  const service = requireService(deps, installed.layout);
  if (!service) return 1;

  const result = service.verb(verb);
  if (result.status !== 0) {
    deps.err((result.stderr || result.stdout).trim() || `could not ${verb} ${service.name}`);
    return result.status;
  }
  if (result.stdout.trim()) deps.out(result.stdout.trim());
  return 0;
}

/**
 * The running daemon's pid, or null when nothing can tell us.
 *
 * Only the init system knows it, and in a container there is not one: the
 * daemon is a sibling process this CLI did not start and cannot identify, so
 * the re-probe timer is the whole answer there.
 */
function runningDaemonPid(deps: ActanaCliDeps): number | null {
  if (inContainer(deps.env)) return null;
  const installed = findInstall(deps);
  if (!installed) return null;
  try {
    return (
      createServiceManager({
        platform: deps.platform,
        layout: installed.layout,
        system: deps.system,
        user: deps.user,
        uid: deps.uid,
      }).state()?.mainPid ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Tell a running daemon to re-probe now.
 *
 * Best effort by design: the Core re-probes on its own timer regardless, so
 * a missing install, a stopped daemon or a signal we are not allowed to send
 * all mean "the Panel notices a minute later" rather than "this failed".
 */
function refreshAvailability(deps: ActanaCliDeps): void {
  const pid = runningDaemonPid(deps);
  if (pid !== null && deps.system.signal(pid, "SIGHUP")) {
    deps.out("The Core re-probed its Harnesses — your Panel sees them now.");
    return;
  }
  deps.out("The Core picks up new Harnesses within a minute; your Panel updates then.");
}

async function cmdHarnesses(deps: ActanaCliDeps, argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "install") {
    deps.err(
      sub === undefined ? "actana harnesses needs a subcommand." : `unknown subcommand: ${sub}`,
    );
    deps.err("Usage: actana harnesses install <id>");
    return EXIT_USAGE;
  }
  if (rest.length === 0) {
    deps.err("actana harnesses install <id> — name the Harness to install.");
    deps.err(supportedHarnessIdsSentence());
    return EXIT_USAGE;
  }

  const wanted: Harness[] = [];
  for (const token of rest) {
    const agent = resolveHarnessId(token);
    if (!agent) {
      deps.err(`unknown harness: ${token}`);
      deps.err(supportedHarnessIdsSentence());
      return EXIT_USAGE;
    }
    wanted.push(agent);
  }

  const outcomes = await installAgentsNow(wanted, {
    availability: deps.probeHarnesses(),
    platform: deps.platform,
    system: deps.system,
    homeDir: deps.home,
    out: deps.out,
  });

  if (outcomes.some((outcome) => outcome.status === "installed")) refreshAvailability(deps);

  // A failed vendor installer is this command's whole job, so unlike during
  // setup it is what the exit code reports.
  return outcomes.every(
    (outcome) => outcome.status === "installed" || outcome.status === "already-installed",
  )
    ? 0
    : 1;
}

/**
 * `actana daemon` — the Core in the foreground.
 *
 * On metal the unit carries the daemon's whole environment, so there is
 * nothing to add. In a container there is no unit: the operator's `ACTANA_*`
 * contract is resolved here — translated into the `AC_*` variables
 * `core-entry` reads, plus `ACTANA_LABEL` defaulted to the public host — and a
 * missing public host stops the boot here rather than letting the Core come up
 * with a certificate for a container id (ADR 0016 D15).
 */
async function cmdDaemon(deps: ActanaCliDeps): Promise<number> {
  if (!inContainer(deps.env)) {
    await deps.runDaemon({});
    return 0;
  }

  const contract = readContainerContract(deps.env);
  if ("error" in contract) {
    deps.err(contract.error);
    return 1;
  }

  await deps.runDaemon({
    AC_CORE_LINK_PORT: String(contract.port),
    AC_CORE_PUBLIC_HOST: contract.publicHost,
    // The label is the one contract variable `core-entry` reads under its own
    // name rather than an `AC_*` translation, and it is handed over even when
    // the operator set it — the contract's default (the public host) only
    // exists here, and without it a first-boot blob would carry `label: ""`
    // while `actana token` carried the host, for the same Core.
    [CONTAINER_LABEL_ENV]: contract.label,
  });
  return 0;
}

const LOGS_FLAGS: FlagSpec = {
  follow: { type: "boolean", alias: "f" },
  lines: { type: "string", alias: "n" },
};

async function cmdLogs(deps: ActanaCliDeps, argv: string[]): Promise<number> {
  const parsed = parseFlags(argv, LOGS_FLAGS);
  if ("error" in parsed) {
    deps.err(parsed.error);
    return EXIT_USAGE;
  }
  const lines = intFlag(parsed.values, "lines", 0);
  if (typeof lines !== "number") {
    deps.err(lines.error);
    return EXIT_USAGE;
  }
  const installed = requireInstall(deps);
  if (!installed) return 1;
  const service = requireService(deps, installed.layout);
  if (!service) return 1;

  const { command, args } = service.logs({ follow: parsed.values.follow === true, lines });
  return deps.system.passthrough(command, args);
}

// ─── dispatch ───────────────────────────────────────────────────────────────

/**
 * The version answer: this CLI's version, plus the Core it manages when that
 * Core is on a different one.
 *
 * **Reported, never enforced (#288 D10).** Nothing anywhere refuses a verb
 * because the two differ — pinning would let a global `npm update` break a
 * running Core on a machine where the operator did nothing but update a
 * client. The local verbs read the install's own manifest rather than assuming
 * this CLI's version, so they act on what is actually there.
 *
 * A CLI with no Core installed answers one line and reads nothing off disk
 * beyond the look for an install: `actana --version` on a laptop is a question
 * about this binary.
 */
function versionLines(deps: ActanaCliDeps): string[] {
  const installed = findInstall(deps);
  const manifest = manifestFor(deps, installed?.config ?? null);
  if (!manifest) return [`actana ${CLI_VERSION}`];
  const first = `actana ${CLI_VERSION} (core-link protocol ${manifest.protocolVersion})`;
  if (manifest.version === CLI_VERSION) return [first];
  return [first, `Core installed here: ${manifest.version}`];
}

/** Run one `actana` invocation. Returns the exit code; never calls process.exit. */
export async function runActanaCli(deps: ActanaCliDeps): Promise<number> {
  // Parsed up front only to find the *name* the operator typed. The client
  // nouns take their flags in any position — `actana --json core ls` is the
  // same command as `actana core ls --json` — so "which command is this" is a
  // question about the first positional, not about `argv[0]`. The machine
  // verbs each parse their own flags below, against their own spec.
  const args = parseArgs(deps.argv);
  const head = args.positionals[0];

  if (head === undefined) {
    if (args.version || deps.argv[0] === "-v") {
      for (const line of versionLines(deps)) deps.out(line);
      return EXIT_OK;
    }
    // `actana`, `actana --help` and `actana -h` are a question, not a mistake:
    // printing the help and exiting 0 is what any of the three should do, and
    // there is nothing for a script to have got wrong.
    //
    // The container page goes first: a chunk of the command list does not work
    // there, and an operator should read that before the list, not after it.
    if (inContainer(deps.env)) deps.out(CONTAINER_USAGE.trimEnd() + "\n");
    deps.out(USAGE.trimEnd());
    return EXIT_OK;
  }
  if (head === "help") {
    if (inContainer(deps.env)) deps.out(CONTAINER_USAGE.trimEnd() + "\n");
    deps.out(USAGE.trimEnd());
    return EXIT_OK;
  }

  // Everything after the command name, with the name itself removed. Normally
  // `argv.slice(1)`; the filter is for the flags-first spelling above.
  const rest = deps.argv[0] === head ? deps.argv.slice(1) : deps.argv.filter((a) => a !== head);

  // The client nouns first, and deliberately ahead of the container refusal
  // below: reaching a Core over the core link is the one thing that works
  // identically on metal, in a container, and on a laptop that has no Core at
  // all. Refusing `actana session ls` inside the image would be exactly the
  // dishonesty #288 exists to end — the Core installs a skill that teaches
  // these verbs onto the machine it is itself running on.
  if ((CLIENT_NOUNS as readonly string[]).includes(head)) {
    if (args.missingValue) {
      deps.err(`actana: ${args.missingValue} needs a value.`);
      return EXIT_USAGE;
    }
    if (args.unknown.length > 0) {
      deps.err(`actana: unknown flag ${args.unknown[0]}.`);
      deps.err("`actana --help` lists the flags this build knows.");
      return EXIT_USAGE;
    }

    // ADR 0031 D6: there is no npm lifecycle hook to install the product's own
    // skill from — this package has no `postinstall`, `preinstall` or `prepare`
    // and gains none — so "installed with the CLI" is delivered here instead,
    // in front of the first noun the operator runs. It is a no-op when the
    // copies are current, it writes nothing on a machine where no Harness has a
    // directory of its own, and it cannot fail: nothing it does reaches the
    // exit code or either output stream.
    //
    // `actana harness skills` is the one verb it does not run in front of: that
    // verb does the same work and reports it, and an ensure that had already
    // repaired the copy would leave the explicit path with nothing to say but
    // "current" — a repair verb that can never report a repair.
    if (!(head === "harness" && args.positionals[1] === "skills")) {
      ensureOrchestrationSkillQuietly(deps.home);
    }

    const paths = registryPaths(deps.env, deps.home);

    switch (head) {
      case "core":
        return runCoreCommand(deps, args, paths);
      case "project":
        return runProjectCommand(deps, args, paths);
      case "harness":
        return runHarnessCommand(deps, args, paths);
      case "events":
        return runEventsCommand(deps, args, paths);
      default:
        return runSessionCommand(deps, args, paths);
    }
  }

  // Checked before the machine-side dispatch, not inside each verb: the answer
  // is a property of where this Core is running, and a verb that got as far as
  // parsing its own flags would be a verb an operator could believe was about
  // to run.
  if (inContainer(deps.env)) {
    const refusal = containerRefusal(head);
    if (refusal) {
      deps.err(refusal);
      return EXIT_USAGE;
    }
  }

  switch (head) {
    case "install":
      return cmdInstall(deps, rest);
    case "place":
      return cmdPlace(deps, rest);
    case "setup":
      return cmdSetup(deps, rest);
    case "status":
      return cmdStatus(deps, rest);
    case "token":
      return cmdToken(deps, rest);
    case "pair":
      return cmdPair(deps, rest);
    case "update":
      return cmdUpdate(deps, rest);
    case "start":
    case "stop":
    case "restart":
      return cmdServiceVerb(deps, head, rest);
    case "logs":
      return cmdLogs(deps, rest);
    case "harnesses":
      return cmdHarnesses(deps, rest);
    case "uninstall":
      return cmdUninstall(deps, rest);
    // Not in the usage text: `daemon` is what the unit / LaunchAgent execs —
    // and what the image's `CMD` runs — not something an operator types.
    // `start`/`stop` are their handles on metal; Docker is in a container.
    //
    // There is no "wrong package" refusal here and there is no longer anywhere
    // for one to live: the message the client half used to print — *running a
    // Core is not this package's half of `actana`* — is deleted rather than
    // reworded, because the confusion it explained cannot occur once there is
    // one program under this name (#288).
    case "daemon":
      return cmdDaemon(deps);
    default: {
      const reserved = RESERVED_NOUNS[head];
      if (reserved) {
        deps.err(`actana ${head}: not built yet — ${reserved}.`);
        return EXIT_UNIMPLEMENTED;
      }
      // One message for one namespace (#288). `actana` used to answer
      // `unknown command: setup` from one program and `unknown noun "setup"`
      // from the other, which was the split leaking into its own error text.
      deps.err(`actana: unknown command "${head}".`);
      deps.err("`actana --help` lists the commands and the nouns.");
      return EXIT_USAGE;
    }
  }
}

export { USAGE, CONTAINER_USAGE, CLIENT_NOUNS, EXIT_USAGE };
