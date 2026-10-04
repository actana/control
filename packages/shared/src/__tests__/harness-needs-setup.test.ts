import { describe, expect, it } from "vitest";
import { isNeedsSetup, needsSetupDialog, needsSetupReason } from "../harness-needs-setup";

describe("needs-setup reason", () => {
  it("round-trips the dialog name", () => {
    expect(needsSetupDialog(needsSetupReason("folder-trust"))).toBe("folder-trust");
  });
  it("is null for any other reason", () => {
    expect(needsSetupDialog("not-found")).toBeNull();
    expect(needsSetupDialog(undefined)).toBeNull();
  });
  it("isNeedsSetup needs status missing plus a needs-setup reason", () => {
    expect(isNeedsSetup({ status: "missing", reason: needsSetupReason("no-models") })).toBe(true);
    expect(isNeedsSetup({ status: "missing", reason: "not-found" })).toBe(false);
    expect(isNeedsSetup({ status: "available", reason: needsSetupReason("no-models") })).toBe(false);
    expect(isNeedsSetup(undefined)).toBe(false);
  });
});
