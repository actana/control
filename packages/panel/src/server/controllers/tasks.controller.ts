import { z } from "zod";
import { TASK_AGENTS, TASK_STATUSES } from "@actana/shared/domain";
import {
  archiveTask,
  createTask,
  deleteTask,
  getTask,
  listTasksForProject,
  restoreTask,
  sweepOrphanedActiveTasks,
  updateStatus,
  updateTask,
} from "../services/tasks";
import { getPendingQuestion } from "../services/pending-questions";
import {
  rethrowUnlessDomain,
  idParam,
  json,
  noContent,
  notFound,
  parseJsonBody,
} from "./_helpers";
import { HTTP_CREATED } from "~/shared/http-status";
import { generateTitleForTask } from "../services/title-generator";

const createTaskBody = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1, "title required"),
  agent: z.enum(TASK_AGENTS),
  status: z.enum(TASK_STATUSES).optional(),
  preview: z.string().optional(),
  claudeSessionId: z.string().nullable().optional(),
  claudeSkipPermissions: z.boolean().optional(),
  claudeBareSession: z.boolean().optional(),
});

const updateTaskBody = z
  .object({
    title: z.string().trim().min(1, "title required"),
    icon: z.string().nullable(),
    pinned: z.boolean(),
    claudeSessionId: z.string().nullable(),
    claudeSkipPermissions: z.boolean(),
    claudeBareSession: z.boolean(),
  })
  .partial();

const updateStatusBody = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  preview: z.string().optional(),
  lines: z.number().optional(),
  prompt: z.string().optional(),
});

export async function listForProject(rawProjectId: string, request: Request): Promise<Response> {
  const parsed = idParam.safeParse(rawProjectId);
  if (!parsed.success) return json({ tasks: [] });
  try {
    return json({ tasks: listTasksForProject(parsed.data) });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

export async function create(rawProjectId: string, request: Request): Promise<Response> {
  const projectIdParsed = idParam.safeParse(rawProjectId);
  if (!projectIdParsed.success) return notFound();
  const parsed = await parseJsonBody(request, createTaskBody);
  if (!parsed.ok) return parsed.response;
  try {
    const t = createTask({
      ...parsed.data,
      projectId: projectIdParsed.data,
    });
    return json({ task: t }, { status: HTTP_CREATED });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

export async function getOne(rawId: string, request: Request): Promise<Response> {
  const parsed = idParam.safeParse(rawId);
  if (!parsed.success) return notFound();
  const t = getTask(parsed.data);
  if (!t) return notFound();
  return json({ task: t });
}

export function readQuestion(rawId: string): Response {
  const parsed = idParam.safeParse(rawId);
  if (!parsed.success) return notFound();
  const t = getTask(parsed.data);
  if (!t) return notFound();
  return json({ question: getPendingQuestion(parsed.data) });
}

export async function update(rawId: string, request: Request): Promise<Response> {
  const idParsed = idParam.safeParse(rawId);
  if (!idParsed.success) return notFound();
  const parsed = await parseJsonBody(request, updateTaskBody);
  if (!parsed.ok) return parsed.response;
  try {
    const patch = Object.prototype.hasOwnProperty.call(parsed.data, "title")
      ? { ...parsed.data, titleManuallySet: true }
      : parsed.data;
    const t = updateTask(idParsed.data, patch);
    if (!t) return notFound();
    return json({ task: t });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

export async function remove(rawId: string, request: Request): Promise<Response> {
  const parsed = idParam.safeParse(rawId);
  if (!parsed.success) return notFound();
  return deleteTask(parsed.data) ? noContent() : notFound();
}

export async function setStatus(rawId: string, request: Request): Promise<Response> {
  const idParsed = idParam.safeParse(rawId);
  if (!idParsed.success) return notFound();
  const parsed = await parseJsonBody(request, updateStatusBody);
  if (!parsed.ok) return parsed.response;
  try {
    const t = updateStatus(idParsed.data, parsed.data);
    if (!t) return notFound();
    const prompt = typeof parsed.data.prompt === "string" ? parsed.data.prompt.trim() : "";
    if (prompt) {
      void generateTitleForTask(idParsed.data, prompt).catch(() => undefined);
    }
    return json({ task: t });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

/**
 * POST /api/tasks/sweep-disconnected — the Panel calls this once per service
 * boot (before the first window) to settle statuses orphaned by the previous
 * run. See sweepOrphanedActiveTasks for the invariant that makes this safe.
 */
export async function sweepDisconnected(): Promise<Response> {
  return json({ swept: sweepOrphanedActiveTasks() });
}

export async function archive(rawId: string, request: Request): Promise<Response> {
  const parsed = idParam.safeParse(rawId);
  if (!parsed.success) return notFound();
  const t = archiveTask(parsed.data);
  if (!t) return notFound();
  return json({ task: t });
}

export async function restore(rawId: string, request: Request): Promise<Response> {
  const parsed = idParam.safeParse(rawId);
  if (!parsed.success) return notFound();
  const t = restoreTask(parsed.data);
  if (!t) return notFound();
  return json({ task: t });
}
