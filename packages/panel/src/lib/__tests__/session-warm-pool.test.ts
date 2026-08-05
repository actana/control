import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSessionPayload, prepareSessionWarmSlot } from "../session-warm-pool";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session-warm-pool", () => {
  it("builds default payload from saved harness settings", () => {
    expect(
      defaultSessionPayload({
        rememberHarnessSettings: true,
        savedHarness: "codex",
      }),
    ).toEqual({
      agent: "codex",
      bareSession: false,
    });
  });

  it("falls back to claude-code when nothing is saved", () => {
    expect(
      defaultSessionPayload({
        rememberHarnessSettings: false,
      }),
    ).toEqual({
      agent: "claude-code",
      bareSession: false,
    });
  });

  it("uses the last selected harness without remembered settings", () => {
    expect(
      defaultSessionPayload({
        rememberHarnessSettings: false,
        savedHarness: "cursor-cli",
      }),
    ).toEqual({
      agent: "cursor-cli",
      bareSession: false,
    });
  });

  it("carries a remembered bare session only for claude-code", () => {
    expect(
      defaultSessionPayload({
        rememberHarnessSettings: true,
        savedHarness: "claude-code",
        savedBareSession: true,
      }),
    ).toEqual({
      agent: "claude-code",
      bareSession: true,
    });
    expect(
      defaultSessionPayload({
        rememberHarnessSettings: true,
        savedHarness: "codex",
        savedBareSession: true,
      }),
    ).toEqual({
      agent: "codex",
      bareSession: false,
    });
  });

  it("prepares no warm slot when there is no Core to spawn on", async () => {
    vi.stubGlobal("window", {});

    await expect(
      prepareSessionWarmSlot({
        project: { id: "p1", path: "/Users/dev/project" } as never,
        coreId: null,
        payload: {
          agent: "claude-code",
          bareSession: false,
        },
      }),
    ).resolves.toBeNull();
  });
});
