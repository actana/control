import { describe, expect, it } from "vitest";
import {
  SETUP_CHECK_FAILED_MAX_CHARS,
  isNeedsSetup,
  needsSetupDialog,
  needsSetupReason,
  setupCheckFailedReason,
  setupCheckFailure,
} from "../harness-needs-setup";

describe("needs-setup reason", () => {
  it("round-trips the dialog name", () => {
    expect(needsSetupDialog(needsSetupReason("folder-trust"))).toBe("folder-trust");
  });
  it("is null for any other reason", () => {
    expect(needsSetupDialog("not-found")).toBeNull();
    expect(needsSetupDialog(undefined)).toBeNull();
    expect(needsSetupDialog(setupCheckFailedReason("EACCES"))).toBeNull();
  });
  it("isNeedsSetup needs status missing plus a needs-setup reason", () => {
    expect(isNeedsSetup({ status: "missing", reason: needsSetupReason("no-models") })).toBe(true);
    expect(isNeedsSetup({ status: "missing", reason: "not-found" })).toBe(false);
    expect(isNeedsSetup({ status: "available", reason: needsSetupReason("no-models") })).toBe(false);
    expect(isNeedsSetup(undefined)).toBe(false);
  });
});

describe("setup-check-failed reason (#700)", () => {
  it("round-trips the error, and is not a dialog", () => {
    const reason = setupCheckFailedReason("posix_spawnp failed");
    expect(setupCheckFailure(reason)).toBe("posix_spawnp failed");
    expect(needsSetupDialog(reason)).toBeNull();
    expect(setupCheckFailure(needsSetupReason("folder-trust"))).toBeNull();
    expect(setupCheckFailure("not-found")).toBeNull();
    expect(setupCheckFailure(undefined)).toBeNull();
  });
  it("keeps the first line of the error only, trimmed and capped, and never an empty one", () => {
    expect(setupCheckFailure(setupCheckFailedReason("  EACCES: permission denied\n    at spawn (node:pty)\n"))).toBe(
      "EACCES: permission denied",
    );
    const long = "x".repeat(SETUP_CHECK_FAILED_MAX_CHARS + 50);
    const kept = setupCheckFailure(setupCheckFailedReason(long))!;
    expect(kept).toHaveLength(SETUP_CHECK_FAILED_MAX_CHARS);
    expect(kept.endsWith("…")).toBe(true);
    expect(setupCheckFailure(setupCheckFailedReason(""))).toBe("unknown error");
    expect(setupCheckFailure(setupCheckFailedReason("\n\n"))).toBe("unknown error");
  });
  it("counts as needs-setup: installed, not ready", () => {
    expect(isNeedsSetup({ status: "missing", reason: setupCheckFailedReason("EACCES") })).toBe(true);
    expect(isNeedsSetup({ status: "available", reason: setupCheckFailedReason("EACCES") })).toBe(false);
  });
});
