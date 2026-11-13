import { beforeEach, describe, expect, it, vi } from "vitest";

const start = vi.hoisted(() => vi.fn());
vi.mock("@actana/sdk/core", async (orig) => ({
  ...(await orig<typeof import("@actana/sdk/core")>()),
  CoreSession: { start },
}));
const sessionsMutate = vi.hoisted(() => vi.fn());
vi.mock("../../services/core-link-manager", () => ({ coreLinkManager: () => ({ client: () => ({ sdk: { sessionsMutate } }) }) }));

import { startSessionOnCore } from "../session-starter";

describe("starting a Task's Session on a Core", () => {
  beforeEach(() => {
    start.mockReset();
    sessionsMutate.mockReset();
    sessionsMutate.mockImplementation(async (m: { op: string }) => (m.op === "create" ? { sessionId: "row-1" } : null));
    start.mockResolvedValue({ sessionId: "s1", onExit: () => {}, onStatus: () => () => {}, dispose: () => {} });
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

  it("hands the Core's status changes on, and lets go of the subscription with the handle", async () => {
    const unsubscribe = vi.fn();
    let listener: ((status: string) => void) | null = null;
    const dispose = vi.fn();
    start.mockResolvedValue({
      sessionId: "s1",
      onExit: () => {},
      onStatus: (cb: (status: string) => void) => {
        listener = cb;
        return unsubscribe;
      },
      dispose,
    });
    const handle = await startSessionOnCore({ coreId: "core_1", harness: "claude-code", title: "t", prompt: "p", model: null, flags: [] } as never);
    const seen: string[] = [];
    handle.onStatus((status) => seen.push(status));
    listener!("running");
    listener!("needs-input");
    expect(seen).toEqual(["running", "needs-input"]);

    handle.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("creates the Session row itself and hands its id to CoreSession.start", async () => {
    await startSessionOnCore({ coreId: "core_1", harness: "claude-code", title: "Task: x", prompt: "p", model: null, flags: [] } as never);
    expect(sessionsMutate).toHaveBeenCalledTimes(1);
    expect(sessionsMutate).toHaveBeenCalledWith({ op: "create", title: "Task: x", agent: "claude-code" });
    expect(start.mock.calls[0]![1]).toMatchObject({ sessionId: "row-1" });
  });

  it("deletes the row it created when the spawn is refused, and rethrows the original error (no orphan Session)", async () => {
    const refused = new Error("the Core refused to start a claude-code Session: pty:spawn refused: 8 live harness PTYs");
    start.mockRejectedValue(refused);
    await expect(
      startSessionOnCore({ coreId: "core_1", harness: "claude-code", title: "Task: x", prompt: "p", model: null, flags: [] } as never),
    ).rejects.toBe(refused);
    const ops = sessionsMutate.mock.calls.map(([m]) => m);
    expect(ops).toEqual([
      { op: "create", title: "Task: x", agent: "claude-code" },
      { op: "delete", sessionId: "row-1" },
    ]);
  });

  it("still rethrows the spawn error when the cleanup delete itself fails", async () => {
    const refused = new Error("pty:spawn refused: 8 live harness PTYs");
    start.mockRejectedValue(refused);
    sessionsMutate.mockImplementation(async (m: { op: string }) => {
      if (m.op === "delete") throw new Error("link down");
      return { sessionId: "row-1" };
    });
    await expect(
      startSessionOnCore({ coreId: "core_1", harness: "claude-code", title: "t", prompt: "p", model: null, flags: [] } as never),
    ).rejects.toBe(refused);
  });

  it("creates no row to clean up when the Core will not create one", async () => {
    sessionsMutate.mockResolvedValue(null);
    await expect(
      startSessionOnCore({ coreId: "core_1", harness: "claude-code", title: "t", prompt: "p", model: null, flags: [] } as never),
    ).rejects.toThrow(/Session row/);
    expect(start).not.toHaveBeenCalled();
    expect(sessionsMutate).toHaveBeenCalledTimes(1);
  });
});
