import { z } from "zod";
import { forbidden, json, noContent, notFound, parseJsonBody, rethrowUnlessDomain } from "./_helpers";
import { NotFoundError, ValidationError } from "../errors";
import { HTTP_BAD_GATEWAY, HTTP_CONFLICT, HTTP_CREATED, HTTP_SERVICE_UNAVAILABLE } from "~/shared/http-status";
import { jsonError } from "../http-responses";
import type { SessionsPageDto } from "~/shared/session-wire";
import {
  InvalidSessionPageError,
  SESSION_PAGE_MAX,
  SESSION_STATUS_FILTERS,
  decodeSessionCursor,
  type SessionStatusFilter,
} from "@actana/shared/session-paging";
import type { ApiPrincipal } from "../api-key-auth";
import { closeSession, queuedAnswer, stopTask } from "../task-dispatch";
import { stopTaskBody } from "./tasks.controller";
import { scopeReaches } from "../services/api-keys";
import { getCore, listCores } from "../services/cores";
import { readCoreCapacity } from "../services/core-capacity";
import { coreLinkManager } from "../services/core-link-manager";
import type { Core, CoreWithDial } from "~/shared/cores";
import { toSessionState, type AgentDto, type TaskCommentDto, type TaskDto, type TasksPageDto } from "~/shared/task-wire";
import { TASK_SESSION_STATES, isTaskSessionState, taskWaitingReason, type TaskSessionState, type TaskStatus } from "~/shared/tasks";
import {
  nextAttemptWatchExpiresAt,
  nextAttemptWatchToken,
  pollAfterSeconds,
  taskWatchToken,
  taskWatchUrl,
  watchExpiresAt,
} from "../services/task-watch";
import {
  addTaskComment,
  changeTaskStatus,
  commentAndReassign,
  createTask,
  deleteTask,
  getTask,
  listTaskComments,
  listTasks,
  listTasksPage,
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
  updateAgent,
  CoreHarnessesUnavailableError,
  HarnessMissingOnCoreError,
  HarnessNotReadyError,
  type Agent,
} from "../services/agents";
import { getOperator } from "../services/operator";
import { findCoreById } from "../repositories/cores.repo";
import { HARNESSES } from "~/shared/agents";
import { OPERATOR_TASK_STATUSES, taskListDto, timeoutMinutesSchema, updateTaskBody } from "./tasks.controller";

/**
 * The public REST API under `/api/v1` (#572 PR 2). Every handler takes the
 * principal the gate already resolved: a key's calls run as the key's owner
 * and see only the Cores in that key's scope; a session call sees the Owner's
 * whole fleet. Status moves go through the Tasks service, and a key client may
 * only ask for the operator moves `assigned` and `draft` (same line as #630).
 * Edits and deletes (#722) go through the same service, which refuses both
 * while the Task is `in_progress`; the exception is the time limit (#724,
 * `timeoutMinutes`), which a PATCH may change at any status.
 */

