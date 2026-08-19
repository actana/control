import { HARNESSES, type Harness } from "./domain";

export type HarnessCliVersionScheme = "semver" | "calendar-date";

export type HarnessCliUpdateCommands =
  | readonly string[]
  | {
      default: readonly string[];
      win32?: readonly string[];
      darwin?: readonly string[];
      linux?: readonly string[];
    };

/**
 * The vendor's own way of putting this CLI on a machine that has never had it.
 *
 * One shell command line per platform, not a list: `actana` runs this, so the
 * registry has to name a single official method rather than offer choices.
 * A platform with no entry has no scripted install — the operator gets the
 * `packageUrl` instead. Distinct from {@link HarnessCliUpdateCommands}, which is
 * guidance the Panel *shows* for a CLI that is already there.
 */
export type HarnessCliInstallCommand =
  | string
  | {
      default?: string;
      win32?: string;
      darwin?: string;
      linux?: string;
    };

/**
 * How one Harness takes a globally-installed agent skill (ADR 0031 D4).
 *
 * A *descriptor* rather than a path string, and deliberately so. The four
 * families' extension points are not one shape — three of them take a JSON
 * settings file for hooks and OpenCode takes a JavaScript plugin, which is the
 * whole reason `harness-hooks-opencode.ts` exists next door — so a field that
 * was a directory today would be a redesign the first time a vendor's answer to
 * "how do I ship you a skill" is a manifest entry or a plugin. `kind` is what
 * keeps that from being a redesign: a harness whose extension point is not a
 * directory of skill folders gets a new `kind` and its own writer, and every
 * reader here already has to switch on it.
 *
 * That the four vendors have in fact converged on `SKILL.md` is a fact read off
 * their current documentation in August 2026, recorded in {@link source} per
 * entry, and not a shape this type assumes.
 */
export type HarnessSkillTarget = {
  /**
   * The only kind that exists today: a directory holding one directory per
   * skill, each with a `SKILL.md` inside it.
   */
  kind: "skill-dir";
  /**
   * Home-relative directories whose existence is evidence this Harness has run
   * as this operator, `/`-separated. Any one of them is enough.
   *
   * Not the same thing as {@link skillDir}, and the gap is ADR 0031 D4: the
   * installer starts no process (#129 D9) so it cannot ask a vendor's CLI
   * whether it is installed, and the directory it writes *into* is in several
   * cases a cross-vendor one that proves nothing about any particular harness.
   * `~/.agents/skills` existing says somebody uses some agent; `~/.codex`
   * existing says Codex has run here.
   */
  homeMarkers: readonly string[];
  /**
   * Home-relative directory a global skill goes in, `/`-separated. One
   * sub-directory per skill underneath it.
   *
   * Two harnesses sharing one value is expected rather than a mistake — see
   * ADR 0031 D4 on why the fan-out writes the covering set of directories
   * rather than one per vendor. The installer deduplicates by resolved path.
   */
  skillDir: string;
  /** The vendor page this was read off. Not a guess, and not from this repo. */
  source: string;
  /** ISO date it was last read. A vendor that moves the directory moves it silently. */
  verifiedOn: string;
};

export type HarnessCliPathSuffixes =
  | readonly string[]
  | {
      default?: readonly string[];
      win32?: readonly string[];
      darwin?: readonly string[];
      linux?: readonly string[];
    };

