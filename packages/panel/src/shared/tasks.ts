// Tasks, as the Panel's server and (later) the browser see them (#568, ADR 0041).
//
// A Task is a unit of work for an agent on a Core. Its status moves only along
// the edges in TASK_TRANSITIONS; the server enforces that, the UI only reflects it.

export const TASK_STATUSES = ["draft", "assigned", "in_progress", "done", "failed", "partial"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** The statuses a Task ends in. A finished Task can be assigned again. */
export const FINISHED_TASK_STATUSES = ["done", "failed", "partial"] as const satisfies readonly TaskStatus[];

/**
 * The statuses a Task's title and description can be edited in, and the ones it
 * can be deleted in (#722). Not `in_progress`: its Session already has the old
 * prompt, and deleting the Task would leave that Session running with nothing to
 * report to.
 */
export const EDITABLE_TASK_STATUSES = ["draft", "assigned", ...FINISHED_TASK_STATUSES] as const satisfies readonly TaskStatus[];
export const DELETABLE_TASK_STATUSES = EDITABLE_TASK_STATUSES;

export function canEditTask(status: TaskStatus): boolean {
  return (EDITABLE_TASK_STATUSES as readonly TaskStatus[]).includes(status);
}

export function canDeleteTask(status: TaskStatus): boolean {
  return (DELETABLE_TASK_STATUSES as readonly TaskStatus[]).includes(status);
}

/** Every legal move, by the status it leaves. Anything not listed here is rejected. */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  draft: ["assigned"],
  assigned: ["draft", "in_progress"],
  in_progress: ["done", "failed", "partial"],
  done: ["assigned"],
  failed: ["assigned"],
  partial: ["assigned"],
};

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

export function canMoveTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/** The statuses a Task may be in for a move to `to` to be legal. */
export function statusesBefore(to: TaskStatus): TaskStatus[] {
  return TASK_STATUSES.filter((from) => canMoveTask(from, to));
}

export const COMMENT_AUTHOR_KINDS = ["user", "agent", "system"] as const;
export type CommentAuthorKind = (typeof COMMENT_AUTHOR_KINDS)[number];
