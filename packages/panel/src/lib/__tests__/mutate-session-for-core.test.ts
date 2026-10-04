import { afterEach, describe, expect, it, vi } from "vitest";
import { __setPanelBridgeForTests } from "~/lib/panel-bridge";
import { mutateSessionForCore } from "../mutate-session-for-core";

// A Session's row lives on the Core that owns it, and the Panel has one way to
// write it: a frame on its panel link, addressed to that Core.

const apiCalls: string[] = [];
vi.mock("~/lib/api", () => ({
  api: new Proxy(
    {},
    {
      get: (_target, name) => () => {
        apiCalls.push(String(name));
        return Promise.resolve({ session: null });
      },
    },
  ),
}));

const SNAPSHOT = {
  sessionId: "t1",
  title: "Session",
  titleManuallySet: false,
  claudeSessionId: null,
  icon: null,
  agent: "claude",
  status: "ready",
  archived: false,
  pinned: false,
  updatedAt: 43,
};

function bridgeAnswering(snapshot: unknown) {
  // The bridge is null while server-rendering; this suite runs in node, so
  // stand up the `window` the bridge lookup gates on.
  vi.stubGlobal("window", {});
  const mutateSession = vi.fn().mockResolvedValue(snapshot);
  __setPanelBridgeForTests({ mutateSession } as never);
  return mutateSession;
}

afterEach(() => {
  __setPanelBridgeForTests(null);
  vi.unstubAllGlobals();
  apiCalls.length = 0;
});

describe("mutateSessionForCore", () => {
  it("sends an archive to the named Core over the panel link", async () => {
    const mutateSession = bridgeAnswering({ ...SNAPSHOT, archived: true });

    const snapshot = await mutateSessionForCore("core-a", {
      op: "update",
      sessionId: "t1",
      archived: true,
    });

    expect(mutateSession).toHaveBeenCalledWith("core-a", {
      op: "update",
      sessionId: "t1",
      archived: true,
    });
    expect(snapshot?.archived).toBe(true);
  });

  it("sends a status patch the same way", async () => {
    const mutateSession = bridgeAnswering({ ...SNAPSHOT, status: "finished" });

    await mutateSessionForCore("core-a", { op: "update", sessionId: "t1", status: "finished" });

    expect(mutateSession).toHaveBeenCalledWith("core-a", {
      op: "update",
      sessionId: "t1",
      status: "finished",
    });
  });

  it("sends a delete to the Core, which hands back the row it removed", async () => {
    const mutateSession = bridgeAnswering(SNAPSHOT);

    const snapshot = await mutateSessionForCore("core-a", { op: "delete", sessionId: "t1" });

    expect(mutateSession).toHaveBeenCalledWith("core-a", { op: "delete", sessionId: "t1" });
    expect(snapshot?.sessionId).toBe("t1");
  });

  it("carries a create without any project", async () => {
    const mutateSession = bridgeAnswering(SNAPSHOT);

    await mutateSessionForCore("core-a", {
      op: "create",
      sessionId: "t1",
      title: "Session",
      agent: "claude-code",
    });

    expect(mutateSession.mock.calls[0]?.[1]).not.toHaveProperty("projectId");
  });

  it("reports a row the Core does not have as null", async () => {
    bridgeAnswering(null);

    expect(
      await mutateSessionForCore("core-a", { op: "update", sessionId: "gone", archived: true }),
    ).toBeNull();
  });

  it("never touches the Panel's own HTTP API", async () => {
    bridgeAnswering(SNAPSHOT);

    await mutateSessionForCore("core-a", { op: "update", sessionId: "t1", pinned: true });
    await mutateSessionForCore("core-a", { op: "delete", sessionId: "t1" });

    expect(apiCalls).toEqual([]);
  });

  it("throws, rather than doing nothing, when there is no panel link", async () => {
    await expect(
      mutateSessionForCore("core-a", { op: "update", sessionId: "t1", archived: true }),
    ).rejects.toThrow(/not connected/i);
  });
});