/** Single source of truth for managed Harness binaries, versions, and install guidance. */
export type HarnessCliConfig = {
  agent: Harness;
  /** Canonical command token used in spawn strings and allow-list validation. */
  command: string;
  /** PATH lookup order; first existing match wins. Defaults to [command]. */
  resolveAs?: readonly string[];
  label: string;
  versionScheme: HarnessCliVersionScheme;
  minimumVersion: string;
  packageUrl: string;
  /** npm package published for this CLI; absent when there is no public registry to query for the latest version. */
  npmPackage?: string;
  updateCommands: HarnessCliUpdateCommands;
  /** The vendor's official first-install method, per platform. */
  installCommand: HarnessCliInstallCommand;
  /** Extra directories under the user home dir to prepend on PATH when they exist. */
  homePathSuffixes?: HarnessCliPathSuffixes;
  /**
   * Where a globally-installed agent skill goes for this Harness, and how to
   * tell the Harness is on this machine at all (ADR 0031 D4).
   *
   * Required, not optional, and that is the point: `HARNESS_CLI_CONFIG` is
   * declared `as const satisfies Record<Harness, HarnessCliConfig>`, so a new
   * member of `HARNESSES` that nobody has found a skill directory for is a
   * compile error here rather than a Harness that silently never gets the
   * product's own skill. Nothing about this repository recorded a global skill
   * directory for any Harness before #265; every value below was read off the
   * vendor's current documentation and carries the URL and the date.
   */
  skillTarget: HarnessSkillTarget;
  /**
   * This CLI's own spelling of "do not stop to ask me" — the flag that turns a
   * launch into an unattended one (issue 177 finding 2).
   *
   * Absent means the vendor ships no such flag, which is a different fact from
   * "we have not filled this in": OpenCode has none, so a caller asking for
   * auto mode there is asking for something that does not exist rather than
   * something that was dropped. Every other consumer of this idea — the spawn
   * policy's allow-list, the Panel's launch builder, the SDK's default command
   * — reads it from here, because four transcriptions of one vendor fact is
   * four chances to disagree about it.
   */
  autoModeFlag?: string;
};

export const MANAGED_HARNESSES = HARNESSES;

function withResolveAs(config: Omit<HarnessCliConfig, "resolveAs"> & { resolveAs?: readonly string[] }): HarnessCliConfig {
  return {
    ...config,
    resolveAs: config.resolveAs ?? [config.command],
  };
}

