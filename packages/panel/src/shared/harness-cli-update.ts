
export type HarnessCliInstallMethod = "npm" | "homebrew" | "other";

/**
 * Classify an installed binary by its real (symlink-resolved) path. npm is
 * checked before homebrew: a brew-node global install lives at
 * /opt/homebrew/lib/node_modules/... and must count as npm-managed.
 */
export function detectHarnessCliInstallMethod(realBinaryPath: string): HarnessCliInstallMethod {
  const normalized = realBinaryPath.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("/node_modules/")) return "npm";
  if (
    normalized.includes("/cellar/") ||
    normalized.includes("/homebrew/") ||
    normalized.includes("/linuxbrew/")
  ) {
    return "homebrew";
  }
  return "other";
}

const NPM_COMMAND_RE = /^(npm|pnpm|yarn|bun)\s/;
const INSTALLER_SCRIPT_RE = /^(curl|wget|irm)\b/;

/**
 * Pick the update command matching the detected install method from the
 * platform-resolved alternatives. `cliAliases` are the binary names the CLI
 * answers to (HARNESS_CLI_CONFIG resolveAs), used to recognize a self-update
 * command like `opencode upgrade` or `agent update`.
 */
export function selectHarnessCliUpdateCommand(
  commands: readonly string[],
  method: HarnessCliInstallMethod,
  cliAliases: readonly string[],
): string | null {
  const npm = commands.find((command) => NPM_COMMAND_RE.test(command));
  const brew = commands.find((command) => command.startsWith("brew "));
  const selfUpdate = commands.find((command) => {
    const binary = command.split(/\s+/)[0];
    return !!binary && cliAliases.includes(binary);
  });
  const installerScript = commands.find((command) => INSTALLER_SCRIPT_RE.test(command));

  if (method === "npm" && npm) return npm;
  if (method === "homebrew" && brew) return brew;
  return selfUpdate ?? installerScript ?? npm ?? commands[0] ?? null;
}
