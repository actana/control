import { describe, expect, it } from "vitest";
import { HARNESS_REGISTRY, UI_HARNESSES } from "../harnesses";
import { HARNESS_HOOK_TRUST_FLAGS, hookTrustFlagForHarness } from "../harness-cli-config";
import { HARNESSES } from "../domain";

describe("agent registry", () => {
  it("launches Codex with current hook support enabled", () => {
    expect(HARNESS_REGISTRY.codex.startCommand()).toBe("codex --enable hooks");
    expect(HARNESS_REGISTRY.codex.startCommand({ skipPermissions: true })).toBe(
      "codex --enable hooks --yolo"
    );
  });

  it("puts no hook-trust bypass in any launch command (issue 290)", () => {
    // The flag lifts Codex's review of hooks it has not seen. A command is
    // composed before any hooks file lands — by a client that has not looked
    // at the workspace, and in the Panel's case is not on the same machine —
    // so it cannot know whether the hooks about to run are this Core's or a
    // cloned repository's. The Core decides at spawn, in
    // `reconcileHookTrustFlag`; a command string that carried the flag would
    // be vouching for hooks nobody has vetted.
    for (const harness of HARNESSES) {
      const flag = hookTrustFlagForHarness(harness);
      if (flag === null) continue;
      const entry = HARNESS_REGISTRY[harness];
      expect(entry.startCommand().split(" ")).not.toContain(flag);
      expect(entry.startCommand({ skipPermissions: true }).split(" ")).not.toContain(flag);
    }
  });

  it("records the hook-trust flag as a vendor fact for Codex alone", () => {
    // Not a restatement of the table: it is the claim that the other three
    // vendors run the file this Core wrote without holding it for review, so
    // `null` there means "verified as needing none" rather than "not filled
    // in yet".
    expect(hookTrustFlagForHarness("codex")).toBe("--dangerously-bypass-hook-trust");
    expect(hookTrustFlagForHarness("claude-code")).toBeNull();
    expect(hookTrustFlagForHarness("cursor-cli")).toBeNull();
    expect(hookTrustFlagForHarness("opencode")).toBeNull();
    expect(Object.keys(HARNESS_HOOK_TRUST_FLAGS).sort()).toEqual([...HARNESSES].sort());
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