export const HARNESS_CLI_CONFIG = {
  "claude-code": withResolveAs({
    agent: "claude-code",
    command: "claude",
    label: "Claude Code",
    versionScheme: "semver",
    minimumVersion: "2.1.146",
    packageUrl: "https://docs.anthropic.com/en/docs/claude-code/setup",
    npmPackage: "@anthropic-ai/claude-code",
    updateCommands: ["claude update", "npm install -g @anthropic-ai/claude-code@latest"],
    installCommand: {
      default: "curl -fsSL https://claude.ai/install.sh | bash",
      win32: "irm https://claude.ai/install.ps1 | iex",
    },
    autoModeFlag: "--dangerously-skip-permissions",
    // Claude Code reads exactly one global skills root and it is its own — it
    // does not read `~/.agents/skills`, which is why the fan-out cannot be one
    // directory (ADR 0031 D4).
    skillTarget: {
      kind: "skill-dir",
      homeMarkers: [".claude"],
      skillDir: ".claude/skills",
      source: "https://code.claude.com/docs/en/skills — \"Where skills live\": Personal, `~/.claude/skills/<skill-name>/SKILL.md`",
      verifiedOn: "2026-08-19",
    },
  }),
  codex: withResolveAs({
    agent: "codex",
    command: "codex",
    label: "Codex",
    versionScheme: "semver",
    minimumVersion: "0.132.0",
    packageUrl: "https://www.npmjs.com/package/@openai/codex",
    npmPackage: "@openai/codex",
    updateCommands: {
      default: ["npm install -g @openai/codex@latest"],
      darwin: ["npm install -g @openai/codex@latest", "brew upgrade codex"],
    },
    installCommand: "npm install -g @openai/codex@latest",
    autoModeFlag: "--yolo",
    // Codex's USER scope is `$HOME/.agents/skills` and nothing else — it is
    // the one harness of the four whose global skills root is NOT under its own
    // dot-directory, so `~/.codex` is the presence marker and `~/.agents/skills`
    // is the target. Community write-ups still say `~/.codex/skills`; OpenAI's
    // own page does not, and the page is what this row records.
    skillTarget: {
      kind: "skill-dir",
      homeMarkers: [".codex"],
      skillDir: ".agents/skills",
      source: "https://developers.openai.com/codex/skills — skill locations table, USER scope: `$HOME/.agents/skills`",
      verifiedOn: "2026-08-19",
    },
  }),
  "cursor-cli": withResolveAs({
    agent: "cursor-cli",
    command: "cursor-agent",
    resolveAs: ["cursor-agent", "agent"],
    label: "Cursor CLI",
    versionScheme: "calendar-date",
    minimumVersion: "2026.05.20",
    packageUrl: "https://cursor.com/docs/cli/installation",
    updateCommands: {
      default: ["curl https://cursor.com/install -fsS | bash", "agent update"],
      win32: ["irm 'https://cursor.com/install?win32=true' | iex", "agent update"],
    },
    installCommand: {
      default: "curl https://cursor.com/install -fsS | bash",
      win32: "irm 'https://cursor.com/install?win32=true' | iex",
    },
    autoModeFlag: "--force",
    // Cursor reads `~/.cursor/skills` AND `~/.agents/skills` (and Claude's and
    // Codex's roots besides). `.agents/skills` is chosen so this Harness costs
    // the operator's home no directory that Codex has not already cost it —
    // ADR 0031 D4's covering set.
    skillTarget: {
      kind: "skill-dir",
      homeMarkers: [".cursor"],
      skillDir: ".agents/skills",
      source: "https://cursor.com/help/customization/skills — \"Skills are automatically loaded from .agents/skills/, .cursor/skills/, ~/.agents/skills/ (global), and ~/.cursor/skills/ (global)\"",
      verifiedOn: "2026-08-19",
    },
  }),
  opencode: withResolveAs({
    agent: "opencode",
    command: "opencode",
    label: "OpenCode",
    versionScheme: "semver",
    minimumVersion: "1.0.0",
    packageUrl: "https://opencode.ai/docs/cli/",
    npmPackage: "opencode-ai",
    updateCommands: {
      default: ["curl -fsSL https://opencode.ai/install | bash", "opencode upgrade"],
      win32: ["npm i -g opencode-ai@latest", "opencode upgrade"],
      darwin: [
        "curl -fsSL https://opencode.ai/install | bash",
        "npm i -g opencode-ai@latest",
        "opencode upgrade",
      ],
    },
    installCommand: {
      default: "curl -fsSL https://opencode.ai/install | bash",
      win32: "npm i -g opencode-ai@latest",
    },
    homePathSuffixes: [".opencode/bin"],
    // OpenCode's first-listed global root is `~/.config/opencode/skills`, which
    // moves when `XDG_CONFIG_HOME` is set — a second thing to get right for no
    // coverage this row does not already have, because OpenCode also reads
    // `~/.agents/skills` and that path is home-relative under every
    // configuration. Two markers because the two ways OpenCode arrives leave
    // different traces: the install script leaves `~/.opencode/bin` (which is
    // why `homePathSuffixes` above already knows it), and running it leaves the
    // config directory.
    skillTarget: {
      kind: "skill-dir",
      homeMarkers: [".opencode", ".config/opencode"],
      skillDir: ".agents/skills",
      source: "https://opencode.ai/docs/skills — global paths: `~/.config/opencode/skills/<name>/SKILL.md`, `~/.claude/skills/<name>/SKILL.md`, `~/.agents/skills/<name>/SKILL.md`",
      verifiedOn: "2026-08-19",
    },
  }),
} as const satisfies Record<Harness, HarnessCliConfig>;

export type ManagedHarness = Harness;
export type HarnessCliVersionRequirement = HarnessCliConfig;

export const HARNESS_CLI_CONFIG_BY_COMMAND = Object.fromEntries(
  Object.values(HARNESS_CLI_CONFIG).map((config) => [config.command, config]),
) as Readonly<Record<string, HarnessCliConfig | undefined>>;

/**
 * Read a `{default, win32?, darwin?, linux?}` record for one platform: the
 * platform's own entry when it has one, else `default`.
 *
 * Three registry fields are shaped this way; without one reader the cascade
 * gets copied a fourth time the next time a field joins them.
 */
