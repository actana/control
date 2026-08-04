// Harness CLI detection and offers — the part of `actana setup` that makes the
// install one-stop rather than "installed, now go read four vendors' docs".
//
// The Core's own availability probe is the source of truth for what is
// missing (CONTEXT.md: "CLI availability is Core-published state"), so
// nothing here re-implements a PATH lookup — this module takes an availability
// map and decides what to do about it.
//
// What to do about it depends on how `actana` was invoked, and the three modes
// must not bleed into each other:
//
//   • A terminal, no flags → one Y/n offer per missing agent.
//   • `--with-<harness>` / `--yes` → install unattended, no questions.
//   • No terminal, no flags → install nothing, print how to do it later.
//
// The last one is the rule the others exist to protect: a provisioning script
// piping the one-liner into bash must never block on a prompt nobody can see.
//
// Each install shells to the vendor's own installer (`installCommand` in the
// shared registry) so the agent's updater and login flow work normally
// afterwards. A vendor installer that fails is reported and stepped over — an
// operator whose Core installed fine has a working Core, and losing that
// over a third party's bad day would be absurd.

import { HARNESS_REGISTRY, UI_HARNESSES } from "@actana/shared/harnesses";
import {
  HARNESS_CLI_CONFIG,
  harnessHomePathSuffixes,
  resolveHarnessCliInstallCommand,
  type HarnessCliConfig,
} from "@actana/shared/harness-cli-config";
import type { Harness } from "@actana/shared/domain";
import type { CoreLinkHarnessAvailabilityMap } from "@actana/shared/core-link-frames";
import type { ActanaSystem } from "./actana-system";
import { ensureOperatorLoginPathOnDisk } from "./operator-login-path";

/** What became of one agent during an offer round. */
export type HarnessInstallStatus =
  /** The vendor's installer ran and exited 0. */
  | "installed"
  /** The vendor's installer ran and failed. The Core install is unaffected. */
  | "failed"
  /** The operator answered no. */
  | "declined"
  /** It was already on PATH — nothing to do. */
  | "already-installed"
  /** Nobody asked for it and there was no terminal to offer it on. */
  | "skipped"
  /** The vendor publishes no scripted installer for this platform. */
  | "unsupported";

export type HarnessInstallOutcome = {
  agent: Harness;
  /** The vendor's name for it — "Claude Code", not "claude-code". */
  label: string;
  status: HarnessInstallStatus;
};

export type HarnessOfferOptions = {
  /** What the Core's probe found. */
  availability: CoreLinkHarnessAvailabilityMap;
  /** Harnesses named with `--with-<harness>`; installed without asking. */
  requested: readonly Harness[];
  /**
   * Consider only these agents. `actana harnesses install <id>` sets it so the
   * round is about the ids the operator named and says nothing about the rest;
   * `actana setup` leaves it off and considers every managed agent.
   */
  scope?: readonly Harness[];
  /** `--no-harnesses` — do not install or offer anything. */
  noHarnesses: boolean;
  /** `--yes` — take the recommended answer, which is "install it". */
  assumeYes: boolean;
  /** Whether there is a terminal to prompt on. */
  interactive: boolean;
  platform: NodeJS.Platform;
  system: ActanaSystem;
  /**
   * The operator's home directory, for the managed PATH block written after a
   * successful install (see `operator-login-path.ts`).
   *
   * Optional, and absent means "write nothing": this is the one part of an
   * offer round that touches the operator's dotfiles, so a caller has to name
   * the home it means rather than getting the real one by default.
   */
  homeDir?: string;
  /**
   * The operator's login shell, which decides *which* profile is written.
   * Production leaves it unset and lets `resolveShell()` answer; tests set it
   * so their assertions do not depend on the developer's own `$SHELL`.
   */
  shell?: string;
  /** Progress and warnings for the operator. */
  out: (line: string) => void;
};

/** The prefix `--with-<id>` flags are built from, and read back out of. */
const HARNESS_FLAG_PREFIX = "with-";

