import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreLinkTaskSnapshot } from "@actana/shared/core-link-frames";

/**
 * Where the Archived view's contents come from, per owner (ADR 0019).
 *
 * A Core sends its archived rows over a frame of their own, and the number of
 * them rides the active answer as a scalar — so the Archived tab can be gated
 * and labelled while the active view is showing, without an archived row
 * having been fetched. A Panel-owned project keeps its single read path.
 */

const listTasks = vi.fn();
const listArchivedTasks = vi.fn();
const apiListTasks = vi.fn();

vi.mock("~/lib/panel-bridge", () => ({
  getPanelBridge: () => ({ listTasks, listArchivedTasks }),
}));
vi.mock("~/lib/api", () => ({ api: { listTasks: (id: string) => apiListTasks(id) } }));

const { archivedTasksQueryOptions, queryKeys, tasksQueryOptions } = await import("~/queries");

function snapshot(over: Partial<CoreLinkTaskSnapshot> = {}): CoreLinkTaskSnapshot {
  return {
    taskId: "t1",
    projectId: "p1",
    title: "restock",
    titleManuallySet: false,
    claudeSessionId: null,
    agent: "claude-code",
    status: "running",
    pinned: false,
    archived: false,
    icon: null,
    updatedAt: 1,
    ...over,
  };
}

describe("the archived read path", () => {
  let qc: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it("parks the archived count from the tasks answer where the Archived tab reads it", async () => {
    listTasks.mockResolvedValue({ tasks: [snapshot()], archivedCount: 3 });

    const tasks = await qc.fetchQuery(tasksQueryOptions("p1", { coreId: "core_a" }));

    expect(tasks.map((t) => t.id)).toEqual(["t1"]);
    expect(qc.getQueryData(queryKeys.coreArchivedTaskCount("p1", "core_a"))).toBe(3);
    // Knowing the count cost no archived rows.
    expect(listArchivedTasks).not.toHaveBeenCalled();
  });

  it("keeps each Core's count in its own bucket", async () => {
    listTasks.mockResolvedValueOnce({ tasks: [], archivedCount: 3 });
    listTasks.mockResolvedValueOnce({ tasks: [], archivedCount: 9 });

    await qc.fetchQuery(tasksQueryOptions("p1", { coreId: "core_a" }));
    await qc.fetchQuery(tasksQueryOptions("p1", { coreId: "core_b" }));

    expect(qc.getQueryData(queryKeys.coreArchivedTaskCount("p1", "core_a"))).toBe(3);
    expect(qc.getQueryData(queryKeys.coreArchivedTaskCount("p1", "core_b"))).toBe(9);
  });

  it("parks nothing for a Panel-owned project — its list already carries the rows", async () => {
    apiListTasks.mockResolvedValue({ tasks: [] });

    await qc.fetchQuery(tasksQueryOptions("p1"));

    expect(listTasks).not.toHaveBeenCalled();
    expect(qc.getQueryData(queryKeys.coreArchivedTaskCount("p1", ""))).toBeUndefined();
  });

  it("fetches the archived rows over their own frame, scoped to the project", async () => {
    listArchivedTasks.mockResolvedValue([snapshot({ taskId: "old", archived: true })]);

    const rows = await qc.fetchQuery(
      archivedTasksQueryOptions("p1", { coreId: "core_a", enabled: true }),
    );

    expect(listArchivedTasks).toHaveBeenCalledWith("core_a", "p1");
    expect(rows).toEqual([expect.objectContaining({ id: "old", archived: true })]);
    expect(listTasks).not.toHaveBeenCalled();
  });

  it("keeps the archived rows out of the active list's cache bucket", async () => {
    listTasks.mockResolvedValue({ tasks: [snapshot()], archivedCount: 1 });
    listArchivedTasks.mockResolvedValue([snapshot({ taskId: "old", archived: true })]);

    await qc.fetchQuery(tasksQueryOptions("p1", { coreId: "core_a" }));
    await qc.fetchQuery(archivedTasksQueryOptions("p1", { coreId: "core_a", enabled: true }));

    const active = qc.getQueryData<Array<{ id: string }>>([
      ...queryKeys.tasks("p1"),
      "core",
      "core_a",
    ]);
    expect(active?.map((t) => t.id)).toEqual(["t1"]);
  });

  it("surfaces an unreachable Core as a query error, like the active list does", async () => {
    listArchivedTasks.mockRejectedValue(new Error("core_a is unreachable"));

    await expect(
      qc.fetchQuery(archivedTasksQueryOptions("p1", { coreId: "core_a", enabled: true })),
    ).rejects.toThrow("core_a is unreachable");
  });
});
