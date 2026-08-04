import { describe, expect, it } from "vitest";
import { HARNESS_CLI_CONFIG, resolveHarnessCliUpdateCommands } from "@actana/shared/harness-cli-config";
import { detectHarnessCliInstallMethod, selectHarnessCliUpdateCommand } from "../harness-cli-update";
import type { Harness } from "@actana/shared/domain";

function commandsFor(agent: Harness, platform: NodeJS.Platform): readonly string[] {
  return resolveHarnessCliUpdateCommands(HARNESS_CLI_CONFIG[agent].updateCommands, platform);
}

describe("detectHarnessCliInstallMethod", () => {
  it("classifies npm global installs, including brew-node prefixes", () => {
    expect(
      detectHarnessCliInstallMethod("/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js"),
    ).toBe("npm");
    // A brew-installed node's global prefix still means npm manages the CLI.
    expect(
      detectHarnessCliInstallMethod("/opt/homebrew/lib/node_modules/opencode-ai/bin/opencode"),
    ).toBe("npm");
    expect(
      detectHarnessCliInstallMethod(
        "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
      ),
    ).toBe("npm");
  });

  it("classifies homebrew formula installs", () => {
    expect(detectHarnessCliInstallMethod("/opt/homebrew/Cellar/codex/0.144.1/bin/codex")).toBe(
      "homebrew",
    );
    expect(
      detectHarnessCliInstallMethod("/home/linuxbrew/.linuxbrew/Cellar/codex/0.1/bin/codex"),
    ).toBe("homebrew");
  });

  it("classifies vendor installer locations as other", () => {
    expect(detectHarnessCliInstallMethod("/Users/me/.opencode/bin/opencode")).toBe("other");
    expect(detectHarnessCliInstallMethod("/Users/me/.local/bin/claude")).toBe("other");
  });
});

describe("selectHarnessCliUpdateCommand", () => {
  it("updates npm installs via npm", () => {
    expect(selectHarnessCliUpdateCommand(commandsFor("claude-code", "darwin"), "npm", ["claude"])).toBe(
      "npm install -g @anthropic-ai/claude-code@latest",
    );
    expect(selectHarnessCliUpdateCommand(commandsFor("opencode", "darwin"), "npm", ["opencode"])).toBe(
      "npm i -g opencode-ai@latest",
    );
  });

  it("updates homebrew installs via brew", () => {
    expect(selectHarnessCliUpdateCommand(commandsFor("codex", "darwin"), "homebrew", ["codex"])).toBe(
      "brew upgrade codex",
    );
  });

  it("prefers the CLI's own self-updater when the install method is unknown", () => {
    expect(selectHarnessCliUpdateCommand(commandsFor("claude-code", "darwin"), "other", ["claude"])).toBe(
      "claude update",
    );
    expect(selectHarnessCliUpdateCommand(commandsFor("opencode", "darwin"), "other", ["opencode"])).toBe(
      "opencode upgrade",
    );
    expect(
      selectHarnessCliUpdateCommand(commandsFor("cursor-cli", "darwin"), "other", [
        "cursor-agent",
        "agent",
      ]),
    ).toBe("agent update");
  });

  it("falls back to npm, then the first command, when nothing matches the method", () => {
    // codex has no self-updater or installer script — unknown installs use npm.
    expect(selectHarnessCliUpdateCommand(commandsFor("codex", "darwin"), "other", ["codex"])).toBe(
      "npm install -g @openai/codex@latest",
    );
    expect(selectHarnessCliUpdateCommand([], "other", ["x"])).toBeNull();
  });

  it("picks the PowerShell installer for unknown Windows cursor installs", () => {
    expect(
      selectHarnessCliUpdateCommand(commandsFor("cursor-cli", "win32"), "other", ["cursor-agent", "agent"]),
    ).toBe("agent update");
  });
});
