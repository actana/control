import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiCalls: string[] = [];
const archiveSession = vi.fn();
const restoreSession = vi.fn();
const updateSession = vi.fn();
const updateSessionStatus = vi.fn();
const deleteSession = vi.fn();

vi.mock("~/lib/api", () => ({
  api: {
    updateSessionStatus: (id: string, body: unknown) => {
      apiCalls.push(`status:${id}`);
      return updateSessionStatus(id, body);
    },
    deleteSession: (id: string) => {
      apiCalls.push(`delete:${id}`);
      return deleteSession(id);
    },
    archiveSession: (id: string) => {
      apiCalls.push(`archive:${id}`);
      return archiveSession(id);
    },
    restoreSession: (id: string) => {
      apiCalls.push(`restore:${id}`);
      return restoreSession(id);
    },
    updateSession: (id: string, body: unknown) => {
      apiCalls.push(`update:${id}`);
      return updateSession(id, body);
    },
  },
}));

import { __setPanelBridgeForTests } from "~/lib/panel-bridge";
import { mutateSessionForCore } from "../mutate-session-for-core";

function panelSession(over: Record<string, unknown> = {}) {
  return {
    session: {
      id: "t1",
      projectId: "p1",
      title: "Session",
      icon: null,
      agent: "claude",
      status: "ready",
      archived: false,
      pinned: false,
      updatedAt: 42,
      ...over,
    },
  };
}

