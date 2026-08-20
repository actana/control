// `actana` — one command, one program: the Core manager and the client.
//
//   Machine-side verbs — what this machine's own Core is and does
//     actana install   fetch a release, verify it, install and start a Core
//     actana setup     install from an extracted tarball, or fetch one first
//     actana status    daemon state, versions, endpoint, Harness availability
//     actana token     reprint the pairing token
//     actana token regenerate   mint fresh credentials, invalidating the old ones
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
//   **A blob is a credential and never reaches an output sink.** Not stdout,
//   not stderr, not `--verbose`, not an error message quoting the input that
//   failed to parse. `registration-blob-file.ts` is the only module that turns
//   bytes into a blob and it reduces one to a {@link BlobSummary} for anything
//   that prints; `src/__tests__/never-logs-a-blob.test.ts` runs every verb,
//   with `--verbose`, against a blob whose material is a known sentinel and
//   fails if any byte of it appears in any output.
//
//   **Context-sensitivity stays.** The same binary ships inside the Core
//   image, where the machine lifecycle belongs to the container runtime
//   instead: `setup`, `install`, `start`, `stop`, `restart`, `update`,
//   `uninstall` and `logs` refuse and name the Docker command that does the
//   job, driven by `ACTANA_CONTAINER` and never by sniffing `/.dockerenv`
//   (ADR 0016 D13/D15/D16). The client nouns are never refused: talking to a
//   Core is the one thing that works identically everywhere.
//
// Operator-facing strings say "pairing token" (CONTEXT.md's UI note); the code
// underneath keeps the domain name "Registration blob".


import * as fs from "node:fs";
import { signBearer, type BearerSecret } from "@actana/shared/core-link-bearer";
import { encodeRegistrationBlob } from "@actana/shared/registration-blob";
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
import { choosePublicHost, runActanaSetup } from "./actana-setup.ts";
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

/** Bearer validity for a reprinted token. Same lease setup issues. */
const BEARER_DAYS = 365;

/** How long a verb that restarts the daemon waits for its port to answer. */
const LISTEN_TIMEOUT_MS = 30_000;

const USAGE = `actana — drive AI coding agents across your Cores, and run one here.

Usage:
  actana <command> [options]
  actana <noun> <verb> [flags]

Cores this machine can reach
  core       Register, select and inspect them
  project    The Projects a Core owns: ls, add, browse, files, cp
  harness    The coding agents a Core can run: ls, install, skills
  events     Follow a Core's event log: tail
  session    Start, ls, logs, resume, attach, kill and send to Sessions on one

This machine's own Core
  install    Fetch a release, verify it, install the Core and start it
  setup      Install from an extracted tarball — or fetch one when there is none
  status     Show daemon state, versions, endpoint, and Harness availability
  token      Reprint the pairing token
  token regenerate
             Issue fresh pairing credentials and invalidate the old ones
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
  --verbose             Explain the steps, on stderr. Never prints a blob.

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
                        it is baked into this Core's certificate and its pairing token
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

/**
 * Mint a pairing token from persisted material.
 *
 * The bearer is re-signed rather than stored: the same secret and coreId the
 * daemon loads verify it, and a freshly signed one carries a full lease
 * instead of whatever was left of the original.
 */
function pairingToken(config: ActanaConfig, materialPath: string, now: number): string | null {
  const material = loadMaterialFromFile(materialPath);
  if (!material) return null;
  return encodeRegistrationBlob({
    endpoint: endpointFor(config),
    label: config.label,
    caCert: material.caCert,
    clientCert: material.clientCert,
    clientKey: material.clientKey,
    bearer: signBearer(
      { coreId: material.coreId, exp: now + BEARER_DAYS * 24 * 60 * 60 * 1000 },
      material.bearerSecret as BearerSecret,
    ),
  });
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
    // and the address is the half the Panel holds — so the token is the fix
    // here, not just an option.
    deps.out(
      "This machine's pairing credentials are unchanged — a paired Panel still " +
        `trusts this Core, but it is dialling the address it paired with. Point it at ` +
        `${publicHost} or re-pair it with this token:`,
    );
  } else if (result.materialOutcome === "reused") {
    // The bytes differ every time (the bearer inside carries a fresh expiry),
    // so "the same token" would be a lie — but the credentials a paired Panel
    // pinned are untouched, which is what the operator needs to know.
    deps.out(
      "This machine's pairing credentials are unchanged — a Panel already paired " +
        "with it stays paired. Pair a new Panel with this token:",
    );
  } else {
    deps.out('Your pairing token — paste this into your Panel\'s "Add Core":');
  }
  deps.out("");
  deps.out(result.blob);
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

async function cmdToken(deps: ActanaCliDeps, argv: string[]): Promise<number> {
  if (argv[0] === "regenerate") return cmdTokenRegenerate(deps, argv.slice(1));

  const parsed = parseFlags(argv, {});
  if ("error" in parsed) {
    deps.err(parsed.error);
    return EXIT_USAGE;
  }
  const installed = requireInstall(deps);
  if (!installed) return 1;

  const token = pairingToken(
    installed.config,
    materialPathFor(deps, installed.layout),
    deps.now(),
  );
  if (!token) {
    deps.err(
      inContainer(deps.env)
        ? "This Core has no pairing material yet — it is minted on first boot. Check " +
            "`docker compose logs` for why the daemon did not start."
        : "No pairing material found. Re-run `actana setup` to reissue it.",
    );
    return 1;
  }

  // The instruction goes to stderr so stdout stays a single pipeable token.
  deps.err('Your pairing token — paste this into your Panel\'s "Add Core":');
  deps.out(token);
  return 0;
}

const REGENERATE_FLAGS: FlagSpec = { yes: { type: "boolean", alias: "y" } };

/**
 * `actana token regenerate` — the one-command answer to a leaked pairing token.
 *
 * Fresh material means a new CA, new certs, a new bearer secret and a new
 * coreId, so every credential in every blob this Core ever printed stops
 * working: the old client cert is no longer signed by the CA the daemon
 * presents, and the old bearer no longer verifies. That is the point, and it is
 * also why the daemon must be restarted before the operator is told it is done
 * — until it reloads `material.json` it is still serving the old identity from
 * memory, and "invalidated" would be a lie.
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
    const token = pairingToken(config, materialPath, deps.now());
    if (!token) {
      deps.err(`The new pairing material could not be read back from ${materialPath}.`);
      return 1;
    }
    // Said before the token, and said as a restart the operator still owes:
    // the daemon holds the old identity in memory until the container comes
    // back, so "invalidated" is not true yet and must not be printed as if it
    // were.
    deps.err(
      "New pairing credentials are written. This Core is still serving the old ones " +
        "until you restart the container — `docker compose restart` — and the token " +
        "below only works after that. Re-pair every Panel with it:",
    );
    deps.out(token);
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

  const token = pairingToken(config, materialPath, deps.now());
  if (!token) {
    deps.err("The new pairing material could not be read back. Re-run `actana setup`.");
    return 1;
  }

  deps.err(
    "This Core's previous pairing tokens no longer work. Re-pair every Panel with this one:",
  );
  deps.out(token);

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
    case "setup":
      return cmdSetup(deps, rest);
    case "status":
      return cmdStatus(deps, rest);
    case "token":
      return cmdToken(deps, rest);
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
