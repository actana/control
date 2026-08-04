// The `actana` CLI — one command that owns a Core's machine-side lifecycle.
//
//   actana setup     install, auto-start, and print the pairing token
//   actana status    daemon state, versions, endpoint, agent availability
//   actana token     reprint the pairing token
//   actana token regenerate   mint fresh credentials, invalidating the old ones
//   actana update    fetch, verify and swap in a release, then restart
//   actana start|stop|restart|logs
//   actana agents install <id>   install an agent CLI, the vendor's way
//   actana uninstall remove the service and the install
//
// `runActanaCli` takes every side effect as a dependency and returns an exit
// code instead of calling `process.exit`, so the whole verb surface — dispatch,
// flag validation, output, exit codes — is exercised in unit tests. The thin
// `actana-cli-entry.ts` wires it to the real process.
//
// Operator-facing strings say "pairing token" (CONTEXT.md's UI note); the code
// underneath keeps the domain name "Registration blob".

import * as fs from "node:fs";
import { signBearer, type BearerSecret } from "../../shared/src/core-link-bearer";
import { encodeRegistrationBlob } from "../../shared/src/registration-blob";
import type { CoreLinkAgentAvailabilityMap } from "../../shared/src/core-link-frames";
import { loadMaterial, materialFilePath, persistMaterial } from "./harness-material-store";
import { endpointFor, readActanaConfig, type ActanaConfig } from "./actana-config";
import { binDirOnPath, resolveActanaLayout, type ActanaLayout } from "./actana-layout";
import { readHarnessManifest, type HarnessManifest } from "./actana-manifest";
import { releaseChannel, type ReleaseFetcher } from "./actana-release";
import {
  createServiceManager,
  type ActanaServiceManager,
  type ServiceVerb,
} from "./actana-service";
import { choosePublicHost, mintFreshMaterial, runActanaSetup } from "./actana-setup";
import {
  agentFlagNames,
  agentFromFlagName,
  installAgentsNow,
  offerableAgentIds,
  resolveAgentId,
  summarizeAgentInstalls,
  supportedAgentIdsSentence,
} from "./actana-agents";
import type { TaskAgent } from "../../shared/src/domain";
import { formatActanaStatus, summarizeHealth } from "./actana-status";
import type { ActanaSystem } from "./actana-system";
import { runActanaUninstall } from "./actana-uninstall";
import { runActanaUpdate } from "./actana-update";

/** Exit code for a usage error — wrong verb, unknown flag, unparseable value. */
const EXIT_USAGE = 2;

/** Default core-link port. Matches the port the docs and install script use. */
const DEFAULT_PORT = 8443;

/** Bearer validity for a reprinted token. Same lease setup issues. */
const BEARER_DAYS = 365;

/** How long a verb that restarts the daemon waits for its port to answer. */
const LISTEN_TIMEOUT_MS = 30_000;

export type ActanaCliDeps = {
  /** `process.argv.slice(2)`. */
  argv: string[];
  env: NodeJS.ProcessEnv;
  home: string;
  hostname: string;
  networkInterfaces: NodeJS.Dict<{ address: string; family: string; internal: boolean }[]>;
  platform: NodeJS.Platform;
  arch: string;
  /** The operator's username, for `loginctl`. */
  user: string;
  /** The operator's uid, for the launchd domain. */
  uid: number;
  /** The extracted tarball tree this CLI is running from. */
  installRoot: string;
  /** Whether there is a terminal to prompt on. */
  interactive: boolean;
  system: ActanaSystem;
  /** How `actana update` reaches the release channel. */
  fetcher: ReleaseFetcher;
  out: (line: string) => void;
  err: (line: string) => void;
  /** The Harness's own PATH probe — the source of truth for agent availability. */
  probeAgents: () => CoreLinkAgentAvailabilityMap;
  /** Run the Harness daemon in the foreground. What the systemd unit execs. */
  runDaemon: () => Promise<void>;
};

