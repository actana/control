// Tasks, as the Panel's server and (later) the browser see them (#568, ADR 0041).
//
// A Task is a unit of work for an agent on a Core. Its status moves only along
// the edges in TASK_TRANSITIONS; the server enforces that, the UI only reflects it.

export const TASK_STATUSES = ["draft", "assigned", "in_progress", "done", "failed", "partial"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** The statuses a Task ends in. A finished Task can be assigned again. */
export const FINISHED_TASK_STATUSES = ["done", "failed", "partial"] as const satisfies readonly TaskStatus[];

/**
 * The Tasks board's columns (#896). A column is one status, except `finished`,
 * which holds every status a Task ends in.
 */
export const TASK_COLUMNS = ["draft", "assigned", "in_progress", "finished"] as const;
export type TaskColumn = (typeof TASK_COLUMNS)[number];
export const TASK_COLUMN_STATUSES: Record<TaskColumn, readonly TaskStatus[]> = {
  draft: ["draft"],
  assigned: ["assigned"],
  in_progress: ["in_progress"],
  finished: FINISHED_TASK_STATUSES,
};

/** A page of Tasks: the board asks for 10, a caller may ask for up to 100. */
export const TASKS_PAGE_DEFAULT_LIMIT = 10;
export const TASKS_PAGE_MAX_LIMIT = 100;

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

/**
 * What a Task's Session is doing (#949). Set while an attempt runs, `null` when none does. It never moves a
 * Task's `status`: the result file stays the only success signal. Shared contract with the Studio twin; keep
 * the names word for word.
 */
export const TASK_SESSION_STATES = ["working", "needs-input", "interrupted", "idle-no-result", "exited"] as const;
export type TaskSessionState = (typeof TASK_SESSION_STATES)[number];

export function isTaskSessionState(v: unknown): v is TaskSessionState {
  return typeof v === "string" && (TASK_SESSION_STATES as readonly string[]).includes(v);
}

/**
 * The Session state for a Core Session status: `running` is `working`; `needs-input` and `interrupted` keep
 * their names; `finished` is `idle-no-result` (a Session that finished with a complete result file ends its
 * Task, which clears the state); `terminated` and `disconnected` are `exited`. Any other status is null.
 */
export function sessionStateForCoreStatus(status: string): TaskSessionState | null {
  switch (status) {
    case "running":
      return "working";
    case "needs-input":
      return "needs-input";
    case "interrupted":
      return "interrupted";
    case "finished":
      return "idle-no-result";
    case "terminated":
    case "disconnected":
      return "exited";
    default:
      return null;
  }
}

const SESSION_STATE_COMMENTS: Partial<Record<TaskSessionState, string>> = {
  "needs-input": "The agent's Session needs input (it is waiting at a prompt).",
  interrupted: "The agent's Session was interrupted.",
  "idle-no-result": "The agent's Session finished its turn without writing a result file.",
};

/**
 * The system comment for a change of Session state, or null when the change gets none: one comment per change
 * into `needs-input`, `interrupted` or `idle-no-result`, and one when the Session is `working` again after one
 * of them. Everything else, `working` to `working` and `exited` included, is silent.
 */
export function formatTaskSessionStateComment(from: TaskSessionState | null, to: TaskSessionState): string | null {
  if (from === to) return null;
  const into = SESSION_STATE_COMMENTS[to];
  if (into) return into;
  if (to === "working" && from !== null && SESSION_STATE_COMMENTS[from]) return "The agent's Session is working again.";
  return null;
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

/**
 * The charset of a Core id and a Session id in a dispatch comment (#680). Both come from outside the
 * Panel (a Core names its own Sessions) and are read back out of prose, so anything that could carry
 * the comment's own separators (spaces, colons, parentheses, dots) is not an id.
 */
const TASK_DISPATCH_ID = /^[\w-]+$/;

export function isTaskDispatchId(value: string): boolean {
  return TASK_DISPATCH_ID.test(value);
}

/**
 * The system comment body for one dispatch. Byte-stable: existing Tasks keep their Open session button.
 * Throws when the Core id or Session id is outside the id charset, rather than writing a comment that
 * could name another Core's Session.
 */
export function formatTaskDispatchComment(fields: TaskDispatchCommentFields): string {
  if (!isTaskDispatchId(fields.coreId)) throw new Error("the Core id is not a valid id (letters, digits, _ and - only)");
  if (!isTaskDispatchId(fields.sessionId)) throw new Error("the Session id is not a valid id (letters, digits, _ and - only)");
  return `Dispatched (attempt ${fields.attempt}) to ${fields.agentName} (${fields.harness}) on Core ${fields.coreId}: Session ${fields.sessionId}.`;
}

/**
 * Read attempt, agent, harness, Core and Session out of a dispatch comment.
 * Agent names may contain parentheses; the harness is the last `(…)` before ` on Core`.
 * Core id and Session id are only ever read as `[\w-]+`, and the agent name may not contain
 * the whole separator ` on Core <id>: Session `, so text inside a name cannot pose as the Core
 * and Session (#680). A name may still contain ` on Core ` on its own. A comment that
 * does not fit returns null.
 */
export function parseTaskDispatchComment(body: string): TaskDispatchCommentFields | null {
  const m = /^Dispatched \(attempt (\d+)\) to ((?:(?! on Core [\w-]+: Session ).)+) \(([^)]+)\) on Core ([\w-]+): Session ([\w-]+)\.$/.exec(body);
  if (!m) return null;
  return {
    attempt: Number(m[1]),
    agentName: m[2]!,
    harness: m[3]!,
    coreId: m[4]!,
    sessionId: m[5]!,
  };
}

/**
 * The system comment for an attempt that went to the Task's own Session again (#955): `Resumed Session <id> (attempt <n>)`.
 * It names no Core, Agent or harness: those are the ones of the dispatch comment that started that Session
 * ({@link resolveAttemptSessions} reads them from there).
 */
export type TaskResumeCommentFields = { attempt: number; sessionId: string };

export function formatTaskResumeComment(fields: TaskResumeCommentFields): string {
  if (!isTaskDispatchId(fields.sessionId)) throw new Error("the Session id is not a valid id (letters, digits, _ and - only)");
  return `Resumed Session ${fields.sessionId} (attempt ${fields.attempt})`;
}

export function parseTaskResumeComment(body: string): TaskResumeCommentFields | null {
  const m = /^Resumed Session ([\w-]+) \(attempt (\d+)\)$/.exec(body);
  return m ? { attempt: Number(m[2]), sessionId: m[1]! } : null;
}

/** The Session one attempt ran in, as the Panel's own system comments say. */
export type TaskAttemptSession = {
  /** Where the comment sits in the list given. */
  index: number;
  attempt: number;
  sessionId: string;
  coreId: string;
  agentName: string | null;
  harness: string | null;
  /** The attempt resumed an earlier Session instead of starting one. */
  resumed: boolean;
};

/**
 * Every attempt's Session, oldest first, from a Task's comments (system ones only: a user or agent comment that
 * looks like a dispatch comment is not one). A `Resumed Session` comment has no Core, so it takes the Core, Agent
 * and harness of the latest earlier comment that named the same Session; with none it is skipped.
 */
export function resolveAttemptSessions(comments: readonly { authorKind: string; body: string }[]): TaskAttemptSession[] {
  const out: TaskAttemptSession[] = [];
  comments.forEach((c, index) => {
    if (c.authorKind !== "system") return;
    const dispatched = parseTaskDispatchComment(c.body);
    if (dispatched) {
      out.push({ index, attempt: dispatched.attempt, sessionId: dispatched.sessionId, coreId: dispatched.coreId, agentName: dispatched.agentName, harness: dispatched.harness, resumed: false });
      return;
    }
    const resumed = parseTaskResumeComment(c.body);
    if (!resumed) return;
    const origin = [...out].reverse().find((s) => s.sessionId === resumed.sessionId);
    if (origin) out.push({ ...origin, index, attempt: resumed.attempt, resumed: true });
  });
  return out;
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

/** Read the limits (as written, e.g. "1 hour") and who changed it out of a time-limit change comment. */
export function parseTaskTimeLimitChangeComment(body: string): { from: string; to: string; changedBy: string } | null {
  const m = /^Time limit changed from (No limit|\d+ (?:min|hours?|days?)) to (No limit|\d+ (?:min|hours?|days?)) by (.+)\.$/.exec(body);
  return m ? { from: m[1]!, to: m[2]!, changedBy: m[3]! } : null;
}

/** "40 min", "2 h 51 min", "3 h": time left on a running attempt. */
export function formatTaskTimeLeft(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${rest} min`;
}

/**
 * An `assigned` Task that is not being started says why in its `lastError`, always starting with this (#962):
 * `waiting: Core full (8/8)`, `waiting: Core not connected`, `waiting: Harness not ready (...)`. No other error starts so.
 */
export const TASK_WAITING_PREFIX = "waiting: ";

/** The reason an `assigned` Task is waiting, or null (not assigned, or its `lastError` is an earlier failure). */
export function taskWaitingReason(task: { status: string; lastError: string | null }): string | null {
  return task.status === "assigned" && task.lastError?.startsWith(TASK_WAITING_PREFIX) ? task.lastError : null;
}
