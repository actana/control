import { describe, expect, it } from "vitest";
import { firstAvailableHarness, fromCoreLinkMap, harnessCanLaunch, isCliUnavailable } from "../cli-availability";
import type { Harness } from "@actana/shared/domain";
import { coreHasHarness } from "../core-has-harness";

describe("a Harness the Core reports as needing setup (#685)", () => {
  const map = fromCoreLinkMap({
    "claude-code": { status: "missing", reason: "needs-setup: folder-trust", path: "/bin/claude", version: "2.1.289" },
    codex: { status: "missing", reason: "not-found" },
  });

  it("becomes its own status, carrying the dialog and the version", () => {
    expect(map["claude-code"]).toMatchObject({ status: "needs-setup", setupDialog: "folder-trust", version: "2.1.289" });
  });

  it("is launchable, so its setup can be finished in a Session; a plain missing one stays missing", () => {
    expect(harnessCanLaunch(map, "claude-code")).toBe(true);
    expect(harnessCanLaunch(map, "codex")).toBe(false);
    expect(isCliUnavailable(map, "claude-code")).toBe(true);
    expect(coreHasHarness(map, "claude-code")).toBe(true);
    expect(map.codex?.status).toBe("missing");
  });

  it("is never the default pick while a ready Harness exists", () => {
    const mixed = fromCoreLinkMap({
      "claude-code": { status: "missing", reason: "needs-setup: no-models", path: "/bin/claude" },
      codex: { status: "available", path: "/bin/codex" },
    });
    expect(firstAvailableHarness(mixed)).toBe("codex");
    const onlySetup = fromCoreLinkMap({
      "claude-code": { status: "missing", reason: "needs-setup: no-models", path: "/bin/claude" },
      codex: { status: "missing" },
      "cursor-cli": { status: "missing" },
      opencode: { status: "missing" },
      pi: { status: "missing" },
    });
    expect(firstAvailableHarness(onlySetup)).toBe("claude-code");
  });

  it("seeds the dialog from the offered options, not the first one, so a needs-setup claude-code is not preselected", () => {
    const mixed = fromCoreLinkMap({
      "claude-code": { status: "missing", reason: "needs-setup: folder-trust", path: "/bin/claude" },
      codex: { status: "available", path: "/bin/codex" },
    });
    const options: Harness[] = ["claude-code", "codex"];
    expect(firstAvailableHarness(mixed, options)).toBe("codex");
    expect(firstAvailableHarness(mixed, ["claude-code"])).toBe("claude-code");
  });
});
