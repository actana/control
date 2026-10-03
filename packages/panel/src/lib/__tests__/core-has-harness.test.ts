import { describe, expect, it } from "vitest";
import { coreHasHarness } from "../core-has-harness";
import type { CliAvailabilityMap } from "../cli-availability";

describe("coreHasHarness (issue 560)", () => {
  it("is true only when the Core has the CLI (available, outdated, or still checking)", () => {
    const map: CliAvailabilityMap = {
      "claude-code": { status: "available", path: "/usr/bin/claude" },
      codex: { status: "outdated", version: "0.1.0", requiredVersion: "0.2.0" },
      "cursor-cli": { status: "missing", reason: "not-found" },
      opencode: { status: "checking" },
    };
    expect(coreHasHarness(map, "claude-code")).toBe(true);
    expect(coreHasHarness(map, "codex")).toBe(true);
    expect(coreHasHarness(map, "cursor-cli")).toBe(false);
    expect(coreHasHarness(map, "opencode")).toBe(true);
    expect(coreHasHarness(map, "pi")).toBe(false);
  });
});
