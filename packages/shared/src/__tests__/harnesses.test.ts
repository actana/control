import { describe, expect, it } from "vitest";
import { HARNESS_REGISTRY, UI_HARNESSES } from "../harnesses";

describe("agent registry", () => {
  it("launches Codex with current hook support enabled", () => {
    expect(HARNESS_REGISTRY.codex.startCommand()).toBe("codex --enable hooks");
    expect(HARNESS_REGISTRY.codex.startCommand({ skipPermissions: true })).toBe(
      "codex --enable hooks --yolo"
    );
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
