import { describe, expect, it } from "vitest";
import { BOARD_COLUMNS, columnTasks, taskCountsByCore, tasksForCore } from "../task-board";
import type { TaskDto } from "~/shared/task-wire";

const t = (id: string, status: TaskDto["status"], coreId: string | null, updatedAt = 1): TaskDto => ({
  id, title: id, description: "", status, coreId, agent: null, attemptCount: 0, dispatchedAt: null, lastError: null, createdAt: 1, updatedAt,
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
