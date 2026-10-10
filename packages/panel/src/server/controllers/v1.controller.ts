import { z } from "zod";
import { forbidden, json, noContent, notFound, parseJsonBody, rethrowUnlessDomain } from "./_helpers";
import { NotFoundError, ValidationError } from "../errors";
import { HTTP_CREATED } from "~/shared/http-status";
import type { ApiPrincipal } from "../api-key-auth";
import { scopeReaches } from "../services/api-keys";
import { getCore, listCores } from "../services/cores";
import { coreLinkManager } from "../services/core-link-manager";
import type { Core, CoreWithDial } from "~/shared/cores";
import type { AgentDto, TaskCommentDto, TaskDto } from "~/shared/task-wire";
import {
  addTaskComment,
  changeTaskStatus,
  commentAndReassign,
  createTask,
  deleteTask,
  getTask,
  listTaskComments,
  listTasks,
  updateTask,
  type Task,
  type TaskComment,
} from "../services/tasks";
import {
  createAgent,
  deleteAgent,
  getAgent,
  listAgents,
  listAgentsForCore,
  type Agent,
} from "../services/agents";
import { getOperator } from "../services/operator";
import { findCoreById } from "../repositories/cores.repo";
import { HARNESSES } from "~/shared/agents";
import { OPERATOR_TASK_STATUSES, updateTaskBody } from "./tasks.controller";

/**
 * The public REST API under `/api/v1` (#572 PR 2). Every handler takes the
 * principal the gate already resolved: a key's calls run as the key's owner
 * and see only the Cores in that key's scope; a session call sees the Owner's
 * whole fleet. Status moves go through the Tasks service, and a key client may
 * only ask for the operator moves `assigned` and `draft` (same line as #630).
 * Edits and deletes (#722) go through the same service, which refuses both
 * while the Task is `in_progress`.
 */

const newTaskBody = z.object({
  title: z.string(),
  description: z.string().optional(),
  coreId: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
  startNow: z.boolean().optional(),
});
const statusBody = z.object({ status: z.enum(OPERATOR_TASK_STATUSES) });
const commentBody = z.object({ body: z.string(), reassign: z.boolean().optional() });
const newAgentBody = z.object({
  coreId: z.string(),
  name: z.string(),
  harness: z.enum(HARNESSES),
  model: z.string().nullable().optional(),
  flags: z.array(z.string()).optional(),
});

function withDial(core: Core): CoreWithDial {
  return { ...core, dial: coreLinkManager().status(core.id) };
}