describe("mutateSessionForCore", () => {
  beforeEach(() => {
    apiCalls.length = 0;
    archiveSession.mockReset().mockResolvedValue(panelSession({ archived: true }));
    restoreSession.mockReset().mockResolvedValue(panelSession({ archived: false }));
    updateSession.mockReset().mockResolvedValue(panelSession());
    updateSessionStatus.mockReset().mockResolvedValue(panelSession({ status: "finished" }));
    deleteSession.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    __setPanelBridgeForTests(null);
    vi.unstubAllGlobals();
  });

  it("routes a Core-owned archive over the panel link, not the Panel's HTTP API", async () => {
    // The bridge is null while server-rendering; this suite runs in node, so
    // stand up the `window` the bridge lookup gates on.
    vi.stubGlobal("window", {});
    const mutateSession = vi.fn().mockResolvedValue({
      sessionId: "t1",
      projectId: "p1",
      title: "Session",
      icon: null,
      agent: "claude",
      status: "ready",
      archived: true,
      pinned: false,
      updatedAt: 43,
    });
    __setPanelBridgeForTests({ mutateSession } as never);

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
    expect(apiCalls).toEqual([]);
    expect(snapshot?.archived).toBe(true);
  });

  it("archives a Panel-owned row over the archive endpoint", async () => {
    const snapshot = await mutateSessionForCore(null, {
      op: "update",
      sessionId: "t1",
      archived: true,
    });

    expect(apiCalls).toEqual(["archive:t1"]);
    expect(snapshot?.archived).toBe(true);
  });

  it("restores a Panel-owned row over the restore endpoint", async () => {
    const snapshot = await mutateSessionForCore(null, {
      op: "update",
      sessionId: "t1",
      archived: false,
    });

    expect(apiCalls).toEqual(["restore:t1"]);
    expect(snapshot?.archived).toBe(false);
  });

  it("applies title/pinned before flipping archived on a Panel-owned row", async () => {
    await mutateSessionForCore(null, {
      op: "update",
      sessionId: "t1",
      title: "Renamed",
      archived: true,
    });

    expect(apiCalls).toEqual(["update:t1", "archive:t1"]);
    expect(updateSession).toHaveBeenCalledWith("t1", { title: "Renamed" });
  });

  it("forwards claudeSessionId on a Panel-owned row", async () => {
    // The resume-failed path writes a fresh session id through this function.
    // Dropping it here is not a no-op: the row keeps the DEAD id, so every
    // later reopen retries it, fails, and falls back again — the stale-session
    // loop the write exists to break.
    await mutateSessionForCore(null, {
      op: "update",
      sessionId: "t1",
      claudeSessionId: "sess-fresh",
    });

    expect(updateSession).toHaveBeenCalledWith("t1", { claudeSessionId: "sess-fresh" });
  });

  it("forwards a cleared claudeSessionId, which is not the same as an absent one", async () => {
    // codex/opencode get `null` rather than a fresh id — the row must actually
    // be cleared, not left holding the old one.
    await mutateSessionForCore(null, { op: "update", sessionId: "t1", claudeSessionId: null });

    expect(updateSession).toHaveBeenCalledWith("t1", { claudeSessionId: null });
  });

  it("forwards icon on a Panel-owned row", async () => {
    await mutateSessionForCore(null, { op: "update", sessionId: "t1", icon: "bug" });

    expect(updateSession).toHaveBeenCalledWith("t1", { icon: "bug" });
  });

  it("carries a generated title's unpinned flag to a Panel-owned row", async () => {
    // Both arms of one frame must agree on what a title means, or a title
    // generated on one host pins a rename flag the other would not have.
    await mutateSessionForCore(null, {
      op: "update",
      sessionId: "t1",
      title: "Rebuild the picker",
      titleManuallySet: false,
    });

    expect(updateSession).toHaveBeenCalledWith("t1", {
      title: "Rebuild the picker",
      titleManuallySet: false,
    });
  });

  it("leaves a patch without archived on the update endpoint alone", async () => {
    await mutateSessionForCore(null, { op: "update", sessionId: "t1", pinned: true });

    expect(apiCalls).toEqual(["update:t1"]);
    expect(updateSession).toHaveBeenCalledWith("t1", { pinned: true });
  });

  it("patches a Panel-owned status over the status endpoint", async () => {
    const snapshot = await mutateSessionForCore(null, {
      op: "update",
      sessionId: "t1",
      status: "finished",
    });

    expect(apiCalls).toEqual(["status:t1"]);
    expect(updateSessionStatus).toHaveBeenCalledWith("t1", { status: "finished" });
    expect(snapshot?.status).toBe("finished");
  });

  it("routes a Core-owned status patch over the panel link", async () => {
    vi.stubGlobal("window", {});
    const mutateSession = vi.fn().mockResolvedValue(panelSession({ status: "finished" }).session);
    __setPanelBridgeForTests({ mutateSession } as never);

    await mutateSessionForCore("core-a", { op: "update", sessionId: "t1", status: "finished" });

    expect(mutateSession).toHaveBeenCalledWith("core-a", {
      op: "update",
      sessionId: "t1",
      status: "finished",
    });
    expect(apiCalls).toEqual([]);
  });

  it("applies the plain columns, then status, then archived on a Panel-owned row", async () => {
    await mutateSessionForCore(null, {
      op: "update",
      sessionId: "t1",
      title: "Renamed",
      status: "finished",
      archived: true,
    });

    expect(apiCalls).toEqual(["update:t1", "status:t1", "archive:t1"]);
  });

  it("routes a Core-owned delete over the panel link, not the Panel's HTTP API", async () => {
    vi.stubGlobal("window", {});
    const mutateSession = vi.fn().mockResolvedValue({
      sessionId: "t1",
      projectId: "p1",
      title: "Session",
      icon: null,
      agent: "claude",
      status: "ready",
      archived: true,
      pinned: false,
      updatedAt: 43,
    });
    __setPanelBridgeForTests({ mutateSession } as never);

    const snapshot = await mutateSessionForCore("core-a", { op: "delete", sessionId: "t1" });

    expect(mutateSession).toHaveBeenCalledWith("core-a", { op: "delete", sessionId: "t1" });
    expect(apiCalls).toEqual([]);
    // The Core hands back the row it removed, so the caller can echo it.
    expect(snapshot?.sessionId).toBe("t1");
  });

  it("deletes a Panel-owned row over the delete endpoint", async () => {
    expect(await mutateSessionForCore(null, { op: "delete", sessionId: "t1" })).toBeNull();

    expect(apiCalls).toEqual(["delete:t1"]);
  });

  it("reports a missing Panel-owned row as null", async () => {
    archiveSession.mockResolvedValue({ session: null });

    expect(
      await mutateSessionForCore(null, { op: "update", sessionId: "gone", archived: true }),
    ).toBeNull();
  });
});
