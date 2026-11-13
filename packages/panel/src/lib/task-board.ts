import { FINISHED_TASK_STATUSES, type TaskStatus } from "~/shared/tasks";
import type { InfiniteData } from "@tanstack/react-query";
import type { TaskCountsDto, TaskDto, TaskListDto, TasksPageDto } from "~/shared/task-wire";

/** The board's four columns (screen 06). Finished, Partial and Failed share the last one. */
export const BOARD_COLUMNS: readonly {
  id: "draft" | "assigned" | "in_progress" | "finished";
  label: string;
  statuses: readonly TaskStatus[];
  color: string;
}[] = [
  { id: "draft", label: "Draft", statuses: ["draft"], color: "var(--text-dim)" },
  { id: "assigned", label: "Assigned", statuses: ["assigned"], color: "var(--brand-accent)" },
  { id: "in_progress", label: "In progress", statuses: ["in_progress"], color: "var(--warning)" },
  { id: "finished", label: "Finished · Partial · Failed", statuses: FINISHED_TASK_STATUSES, color: "var(--text-success)" },
];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  draft: "Draft",
  assigned: "Assigned",
  in_progress: "In progress",
  done: "Done",
  failed: "Failed",
  partial: "Partial",
};

/** The Tasks a board shows: all of them, or one Core's (`coreId` null is "All Cores"). */
export function tasksForCore(tasks: readonly TaskDto[], coreId: string | null): TaskDto[] {
  return coreId === null ? [...tasks] : tasks.filter((t) => t.coreId === coreId);
}

/** Count per Core for the filter chips; a Task with no Core yet counts only toward All. */
export function taskCountsByCore(tasks: readonly TaskDto[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tasks) if (t.coreId) counts.set(t.coreId, (counts.get(t.coreId) ?? 0) + 1);
  return counts;
}

/** Newest first inside a column, as the service lists them. */
export function columnTasks(tasks: readonly TaskDto[], statuses: readonly TaskStatus[]): TaskDto[] {
  return tasks.filter((t) => statuses.includes(t.status)).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A column's (or the chips') count from the counts endpoint: a status or Core it does not list has none. `coreId` null is All Cores. */
export function statusesCount(counts: TaskCountsDto, statuses: readonly TaskStatus[], coreId: string | null): number {
  const by = coreId === null ? counts.byStatus : (counts.byCore[coreId] ?? {});
  return statuses.reduce((sum, s) => sum + (by[s] ?? 0), 0);
}

/** The counts after a Task changes status, for the optimistic move; the refetch after it replaces them. */
export function moveInCounts(counts: TaskCountsDto, task: Pick<TaskDto, "status" | "coreId">, to: TaskStatus): TaskCountsDto {
  const shift = (by: Partial<Record<TaskStatus, number>>) => {
    const next = { ...by, [task.status]: Math.max(0, (by[task.status] ?? 0) - 1) };
    next[to] = (next[to] ?? 0) + 1;
    return next;
  };
  return {
    byStatus: shift(counts.byStatus),
    byCore: task.coreId ? { ...counts.byCore, [task.coreId]: shift(counts.byCore[task.coreId] ?? {}) } : counts.byCore,
  };
}

/** A column's cached pages without Task `id`, and with `add` (if given) on top of the first page. A column never loaded stays unloaded. */
export function moveInPages(
  data: InfiniteData<TasksPageDto, string | null> | undefined,
  id: string,
  add: TaskListDto | null,
): InfiniteData<TasksPageDto, string | null> | undefined {
  if (!data) return data;
  const pages = data.pages.map((p, i) => {
    const tasks = p.tasks.filter((t) => t.id !== id);
    return { ...p, tasks: i === 0 && add ? [add, ...tasks] : tasks };
  });
  return { ...data, pages };
}
