// Tasks, Agents and comments as the Panel's browser reads them (#571). The
// server's rows minus the owner: a browser never learns an owner id.

import { isTaskSessionState, type CommentAuthorKind, type TaskSessionState, type TaskStatus } from "./tasks";

export type TaskDto = {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  coreId: string | null;
  /** An Agent id (`agents.id`), or null while a draft has none yet. */
  agent: string | null;
  attemptCount: number;
  dispatchedAt: number | null;
  lastError: string | null;
  /** Why an `assigned` Task is not running yet and on which Core (#962); null when it is not waiting (the Panel and the API always send it). */
  waiting?: { reason: string; coreId: string | null } | null;
  /** The time limit per attempt in minutes (#724); null = No limit. */
  timeoutMinutes: number | null;
  /** What the Session of the running attempt is doing (#949); null when no attempt runs. Never moves `status`. */
  sessionState: TaskSessionState | null;
  /** When `sessionState` last changed (epoch ms); null with it. */
  sessionStateAt: number | null;
  createdAt: number;
  updatedAt: number;
};

/** A stored Session state as the wire carries it: a value this version does not know is null. */
export function toSessionState(v: string | null): TaskSessionState | null {
  return isTaskSessionState(v) ? v : null;
}

/** A Task as a paged list carries it (#896): everything but `description`, which can be large. */
export type TaskListDto = Omit<TaskDto, "description">;

/** One page of Tasks, newest update first. `nextCursor` is opaque; null on the last page. */
export type TasksPageDto = {
  tasks: TaskListDto[];
  nextCursor: string | null;
};

/** Task counts per status (a status with no Task is absent) and, for Tasks that have a Core, per Core id. */
export type TaskCountsDto = {
  byStatus: Partial<Record<TaskStatus, number>>;
  byCore: Record<string, Partial<Record<TaskStatus, number>>>;
};

export type TaskCommentDto = {
  id: string;
  taskId: string;
  authorKind: CommentAuthorKind;
  authorName: string;
  /** The result file an agent comment came from, if it came from one. */
  sourceFile: string | null;
  body: string;
  createdAt: number;
};

export type AgentDto = {
  id: string;
  coreId: string;
  name: string;
  harness: string;
  model: string | null;
  isDefault: boolean;
  /** The Panel's own Agent routes carry the flags (the edit form starts from them); the public v1 shape does not. */
  flags?: string[];
};

export type NewTaskRequest = {
  title: string;
  description?: string;
  coreId?: string | null;
  agent?: string | null;
  /** On: created `assigned`. Off: created `draft`. */
  startNow?: boolean;
  /** Minutes per attempt, 1 to 43200 (#724). Omitted: 60. null: No limit. */
  timeoutMinutes?: number | null;
};

/**
 * An edit (#722): the fields to change, at least one. The title and description
 * are refused while the Task is `in_progress`; the time limit (#724) is allowed
 * at any status.
 */
export type UpdateTaskRequest = {
  title?: string;
  description?: string;
  timeoutMinutes?: number | null;
};

export type NewTaskCommentRequest = {
  body: string;
  /** Comment & re-assign: the comment and the move back to `assigned`, in one call. */
  reassign?: boolean;
  /** `now`: also type the comment into the Task's running Session (#935). Without it the comment is a note. */
  deliver?: "now";
};

/** What became of a comment's delivery into the Task's Session (#935): typed, or kept as a note with the reason. */
export type TaskCommentDelivery = { mode: "now"; delivered: boolean; reason?: string };

/** Stop a running Task (#723). */
export type StopTaskRequest = { reason?: string };

export type TaskSessionStopOutcome = "stopped" | "not-running" | "unreachable" | "failed";

export type TaskSessionStopDto = {
  coreId: string;
  sessionId: string;
  outcome: TaskSessionStopOutcome;
  detail: string | null;
};

export type StopTaskResponse = { task: TaskDto; session: TaskSessionStopDto | null };
