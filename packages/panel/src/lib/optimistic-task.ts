import type { QueryClient } from "@tanstack/react-query";
import type { Task } from "~/db/schema";
import { DEFAULT_BRANCH, DEFAULT_TASK_STATUS, type TaskAgent } from "@actana/shared/domain";
import { tasksCacheKey } from "~/queries";
import { TITLE_WAITING } from "~/lib/task-sentinels";

export const OPTIMISTIC_TASK_ID_PREFIX = "t-opt-";

export function isOptimisticTaskId(id: string): boolean {
  return id.startsWith(OPTIMISTIC_TASK_ID_PREFIX);
}

export function newOptimisticTaskId(): string {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${OPTIMISTIC_TASK_ID_PREFIX}${suffix}`;
}

export function buildOptimisticTask(input: {
  id?: string;
  projectId: string;
  agent: TaskAgent;
  claudeSessionId?: string | null;
  claudeSkipPermissions?: boolean;
  claudeBareSession?: boolean;
}): Task {
  const now = Date.now();
  return {
    id: input.id ?? newOptimisticTaskId(),
    projectId: input.projectId,
    title: TITLE_WAITING,
    titleManuallySet: false,
    icon: null,
    agent: input.agent,
    status: DEFAULT_TASK_STATUS,
    branch: DEFAULT_BRANCH,
    preview: "",
    lines: 0,
    archived: false,
    pinned: false,
    claudeSessionId: input.claudeSessionId ?? null,
    claudeSkipPermissions: input.claudeSkipPermissions ?? false,
    claudeBareSession: input.claudeBareSession ?? false,
    createdAt: now,
    updatedAt: now,
  };
}

// All helpers accept an optional trailing `coreId` so writes land in the same
// cache bucket the query reads from. A missing `coreId` reads as the Panel's
// own rows via `tasksCacheKey`.
export function removeTaskFromCache(
  queryClient: QueryClient,
  projectId: string,
  taskId: string,
  coreId?: string | null,
) {
  queryClient.setQueryData<Task[]>(
    tasksCacheKey(projectId, coreId),
    (current) => (current ?? []).filter((t) => t.id !== taskId),
  );
}

export function removeTasksFromCache(
  queryClient: QueryClient,
  projectId: string,
  taskIds: Iterable<string>,
  coreId?: string | null,
) {
  const ids = taskIds instanceof Set ? taskIds : new Set(taskIds);
  queryClient.setQueryData<Task[]>(
    tasksCacheKey(projectId, coreId),
    (current) => (current ?? []).filter((t) => !ids.has(t.id)),
  );
}

export function restoreTasksCache(
  queryClient: QueryClient,
  projectId: string,
  tasks: Task[],
  coreId?: string | null,
) {
  queryClient.setQueryData<Task[]>(tasksCacheKey(projectId, coreId), tasks);
}

export function setTaskArchivedInCache(
  queryClient: QueryClient,
  projectId: string,
  taskId: string,
  archived: boolean,
  coreId?: string | null,
) {
  setTasksArchivedInCache(queryClient, projectId, [taskId], archived, coreId);
}

export function setTasksArchivedInCache(
  queryClient: QueryClient,
  projectId: string,
  taskIds: Iterable<string>,
  archived: boolean,
  coreId?: string | null,
) {
  const ids = taskIds instanceof Set ? taskIds : new Set(taskIds);
  queryClient.setQueryData<Task[]>(
    tasksCacheKey(projectId, coreId),
    (current) => (current ?? []).map((t) => (ids.has(t.id) ? { ...t, archived } : t)),
  );
}

export function setTaskPinnedInCache(
  queryClient: QueryClient,
  projectId: string,
  taskId: string,
  pinned: boolean,
  coreId?: string | null,
) {
  queryClient.setQueryData<Task[]>(
    tasksCacheKey(projectId, coreId),
    (current) =>
      (current ?? []).map((t) => (t.id === taskId ? { ...t, pinned, updatedAt: Date.now() } : t)),
  );
}

export function appendOptimisticTask(
  queryClient: QueryClient,
  projectId: string,
  task: Task,
  coreId?: string | null,
) {
  queryClient.setQueryData<Task[]>(
    tasksCacheKey(projectId, coreId),
    (current) => [task, ...(current ?? [])],
  );
}

export function replaceOptimisticTask(
  queryClient: QueryClient,
  projectId: string,
  optimisticId: string,
  task: Task,
  coreId?: string | null,
) {
  queryClient.setQueryData<Task[]>(
    tasksCacheKey(projectId, coreId),
    (current) => {
      const withoutOptimistic = (current ?? []).filter((t) => t.id !== optimisticId);
      if (withoutOptimistic.some((t) => t.id === task.id)) return withoutOptimistic;
      return [task, ...withoutOptimistic];
    },
  );
}

export function removeOptimisticTask(
  queryClient: QueryClient,
  projectId: string,
  optimisticId: string,
  coreId?: string | null,
) {
  removeTaskFromCache(queryClient, projectId, optimisticId, coreId);
}
