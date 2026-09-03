import { describe, expect, it } from "vitest";
import {
  HARNESS_REGISTRY,
  UI_HARNESSES,
  assertHookTrustFlagInCommand,
  harnessHookTrustFlag,
} from "../harnesses";
import { HARNESSES } from "../domain";

describe("agent registry", () => {
  it("launches Codex with current hook support enabled", () => {
    expect(HARNESS_REGISTRY.codex.startCommand()).toBe(
      "codex --enable hooks --dangerously-bypass-hook-trust"
    );
    expect(HARNESS_REGISTRY.codex.startCommand({ skipPermissions: true })).toBe(
      "codex --enable hooks --dangerously-bypass-hook-trust --yolo"
    );
  });

  it("puts the hook-trust flag on every launch that needs one (issue 290)", () => {
    // The state this asserts against is the one the bug lives in: a workspace
    // Codex has never seen, whose hooks file it has therefore never reviewed.
    // Nothing here consults a review — there is nothing to consult on a fresh
    // machine — so the flag has to be unconditional in the command, and the
    // assertion is written over every harness rather than over Codex so the
    // next family with the same vendor behaviour cannot arrive half-wired.
    for (const harness of HARNESSES) {
      const entry = HARNESS_REGISTRY[harness];
      expect(() => assertHookTrustFlagInCommand(harness, entry.startCommand())).not.toThrow();
      expect(() =>
        assertHookTrustFlagInCommand(harness, entry.startCommand({ skipPermissions: true })),
      ).not.toThrow();
    }
  });

  it("is the only harness of the four that needs one", () => {
    // Not a restatement of the table: it is the claim that the other three
    // vendors run the file this Core wrote without being asked twice, which is
    // why `null` there means "verified as needing none" rather than "not
    // filled in yet".
    expect(harnessHookTrustFlag("codex")).toBe("--dangerously-bypass-hook-trust");
    expect(harnessHookTrustFlag("claude-code")).toBeNull();
    expect(harnessHookTrustFlag("cursor-cli")).toBeNull();
    expect(harnessHookTrustFlag("opencode")).toBeNull();
  });

  it("fails a launch command that dropped the flag, rather than a Session that did", () => {
    // The failure mode this guards is silent by construction: a Codex without
    // the flag spawns cleanly, paints a working TUI, and reports no lifecycle
    // at all, so the first thing anybody learns is a `--wait` that timed out.
    expect(() => assertHookTrustFlagInCommand("codex", "codex --enable hooks")).toThrow(
      /--dangerously-bypass-hook-trust/,
    );
    expect(() => assertHookTrustFlagInCommand("claude-code", "claude")).not.toThrow();
  });

  it("exposes Cursor CLI as a selectable agent", () => {
    expect(UI_HARNESSES).toContain("cursor-cli");
    expect(HARNESS_REGISTRY["cursor-cli"]).toMatchObject({
      command: "cursor-agent",
      uiVisible: true,
      supportsSkipPermissions: true,
    });
    expect(HARNESS_REGISTRY["cursor-cli"].disabled).toBeUndefined();
    expect(HARNESS_REGISTRY["cursor-cli"].startCommand()).toBe("cursor-agent");
    expect(HARNESS_REGISTRY["cursor-cli"].startCommand({ skipPermissions: true })).toBe(
      "cursor-agent --force"
    );
  });

  it("exposes OpenCode as a selectable agent", () => {
    expect(UI_HARNESSES).toContain("opencode");
    expect(HARNESS_REGISTRY.opencode).toMatchObject({
      command: "opencode",
      uiVisible: true,
      supportsSkipPermissions: false,
    });
    expect(HARNESS_REGISTRY.opencode.startCommand()).toBe("opencode");
    expect(HARNESS_REGISTRY.opencode.titleInvocation?.("name this task")).toEqual({
      cmd: "opencode",
      args: ["run", "name this task"],
    });
  });
});
