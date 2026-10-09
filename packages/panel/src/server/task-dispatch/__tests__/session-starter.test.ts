import { beforeEach, describe, expect, it, vi } from "vitest";

const start = vi.hoisted(() => vi.fn());
vi.mock("@actana/sdk/core", async (orig) => ({
  ...(await orig<typeof import("@actana/sdk/core")>()),
  CoreSession: { start },
}));
vi.mock("../../services/core-link-manager", () => ({ coreLinkManager: () => ({ client: () => ({ sdk: {} }) }) }));

import { startSessionOnCore } from "../session-starter";

describe("starting a Task's Session on a Core", () => {
  beforeEach(() => {
    start.mockReset();
    start.mockResolvedValue({ sessionId: "s1", onExit: () => {}, dispose: () => {} });
  });

  it("launches a default cursor-cli Agent with --force and dangerouslySkipPermissions, so the spawn policy accepts it", async () => {
    await startSessionOnCore({ coreId: "core_1", harness: "cursor-cli", title: "t", prompt: "p", model: null, flags: [] } as never);
    expect(start).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ command: "cursor-agent --force", dangerouslySkipPermissions: true }),
    );
  });

  it("sends no skip-permissions intent for a harness with no auto-mode flag", async () => {
    await startSessionOnCore({ coreId: "core_1", harness: "opencode", title: "t", prompt: "p", model: null, flags: ["skip-permissions"] } as never);
    const arg = start.mock.calls[0]![1];
    expect(arg.command).toBe("opencode");
    expect(arg).not.toHaveProperty("dangerouslySkipPermissions");
  });
});
