import { TASK_COLUMN_STATUSES, TASKS_PAGE_DEFAULT_LIMIT, type TaskColumn, type TaskStatus } from "~/shared/tasks";
import type { TaskCountsDto, TaskDto, TasksPageDto } from "~/shared/task-wire";

// What the Tasks API answers for the board tests (#896), computed from the
// Tasks a test holds: a page is the column's Tasks, newest update first, cut
// at `limit`; the cursor is the offset (opaque to the client, as the real one is).

export type PageQuery = { column: TaskColumn; coreId?: string | null; limit?: number; cursor?: string | null };

export function fakeTasksPage(tasks: readonly TaskDto[], q: PageQuery): TasksPageDto {
  const statuses = TASK_COLUMN_STATUSES[q.column];
  const rows = tasks
    .filter((t) => statuses.includes(t.status) && (!q.coreId || t.coreId === q.coreId))
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));
  const from = q.cursor ? Number(q.cursor) : 0;
  const limit = q.limit ?? TASKS_PAGE_DEFAULT_LIMIT;
  const page = rows.slice(from, from + limit).map(({ description: _description, ...slim }) => slim);
  return { tasks: page, nextCursor: from + limit < rows.length ? String(from + limit) : null };
}

/** Sparse, as the server answers: a status or Core with no Task is absent. */
export function fakeTaskCounts(tasks: readonly TaskDto[]): TaskCountsDto {
  const byStatus: Partial<Record<TaskStatus, number>> = {};
  const byCore: Record<string, Partial<Record<TaskStatus, number>>> = {};
  for (const t of tasks) {
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    if (t.coreId) {
      const c = (byCore[t.coreId] ??= {});
      c[t.status] = (c[t.status] ?? 0) + 1;
    }
  }
  return { byStatus, byCore };
}
