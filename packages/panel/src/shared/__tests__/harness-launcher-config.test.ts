import { describe, expect, it } from "vitest";
import { HARNESSES } from "@actana/shared/domain";
import {
  DEFAULT_AGENT_LAUNCHER_CONFIG,
  normalizeHarnessLauncherConfig,
  visibleLauncherHarnesses,
} from "../harness-launcher-config";

describe("normalizeHarnessLauncherConfig", () => {
  it("returns the default config for garbage input", () => {
    for (const raw of [null, undefined, 42, "codex", [], { order: "codex" }]) {
      expect(normalizeHarnessLauncherConfig(raw)).toEqual(DEFAULT_AGENT_LAUNCHER_CONFIG);
    }
  });

  it("drops unknown ids and duplicates", () => {
    const result = normalizeHarnessLauncherConfig({
      order: ["codex", "not-an-agent", "codex", "claude-code"],
      hidden: ["nope", "opencode", "opencode"],
    });
    expect(result.order).toEqual(["codex", "claude-code", "cursor-cli", "opencode"]);
    expect(result.hidden).toEqual(["opencode"]);
  });

  it("appends agents missing from order in default order", () => {
    const result = normalizeHarnessLauncherConfig({ order: ["opencode"], hidden: [] });
    expect(result.order).toEqual(["opencode", "claude-code", "codex", "cursor-cli"]);
  });

  it("keeps at least one agent visible when everything is hidden", () => {
    const result = normalizeHarnessLauncherConfig({
      order: ["cursor-cli", "codex", "claude-code", "opencode"],
      hidden: [...HARNESSES],
    });
    expect(result.hidden).not.toContain("cursor-cli");
    expect(visibleLauncherHarnesses(result)).toEqual(["cursor-cli"]);
  });

  it("returns fresh arrays that do not alias the default config", () => {
    const result = normalizeHarnessLauncherConfig(null);
    result.order.push("codex");
    expect(DEFAULT_AGENT_LAUNCHER_CONFIG.order).toEqual([...HARNESSES]);
  });
});

describe("visibleLauncherHarnesses", () => {
  it("filters hidden agents preserving order", () => {
    expect(
      visibleLauncherHarnesses({
        order: ["codex", "claude-code", "cursor-cli", "opencode"],
        hidden: ["claude-code", "opencode"],
      }),
    ).toEqual(["codex", "cursor-cli"]);
  });

  it("returns everything when nothing is hidden", () => {
    expect(visibleLauncherHarnesses(DEFAULT_AGENT_LAUNCHER_CONFIG)).toEqual([...HARNESSES]);
  });
});
