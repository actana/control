// Tasks, as the Panel's server and (later) the browser see them (#568, ADR 0041).
//
// A Task is a unit of work for an agent on a Core. Its status moves only along
// the edges in TASK_TRANSITIONS; the server enforces that, the UI only reflects it.

export const TASK_STATUSES = ["draft", "assigned", "in_progress", "done", "failed", "partial"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** The statuses a Task ends in. A finished Task can be assigned again. */
export const FINISHED_TASK_STATUSES = ["done", "failed", "partial"] as const satisfies readonly TaskStatus[];

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

/**
 * Fields the Panel writes into a Task's system comment when it dispatches an
 * attempt (#570 / #676). The Task detail drawer parses the same string to open
 * that attempt's Session — so format and parse must stay a pair.
 */
export type TaskDispatchCommentFields = {
  attempt: number;
  agentName: string;
  harness: string;
  coreId: string;
  sessionId: string;
};

/** The system comment body for one dispatch. Byte-stable: existing Tasks keep their Open session button. */
export function formatTaskDispatchComment(fields: TaskDispatchCommentFields): string {
  return `Dispatched (attempt ${fields.attempt}) to ${fields.agentName} (${fields.harness}) on Core ${fields.coreId}: Session ${fields.sessionId}.`;
}

/**
 * Read attempt, agent, harness, Core and Session out of a dispatch comment.
 * Agent names may contain parentheses; the harness is the last `(…)` before ` on Core`.
 */
export function parseTaskDispatchComment(body: string): TaskDispatchCommentFields | null {
  const m = /^Dispatched \(attempt (\d+)\) to (.+) \(([^)]+)\) on Core (.+): Session (.+)\.$/.exec(body);
  if (!m) return null;
  return {
    attempt: Number(m[1]),
    agentName: m[2]!,
    harness: m[3]!,
    coreId: m[4]!,
    sessionId: m[5]!,
  };
}
