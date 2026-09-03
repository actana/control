import type { Harness } from "./domain";
import {
  HARNESS_AUTO_MODE_FLAGS,
  HARNESS_CLI_CONFIG,
  HARNESS_HOOK_TRUST_FLAGS,
} from "./harness-cli-config";

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
    // `--enable hooks` asks Codex for the lifecycle surface; the hook-trust
    // flag is what makes the hooks this Core installed into the workspace
    // actually run on the first turn instead of waiting on an operator's
    // `/hooks` review (issue 290). Both are read from the registry rather than
    // typed out, so the spawn allow-list and this builder cannot disagree.
    startCommand: (opts) =>
      [
        "codex",
        "--enable",
        "hooks",
        HARNESS_HOOK_TRUST_FLAGS.codex,
        opts?.skipPermissions ? HARNESS_AUTO_MODE_FLAGS.codex : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" "),
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

/**
 * The flag `harness` needs before it will run hooks this Core installed, or
 * null where it needs none.
 *
 * The registry's re-export of {@link HARNESS_HOOK_TRUST_FLAGS}, for the same
 * reason {@link harnessSkipPermissionsFlag} re-exports the auto-mode one: a
 * caller building a launch command and the policy validating it must be
 * reading the same cell of the same table.
 */
export const harnessHookTrustFlag = (harness: Harness): string | null =>
  HARNESS_HOOK_TRUST_FLAGS[harness];

/**
 * Throw when a launch command for `harness` is missing its hook-trust flag.
 *
 * This flag fails in the same silent direction issue 177 finding 2 did, which
 * is why it gets an assertion rather than a comment. A command built without
 * it spawns cleanly and shows a working harness that reports no lifecycle at
 * all: the Core believes it installed hooks, the operator watches a live TUI,
 * and the only thing that ends a `--wait` is the caller's own timeout. A
 * builder that drops it should fail a test here rather than a Session there.
 */
export function assertHookTrustFlagInCommand(harness: Harness, command: string): void {
  const flag = HARNESS_HOOK_TRUST_FLAGS[harness];
  if (flag === null) return;
  if (!command.split(/\s+/).includes(flag)) {
    throw new Error(`Launch command for ${harness} is missing ${flag}: ${command}`);
  }
}