/**
 * The ids `--with-<id>` and `actana harnesses install <id>` accept, in order.
 *
 * Exactly the agents the Core's availability probe covers, minus the ones
 * the registry has disabled — offering to install something the probe will
 * never report on would produce an agent that is installed and permanently
 * invisible to the Panel.
 */
export function offerableHarnessIds(): Harness[] {
  return UI_HARNESSES.filter((agent) => !HARNESS_REGISTRY[agent].disabled);
}

/**
 * Read an operator-typed agent id.
 *
 * Both the canonical id and the CLI command answer, because both are names the
 * operator has seen: the Panel labels agents `claude-code`, the machine has a
 * `claude` on its PATH, and refusing one of them would be pedantry.
 */
export function resolveHarnessId(token: string): Harness | null {
  const needle = token.trim().toLowerCase();
  if (!needle) return null;
  for (const agent of offerableHarnessIds()) {
    const config = HARNESS_CLI_CONFIG[agent];
    const names = [agent, config.command, ...(config.resolveAs ?? [])];
    if (names.some((name) => name.toLowerCase() === needle)) return agent;
  }
  return null;
}

/** The list an unknown id is answered with. */
export function supportedHarnessIdsSentence(): string {
  return `Supported agents: ${offerableHarnessIds().join(", ")}.`;
}

/** Every `--with-<id>` spelling, for the setup verb's flag spec. */
export function harnessFlagNames(): string[] {
  const names = new Set<string>();
  for (const agent of offerableHarnessIds()) {
    const config = HARNESS_CLI_CONFIG[agent];
    names.add(`${HARNESS_FLAG_PREFIX}${agent}`);
    names.add(`${HARNESS_FLAG_PREFIX}${config.command}`);
  }
  return [...names];
}

/**
 * The agent a parsed flag name names, or null when the flag is not one of
 * ours. The `with-` prefix is built and read in this one module, so the setup
 * verb never has to know how the flags were spelled.
 */
export function harnessFromFlagName(flag: string): Harness | null {
  if (!flag.startsWith(HARNESS_FLAG_PREFIX)) return null;
  return resolveHarnessId(flag.slice(HARNESS_FLAG_PREFIX.length));
}

/**
 * The agents this machine does not have.
 *
 * `outdated` is deliberately not missing: the CLI is there, its own updater
 * owns its version, and the Panel already has an update-required affordance
 * for it. Re-running a vendor's *installer* over a working install would be a
 * different, more destructive act than what the operator was offered.
 */
export function missingHarnesses(availability: CoreLinkHarnessAvailabilityMap): Harness[] {
  return offerableHarnessIds().filter((agent) => {
    const entry = availability[agent];
    // No entry at all means the probe never covered it — treating that as
    // "missing" would offer to install agents the Core does not manage.
    if (!entry) return false;
    return entry.status === "missing" && entry.reason !== "disabled";
  });
}

/** Run one vendor installer with the operator's terminal attached. */
async function installHarness(
  config: HarnessCliConfig,
  opts: HarnessOfferOptions,
): Promise<HarnessInstallStatus> {
  const command = resolveHarnessCliInstallCommand(config.installCommand, opts.platform);
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
    `Warning: installing ${config.label} failed (exit ${status}). Your Core is ` +
      `installed and running. Install it yourself from ${config.packageUrl}, or ` +
      `retry with \`actana harnesses install ${config.agent}\`.`,
  );
  return "failed";
}

/**
 * Offer, install, and report on every managed Harness.
 *
 * Returns one outcome per agent considered, so the caller prints a summary
 * rather than this module deciding what a summary looks like. Never throws:
 * every failure mode is an outcome.
 */
