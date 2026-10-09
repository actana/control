// Tasks, Agents and comments as the Panel's browser reads them (#571). The
// server's rows minus the owner: a browser never learns an owner id.

import type { CommentAuthorKind, TaskStatus } from "./tasks";

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
  createdAt: number;
  updatedAt: number;
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
};

export type NewTaskRequest = {
  title: string;
  description?: string;
  coreId?: string | null;
  agent?: string | null;
  /** On: created `assigned`. Off: created `draft`. */
  startNow?: boolean;
};

/** An edit (#722): the fields to change, at least one. Refused while the Task is `in_progress`. */
export type UpdateTaskRequest = {
  title?: string;
  description?: string;
};

export type NewTaskCommentRequest = {
  body: string;
  /** Comment & re-assign: the comment and the move back to `assigned`, in one call. */
  reassign?: boolean;
};
