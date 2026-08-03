import { describe, expect, it } from "vitest";
import {
  AGENT_CLI_CONFIG,
  AGENT_SPAWN_COMMANDS,
  assertAgentCliRegistrySync,
  pathLookupCandidates,
  resolveAgentCliInstallCommand,
  resolveAgentCliUpdateCommands,
} from "../agent-cli-config";
import { AGENT_REGISTRY } from "../agents";

describe("agent CLI config", () => {
  it("stays in sync with AGENT_REGISTRY command names", () => {
    expect(() => assertAgentCliRegistrySync(AGENT_REGISTRY)).not.toThrow();
  });

  it("defines spawn commands from the same canonical command field", () => {
    for (const [agent, config] of Object.entries(AGENT_CLI_CONFIG)) {
      expect(AGENT_SPAWN_COMMANDS[agent as keyof typeof AGENT_SPAWN_COMMANDS]).toBe(config.command);
    }
  });

  it("resolves Cursor CLI via agent alias candidates", () => {
    expect(pathLookupCandidates("cursor-agent")).toEqual(["cursor-agent", "agent"]);
    expect(pathLookupCandidates("agent")).toEqual(["cursor-agent", "agent"]);
  });

  it("declares an npm package for registry-published CLIs only", () => {
    expect(AGENT_CLI_CONFIG["claude-code"].npmPackage).toBe("@anthropic-ai/claude-code");
    expect(AGENT_CLI_CONFIG.codex.npmPackage).toBe("@openai/codex");
    expect(AGENT_CLI_CONFIG.opencode.npmPackage).toBe("opencode-ai");
    expect(AGENT_CLI_CONFIG["cursor-cli"].npmPackage).toBeUndefined();
  });

  it("names one vendor install command per platform", () => {
    // The Cores this installs on are macOS and Linux; both take the vendor's
    // POSIX installer, so `default` is what actually gets run in practice.
    for (const platform of ["linux", "darwin"] as const) {
      expect(
        resolveAgentCliInstallCommand(AGENT_CLI_CONFIG["claude-code"].installCommand, platform),
      ).toBe("curl -fsSL https://claude.ai/install.sh | bash");
    }
    expect(
      resolveAgentCliInstallCommand(AGENT_CLI_CONFIG["claude-code"].installCommand, "win32"),
    ).toBe("irm https://claude.ai/install.ps1 | iex");
  });

  it("treats a bare install command as every platform's", () => {
    expect(resolveAgentCliInstallCommand(AGENT_CLI_CONFIG.codex.installCommand, "linux")).toBe(
      "npm install -g @openai/codex@latest",
    );
    expect(resolveAgentCliInstallCommand(AGENT_CLI_CONFIG.codex.installCommand, "win32")).toBe(
      "npm install -g @openai/codex@latest",
    );
  });

  it("has no install command where the vendor publishes none for the platform", () => {
    expect(resolveAgentCliInstallCommand({ win32: "x" }, "linux")).toBeNull();
  });

  it("returns platform-specific install commands", () => {
    expect(resolveAgentCliUpdateCommands(AGENT_CLI_CONFIG["cursor-cli"].updateCommands, "win32")).toEqual([
      "irm 'https://cursor.com/install?win32=true' | iex",
      "agent update",
    ]);
    expect(resolveAgentCliUpdateCommands(AGENT_CLI_CONFIG.opencode.updateCommands, "win32")).toEqual([
      "npm i -g opencode-ai@latest",
      "opencode upgrade",
    ]);
  });
});