function pickForPlatform<T>(
  record: { default?: T; win32?: T; darwin?: T; linux?: T },
  platform: NodeJS.Platform,
): T | undefined {
  if (platform === "win32" && record.win32 !== undefined) return record.win32;
  if (platform === "darwin" && record.darwin !== undefined) return record.darwin;
  if (platform === "linux" && record.linux !== undefined) return record.linux;
  return record.default;
}

function isStructuredUpdateCommands(
  updateCommands: HarnessCliUpdateCommands,
): updateCommands is Exclude<HarnessCliUpdateCommands, readonly string[]> {
  return !Array.isArray(updateCommands);
}

function isStructuredPathSuffixes(
  suffixes: HarnessCliPathSuffixes,
): suffixes is Exclude<HarnessCliPathSuffixes, readonly string[]> {
  return !Array.isArray(suffixes);
}

function pathSuffixesForPlatform(
  suffixes: HarnessCliPathSuffixes | undefined,
  platform: NodeJS.Platform,
): readonly string[] {
  if (!suffixes) return [];
  if (!isStructuredPathSuffixes(suffixes)) return suffixes;
  return pickForPlatform(suffixes, platform) ?? [];
}

export function harnessCliConfigForHarness(agent: Harness): HarnessCliConfig {
  return HARNESS_CLI_CONFIG[agent];
}

export function harnessCliConfigForCommand(command: string): HarnessCliConfig | undefined {
  return HARNESS_CLI_CONFIG_BY_COMMAND[command];
}

export function spawnCommandForHarness(agent: Harness): string {
  return HARNESS_CLI_CONFIG[agent].command;
}

export function pathLookupCandidates(command: string): readonly string[] {
  const direct = harnessCliConfigForCommand(command);
  if (direct) return direct.resolveAs ?? [direct.command];

  for (const config of Object.values(HARNESS_CLI_CONFIG)) {
    const aliases = config.resolveAs ?? [config.command];
    if (aliases.includes(command)) return aliases;
  }

  return [command];
}

export function harnessHomePathSuffixes(platform: NodeJS.Platform): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const config of Object.values(HARNESS_CLI_CONFIG)) {
    for (const suffix of pathSuffixesForPlatform(config.homePathSuffixes, platform)) {
      if (!seen.has(suffix)) {
        seen.add(suffix);
        ordered.push(suffix);
      }
    }
  }
  return ordered;
}

/**
 * The one command that installs this CLI on `platform`, or null when the
 * vendor has no scripted method there.
 *
 * Null is a real answer, not a failure: the caller falls back to printing the
 * `packageUrl` so the operator installs it by hand, which is better than
 * running a command that was written for another OS.
 */
export function resolveHarnessCliInstallCommand(
  installCommand: HarnessCliInstallCommand,
  platform: NodeJS.Platform,
): string | null {
  if (typeof installCommand === "string") return installCommand;
  return pickForPlatform(installCommand, platform) ?? null;
}

/**
 * Every update command this CLI knows, unfiltered by OS.
 *
 * For callers that do not know which machine the CLI is on — the Panel is a
 * browser and the CLI lives on a Core (ADR 0010) — showing the whole list is
 * honest, where filtering by the *viewer's* platform would print commands for
 * the wrong OS. Prefer the Core-published `updateCommands` when the Core has
 * answered; this is the fallback for one that has not.
 */
export function allHarnessCliUpdateCommands(
  updateCommands: HarnessCliUpdateCommands,
): readonly string[] {
  if (!isStructuredUpdateCommands(updateCommands)) return updateCommands;
  return updateCommands.default;
}

export function resolveHarnessCliUpdateCommands(
  updateCommands: HarnessCliUpdateCommands,
  platform: NodeJS.Platform,
): readonly string[] {
  if (!isStructuredUpdateCommands(updateCommands)) {
    if (platform === "win32") {
      return updateCommands.filter(
        (command) => !command.startsWith("brew ") && !command.includes("| bash"),
      );
    }
    return updateCommands;
  }

  return pickForPlatform(updateCommands, platform) ?? updateCommands.default;
}