const USAGE = `actana — install and operate an Actana Control Harness.

Usage:
  actana <command> [options]

Commands:
  setup      Install the Harness, start it, and print the pairing token
  status     Show daemon state, versions, endpoint, and agent availability
  token      Reprint the pairing token
  token regenerate
             Issue fresh pairing credentials and invalidate the old ones
  update     Install the latest release and restart the daemon
  start      Start the Harness daemon
  stop       Stop the Harness daemon
  restart    Restart the Harness daemon
  logs       Show the daemon's log output
  agents     Manage agent CLIs — \`actana agents install <id>\`
  uninstall  Stop the daemon and remove the service and the install

Setup options:
  --port <n>            Port the daemon listens on (default ${DEFAULT_PORT})
  --host <addr>         Address the daemon binds (default 0.0.0.0)
  --public-host <addr>  Address your Panel dials (default: this machine's IP)
  --label <name>        Alias shown in your Panel (default: the hostname)
  --with-<agent>        Install this agent CLI without asking (repeatable)
  --no-agents           Do not install or offer any agent CLI
  --yes                 Take the recommended answer to every prompt, which
                        includes installing every missing agent CLI

Missing agent CLIs are offered one at a time on a terminal. With no terminal
and none of the three flags above, nothing is installed and nothing is asked.
Agent ids: ${offerableAgentIds().join(", ")}.

Update options:
  --version <v>         Install this exact release (default: the latest)
  --repo <slug>         GitHub repository to update from
  --base-url <url>      Fetch releases from here instead of GitHub (testing)

Uninstall options:
  --purge-data          Also delete your sessions and this Core's credentials
  --yes                 Do not ask for confirmation

Log options:
  -f, --follow          Keep printing new lines as they arrive
  -n, --lines <n>       Show only the last n lines

Global options:
  --help                Show this help
  --version             Show the installed Harness version

\`actana status\` exits non-zero when the Harness is not healthy, so it works
as a health check in scripts.
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

function requireInstall(deps: ActanaCliDeps): InstalledCore | null {
  const installed = findInstall(deps);
  if (!installed) {
    deps.err("No Harness is installed for this user. Run `actana setup` first.");
  }
  return installed;
}

/** Read the manifest of the installed tree, falling back to the running tree. */
function manifestFor(deps: ActanaCliDeps, config: ActanaConfig | null): HarnessManifest | null {
  return (
    (config ? readHarnessManifest(config.installDir) : null) ??
    readHarnessManifest(deps.installRoot)
  );
}

/**
 * Mint a pairing token from persisted material.
 *
 * The bearer is re-signed rather than stored: the same secret and coreId the
 * daemon loads verify it, and a freshly signed one carries a full lease
 * instead of whatever was left of the original.
 */
function pairingToken(config: ActanaConfig, layout: ActanaLayout): string | null {
  const material = loadMaterial(layout.configDir);
  if (!material) return null;
  return encodeRegistrationBlob({
    endpoint: endpointFor(config),
    label: config.label,
    caCert: material.caCert,
    clientCert: material.clientCert,
    clientKey: material.clientKey,
    bearer: signBearer(
      { coreId: material.coreId, exp: Date.now() + BEARER_DAYS * 24 * 60 * 60 * 1000 },
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
  "no-agents": { type: "boolean" },
  // `--with-<agent>` is one boolean flag per agent rather than a repeatable
  // `--with <id>`: the flags come from the registry, so a typo is caught by
  // the same "unknown option" path as every other flag instead of failing
  // later with an id nobody recognises.
  ...Object.fromEntries(agentFlagNames().map((name) => [name, { type: "boolean" } as const])),
};

/** The agents `--with-<agent>` named, deduplicated in registry order. */
function requestedAgents(values: Record<string, string | true>): TaskAgent[] {
  const named = new Set<TaskAgent>();
  for (const key of Object.keys(values)) {
    const agent = agentFromFlagName(key);
    if (agent) named.add(agent);
  }
  return offerableAgentIds().filter((agent) => named.has(agent));
}

async function cmdSetup(deps: ActanaCliDeps, argv: string[]): Promise<number> {
  const parsed = parseFlags(argv, SETUP_FLAGS);
  if ("error" in parsed) {
    deps.err(parsed.error);
    // A mistyped agent gets the list rather than a bare "unknown option",
    // because `--with-claude-cli` is a guess about naming, not a typo.
    if (parsed.unknownOption?.startsWith("with-")) deps.err(supportedAgentIdsSentence());
    return EXIT_USAGE;
  }
  const agents = requestedAgents(parsed.values);
  if (parsed.values["no-agents"] === true && agents.length > 0) {
    deps.err("--no-agents cannot be combined with --with-<agent>.");
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

  const manifest = readHarnessManifest(deps.installRoot);
  if (!manifest) {
    deps.err(`${deps.installRoot} is not an extracted Harness tarball.`);
    return 1;
  }

  const layout = resolveActanaLayout(deps.env, deps.home, deps.platform);
  const service = requireService(deps, layout);
  if (!service) return 1;

  const publicHost = stringFlag(
    parsed.values,
    "public-host",
    choosePublicHost(deps.networkInterfaces, deps.hostname),
  );

  let result;
  try {
    result = await runActanaSetup({
      layout,
      sourceRoot: deps.installRoot,
      manifest,
      port,
      host: stringFlag(parsed.values, "host", "0.0.0.0"),
      publicHost,
      label: stringFlag(parsed.values, "label", deps.hostname),
      platform: deps.platform,
      arch: deps.arch,
      assumeYes: parsed.values.yes === true,
      interactive: deps.interactive,
      requestedAgents: agents,
      noAgents: parsed.values["no-agents"] === true,
      probeAgents: deps.probeAgents,
      system: deps.system,
      service,
      out: deps.out,
    });
  } catch (err) {
    deps.err(err instanceof Error ? err.message : String(err));
    return 1;
  }

  deps.out("");
  deps.out(`Harness installed at ${result.installDir}`);
  deps.out(`  Version    ${manifest.version}`);
  deps.out(`  Endpoint   wss://${publicHost}:${port}`);
  deps.out(`  Service    ${result.serviceName} (${result.serviceSummary})`);
  const agentSummary = summarizeAgentInstalls(result.agents);
  if (agentSummary) deps.out(`  ${agentSummary}`);
  if (!binDirOnPath(layout.binDir, deps.env.PATH)) {
    deps.out("");
    deps.out(
      `Note: ${layout.binDir} is not on your PATH, so \`actana\` will not be found in a ` +
        `new shell. Add it:\n  export PATH="${layout.binDir}:$PATH"`,
    );
  }
  deps.out("");
  if (result.reusedMaterial) {
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

function cmdStatus(deps: ActanaCliDeps, argv: string[]): number {
  const parsed = parseFlags(argv, {});
  if ("error" in parsed) {
    deps.err(parsed.error);
    return EXIT_USAGE;
  }

  const installed = findInstall(deps);
  const layout = installed?.layout ?? resolveActanaLayout(deps.env, deps.home, deps.platform);
  const config = installed?.config ?? null;
  const manifest = manifestFor(deps, config);
  const service = requireService(deps, layout);
  if (!service) return 1;

  const report = {
    installed: config !== null,
    version: manifest?.version ?? config?.version ?? null,
    protocolVersion: manifest?.protocolVersion ?? null,
    target: manifest?.target ?? null,
    endpoint: config ? endpointFor(config) : null,
    serviceName: service.name,
    service: service.state(),
    persistence: service.persistence(),
    paired: fs.existsSync(materialFilePath(layout.configDir)),
    agents: config ? deps.probeAgents() : {},
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

  const token = pairingToken(installed.config, installed.layout);
  if (!token) {
    deps.err("No pairing material found. Re-run `actana setup` to reissue it.");
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
  const service = requireService(deps, layout);
  if (!service) return 1;

  if (deps.interactive && parsed.values.yes !== true) {
    const yes = await deps.system.confirm(
      "Issue fresh pairing credentials? Every Panel paired with this Core will be " +
        "locked out until you re-pair it.",
      false,
    );
    if (!yes) {
      deps.err("Left this Core's credentials alone.");
      return 1;
    }
  }

  persistMaterial(layout.configDir, await mintFreshMaterial(config.publicHost));

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

  const token = pairingToken(config, layout);
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
      config: installed.config,
      service,
      system: deps.system,
      fetcher: deps.fetcher,
      channel: releaseChannel({
        repo: stringFlag(parsed.values, "repo", ""),
        baseUrl: stringFlag(parsed.values, "base-url", ""),
      }),
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
        ? `Remove the Harness, your sessions in ${layout.dataDir}, and this Core's pairing ` +
            "credentials? This cannot be undone."
        : "Stop the Harness and remove it from this machine?",
      !purgeData,
    );
    if (!yes) {
      deps.err("Left this machine's Harness in place.");
      return 1;
    }
  }

  const result = runActanaUninstall({ layout, service, purgeData, out: deps.out });
  if (result.removed.length === 0 && result.kept.length === 0) {
    deps.out("There was no Harness installed for this user.");
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
 * Tell a running daemon to re-probe now.
 *
 * Best effort by design: the Harness re-probes on its own timer regardless, so
 * a missing install, a stopped daemon or a signal we are not allowed to send
 * all mean "the Panel notices a minute later" rather than "this failed".
 */
function refreshAvailability(deps: ActanaCliDeps): void {
  const installed = findInstall(deps);
  if (!installed) return;
  let pid: number | null = null;
  try {
    pid =
      createServiceManager({
        platform: deps.platform,
        layout: installed.layout,
        system: deps.system,
        user: deps.user,
        uid: deps.uid,
      }).state()?.mainPid ?? null;
  } catch {
    return;
  }
  if (pid !== null && deps.system.signal(pid, "SIGHUP")) {
    deps.out("The Harness re-probed its agent CLIs — your Panel sees them now.");
    return;
  }
  deps.out("The Harness picks up new agent CLIs within a minute; your Panel updates then.");
}

async function cmdAgents(deps: ActanaCliDeps, argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "install") {
    deps.err(
      sub === undefined ? "actana agents needs a subcommand." : `unknown subcommand: ${sub}`,
    );
    deps.err("Usage: actana agents install <id>");
    return EXIT_USAGE;
  }
  if (rest.length === 0) {
    deps.err("actana agents install <id> — name the agent to install.");
    deps.err(supportedAgentIdsSentence());
    return EXIT_USAGE;
  }

  const wanted: TaskAgent[] = [];
  for (const token of rest) {
    const agent = resolveAgentId(token);
    if (!agent) {
      deps.err(`unknown agent: ${token}`);
      deps.err(supportedAgentIdsSentence());
      return EXIT_USAGE;
    }
    wanted.push(agent);
  }

  const outcomes = await installAgentsNow(wanted, {
    availability: deps.probeAgents(),
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

/** Run one `actana` invocation. Returns the exit code; never calls process.exit. */
export async function runActanaCli(deps: ActanaCliDeps): Promise<number> {
  const [verb, ...rest] = deps.argv;

  if (verb === undefined || verb === "help" || verb === "--help" || verb === "-h") {
    deps.out(USAGE.trimEnd());
    return 0;
  }
  if (verb === "--version" || verb === "-v") {
    const manifest = manifestFor(deps, findInstall(deps)?.config ?? null);
    if (!manifest) {
      deps.err("Could not read harness-manifest.json — is this an extracted tarball?");
      return 1;
    }
    deps.out(`actana ${manifest.version} (core-link protocol ${manifest.protocolVersion})`);
    return 0;
  }

  switch (verb) {
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
      return cmdServiceVerb(deps, verb, rest);
    case "logs":
      return cmdLogs(deps, rest);
    case "agents":
      return cmdAgents(deps, rest);
    case "uninstall":
      return cmdUninstall(deps, rest);
    // Not in the usage text: `daemon` is what the unit / LaunchAgent execs,
    // not something an operator runs. `start`/`stop` are their handles.
    case "daemon":
      await deps.runDaemon();
      return 0;
    default:
      deps.err(`unknown command: ${verb}`);
      deps.err("Run `actana --help` for the list of commands.");
      return EXIT_USAGE;
  }
}

export { USAGE, EXIT_USAGE };
