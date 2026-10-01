import { FINISHED_TASK_STATUSES, type TaskStatus } from "~/shared/tasks";
import type { TaskDto } from "~/shared/task-wire";

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
