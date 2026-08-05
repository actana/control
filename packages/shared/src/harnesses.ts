import type { Harness } from "./domain";
import { HARNESS_CLI_CONFIG } from "./harness-cli-config";

export type HarnessRegistryEntry = {
  label: string;
  description: string;
  color: string;
  glyph: string;
  command: string;
  uiVisible: boolean;
  disabled?: boolean;
  supportsSkipPermissions: boolean;
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
    skipPermissionsFlag: "--dangerously-skip-permissions",
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
    skipPermissionsFlag: "--yolo",
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
    skipPermissionsFlag: "--force",
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

export const harnessSupportsSkipPermissions = (agent: Harness) =>
  HARNESS_REGISTRY[agent].supportsSkipPermissions;

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
