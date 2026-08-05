import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiCalls: string[] = [];
const archiveTask = vi.fn();
const restoreTask = vi.fn();
const updateTask = vi.fn();
const updateTaskStatus = vi.fn();
const deleteTask = vi.fn();

vi.mock("~/lib/api", () => ({
  api: {
    updateTaskStatus: (id: string, body: unknown) => {
      apiCalls.push(`status:${id}`);
      return updateTaskStatus(id, body);
    },
    deleteTask: (id: string) => {
      apiCalls.push(`delete:${id}`);
      return deleteTask(id);
    },
    archiveTask: (id: string) => {
      apiCalls.push(`archive:${id}`);
      return archiveTask(id);
    },
    restoreTask: (id: string) => {
      apiCalls.push(`restore:${id}`);
      return restoreTask(id);
    },
    updateTask: (id: string, body: unknown) => {
      apiCalls.push(`update:${id}`);
      return updateTask(id, body);
    },
  },
}));

import { __setPanelBridgeForTests } from "~/lib/panel-bridge";
import { mutateTaskForCore } from "../mutate-task-for-core";

function panelTask(over: Record<string, unknown> = {}) {
  return {
    task: {
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

describe("mutateTaskForCore", () => {
  beforeEach(() => {
    apiCalls.length = 0;
    archiveTask.mockReset().mockResolvedValue(panelTask({ archived: true }));
    restoreTask.mockReset().mockResolvedValue(panelTask({ archived: false }));
    updateTask.mockReset().mockResolvedValue(panelTask());
    updateTaskStatus.mockReset().mockResolvedValue(panelTask({ status: "finished" }));
    deleteTask.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    __setPanelBridgeForTests(null);
    vi.unstubAllGlobals();
  });

  it("routes a Core-owned archive over the panel link, not the Panel's HTTP API", async () => {
    // The bridge is null while server-rendering; this suite runs in node, so
    // stand up the `window` the bridge lookup gates on.
    vi.stubGlobal("window", {});
    const mutateTask = vi.fn().mockResolvedValue({
      taskId: "t1",
      projectId: "p1",
      title: "Session",
      icon: null,
      agent: "claude",
      status: "ready",
      archived: true,
      pinned: false,
      updatedAt: 43,
    });
    __setPanelBridgeForTests({ mutateTask } as never);

    const snapshot = await mutateTaskForCore("core-a", {
      op: "update",
      taskId: "t1",
      archived: true,
    });

    expect(mutateTask).toHaveBeenCalledWith("core-a", {
      op: "update",
      taskId: "t1",
      archived: true,
    });
    expect(apiCalls).toEqual([]);
    expect(snapshot?.archived).toBe(true);
  });

  it("archives a Panel-owned row over the archive endpoint", async () => {
    const snapshot = await mutateTaskForCore(null, {
      op: "update",
      taskId: "t1",
      archived: true,
    });

    expect(apiCalls).toEqual(["archive:t1"]);
    expect(snapshot?.archived).toBe(true);
  });

  it("restores a Panel-owned row over the restore endpoint", async () => {
    const snapshot = await mutateTaskForCore(null, {
      op: "update",
      taskId: "t1",
      archived: false,
    });

    expect(apiCalls).toEqual(["restore:t1"]);
    expect(snapshot?.archived).toBe(false);
  });

  it("applies title/pinned before flipping archived on a Panel-owned row", async () => {
    await mutateTaskForCore(null, {
      op: "update",
      taskId: "t1",
      title: "Renamed",
      archived: true,
    });

    expect(apiCalls).toEqual(["update:t1", "archive:t1"]);
    expect(updateTask).toHaveBeenCalledWith("t1", { title: "Renamed" });
  });

  it("forwards claudeSessionId on a Panel-owned row", async () => {
    // The resume-failed path writes a fresh session id through this function.
    // Dropping it here is not a no-op: the row keeps the DEAD id, so every
    // later reopen retries it, fails, and falls back again — the stale-session
    // loop the write exists to break.
    await mutateTaskForCore(null, {
      op: "update",
      taskId: "t1",
      claudeSessionId: "sess-fresh",
    });

    expect(updateTask).toHaveBeenCalledWith("t1", { claudeSessionId: "sess-fresh" });
  });

  it("forwards a cleared claudeSessionId, which is not the same as an absent one", async () => {
    // codex/opencode get `null` rather than a fresh id — the row must actually
    // be cleared, not left holding the old one.
    await mutateTaskForCore(null, { op: "update", taskId: "t1", claudeSessionId: null });

    expect(updateTask).toHaveBeenCalledWith("t1", { claudeSessionId: null });
  });

  it("forwards icon on a Panel-owned row", async () => {
    await mutateTaskForCore(null, { op: "update", taskId: "t1", icon: "bug" });

    expect(updateTask).toHaveBeenCalledWith("t1", { icon: "bug" });
  });

  it("carries a generated title's unpinned flag to a Panel-owned row", async () => {
    // Both arms of one frame must agree on what a title means, or a title
    // generated on one host pins a rename flag the other would not have.
    await mutateTaskForCore(null, {
      op: "update",
      taskId: "t1",
      title: "Rebuild the picker",
      titleManuallySet: false,
    });

    expect(updateTask).toHaveBeenCalledWith("t1", {
      title: "Rebuild the picker",
      titleManuallySet: false,
    });
  });

  it("leaves a patch without archived on the update endpoint alone", async () => {
    await mutateTaskForCore(null, { op: "update", taskId: "t1", pinned: true });

    expect(apiCalls).toEqual(["update:t1"]);
    expect(updateTask).toHaveBeenCalledWith("t1", { pinned: true });
  });

  it("patches a Panel-owned status over the status endpoint", async () => {
    const snapshot = await mutateTaskForCore(null, {
      op: "update",
      taskId: "t1",
      status: "finished",
    });

    expect(apiCalls).toEqual(["status:t1"]);
    expect(updateTaskStatus).toHaveBeenCalledWith("t1", { status: "finished" });
    expect(snapshot?.status).toBe("finished");
  });

  it("routes a Core-owned status patch over the panel link", async () => {
    vi.stubGlobal("window", {});
    const mutateTask = vi.fn().mockResolvedValue(panelTask({ status: "finished" }).task);
    __setPanelBridgeForTests({ mutateTask } as never);

    await mutateTaskForCore("core-a", { op: "update", taskId: "t1", status: "finished" });

    expect(mutateTask).toHaveBeenCalledWith("core-a", {
      op: "update",
      taskId: "t1",
      status: "finished",
    });
    expect(apiCalls).toEqual([]);
  });

  it("applies the plain columns, then status, then archived on a Panel-owned row", async () => {
    await mutateTaskForCore(null, {
      op: "update",
      taskId: "t1",
      title: "Renamed",
      status: "finished",
      archived: true,
    });

    expect(apiCalls).toEqual(["update:t1", "status:t1", "archive:t1"]);
  });

  it("routes a Core-owned delete over the panel link, not the Panel's HTTP API", async () => {
    vi.stubGlobal("window", {});
    const mutateTask = vi.fn().mockResolvedValue({
      taskId: "t1",
      projectId: "p1",
      title: "Session",
      icon: null,
      agent: "claude",
      status: "ready",
      archived: true,
      pinned: false,
      updatedAt: 43,
    });
    __setPanelBridgeForTests({ mutateTask } as never);

    const snapshot = await mutateTaskForCore("core-a", { op: "delete", taskId: "t1" });

    expect(mutateTask).toHaveBeenCalledWith("core-a", { op: "delete", taskId: "t1" });
    expect(apiCalls).toEqual([]);
    // The Core hands back the row it removed, so the caller can echo it.
    expect(snapshot?.taskId).toBe("t1");
  });

  it("deletes a Panel-owned row over the delete endpoint", async () => {
    expect(await mutateTaskForCore(null, { op: "delete", taskId: "t1" })).toBeNull();

    expect(apiCalls).toEqual(["delete:t1"]);
  });

  it("reports a missing Panel-owned row as null", async () => {
    archiveTask.mockResolvedValue({ task: null });

    expect(
      await mutateTaskForCore(null, { op: "update", taskId: "gone", archived: true }),
    ).toBeNull();
  });
});
