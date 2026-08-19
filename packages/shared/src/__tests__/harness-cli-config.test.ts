import { describe, expect, it } from "vitest";
import {
  HARNESS_AUTO_MODE_FLAGS,
  HARNESS_CLI_CONFIG,
  HARNESS_SPAWN_COMMANDS,
  assertAutoModeFlagsSync,
  assertHarnessCliRegistrySync,
  autoModeFlagForHarness,
  pathLookupCandidates,
  resolveHarnessCliInstallCommand,
  resolveHarnessCliUpdateCommands,
} from "../harness-cli-config";
import {
  HARNESS_REGISTRY,
  harnessSkipPermissionsFlag,
  harnessSupportsSkipPermissions,
} from "../harnesses";

describe("Harness config", () => {
  it("stays in sync with HARNESS_REGISTRY command names", () => {
    expect(() => assertHarnessCliRegistrySync(HARNESS_REGISTRY)).not.toThrow();
  });

  it("defines spawn commands from the same canonical command field", () => {
    for (const [agent, config] of Object.entries(HARNESS_CLI_CONFIG)) {
      expect(HARNESS_SPAWN_COMMANDS[agent as keyof typeof HARNESS_SPAWN_COMMANDS]).toBe(config.command);
    }
  });

  // ─── Auto mode is one fact (issue 177 finding 2) ────────────────────────
  //
  // Finding 1 was a table that agreed with the Core about three harnesses out
  // of four, in the binary column. The flag column had the same shape and a
  // worse failure: a wrong flag is a rejected spawn, a missing one used to be
  // an interactive harness a caller believed was unattended.

  it("names each harness's auto-mode flag, and OpenCode's absence of one", () => {
    expect(HARNESS_AUTO_MODE_FLAGS["claude-code"]).toBe("--dangerously-skip-permissions");
    expect(HARNESS_AUTO_MODE_FLAGS.codex).toBe("--yolo");
    // The flag the client never sent, which is the whole of finding 2.
    expect(HARNESS_AUTO_MODE_FLAGS["cursor-cli"]).toBe("--force");
    // `null` is a fact about the vendor's CLI, not an unfilled cell.
    expect(HARNESS_AUTO_MODE_FLAGS.opencode).toBeNull();
  });

  it("derives that table from the config rather than restating it", () => {
    for (const [agent, config] of Object.entries(HARNESS_CLI_CONFIG)) {
      expect(autoModeFlagForHarness(agent as keyof typeof HARNESS_AUTO_MODE_FLAGS)).toBe(
        config.autoModeFlag ?? null,
      );
    }
  });

  it("keeps HARNESS_REGISTRY's flag and its support boolean on the same fact", () => {
    expect(() =>
      assertAutoModeFlagsSync(
        Object.fromEntries(
          Object.entries(HARNESS_REGISTRY).map(([agent, meta]) => [
            agent,
            meta.skipPermissionsFlag ?? null,
          ]),
        ) as Record<keyof typeof HARNESS_REGISTRY, string | null>,
      ),
    ).not.toThrow();

    for (const agent of Object.keys(HARNESS_REGISTRY) as Array<
      keyof typeof HARNESS_REGISTRY
    >) {
      // "Supports auto mode" can only mean "has a flag for it". A `true` next
      // to a missing flag is the mismatch the Core now refuses at spawn.
      expect(harnessSupportsSkipPermissions(agent)).toBe(
        harnessSkipPermissionsFlag(agent) !== null,
      );
    }
  });

  it("throws on drift rather than letting a second table quietly disagree", () => {
    expect(() =>
      assertAutoModeFlagsSync({
        "claude-code": "--dangerously-skip-permissions",
        codex: "--yolo",
        // The bug, written out: a table that thinks cursor-cli spells auto
        // mode the way Claude Code does.
        "cursor-cli": "--dangerously-skip-permissions",
        opencode: null,
      }),
    ).toThrow(/cursor-cli/);
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
