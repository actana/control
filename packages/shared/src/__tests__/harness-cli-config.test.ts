import { describe, expect, it } from "vitest";
import {
  HARNESS_CLI_CONFIG,
  HARNESS_SPAWN_COMMANDS,
  assertHarnessCliRegistrySync,
  pathLookupCandidates,
  resolveHarnessCliInstallCommand,
  resolveHarnessCliUpdateCommands,
} from "../harness-cli-config";
import { HARNESS_REGISTRY } from "../harnesses";

describe("Harness config", () => {
  it("stays in sync with HARNESS_REGISTRY command names", () => {
    expect(() => assertHarnessCliRegistrySync(HARNESS_REGISTRY)).not.toThrow();
  });

  it("defines spawn commands from the same canonical command field", () => {
    for (const [agent, config] of Object.entries(HARNESS_CLI_CONFIG)) {
      expect(HARNESS_SPAWN_COMMANDS[agent as keyof typeof HARNESS_SPAWN_COMMANDS]).toBe(config.command);
    }
  });

  it("resolves Cursor CLI via agent alias candidates", () => {
    expect(pathLookupCandidates("cursor-agent")).toEqual(["cursor-agent", "agent"]);
    expect(pathLookupCandidates("agent")).toEqual(["cursor-agent", "agent"]);
  });

  it("declares an npm package for registry-published CLIs only", () => {
    expect(HARNESS_CLI_CONFIG["claude-code"].npmPackage).toBe("@anthropic-ai/claude-code");
    expect(HARNESS_CLI_CONFIG.codex.npmPackage).toBe("@openai/codex");
    expect(HARNESS_CLI_CONFIG.opencode.npmPackage).toBe("opencode-ai");
    expect(HARNESS_CLI_CONFIG["cursor-cli"].npmPackage).toBeUndefined();
  });

  it("names one vendor install command per platform", () => {
    // The Cores this installs on are macOS and Linux; both take the vendor's
    // POSIX installer, so `default` is what actually gets run in practice.
    for (const platform of ["linux", "darwin"] as const) {
      expect(
        resolveHarnessCliInstallCommand(HARNESS_CLI_CONFIG["claude-code"].installCommand, platform),
      ).toBe("curl -fsSL https://claude.ai/install.sh | bash");
    }
    expect(
      resolveHarnessCliInstallCommand(HARNESS_CLI_CONFIG["claude-code"].installCommand, "win32"),
    ).toBe("irm https://claude.ai/install.ps1 | iex");
  });

  it("treats a bare install command as every platform's", () => {
    expect(resolveHarnessCliInstallCommand(HARNESS_CLI_CONFIG.codex.installCommand, "linux")).toBe(
      "npm install -g @openai/codex@latest",
    );
    expect(resolveHarnessCliInstallCommand(HARNESS_CLI_CONFIG.codex.installCommand, "win32")).toBe(
      "npm install -g @openai/codex@latest",
    );
  });

  it("has no install command where the vendor publishes none for the platform", () => {
    expect(resolveHarnessCliInstallCommand({ win32: "x" }, "linux")).toBeNull();
  });

  it("returns platform-specific install commands", () => {
    expect(resolveHarnessCliUpdateCommands(HARNESS_CLI_CONFIG["cursor-cli"].updateCommands, "win32")).toEqual([
      "irm 'https://cursor.com/install?win32=true' | iex",
      "agent update",
    ]);
    expect(resolveHarnessCliUpdateCommands(HARNESS_CLI_CONFIG.opencode.updateCommands, "win32")).toEqual([
      "npm i -g opencode-ai@latest",
      "opencode upgrade",
    ]);
  });
});