function taskDto(t: Task): TaskDto {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status as TaskDto["status"],
    coreId: t.coreId,
    agent: t.agent,
    attemptCount: t.attemptCount,
    dispatchedAt: t.dispatchedAt,
    lastError: t.lastError,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

function commentDto(c: TaskComment): TaskCommentDto {
  return {
    id: c.id,
    taskId: c.taskId,
    authorKind: c.authorKind as TaskCommentDto["authorKind"],
    authorName: c.authorName,
    sourceFile: c.sourceFile,
    body: c.body,
    createdAt: c.createdAt,
  };
}

function agentDto(a: Agent): AgentDto {
  return { id: a.id, coreId: a.coreId, name: a.name, harness: a.harness, model: a.model, isDefault: a.isDefault };
}

async function authorName(): Promise<string> {
  return (await getOperator())?.name?.trim() || "operator";
}

/**
 * A key outside a Core's scope gets 403 whether or not the resource exists on
 * that Core, so it learns nothing about it. A Task or Agent with no Core is
 * only visible to an unrestricted key (or a session).
 */
function refuseOutsideScope(principal: ApiPrincipal, coreId: string | null): Response | null {
  if (principal.kind !== "api-key") return null;
  if (coreId === null) {
    return principal.scope.allCores ? null : forbidden("this API key does not reach that Core");
  }
  if (!scopeReaches(principal.scope, coreId)) {
    return forbidden("this API key does not reach that Core");
  }
  return null;
}

function inScope(principal: ApiPrincipal, coreId: string | null): boolean {
  return refuseOutsideScope(principal, coreId) === null;
}

// ── Cores ──────────────────────────────────────────────────────────────────

export async function listCoresV1(principal: ApiPrincipal): Promise<Response> {
  const all = await listCores(principal.ownerId);
  const visible = principal.kind === "api-key" ? all.filter((c) => scopeReaches(principal.scope, c.id)) : all;
  return json({ cores: visible.map(withDial) });
}

export async function getCoreV1(id: string, principal: ApiPrincipal): Promise<Response> {
  const denied = refuseOutsideScope(principal, id);
  if (denied) return denied;
  const core = await getCore(id, principal.ownerId);
  if (!core) return notFound("no such Core");
  return json({ core: withDial(core) });
}

// ── Agents ─────────────────────────────────────────────────────────────────

export async function listAgentsV1(principal: ApiPrincipal): Promise<Response> {
  const all = await listAgents(principal.ownerId);
  return json({ agents: all.filter((a) => inScope(principal, a.coreId)).map(agentDto) });
}

export async function listCoreAgentsV1(principal: ApiPrincipal, coreId: string): Promise<Response> {
  const denied = refuseOutsideScope(principal, coreId);
  if (denied) return denied;
  try {
    if (!(await findCoreById(principal.ownerId, coreId))) throw new NotFoundError("core not found");
    return json({ agents: (await listAgentsForCore(principal.ownerId, coreId)).map(agentDto) });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

export async function getAgentV1(principal: ApiPrincipal, id: string): Promise<Response> {
  try {
    const agent = await getAgent(principal.ownerId, id);
    const denied = refuseOutsideScope(principal, agent.coreId);
    if (denied) return denied;
    return json({ agent: agentDto(agent) });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

export async function createAgentV1(principal: ApiPrincipal, request: Request): Promise<Response> {
  const body = await parseJsonBody(request, newAgentBody);
  if (!body.ok) return body.response;
  const denied = refuseOutsideScope(principal, body.data.coreId);
  if (denied) return denied;
  try {
    const agent = await createAgent(principal.ownerId, {
      coreId: body.data.coreId,
      name: body.data.name,
      harness: body.data.harness,
      ...(body.data.model === undefined ? {} : { model: body.data.model }),
      ...(body.data.flags === undefined ? {} : { flags: body.data.flags }),
    });
    return json({ agent: agentDto(agent) }, { status: HTTP_CREATED });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

export async function deleteAgentV1(principal: ApiPrincipal, id: string): Promise<Response> {
  try {
    const agent = await getAgent(principal.ownerId, id);
    const denied = refuseOutsideScope(principal, agent.coreId);
    if (denied) return denied;
    await deleteAgent(principal.ownerId, id);
    return noContent();
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

// ── Tasks ──────────────────────────────────────────────────────────────────

export async function listTasksV1(principal: ApiPrincipal): Promise<Response> {
  const all = await listTasks(principal.ownerId);
  return json({ tasks: all.filter((t) => inScope(principal, t.coreId)).map(taskDto) });
}

export async function createTaskV1(principal: ApiPrincipal, request: Request): Promise<Response> {
  const body = await parseJsonBody(request, newTaskBody);
  if (!body.ok) return body.response;
  const { title, description, coreId, agent, startNow } = body.data;
  const denied = refuseOutsideScope(principal, coreId ?? null);
  if (denied) return denied;
  try {
    if (agent) {
      const found = await getAgent(principal.ownerId, agent);
      if (!coreId || found.coreId !== coreId) throw new ValidationError("that Agent is not on the chosen Core");
      const agentDenied = refuseOutsideScope(principal, found.coreId);
      if (agentDenied) return agentDenied;
    }
    if (startNow && (!coreId || !agent)) {
      throw new ValidationError("starting a Task now needs a Core and an Agent");
    }
    const task = await createTask(principal.ownerId, {
      title,
      ...(description === undefined ? {} : { description }),
      coreId: coreId ?? null,
      agent: agent ?? null,
      startNow: startNow === true,
    });
    return json({ task: taskDto(task) }, { status: HTTP_CREATED });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

export async function getTaskV1(principal: ApiPrincipal, id: string): Promise<Response> {
  try {
    const task = await getTask(principal.ownerId, id);
    const denied = refuseOutsideScope(principal, task.coreId);
    if (denied) return denied;
    const comments = await listTaskComments(principal.ownerId, id);
    return json({ task: taskDto(task), comments: comments.map(commentDto) });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

export async function setTaskStatusV1(principal: ApiPrincipal, id: string, request: Request): Promise<Response> {
  const body = await parseJsonBody(request, statusBody);
  if (!body.ok) return body.response;
  try {
    const task = await getTask(principal.ownerId, id);
    const denied = refuseOutsideScope(principal, task.coreId);
    if (denied) return denied;
    return json({ task: taskDto(await changeTaskStatus(principal.ownerId, id, body.data.status)) });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

/** `PATCH /api/v1/tasks/:id` (#722): title and description; 409 while the Task is `in_progress`. */
export async function updateTaskV1(principal: ApiPrincipal, id: string, request: Request): Promise<Response> {
  const body = await parseJsonBody(request, updateTaskBody);
  if (!body.ok) return body.response;
  try {
    const task = await getTask(principal.ownerId, id);
    const denied = refuseOutsideScope(principal, task.coreId);
    if (denied) return denied;
    return json({ task: taskDto(await updateTask(principal.ownerId, id, body.data)) });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

/** `DELETE /api/v1/tasks/:id` (#722): 204, or 409 while the Task is `in_progress`. */
export async function deleteTaskV1(principal: ApiPrincipal, id: string): Promise<Response> {
  try {
    const task = await getTask(principal.ownerId, id);
    const denied = refuseOutsideScope(principal, task.coreId);
    if (denied) return denied;
    await deleteTask(principal.ownerId, id);
    return noContent();
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

export async function listTaskCommentsV1(principal: ApiPrincipal, id: string): Promise<Response> {
  try {
    const task = await getTask(principal.ownerId, id);
    const denied = refuseOutsideScope(principal, task.coreId);
    if (denied) return denied;
    return json({ comments: (await listTaskComments(principal.ownerId, id)).map(commentDto) });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

export async function addTaskCommentV1(principal: ApiPrincipal, id: string, request: Request): Promise<Response> {
  const body = await parseJsonBody(request, commentBody);
  if (!body.ok) return body.response;
  try {
    const task = await getTask(principal.ownerId, id);
    const denied = refuseOutsideScope(principal, task.coreId);
    if (denied) return denied;
    const input = { authorKind: "user" as const, authorName: await authorName(), body: body.data.body };
    if (body.data.reassign) {
      const updated = await commentAndReassign(principal.ownerId, id, input);
      return json({ task: taskDto(updated), comments: (await listTaskComments(principal.ownerId, id)).map(commentDto) });
    }
    const stored = await addTaskComment(principal.ownerId, id, input);
    return json({ comment: commentDto(stored) }, { status: HTTP_CREATED });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}
