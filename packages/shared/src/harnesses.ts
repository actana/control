import type { Harness } from "./domain";
import { HARNESS_AUTO_MODE_FLAGS, HARNESS_CLI_CONFIG } from "./harness-cli-config";

export type HarnessRegistryEntry = {
  label: string;
  description: string;
  color: string;
  glyph: string;
  command: string;
  uiVisible: boolean;
  disabled?: boolean;
  supportsSkipPermissions: boolean;
  /**
   * Read from {@link HARNESS_AUTO_MODE_FLAGS}, never typed out here.
   *
   * Issue 177 finding 2 was one table disagreeing with another about which
   * flag a harness spells auto mode with; the fix is that there is one table.
   */
  skipPermissionsFlag?: string;
  startCommand: (opts?: { skipPermissions?: boolean }) => string;
  titleInvocation?: (input: string) => { cmd: string; args: string[] };
};

export const HARNESS_REGISTRY: Record<Harness, HarnessRegistryEntry> = {
  "claude-code": {
    label: "Claude Code",
    description: "Anthropic's agentic coder. Best for multi-file refactors and reasoning.",
    color: "#d6a56b",
    glyph: "◆",
    command: HARNESS_CLI_CONFIG["claude-code"].command,
    uiVisible: true,
    supportsSkipPermissions: true,
    skipPermissionsFlag: HARNESS_AUTO_MODE_FLAGS["claude-code"] ?? undefined,
    startCommand: () => "claude",
    titleInvocation: (input) => ({ cmd: "claude", args: ["-p", input] }),
  },
  codex: {
    label: "Codex",
    description: "OpenAI's terminal coder. Best for test-driven, narrow tasks.",
    color: "#8ab4ff",
    glyph: "◇",
    command: HARNESS_CLI_CONFIG.codex.command,
    uiVisible: true,
    supportsSkipPermissions: true,
    skipPermissionsFlag: HARNESS_AUTO_MODE_FLAGS["codex"] ?? undefined,
    // `--enable hooks` asks Codex for the lifecycle surface. The hook-trust
    // flag that makes those hooks actually RUN is deliberately not here: the
    // Core appends it at spawn, and only when it wrote the hooks file itself
    // and nothing else is in it (issue 290). A launch command cannot know
    // that — it is composed before any file lands — and a client that put the
    // flag here unconditionally would be vouching for hooks that came with
    // somebody's repository.
    startCommand: (opts) =>
      opts?.skipPermissions
        ? "codex --enable hooks --yolo"
        : "codex --enable hooks",
    titleInvocation: (input) => ({ cmd: "codex", args: ["exec", input] }),
  },
  "cursor-cli": {
    label: "Cursor CLI",
    description: "Cursor's terminal agent. Best for quick inline edits.",
    color: "#c792ea",
    glyph: "▲",
    command: HARNESS_CLI_CONFIG["cursor-cli"].command,
    uiVisible: true,
    supportsSkipPermissions: true,
    skipPermissionsFlag: HARNESS_AUTO_MODE_FLAGS["cursor-cli"] ?? undefined,
    startCommand: (opts) => (opts?.skipPermissions ? "cursor-agent --force" : "cursor-agent"),
    titleInvocation: (input) => ({ cmd: "cursor-agent", args: ["-p", input] }),
  },
  opencode: {
    label: "OpenCode",
    description: "Open-source terminal agent. Multi-model support with a plugin ecosystem.",
    color: "#f97316",
    glyph: "◉",
    command: HARNESS_CLI_CONFIG.opencode.command,
    uiVisible: true,
    supportsSkipPermissions: false,
    startCommand: () => "opencode",
    titleInvocation: (input) => ({ cmd: "opencode", args: ["run", input] }),
  },
};

export const UI_HARNESSES = Object.entries(HARNESS_REGISTRY)
  .filter(([, meta]) => meta.uiVisible)
  .map(([id]) => id as Harness);

/**
 * Does this Harness have an auto mode at all?
 *
 * Answered by whether the vendor ships a flag for it, which is the only thing
 * the question can mean. Reading the registry's own boolean instead would let
 * a `true` sit next to a missing flag — the launch builder would put nothing
 * in the command, the spawn descriptor would still declare the intent, and the
 * mismatch would be the one issue 177 finding 2 describes.
 */
export const harnessSupportsSkipPermissions = (agent: Harness) =>
  HARNESS_AUTO_MODE_FLAGS[agent] !== null;

/**
 * The flag this Harness spells auto mode with, or null where it has none.
 *
 * The registry's re-export of {@link HARNESS_AUTO_MODE_FLAGS}, for callers
 * already holding a registry entry. Same cell, same table — see issue 177
 * finding 2 for what the alternative cost.
 */
export const harnessSkipPermissionsFlag = (agent: Harness): string | null =>
  HARNESS_AUTO_MODE_FLAGS[agent];

/**
 * Does a session launched for this Harness carry its skip-permissions flag?
 *
 * Auto-mode is unconditional (issue 22): the New session dialog no longer asks,
 * and no project or task field feeds this. Having a flag at all is the only
 * condition — OpenCode has none, and passing it one would be an argument the
 * spawn policy rejects.
 *
 * This is the single decision point on purpose. The command builder (which
 * puts the argument in the command string) and the spawn descriptor (which
 * declares the intent the policy checks that argument against) must agree, or
 * `resolveSpawnPlan` rejects the spawn and nothing starts. Both read this.
 */
export const harnessLaunchesWithSkipPermissions = (harness: Harness) =>
  harnessSupportsSkipPermissions(harness);

