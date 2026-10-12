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

/** Statuses an operator can stop (#723): a Task whose Session is running. */
export const STOPPABLE_TASK_STATUSES = ["in_progress"] as const satisfies readonly TaskStatus[];

export function canStopTask(status: TaskStatus): boolean {
  return (STOPPABLE_TASK_STATUSES as readonly TaskStatus[]).includes(status);
}

/** The system comment body for a stop: `Stopped by X: reason` or `Stopped by X.` */
export function formatTaskStopComment(f: { stoppedBy: string; reason?: string | null }): string {
  const reason = f.reason?.trim();
  return reason ? `Stopped by ${f.stoppedBy}: ${reason}` : `Stopped by ${f.stoppedBy}.`;
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

export const TASK_TIMEOUT_DEFAULT_MINUTES = 60;
export const TASK_TIMEOUT_MIN_MINUTES = 1;
export const TASK_TIMEOUT_MAX_MINUTES = 43_200; // 30 days
/** The pick cards, in order, before "Custom…" and "No limit". */
export const TASK_TIME_LIMIT_PRESETS = [30, 60, 240, 480, 1440] as const;

/** A Task's time limit per attempt, in minutes (#724). null = No limit. */
export type TaskTimeoutMinutes = number | null;

/** null, or a whole number 1…43200. */
export function isValidTaskTimeoutMinutes(v: unknown): v is TaskTimeoutMinutes {
  if (v === null) return true;
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= TASK_TIMEOUT_MIN_MINUTES &&
    v <= TASK_TIMEOUT_MAX_MINUTES
  );
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** "No limit", "30 min", "90 min", "1 hour", "4 hours", "2 days". */
export function formatTaskTimeLimit(minutes: TaskTimeoutMinutes): string {
  if (minutes === null) return "No limit";
  if (minutes < 60 || minutes % 60 !== 0) return `${minutes} min`;
  if (minutes % 1440 === 0 && minutes > 1440) return plural(minutes / 1440, "day");
  return plural(minutes / 60, "hour");
}

/** "1-minute", "90-minute", "1-hour", "4-hour", "2-day": for "its 4-hour time limit". */
export function formatTaskTimeLimitAdjective(minutes: number): string {
  if (minutes < 60 || minutes % 60 !== 0) return `${minutes}-minute`;
  if (minutes % 1440 === 0 && minutes > 1440) return `${minutes / 1440}-day`;
  return `${minutes / 60}-hour`;
}

/**
 * Why the Panel fails an attempt whose time limit ran out. Keeps "wrote no
 * result within": the dispatcher recognises a timed-out attempt by it.
 */
export function formatTaskTimeoutReason(minutes: number): string {
  return `The agent wrote no result within its ${formatTaskTimeLimitAdjective(minutes)} time limit. To give it longer, change the time limit or set No limit, then run it again.`;
}

/** The system comment body for a changed time limit. */
export function formatTaskTimeLimitChangeComment(f: {
  from: TaskTimeoutMinutes;
  to: TaskTimeoutMinutes;
  changedBy: string;
}): string {
  return `Time limit changed from ${formatTaskTimeLimit(f.from)} to ${formatTaskTimeLimit(f.to)} by ${f.changedBy}.`;
}
