import { describe, expect, it } from "vitest";
import { fromCoreLinkMap, harnessCanLaunch, isCliUnavailable } from "../cli-availability";
import { coreHasHarness } from "../core-has-harness";

describe("a Harness the Core reports as needing setup (#685)", () => {
  const map = fromCoreLinkMap({
    "claude-code": { status: "missing", reason: "needs-setup: folder-trust", path: "/bin/claude", version: "2.1.289" },
    codex: { status: "missing", reason: "not-found" },
  });

  it("becomes its own status, carrying the dialog and the version", () => {
    expect(map["claude-code"]).toMatchObject({ status: "needs-setup", setupDialog: "folder-trust", version: "2.1.289" });
  });

  it("is not launchable, but is on the Core; a plain missing one stays missing", () => {
    expect(harnessCanLaunch(map, "claude-code")).toBe(false);
    expect(isCliUnavailable(map, "claude-code")).toBe(true);
    expect(coreHasHarness(map, "claude-code")).toBe(true);
    expect(map.codex?.status).toBe("missing");
  });
});