export const HARNESS_SPAWN_COMMANDS = Object.fromEntries(
  MANAGED_HARNESSES.map((agent) => [agent, HARNESS_CLI_CONFIG[agent].command]),
) as Readonly<Record<Harness, string>>;

/**
 * Each harness's auto-mode flag, or `null` where the vendor ships none.
 *
 * The one home for {@link HarnessCliConfig.autoModeFlag}, derived rather than
 * re-typed so a new harness cannot arrive with the table half-filled. `null` is
 * load-bearing everywhere this is read: it means "this CLI has no unattended
 * mode", not "nobody has looked it up yet", and it is why OpenCode is neither
 * given a flag nor refused a launch.
 */
export const HARNESS_AUTO_MODE_FLAGS = Object.fromEntries(
  MANAGED_HARNESSES.map((agent) => [agent, HARNESS_CLI_CONFIG[agent].autoModeFlag ?? null]),
) as Readonly<Record<Harness, string | null>>;

/**
 * Every Harness's skill target, in `HARNESSES` order, flattened for a writer.
 *
 * Derived rather than typed out for {@link HARNESS_AUTO_MODE_FLAGS}'s reason: a
 * new Harness cannot arrive with this table half-filled, because the table is
 * the config. The array carries the harness id on each row, so the installer —
 * which is a byte-identical twin of a file in a package that may not import
 * this one — takes plain data and knows nothing about `Harness`.
 *
 * The CLI's hand-declared copy is `packages/cli/src/harness-skill-targets.ts`,
 * and `orchestration-skill-fanout.test.ts` fails when the two disagree or when
 * either is missing a member of `HARNESSES` (ADR 0031 D8).
 */
export const HARNESS_SKILL_TARGETS = MANAGED_HARNESSES.map((agent) => ({
  harness: agent as string,
  ...HARNESS_CLI_CONFIG[agent].skillTarget,
}));

/** The flag that puts `agent` in auto mode, or null where it has none. */
export function autoModeFlagForHarness(agent: Harness): string | null {
  return HARNESS_AUTO_MODE_FLAGS[agent];
}

/**
 * Throw when a registry's auto-mode flags have drifted from this table.
 *
 * The sibling of {@link assertSpawnCommandsSync}, for the second half of a
 * launch command. Issue 177 finding 1 was the binary half of exactly this drift
 * — a table that agreed with the Core about three harnesses out of four — and
 * the flag half is worse, because it fails silently rather than at spawn.
 */
export function assertAutoModeFlagsSync(
  autoModeFlags: Record<Harness, string | null | undefined>,
): void {
  for (const agent of MANAGED_HARNESSES) {
    const expected = HARNESS_AUTO_MODE_FLAGS[agent];
    const actual = autoModeFlags[agent] ?? null;
    if (actual !== expected) {
      throw new Error(
        `Auto-mode flag drift for ${agent}: registry=${actual}, config=${expected}`,
      );
    }
  }
}

export function assertHarnessCliRegistrySync(registry: Record<Harness, { command: string }>): void {
  for (const agent of MANAGED_HARNESSES) {
    const config = HARNESS_CLI_CONFIG[agent];
    const entry = registry[agent];
    if (!entry) {
      throw new Error(`Missing HARNESS_REGISTRY entry for ${agent}`);
    }
    if (entry.command !== config.command) {
      throw new Error(
        `HARNESS_REGISTRY command drift for ${agent}: registry=${entry.command}, config=${config.command}`,
      );
    }
  }
}

export function assertSpawnCommandsSync(spawnCommands: Record<Harness, string>): void {
  for (const agent of MANAGED_HARNESSES) {
    const expected = HARNESS_SPAWN_COMMANDS[agent];
    const actual = spawnCommands[agent];
    if (actual !== expected) {
      throw new Error(
        `Spawn command drift for ${agent}: spawn=${actual}, config=${expected}`,
      );
    }
  }
}