const newTaskBody = z.object({
  title: z.string(),
  description: z.string().optional(),
  coreId: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
  startNow: z.boolean().optional(),
  timeoutMinutes: timeoutMinutesSchema.optional(),
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

/**
 * The change an Agent takes. Loose on purpose: a field that is not one of these
 * (a harness, a Core, a command) reaches the service, which refuses it by name,
 * rather than being dropped here and looking like it worked.
 */
export const agentChangesBody = z.looseObject({
  name: z.string().optional(),
  model: z.string().nullable().optional(),
  flags: z.array(z.string()).optional(),
});

async function withCapacity(core: Core): Promise<CoreWithDial> {
  return { ...withDial(core), ...(await readCoreCapacity(core.id)) };
}

function withDial(core: Core): CoreWithDial {
  return { ...core, dial: coreLinkManager().status(core.id) };
}

function waitingOf(t: Task): TaskDto["waiting"] {
  const reason = taskWaitingReason(t);
  return reason === null ? null : { reason, coreId: t.coreId };
}

/**
 * The status URL of a queued (`assigned`) or running attempt (#951), built with #950's own token and URL helpers. `origin` is the
 * Panel's own (the request's); `AC_PANEL_PUBLIC_URL` wins when set.
 */
function watchOf(t: Task, origin: string): NonNullable<V1TaskDto["watch"]> {
  const now = Date.now();
  if (t.status === "assigned") {
    return {
      url: taskWatchUrl(nextAttemptWatchToken(t, now), origin),
      expiresAt: nextAttemptWatchExpiresAt(t, now),
      pollAfterSeconds: 5,
    };
  }
  return {
    url: taskWatchUrl(taskWatchToken(t, now), origin),
    expiresAt: watchExpiresAt(t, now),
    pollAfterSeconds: pollAfterSeconds(t, now),
  };
}

/** A Task as the v1 API and MCP return it: the Panel's Task plus, for an `assigned` or `in_progress` attempt, its `watch`. */
export type V1TaskDto = TaskDto & { watch?: { url: string; expiresAt: number; pollAfterSeconds: number } };

/** Without `origin` (a list row) there is no `watch`: a list carries `sessionState` only. */
function taskDto(t: Task, origin?: string): V1TaskDto {
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
    waiting: waitingOf(t),
    timeoutMinutes: t.timeoutMinutes,
    sessionState: toSessionState(t.sessionState),
    sessionStateAt: t.sessionStateAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    ...(origin !== undefined && (t.status === "assigned" || t.status === "in_progress") ? { watch: watchOf(t, origin) } : {}),
  };
}

/** The Panel's own origin from a request; an MCP call's stand-in request has none (`mcp.invalid`), so the tool passes the real one. */
function originOf(request: Request): string {
  return new URL(request.url).origin;
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
  return json({ cores: await Promise.all(visible.map(withCapacity)) });
}

export async function getCoreV1(id: string, principal: ApiPrincipal): Promise<Response> {
  const denied = refuseOutsideScope(principal, id);
  if (denied) return denied;
  const core = await getCore(id, principal.ownerId);
  if (!core) return notFound("no such Core");
  return json({ core: await withCapacity(core) });
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

/**
 * An Agent write's error as a response. When the Core cannot be asked, or does
 * not have the harness, the 409 also carries a stable `code`
 * (`core_harnesses_unavailable`, `harness_missing_on_core`, `harness_not_ready`)
 * a client can branch on; the last is a harness still being checked: ask again.
 */
export function agentWriteError(e: unknown): Response {
  if (
    e instanceof CoreHarnessesUnavailableError ||
    e instanceof HarnessMissingOnCoreError ||
    e instanceof HarnessNotReadyError
  ) {
    return json({ error: e.message, code: e.code }, { status: HTTP_CONFLICT });
  }
  return rethrowUnlessDomain(e);
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
    return agentWriteError(e);
  }
}

export async function updateAgentV1(principal: ApiPrincipal, id: string, request: Request): Promise<Response> {
  const body = await parseJsonBody(request, agentChangesBody);
  if (!body.ok) return body.response;
  try {
    const agent = await getAgent(principal.ownerId, id);
    const denied = refuseOutsideScope(principal, agent.coreId);
    if (denied) return denied;
    return json({ agent: agentDto(await updateAgent(principal.ownerId, id, body.data)) });
  } catch (e) {
    return agentWriteError(e);
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

// ── Sessions ───────────────────────────────────────────────────────────────

export type ListSessionsQuery = {
  /** The Core whose Sessions to list; the caller has not checked scope yet. */
  coreId?: string;
  /** 1 to 100, default 25. */
  limit?: number;
  /** The `nextCursor` of the previous page. */
  cursor?: string;
  status?: string;
  archived?: boolean;
  harness?: string;
  q?: string;
};

const SESSIONS_DEFAULT_LIMIT = 25;

type CoreSessionPage = {
  type?: string;
  sessions?: Array<{
    sessionId: string;
    ptyId: string | null;
    status: string;
    updatedAt: number;
    title?: string;
    agent?: string;
    pinned?: boolean;
    archived?: boolean;
  }>;
  nextCursor?: string | null;
  total?: number;
};

/**
 * One page of a Core's Sessions, asked of the Core itself (#960): the Core owns
 * the rows, filters and orders them, and counts the total. Auth and ownership
 * as the other v1 routes: a key outside the Core's scope gets 403, another
 * owner's Core is a 404. Lean rows: no prompt, no transcript.
 */
export async function listSessionsV1(principal: ApiPrincipal, query: ListSessionsQuery): Promise<Response> {
  try {
    if (!query.coreId) throw new ValidationError("coreId is required");
    const limit = query.limit ?? SESSIONS_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > SESSION_PAGE_MAX) {
      throw new ValidationError(`limit must be a whole number from 1 to ${SESSION_PAGE_MAX}`);
    }
    if (query.status !== undefined && !(SESSION_STATUS_FILTERS as readonly string[]).includes(query.status)) {
      throw new ValidationError(`status must be one of ${SESSION_STATUS_FILTERS.join(", ")}`);
    }
    if (query.cursor !== undefined) {
      try {
        decodeSessionCursor(query.cursor);
      } catch (e) {
        if (e instanceof InvalidSessionPageError) throw new ValidationError(e.message);
        throw e;
      }
    }
    const denied = refuseOutsideScope(principal, query.coreId);
    if (denied) return denied;
    if (!(await getCore(query.coreId, principal.ownerId))) return notFound("no such Core");
    const client = coreLinkManager().client(query.coreId);
    if (!client) return jsonError(HTTP_SERVICE_UNAVAILABLE, "the Core is not connected");
    const frame = {
      type: "sessionsList",
      limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.status === undefined ? {} : { status: query.status as SessionStatusFilter }),
      archived: query.archived ?? false,
      ...(query.harness ? { harness: query.harness } : {}),
      ...(query.q ? { q: query.q } : {}),
    };
    let answer: CoreSessionPage;
    try {
      answer = (await client.request(frame as never)) as CoreSessionPage;
    } catch {
      return jsonError(HTTP_BAD_GATEWAY, "the Core did not answer");
    }
    // The link hands an error frame back as an answer, not a rejection.
    if (answer.type !== "sessionsListResult") {
      const message = String((answer as { message?: unknown }).message ?? "");
      // The Core refuses what it cannot read: that is the caller's request, not an outage.
      if (/^(invalid cursor|limit must|status must)/.test(message)) throw new ValidationError(message);
      return jsonError(
        HTTP_BAD_GATEWAY,
        /does not take/.test(message) ? "this Core is too old to page Sessions; update it" : "the Core did not answer",
      );
    }
    const body: SessionsPageDto = {
      sessions: (answer.sessions ?? []).map((s) => ({
        id: s.sessionId,
        title: s.title ?? "",
        harness: s.agent ?? "",
        status: s.status,
        pinned: s.pinned === true,
        archived: s.archived === true,
        live: s.ptyId !== null,
        updatedAt: s.updatedAt,
      })),
      nextCursor: answer.nextCursor ?? null,
      total: answer.total ?? answer.sessions?.length ?? 0,
    };
    return json(body);
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

/** `GET /api/v1/sessions?coreId=&limit=&cursor=&status=&archived=&harness=&q=`. */
export async function listSessionsV1FromQuery(principal: ApiPrincipal, params: URLSearchParams): Promise<Response> {
  const get = (name: string) => params.get(name) ?? undefined;
  const limit = get("limit");
  const archived = get("archived");
  if (archived !== undefined && archived !== "true" && archived !== "false") {
    return jsonError(400, "archived must be true or false");
  }
  return listSessionsV1(principal, {
    ...(get("coreId") === undefined ? {} : { coreId: get("coreId")! }),
    ...(limit === undefined ? {} : { limit: Number(limit) }),
    ...(get("cursor") === undefined ? {} : { cursor: get("cursor")! }),
    ...(get("status") === undefined ? {} : { status: get("status")! }),
    ...(archived === undefined ? {} : { archived: archived === "true" }),
    ...(get("harness") === undefined ? {} : { harness: get("harness")! }),
    ...(get("q") === undefined ? {} : { q: get("q")! }),
  });
}

// ── Tasks ──────────────────────────────────────────────────────────────────

export type ListTasksQuery = {
  /** Only this status. */
  status?: TaskStatus;
  /** Only this Core; the caller has already checked the key reaches it. */
  coreId?: string;
  /** 1 to 100. Given: a page of rows without `description` and a `nextCursor`. Absent: every Task, full rows. */
  limit?: number;
  /** The `nextCursor` of the previous page; needs `limit`. */
  cursor?: string;
  /** Only Tasks whose Session is in one of these states: one value or a comma list (#951). */
  sessionState?: string;
};

/** `sessionState=a,b` as states, or a 400 for an empty list or a value that is not one. */
export function parseSessionStateFilter(raw: string): TaskSessionState[] {
  const parts = raw.split(",").map((p) => p.trim());
  const bad = parts.find((p) => !isTaskSessionState(p));
  if (bad !== undefined) {
    throw new ValidationError(`sessionState must be one or more of ${TASK_SESSION_STATES.join(", ")} (comma separated)`);
  }
  return [...new Set(parts as TaskSessionState[])];
}

/**
 * The Tasks the principal reaches. Without `limit`, every one with full rows, as it always was (#572).
 * With `limit` (#896), one page filtered in SQL, newest update first, without `description`, plus `nextCursor`.
 */
export async function listTasksV1(principal: ApiPrincipal, query: ListTasksQuery = {}): Promise<Response> {
  try {
    const sessionStates = query.sessionState === undefined ? undefined : parseSessionStateFilter(query.sessionState);
    if (query.limit === undefined) {
      if (query.cursor !== undefined) throw new ValidationError("cursor needs a limit");
      const all = await listTasks(principal.ownerId, query.status ? [query.status] : undefined, sessionStates);
      const visible = all.filter(
        (t) => inScope(principal, t.coreId) && (query.coreId === undefined || t.coreId === query.coreId),
      );
      return json({ tasks: visible.map((t) => taskDto(t)) });
    }
    const page = await listTasksPage(principal.ownerId, {
      limit: query.limit,
      ...(query.status ? { statuses: [query.status] } : {}),
      ...(sessionStates === undefined ? {} : { sessionStates }),
      ...(query.coreId === undefined ? {} : { coreId: query.coreId }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(principal.kind === "api-key" && !principal.scope.allCores ? { scopeCoreIds: [...principal.scope.coreIds] } : {}),
    });
    const body: TasksPageDto = { tasks: page.tasks.map(taskListDto), nextCursor: page.nextCursor };
    return json(body);
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

/** `GET /api/v1/tasks?limit=&cursor=`: the query string as a {@link ListTasksQuery}. */
export async function listTasksV1FromQuery(principal: ApiPrincipal, params: URLSearchParams): Promise<Response> {
  const limit = params.get("limit");
  const cursor = params.get("cursor");
  const sessionState = params.get("sessionState");
  return listTasksV1(principal, {
    ...(limit === null ? {} : { limit: Number(limit) }),
    ...(cursor === null ? {} : { cursor }),
    ...(sessionState === null ? {} : { sessionState }),
  });
}

export async function createTaskV1(principal: ApiPrincipal, request: Request, origin = originOf(request)): Promise<Response> {
  const body = await parseJsonBody(request, newTaskBody);
  if (!body.ok) return body.response;
  const { title, description, coreId, agent, startNow, timeoutMinutes } = body.data;
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
      ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
    });
    return json({ task: taskDto(task, origin), ...queuedAnswer(startNow, coreId) }, { status: HTTP_CREATED });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

export async function getTaskV1(principal: ApiPrincipal, id: string, origin = ""): Promise<Response> {
  try {
    const task = await getTask(principal.ownerId, id);
    const denied = refuseOutsideScope(principal, task.coreId);
    if (denied) return denied;
    const comments = await listTaskComments(principal.ownerId, id);
    return json({ task: taskDto(task, origin), comments: comments.map(commentDto) });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

export async function setTaskStatusV1(principal: ApiPrincipal, id: string, request: Request, origin = originOf(request)): Promise<Response> {
  const body = await parseJsonBody(request, statusBody);
  if (!body.ok) return body.response;
  try {
    const task = await getTask(principal.ownerId, id);
    const denied = refuseOutsideScope(principal, task.coreId);
    if (denied) return denied;
    return json({ task: taskDto(await changeTaskStatus(principal.ownerId, id, body.data.status), origin) });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

/** `PATCH /api/v1/tasks/:id` (#722): title, description (409 while `in_progress`) or time limit (#724, any status). */
export async function updateTaskV1(principal: ApiPrincipal, id: string, request: Request, origin = originOf(request)): Promise<Response> {
  const body = await parseJsonBody(request, updateTaskBody);
  if (!body.ok) return body.response;
  try {
    const task = await getTask(principal.ownerId, id);
    const denied = refuseOutsideScope(principal, task.coreId);
    if (denied) return denied;
    return json({ task: taskDto(await updateTask(principal.ownerId, id, { ...body.data, changedBy: await authorName() }), origin) });
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

/** `POST /api/v1/tasks/:id/stop` (#723): stops the Task's Session and fails the Task; 409 unless it is `in_progress`. */
export async function stopTaskV1(principal: ApiPrincipal, id: string, request: Request, origin = originOf(request)): Promise<Response> {
  const body = await parseJsonBody(request, stopTaskBody);
  if (!body.ok) return body.response;
  try {
    const task = await getTask(principal.ownerId, id);
    const denied = refuseOutsideScope(principal, task.coreId);
    if (denied) return denied;
    const stopped = await stopTask(principal.ownerId, id, { stoppedBy: await authorName(), reason: body.data.reason });
    return json({ task: taskDto(stopped.task, origin), session: stopped.session });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

/** `POST /api/v1/tasks/:id/close-session` (#962): end a finished Task's harness and free its PTY slot; 409 while someone is working in it. */
export async function closeTaskSessionV1(principal: ApiPrincipal, id: string, origin = ""): Promise<Response> {
  try {
    const task = await getTask(principal.ownerId, id);
    const denied = refuseOutsideScope(principal, task.coreId);
    if (denied) return denied;
    const closed = await closeSession(principal.ownerId, id, { closedBy: await authorName() });
    return json({ task: taskDto(closed.task, origin), session: closed.session });
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

export async function addTaskCommentV1(principal: ApiPrincipal, id: string, request: Request, origin = originOf(request)): Promise<Response> {
  const body = await parseJsonBody(request, commentBody);
  if (!body.ok) return body.response;
  try {
    const task = await getTask(principal.ownerId, id);
    const denied = refuseOutsideScope(principal, task.coreId);
    if (denied) return denied;
    const input = { authorKind: "user" as const, authorName: await authorName(), body: body.data.body };
    if (body.data.reassign) {
      const updated = await commentAndReassign(principal.ownerId, id, input);
      return json({ task: taskDto(updated, origin), comments: (await listTaskComments(principal.ownerId, id)).map(commentDto) });
    }
    const stored = await addTaskComment(principal.ownerId, id, input);
    return json({ comment: commentDto(stored) }, { status: HTTP_CREATED });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}