export async function offerHarnessInstalls(
  opts: HarnessOfferOptions,
): Promise<HarnessInstallOutcome[]> {
  if (opts.noHarnesses) return [];

  const requested = new Set(opts.requested);
  const missing = new Set(missingHarnesses(opts.availability));
  const considered = opts.scope
    ? offerableHarnessIds().filter((agent) => opts.scope!.includes(agent))
    : offerableHarnessIds();
  const outcomes: HarnessInstallOutcome[] = [];
  const deferred: Harness[] = [];

  for (const agent of considered) {
    const config = HARNESS_CLI_CONFIG[agent];
    const record = (status: HarnessInstallStatus) =>
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
      record(await installHarness(config, opts));
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
    record(await installHarness(config, opts));
  }

  if (deferred.length > 0) {
    opts.out("");
    opts.out(
      `These Harnesses are not installed: ${deferred.join(", ")}. Install one with ` +
        `\`actana harnesses install <id>\`.`,
    );
  }

  linkOperatorPath(outcomes, opts);
  return outcomes;
}

/**
 * Put the directories the CLIs live in on the operator's login PATH.
 *
 * `already-installed` counts, not just `installed`: a CLI the vendor put there
 * directly, or one from an Actana old enough to predate this, is exactly the
 * case whose login PATH is broken, and re-running `actana harnesses install
 * opencode` is the obvious thing an operator tries. Making that repair it
 * costs one idempotent write. A round that declined or skipped everything
 * still touches nothing.
 *
 * See `operator-login-path.ts` for why the vendors' own PATH edits are not
 * enough on their own.
 */
function linkOperatorPath(
  outcomes: readonly HarnessInstallOutcome[],
  opts: HarnessOfferOptions,
): void {
  if (!opts.homeDir) return;
  const present = outcomes.some(
    (outcome) => outcome.status === "installed" || outcome.status === "already-installed",
  );
  if (!present) return;

  const { written, failed } = ensureOperatorLoginPathOnDisk({
    homeDir: opts.homeDir,
    platform: opts.platform,
    shell: opts.shell,
  });

  if (written.length > 0) {
    const files = written.map((profile) => `~/${profile}`).join(" and ");
    opts.out(
      `Added the Harness directories to your PATH in ${files}. ` +
        `Open a new shell to pick them up.`,
    );
  }
  // Loud, but not fatal, for the same reason a failed vendor installer is: the
  // CLI is installed and the Core's own probe finds it either way. Only the
  // operator's shell is short, and they can fix that in one line.
  if (failed.length > 0) {
    opts.out(
      `Warning: could not write ${failed.map((profile) => `~/${profile}`).join(", ")}. ` +
        `Add this to your shell profile by hand: ` +
        `export PATH="$HOME/${harnessHomePathSuffixes(opts.platform).join(':$HOME/')}:$PATH"`,
    );
  }
}

/** What `installAgentsNow` needs that is not the list of agents. */
export type HarnessInstallContext = Pick<
  HarnessOfferOptions,
  "availability" | "platform" | "system" | "out" | "homeDir" | "shell"
>;

/**
 * Install exactly these agents — what `actana harnesses install <id>` does.
 *
 * The operator named them on the command line, so there is nothing left to
 * offer: no prompt, and no word about the agents they did not name.
 */
export function installAgentsNow(
  agents: readonly Harness[],
  context: HarnessInstallContext,
): Promise<HarnessInstallOutcome[]> {
  return offerHarnessInstalls({
    ...context,
    requested: agents,
    scope: agents,
    noHarnesses: false,
    assumeYes: false,
    interactive: false,
  });
}

/** The one-line summary `actana setup` prints for a finished offer round. */
export function summarizeHarnessInstalls(outcomes: readonly HarnessInstallOutcome[]): string | null {
  const installed = outcomes.filter((o) => o.status === "installed");
  const failed = outcomes.filter((o) => o.status === "failed" || o.status === "unsupported");
  if (installed.length === 0 && failed.length === 0) return null;

  const parts: string[] = [];
  if (installed.length > 0) parts.push(`installed ${installed.map((o) => o.label).join(", ")}`);
  if (failed.length > 0) parts.push(`could not install ${failed.map((o) => o.label).join(", ")}`);
  return `Harness CLIs: ${parts.join("; ")}.`;
}
