import { describe, expect, it } from "vitest";
import { defaultSessionPayload } from "../session-create-payload";

describe("defaultSessionPayload", () => {
  it("uses the harness remembered for the Core", () => {
    expect(defaultSessionPayload({ savedHarness: "codex" })).toEqual({
      agent: "codex",
      bareSession: false,
    });
  });

  it("falls back to claude-code when nothing is remembered", () => {
    expect(defaultSessionPayload({ savedHarness: null })).toEqual({
      agent: "claude-code",
      bareSession: false,
    });
  });

  it("never starts a remembered claude-code session bare", () => {
    expect(defaultSessionPayload({ savedHarness: "claude-code" }).bareSession).toBe(false);
  });
});
