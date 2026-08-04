import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSessionPayload, prepareSessionWarmSlot } from "../session-warm-pool";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session-warm-pool", () => {
  it("builds default payload from saved agent settings", () => {
    expect(
      defaultSessionPayload({
        rememberHarnessSettings: true,
        savedHarness: "codex",
        savedSkipPermissions: true,
      }),
    ).toEqual({
      agent: "codex",
      skipPermissions: true,
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
      skipPermissions: false,
      bareSession: false,
    });
  });

  it("remembers skip permissions without remembered agent settings", () => {
    expect(
      defaultSessionPayload({
        rememberHarnessSettings: false,
        savedSkipPermissions: true,
      }),
    ).toEqual({
      agent: "claude-code",
      skipPermissions: true,
      bareSession: false,
    });
  });

  it("uses the last selected agent without remembered agent settings", () => {
    expect(
      defaultSessionPayload({
        rememberHarnessSettings: false,
        savedHarness: "cursor-cli",
        savedSkipPermissions: true,
      }),
    ).toEqual({
      agent: "cursor-cli",
      skipPermissions: true,
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
          skipPermissions: false,
          bareSession: false,
        },
      }),
    ).resolves.toBeNull();
  });
});
