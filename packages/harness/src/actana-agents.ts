// Agent CLI detection and offers — the part of `actana setup` that makes the
// install one-stop rather than "installed, now go read four vendors' docs".
//
// The Harness's own availability probe is the source of truth for what is
// missing (CONTEXT.md: "CLI availability is Harness-published state"), so
// nothing here re-implements a PATH lookup — this module takes an availability
// map and decides what to do about it.
//
// What to do about it depends on how `actana` was invoked, and the three modes
// must not bleed into each other:
//
//   • A terminal, no flags → one Y/n offer per missing agent.
//   • `--with-<agent>` / `--yes` → install unattended, no questions.
//   • No terminal, no flags → install nothing, print how to do it later.
//
// The last one is the rule the others exist to protect: a provisioning script
// piping the one-liner into bash must never block on a prompt nobody can see.
//
// Each install shells to the vendor's own installer (`installCommand` in the
// shared registry) so the agent's updater and login flow work normally
// afterwards. A vendor installer that fails is reported and stepped over — an
// operator whose Harness installed fine has a working Core, and losing that
// over a third party's bad day would be absurd.

import { AGENT_REGISTRY, UI_AGENTS } from "../../shared/src/agents";
import {
  AGENT_CLI_CONFIG,
  resolveAgentCliInstallCommand,
  type AgentCliConfig,
} from "../../shared/src/agent-cli-config";
import type { TaskAgent } from "../../shared/src/domain";
import type { CoreLinkAgentAvailabilityMap } from "../../shared/src/core-link-frames";
import type { ActanaSystem } from "./actana-system";

/** What became of one agent during an offer round. */
export type AgentInstallStatus =
  /** The vendor's installer ran and exited 0. */
  | "installed"
  /** The vendor's installer ran and failed. The Harness install is unaffected. */
  | "failed"
  /** The operator answered no. */
  | "declined"
  /** It was already on PATH — nothing to do. */
  | "already-installed"
  /** Nobody asked for it and there was no terminal to offer it on. */
  | "skipped"
  /** The vendor publishes no scripted installer for this platform. */
  | "unsupported";

export type AgentInstallOutcome = {
  agent: TaskAgent;
  /** The vendor's name for it — "Claude Code", not "claude-code". */
  label: string;
  status: AgentInstallStatus;
};

export type AgentOfferOptions = {
  /** What the Harness's probe found. */
  availability: CoreLinkAgentAvailabilityMap;
  /** Agents named with `--with-<agent>`; installed without asking. */
  requested: readonly TaskAgent[];
  /**
   * Consider only these agents. `actana agents install <id>` sets it so the
   * round is about the ids the operator named and says nothing about the rest;
   * `actana setup` leaves it off and considers every managed agent.
   */
  scope?: readonly TaskAgent[];
  /** `--no-agents` — do not install or offer anything. */
  noAgents: boolean;
  /** `--yes` — take the recommended answer, which is "install it". */
  assumeYes: boolean;
  /** Whether there is a terminal to prompt on. */
  interactive: boolean;
  platform: NodeJS.Platform;
  system: ActanaSystem;
  /** Progress and warnings for the operator. */
  out: (line: string) => void;
};

/** The prefix `--with-<id>` flags are built from, and read back out of. */
const AGENT_FLAG_PREFIX = "with-";

/**
 * The ids `--with-<id>` and `actana agents install <id>` accept, in order.
 *
 * Exactly the agents the Harness's availability probe covers, minus the ones
 * the registry has disabled — offering to install something the probe will
 * never report on would produce an agent that is installed and permanently
 * invisible to the Panel.
 */
export function offerableAgentIds(): TaskAgent[] {
  return UI_AGENTS.filter((agent) => !AGENT_REGISTRY[agent].disabled);
}

/**
 * Read an operator-typed agent id.
 *
 * Both the canonical id and the CLI command answer, because both are names the
 * operator has seen: the Panel labels agents `claude-code`, the machine has a
 * `claude` on its PATH, and refusing one of them would be pedantry.
 */
export function resolveAgentId(token: string): TaskAgent | null {
  const needle = token.trim().toLowerCase();
  if (!needle) return null;
  for (const agent of offerableAgentIds()) {
    const config = AGENT_CLI_CONFIG[agent];
    const names = [agent, config.command, ...(config.resolveAs ?? [])];
    if (names.some((name) => name.toLowerCase() === needle)) return agent;
  }
  return null;
}

/** The list an unknown id is answered with. */
export function supportedAgentIdsSentence(): string {
  return `Supported agents: ${offerableAgentIds().join(", ")}.`;
}

/** Every `--with-<id>` spelling, for the setup verb's flag spec. */
export function agentFlagNames(): string[] {
  const names = new Set<string>();
  for (const agent of offerableAgentIds()) {
    const config = AGENT_CLI_CONFIG[agent];
    names.add(`${AGENT_FLAG_PREFIX}${agent}`);
    names.add(`${AGENT_FLAG_PREFIX}${config.command}`);
  }
  return [...names];
}

/**
 * The agent a parsed flag name names, or null when the flag is not one of
 * ours. The `with-` prefix is built and read in this one module, so the setup
 * verb never has to know how the flags were spelled.
 */
