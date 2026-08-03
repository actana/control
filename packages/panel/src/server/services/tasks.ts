import { DEFAULT_BRANCH, DEFAULT_TASK_STATUS, isTaskAgent, isTaskStatus } from "@actana/shared/domain";
import type { TaskAgent, TaskStatus } from "@actana/shared/domain";
import type { Task } from "~/db/schema";
import { events } from "../events";
import { clearPendingQuestion } from "./pending-questions";
import { clearSubagentActivity } from "./subagent-activity";
import {
  deleteTaskRow,
  findActiveLocalTasks,
  findTaskById,
  findTasksByProjectId,
  insertTask,
  updateTaskRow,
} from "../repositories/tasks.repo";
import { findProjectNameById } from "../repositories/projects.repo";
import {
  deleteTerminalLogById,
  findTerminalLogsByTaskId,
  insertTerminalLog,
} from "../repositories/terminal-logs.repo";
import { newId } from "./_ids";
import { isClientDomainId } from "@actana/shared/client-id";

export function listTasksForProject(projectId: string): Task[] {
  return findTasksByProjectId(projectId);
}

export function getTask(id: string): Task | null {
  return findTaskById(id);
}

export function createTask(input: {
  id?: string;
  projectId: string;
  title: string;
  agent: TaskAgent;
  status?: TaskStatus;
  preview?: string;
  claudeSessionId?: string | null;
  claudeSkipPermissions?: boolean;
  claudeBareSession?: boolean;
}): Task {
  if (!input.projectId) throw new Error("projectId required");
  if (!input.title?.trim()) throw new Error("title required");
  if (!isTaskAgent(input.agent)) throw new Error("invalid agent");

  const now = Date.now();
  const requestedId = input.id?.trim();
  if (requestedId && !isClientDomainId(requestedId)) throw new Error("invalid task id");
  if (requestedId && findTaskById(requestedId)) throw new Error("task id already exists");
  const row: Task = {
    id: requestedId || newId("t"),
    projectId: input.projectId,
    title: input.title.trim(),
    titleManuallySet: false,
    icon: null,
    agent: input.agent,
    status: input.status ?? DEFAULT_TASK_STATUS,
    branch: DEFAULT_BRANCH,
    preview: input.preview ?? "",
    lines: 0,
    archived: false,
    pinned: false,
    claudeSessionId: input.claudeSessionId ?? null,
    claudeSkipPermissions: input.claudeSkipPermissions ?? false,
    claudeBareSession: input.claudeBareSession ?? false,
    createdAt: now,
    updatedAt: now,
  };
  insertTask(row);
  events.emit("task:created", { id: row.id, projectId: row.projectId });
  return row;
}

export function updateStatus(
  id: string,
  patch: { status?: TaskStatus; preview?: string; lines?: number }
): Task | null {
  if (patch.status && !isTaskStatus(patch.status)) throw new Error("invalid status");
  const existing = findTaskById(id);
  if (!existing) return null;
  const next = {
    ...existing,
    status: patch.status ?? existing.status,
    preview: patch.preview ?? existing.preview,
    lines: patch.lines ?? existing.lines,
    updatedAt: Date.now(),
  };
  updateTaskRow(id, {
    status: next.status,
    preview: next.preview,
    lines: next.lines,
    updatedAt: next.updatedAt,
  });
  events.emit("task:updated", { id, projectId: existing.projectId });
  // Any status transition away from needs-input means the agent moved on, so
  // whatever question was pending is stale (answered, cancelled, interrupted).
  if (patch.status && patch.status !== "needs-input") {
    clearPendingQuestion(id);
  }
  // A dead or detached terminal takes its session's subagents with it; their
  // tracked entries must not hold a future session of this task on "running".
  if (patch.status === "terminated" || patch.status === "disconnected") {
    clearSubagentActivity(id);
  }
  if (
    patch.status === "finished" &&
    existing.status !== "finished"
  ) {
    const projectName = findProjectNameById(existing.projectId);
    events.emit("session:finished", {
      id,
      projectId: existing.projectId,
      projectName: projectName ?? "Project",
      taskTitle: existing.title,
    });
  }
  return next;
}

/**
 * Startup sweep: mark every local-scope task still claiming a live agent
 * process (running / needs-input) as disconnected. Called by the Panel
 * once per app boot, before the first window loads — at that point no local
 * PTYs exist, so any such status is an orphan of a previous run (app quit or
 * crash killed the process before any hook could report). Goes through
 * updateStatus so events fire and stale subagent tracking is dropped.
 */
export function sweepOrphanedActiveTasks(): number {
  const orphans = findActiveLocalTasks();
  for (const t of orphans) {
    updateStatus(t.id, { status: "disconnected" });
  }
  return orphans.length;
}

export function updateTask(
  id: string,
  patch: Partial<
    Pick<
      Task,
      | "title"
      | "titleManuallySet"
      | "icon"
      | "pinned"
      | "claudeSessionId"
      | "claudeSkipPermissions"
      | "claudeBareSession"
    >
  >
): Task | null {
  const existing = findTaskById(id);
  if (!existing) return null;
  const next = { ...existing, ...patch, updatedAt: Date.now() };
  updateTaskRow(id, next);
  events.emit("task:updated", { id, projectId: existing.projectId });
  return next;
}

export function archiveTask(id: string): Task | null {
  const existing = findTaskById(id);
  if (!existing) return null;
  updateTaskRow(id, { archived: true, updatedAt: Date.now() });
  const next = { ...existing, archived: true } as Task;
  clearPendingQuestion(id);
  events.emit("task:archived", { id, projectId: existing.projectId });
  return next;
}

export function restoreTask(id: string): Task | null {
  const existing = findTaskById(id);
  if (!existing) return null;
  updateTaskRow(id, { archived: false, updatedAt: Date.now() });
  const next = { ...existing, archived: false } as Task;
  events.emit("task:restored", { id, projectId: existing.projectId });
  return next;
}

export function deleteTask(id: string): boolean {
  const existing = findTaskById(id);
  if (!existing) return false;
  const changes = deleteTaskRow(id);
  if (changes > 0) {
    clearPendingQuestion(id);
    events.emit("task:deleted", { id, projectId: existing.projectId });
    return true;
  }
  return false;
}

const RING_LIMIT_BYTES = 1_000_000;

export function appendTerminalLog(taskId: string, chunk: string) {
  const id = newId("tl");
  insertTerminalLog({ id, taskId, chunk, createdAt: Date.now() });
  // rough FIFO eviction by total length per task
  const all = findTerminalLogsByTaskId(taskId);
  let total = all.reduce((a, r) => a + r.chunk.length, 0);
  for (const r of all) {
    if (total <= RING_LIMIT_BYTES) break;
    deleteTerminalLogById(r.id);
    total -= r.chunk.length;
  }
}

export function readTerminalLog(taskId: string): string {
  return findTerminalLogsByTaskId(taskId)
    .map((r) => r.chunk)
    .join("");
}
