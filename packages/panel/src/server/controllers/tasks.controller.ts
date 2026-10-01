import { z } from "zod";
import { json, parseJsonBody, rethrowUnlessDomain } from "./_helpers";
import { NotFoundError, ValidationError } from "../errors";
import { HTTP_CREATED } from "~/shared/http-status";
import type { AgentDto, TaskCommentDto, TaskDto } from "~/shared/task-wire";
import {
  addTaskComment,
  changeTaskStatus,
  commentAndReassign,
  createTask,
  getTask,
  listTaskComments,
  listTasks,
  type Task,
  type TaskComment,
} from "../services/tasks";
import { getAgent, listAgentsForCore, type Agent } from "../services/agents";
import { getOperator } from "../services/operator";
import { findCoreById } from "../repositories/cores.repo";

/**
 * Tasks and their comments, for the operator's browser (#571). Every handler
 * takes the owner the session belongs to and passes it to the Tasks and Agents
 * services, which are where the status rules live: a route never decides a
 * move, it asks for one and reports the service's answer (409 when the rules
 * refuse it, 404 for a Task or Agent that is not the owner's).
 */

const newTaskBody = z.object({
  title: z.string(),
  description: z.string().optional(),
  coreId: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
  startNow: z.boolean().optional(),
});
// Only the moves an operator makes by hand. `in_progress` is the dispatcher's claim and
// done, failed and partial are the result watcher's: a client that made them would leave a
// Task running with nothing behind it, or let a re-assign start a second attempt on top of one.
export const OPERATOR_TASK_STATUSES = ["assigned", "draft"] as const;
const statusBody = z.object({ status: z.enum(OPERATOR_TASK_STATUSES) });
const commentBody = z.object({ body: z.string(), reassign: z.boolean().optional() });

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

export async function list(ownerId: number): Promise<Response> {
  return json({ tasks: (await listTasks(ownerId)).map(taskDto) });
}

export async function create(ownerId: number, request: Request): Promise<Response> {
  const body = await parseJsonBody(request, newTaskBody);
  if (!body.ok) return body.response;
  const { title, description, coreId, agent, startNow } = body.data;
  try {
    // The Agent is the chosen Core's: the picker only offers those, and the
    // route holds the same line for a client that skips the picker.
    if (agent) {
      const found = await getAgent(ownerId, agent);
      if (!coreId || found.coreId !== coreId) throw new ValidationError("that Agent is not on the chosen Core");
    }
    if (startNow && (!coreId || !agent)) {
      throw new ValidationError("starting a Task now needs a Core and an Agent");
    }
    const task = await createTask(ownerId, {
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

export async function read(ownerId: number, id: string): Promise<Response> {
  try {
    const task = await getTask(ownerId, id);
    const comments = await listTaskComments(ownerId, id);
    return json({ task: taskDto(task), comments: comments.map(commentDto) });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

/** Assign (`assigned`) or send back to `draft`. Any other status is a 400; the service says whether the move is legal. */
export async function setStatus(ownerId: number, id: string, request: Request): Promise<Response> {
  const body = await parseJsonBody(request, statusBody);
  if (!body.ok) return body.response;
  try {
    return json({ task: taskDto(await changeTaskStatus(ownerId, id, body.data.status)) });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

/** A comment, or with `reassign` the service's single Comment & re-assign call. */
export async function comment(ownerId: number, id: string, request: Request): Promise<Response> {
  const body = await parseJsonBody(request, commentBody);
  if (!body.ok) return body.response;
  try {
    const input = { authorKind: "user" as const, authorName: await authorName(), body: body.data.body };
    if (body.data.reassign) {
      const task = await commentAndReassign(ownerId, id, input);
      return json({ task: taskDto(task), comments: (await listTaskComments(ownerId, id)).map(commentDto) });
    }
    const stored = await addTaskComment(ownerId, id, input);
    return json({ comment: commentDto(stored) }, { status: HTTP_CREATED });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

/** One Core's Agents, from the Agents service. */
export async function listCoreAgents(ownerId: number, coreId: string): Promise<Response> {
  try {
    if (!(await findCoreById(ownerId, coreId))) throw new NotFoundError("core not found");
    return json({ agents: (await listAgentsForCore(ownerId, coreId)).map(agentDto) });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}
