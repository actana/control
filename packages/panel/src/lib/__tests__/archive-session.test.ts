import { beforeEach, describe, expect, it, vi } from "vitest";

const mutateTaskForCore = vi.fn();

vi.mock("~/lib/mutate-task-for-core", () => ({
  mutateTaskForCore: (...args: unknown[]) => mutateTaskForCore(...args),
}));

import { archiveOpenSession } from "../archive-session";
import type { OpenTerminal } from "~/lib/terminal-store";

function session(over: Partial<OpenTerminal> = {}): OpenTerminal {
  return {
    taskId: "t1",
    ptyId: null,
    startCommand: "claude",
    dangerouslySkipPermissions: false,
    cwd: "/work",
    project: { id: "p1" },
    task: { id: "t1" },
    ...over,
  } as OpenTerminal;
}

function queryClientStub() {
  const invalidated: unknown[] = [];
  return {
    client: { invalidateQueries: (arg: unknown) => (invalidated.push(arg), Promise.resolve()) },
    invalidated,
  };
}

describe("archiveOpenSession", () => {
  beforeEach(() => {
    mutateTaskForCore.mockReset().mockResolvedValue({ taskId: "t1", archived: true });
  });

  it("routes the archive to the Core that owns the task row", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const { client } = queryClientStub();

    await archiveOpenSession(session({ coreId: "core-a" }), close, client as never, {
      skipInvalidate: true,
    });

    expect(close).toHaveBeenCalledWith("t1", { activateTaskId: null });
    expect(mutateTaskForCore).toHaveBeenCalledWith("core-a", {
      op: "update",
      taskId: "t1",
      archived: true,
    });
  });

  it("passes a Panel-owned session's null coreId straight through", async () => {
    const { client } = queryClientStub();

    await archiveOpenSession(session({ coreId: null }), vi.fn().mockResolvedValue(undefined), client as never, {
      skipInvalidate: true,
    });

    expect(mutateTaskForCore.mock.calls[0]?.[0]).toBeNull();
  });

  it("still archives when closing the PTY fails", async () => {
    const close = vi.fn().mockRejectedValue(new Error("pty gone"));
    const { client } = queryClientStub();

    await archiveOpenSession(session({ coreId: "core-a" }), close, client as never, {
      skipInvalidate: true,
    });

    expect(mutateTaskForCore).toHaveBeenCalledTimes(1);
  });

  it("throws when the Core rejects the mutation so the caller can toast", async () => {
    mutateTaskForCore.mockRejectedValue(new Error("link down"));
    const { client } = queryClientStub();

    await expect(
      archiveOpenSession(session({ coreId: "core-a" }), vi.fn().mockResolvedValue(undefined), client as never, {
        skipInvalidate: true,
      }),
    ).rejects.toThrow("link down");
  });
});
