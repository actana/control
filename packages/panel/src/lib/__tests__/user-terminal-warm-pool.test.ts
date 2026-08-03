import { describe, expect, it } from "vitest";
import { userTerminalWarmSignature } from "../user-terminal-warm-pool";

describe("user-terminal-warm-pool", () => {
  it("keys warm slots by cwd", () => {
    expect(userTerminalWarmSignature("core_a", "/tmp/checkout-a")).not.toBe(
      userTerminalWarmSignature("core_a", "/tmp/checkout-b"),
    );
  });

  it("keys warm slots by Core, so the same path on two machines never collides", () => {
    expect(userTerminalWarmSignature("core_a", "/Users/dev/project")).not.toBe(
      userTerminalWarmSignature("core_b", "/Users/dev/project"),
    );
  });

  it("is stable for the same Core and cwd", () => {
    expect(userTerminalWarmSignature("core_a", "/Users/dev/project")).toBe(
      userTerminalWarmSignature("core_a", "/Users/dev/project"),
    );
  });
});
