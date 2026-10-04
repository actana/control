import { describe, expect, it } from "vitest";
import { needsSetupDialog, needsSetupReason } from "../harness-needs-setup";

describe("needs-setup reason", () => {
  it("round-trips the dialog name", () => {
    expect(needsSetupDialog(needsSetupReason("folder-trust"))).toBe("folder-trust");
  });
  it("is null for any other reason", () => {
    expect(needsSetupDialog("not-found")).toBeNull();
    expect(needsSetupDialog(undefined)).toBeNull();
  });
});
