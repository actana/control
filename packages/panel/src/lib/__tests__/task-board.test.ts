import { describe, expect, it } from "vitest";
import { BOARD_COLUMNS, columnTasks, moveInPages, moveInCounts, statusesCount, taskCountsByCore, tasksForCore } from "../task-board";
import type { InfiniteData } from "@tanstack/react-query";
import type { TaskCountsDto, TaskDto, TaskListDto, TasksPageDto } from "~/shared/task-wire";

const t = (id: string, status: TaskDto["status"], coreId: string | null, updatedAt = 1): TaskDto => ({
  id, title: id, description: "", status, coreId, agent: null, attemptCount: 0, dispatchedAt: null, lastError: null, timeoutMinutes: 60, sessionState: null, sessionStateAt: null, createdAt: 1, updatedAt,
});

describe("task board helpers", () => {
  const tasks = [t("a", "draft", "c1"), t("b", "done", "c2"), t("c", "failed", "c1", 5), t("d", "partial", null), t("e", "in_progress", "c1")];

  it("filters to one Core, and null is every Core", () => {
    expect(tasksForCore(tasks, null)).toHaveLength(5);
    expect(tasksForCore(tasks, "c1").map((x) => x.id)).toEqual(["a", "c", "e"]);
  });

  it("counts per Core and leaves a Core-less Task out of every Core's count", () => {
    expect(Object.fromEntries(taskCountsByCore(tasks))).toEqual({ c1: 3, c2: 1 });
  });

  it("puts done, partial and failed in one column, newest first", () => {
    const finished = BOARD_COLUMNS.find((c) => c.id === "finished")!;
    expect(columnTasks(tasks, finished.statuses).map((x) => x.id)).toEqual(["c", "b", "d"]);
  });
});

describe("board counts from the counts endpoint", () => {
  const counts: TaskCountsDto = { byStatus: { draft: 2, done: 3, failed: 1 }, byCore: { c1: { draft: 1, done: 2 } } };
  const finished = BOARD_COLUMNS.find((c) => c.id === "finished")!.statuses;

  it("adds up a column's statuses, and treats an absent one as 0", () => {
    expect(statusesCount(counts, finished, null)).toBe(4);
    expect(statusesCount(counts, ["in_progress"], null)).toBe(0);
  });

  it("counts one Core's Tasks, and 0 for a Core the server does not list", () => {
    expect(statusesCount(counts, finished, "c1")).toBe(2);
    expect(statusesCount(counts, ["draft"], "c9")).toBe(0);
  });

  it("counts every status for All Cores", () => {
    expect(statusesCount(counts, ["draft", "assigned", "in_progress", "done", "failed", "partial"], null)).toBe(6);
  });

  it("moves one Task between statuses, for All Cores and for its Core", () => {
    const next = moveInCounts(counts, { status: "done", coreId: "c1" }, "assigned");
    expect(next.byStatus).toEqual({ draft: 2, done: 2, failed: 1, assigned: 1 });
    expect(next.byCore.c1).toEqual({ draft: 1, done: 1, assigned: 1 });
    expect(counts.byStatus.done).toBe(3);
  });
});

describe("moving a Task in cached pages", () => {
  const slim = (id: string, status: TaskDto["status"]): TaskListDto => {
    const { description: _d, ...rest } = t(id, status, "c1");
    return rest;
  };
  const pages = (...p: TasksPageDto[]): InfiniteData<TasksPageDto, string | null> => ({ pages: p, pageParams: p.map((_, i) => (i ? "x" : null)) });

  it("takes the Task out of whichever page holds it", () => {
    const data = pages({ tasks: [slim("a", "draft")], nextCursor: "n" }, { tasks: [slim("b", "draft")], nextCursor: null });
    const next = moveInPages(data, "b", null)!;
    expect(next.pages.map((p) => p.tasks.map((x) => x.id))).toEqual([["a"], []]);
    expect(next.pages[0]!.nextCursor).toBe("n");
  });

  it("puts a Task on top of the first page", () => {
    const data = pages({ tasks: [slim("a", "assigned")], nextCursor: null });
    const next = moveInPages(data, "z", { ...slim("z", "assigned"), updatedAt: 9 })!;
    expect(next.pages[0]!.tasks.map((x) => x.id)).toEqual(["z", "a"]);
  });

  it("leaves a column that was never loaded alone", () => {
    expect(moveInPages(undefined, "a", slim("a", "draft"))).toBeUndefined();
  });
});