export function agentFromFlagName(flag: string): TaskAgent | null {
  if (!flag.startsWith(AGENT_FLAG_PREFIX)) return null;
  return resolveAgentId(flag.slice(AGENT_FLAG_PREFIX.length));
}

/**
 * The agents this machine does not have.
 *
 * `outdated` is deliberately not missing: the CLI is there, its own updater
 * owns its version, and the Panel already has an update-required affordance
 * for it. Re-running a vendor's *installer* over a working install would be a
 * different, more destructive act than what the operator was offered.
 */
export function missingAgents(availability: CoreLinkAgentAvailabilityMap): TaskAgent[] {
  return offerableAgentIds().filter((agent) => {
    const entry = availability[agent];
    // No entry at all means the probe never covered it — treating that as
    // "missing" would offer to install agents the Harness does not manage.
    if (!entry) return false;
    return entry.status === "missing" && entry.reason !== "disabled";
  });
}

/** Run one vendor installer with the operator's terminal attached. */
async function installAgent(
  config: AgentCliConfig,
  opts: AgentOfferOptions,
): Promise<AgentInstallStatus> {
  const command = resolveAgentCliInstallCommand(config.installCommand, opts.platform);
  if (!command) {
    opts.out(
      `${config.label} has no scripted installer for ${opts.platform}. ` +
        `Install it from ${config.packageUrl}.`,
    );
    return "unsupported";
  }

  opts.out(`Installing ${config.label}: ${command}`);
  // Passthrough rather than a captured run: vendor installers print progress
  // and some of them take a while, and a silent minute reads as a hang.
  const status = await opts.system.passthrough("/bin/sh", ["-c", command]);
  if (status === 0) return "installed";

  // Loud, but not fatal — the caller keeps going and setup still finishes.
  opts.out(
    `Warning: installing ${config.label} failed (exit ${status}). Your Harness is ` +
      `installed and running. Install it yourself from ${config.packageUrl}, or ` +
      `retry with \`actana agents install ${config.agent}\`.`,
  );
  return "failed";
}

/**
 * Offer, install, and report on every managed agent CLI.
 *
 * Returns one outcome per agent considered, so the caller prints a summary
 * rather than this module deciding what a summary looks like. Never throws:
 * every failure mode is an outcome.
 */
export async function offerAgentInstalls(
  opts: AgentOfferOptions,
): Promise<AgentInstallOutcome[]> {
  if (opts.noAgents) return [];

  const requested = new Set(opts.requested);
  const missing = new Set(missingAgents(opts.availability));
  const considered = opts.scope
    ? offerableAgentIds().filter((agent) => opts.scope!.includes(agent))
    : offerableAgentIds();
  const outcomes: AgentInstallOutcome[] = [];
  const deferred: TaskAgent[] = [];

  for (const agent of considered) {
    const config = AGENT_CLI_CONFIG[agent];
    const record = (status: AgentInstallStatus) =>
      outcomes.push({ agent, label: config.label, status });

    if (!missing.has(agent)) {
      // Only worth a line when the operator asked for it — otherwise every
      // setup would report three agents nobody mentioned.
      if (requested.has(agent)) {
        opts.out(`${config.label} is already installed.`);
        record("already-installed");
      }
      continue;
    }

    if (requested.has(agent) || opts.assumeYes) {
      record(await installAgent(config, opts));
      continue;
    }

    if (!opts.interactive) {
      deferred.push(agent);
      record("skipped");
      continue;
    }

    const yes = await opts.system.confirm(
      `Install ${config.label} (${config.command})? It is not on this machine.`,
      true,
    );
    if (!yes) {
      record("declined");
      continue;
    }
    record(await installAgent(config, opts));
  }

  if (deferred.length > 0) {
    opts.out("");
    opts.out(
      `These agent CLIs are not installed: ${deferred.join(", ")}. Install one with ` +
        `\`actana agents install <id>\`.`,
    );
  }

  return outcomes;
}

/** What `installAgentsNow` needs that is not the list of agents. */
export type AgentInstallContext = Pick<
  AgentOfferOptions,
  "availability" | "platform" | "system" | "out"
>;

/**
 * Install exactly these agents — what `actana agents install <id>` does.
 *
 * The operator named them on the command line, so there is nothing left to
 * offer: no prompt, and no word about the agents they did not name.
 */
export function installAgentsNow(
  agents: readonly TaskAgent[],
  context: AgentInstallContext,
): Promise<AgentInstallOutcome[]> {
  return offerAgentInstalls({
    ...context,
    requested: agents,
    scope: agents,
    noAgents: false,
    assumeYes: false,
    interactive: false,
  });
}

/** The one-line summary `actana setup` prints for a finished offer round. */
export function summarizeAgentInstalls(outcomes: readonly AgentInstallOutcome[]): string | null {
  const installed = outcomes.filter((o) => o.status === "installed");
  const failed = outcomes.filter((o) => o.status === "failed" || o.status === "unsupported");
  if (installed.length === 0 && failed.length === 0) return null;

  const parts: string[] = [];
  if (installed.length > 0) parts.push(`installed ${installed.map((o) => o.label).join(", ")}`);
  if (failed.length > 0) parts.push(`could not install ${failed.map((o) => o.label).join(", ")}`);
  return `Agent CLIs: ${parts.join("; ")}.`;
}
