import { z } from "zod";
import { json, jsonError, parseJsonBody, rethrowUnlessDomain } from "./_helpers";
import { NotFoundError, ValidationError } from "../errors";
import { HTTP_BAD_REQUEST, HTTP_CREATED, HTTP_PAYLOAD_TOO_LARGE } from "~/shared/http-status";
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
import { PayloadTooLargeError, sharedFiles } from "../services/shared-files";
import {
  TaskAttachmentError,
  commentWithAttachments,
  createTaskWithAttachments,
  type AttachmentFile,
} from "../services/task-attachments";
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

/** The multipart request's own framing (boundaries, field headers) on top of the files it carries. */
const MULTIPART_SLACK_BYTES = 1024 * 1024;

type Parsed<T> = { ok: true; data: T; files: AttachmentFile[] } | { ok: false; response: Response };

/**
 * A request that carries attachments is `multipart/form-data`: the usual JSON body as the `json` field, the files as
 * `files` and, in the same order, each one's path relative to the Task's attachments folder as `paths` (a JSON array,
 * because a browser does not keep a picked folder's tree in a file's name). The files together stay within the upload
 * limit, checked from the declared length before the body is read and again on what was read.
 */
async function parseMultipart<S extends z.ZodType>(request: Request, schema: S): Promise<Parsed<z.infer<S>>> {
  const limit = sharedFiles().uploadLimitBytes;
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit + MULTIPART_SLACK_BYTES) {
    return { ok: false, response: tooLarge(limit) };
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { ok: false, response: jsonError(HTTP_BAD_REQUEST, "invalid multipart body") };
  }
  const rawJson = form.get("json");
  let raw: unknown;
  try {
    raw = JSON.parse(typeof rawJson === "string" ? rawJson : "{}");
  } catch {
    return { ok: false, response: jsonError(HTTP_BAD_REQUEST, "invalid JSON in the json field") };
  }
  const data = schema.safeParse(raw);
  if (!data.success) return { ok: false, response: jsonError(HTTP_BAD_REQUEST, data.error.issues.map((i) => i.message).join("; ")) };
  const blobs = form.getAll("files").filter((v): v is File => typeof v !== "string");
  let paths: unknown;
  try {
    paths = JSON.parse(typeof form.get("paths") === "string" ? (form.get("paths") as string) : "[]");
  } catch {
    return { ok: false, response: jsonError(HTTP_BAD_REQUEST, "invalid JSON in the paths field") };
  }
  if (!Array.isArray(paths) || paths.length !== blobs.length || !paths.every((p) => typeof p === "string")) {
    return { ok: false, response: jsonError(HTTP_BAD_REQUEST, "every file needs its path: paths must list one per file") };
  }
  const total = blobs.reduce((n, b) => n + b.size, 0);
  if (total > limit) return { ok: false, response: tooLarge(limit) };
  const files = blobs.map((b, i) => ({ path: paths[i] as string, size: b.size, stream: () => b.stream() as ReadableStream<Uint8Array> }));
  return { ok: true, data: data.data, files };
}

function tooLarge(limit: number): Response {
  return jsonError(HTTP_PAYLOAD_TOO_LARGE, `The attachments are larger than the upload limit of ${limit} bytes.`, { "x-upload-limit": String(limit) });
}

const isMultipart = (request: Request) => (request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data");

/** A refused attachment: its own status (413 over the limit, 409 from the store), and which Task is still a draft. */
async function attachmentFailure(err: unknown): Promise<Response> {
  if (!(err instanceof TaskAttachmentError)) {
    if (err instanceof PayloadTooLargeError) return tooLarge(err.limitBytes);
    return rethrowUnlessDomain(err);
  }
  // The status is the cause's own: 413 over the limit, 404 for a Core that is not the owner's, 409 from the store.
  const base = err.reason instanceof PayloadTooLargeError ? tooLarge(err.reason.limitBytes) : rethrowUnlessDomain(err.reason);
  return json({ error: err.message, taskId: err.taskId, path: err.path }, { status: base.status, headers: base.headers });
}

export async function create(ownerId: number, request: Request): Promise<Response> {
  const parsed = isMultipart(request)
    ? await parseMultipart(request, newTaskBody)
    : await parseJsonBody(request, newTaskBody).then((b) => (b.ok ? { ...b, files: [] as AttachmentFile[] } : b));
  if (!parsed.ok) return parsed.response;
  const { title, description, coreId, agent, startNow } = parsed.data;
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
    const input = {
      title,
      ...(description === undefined ? {} : { description }),
      coreId: coreId ?? null,
      agent: agent ?? null,
      startNow: startNow === true,
    };
    const task =
      parsed.files.length > 0
        ? await createTaskWithAttachments(ownerId, input, parsed.files, await authorName())
        : await createTask(ownerId, input);
    return json({ task: taskDto(task) }, { status: HTTP_CREATED });
  } catch (e) {
    return attachmentFailure(e);
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

/** A comment, or with `reassign` the service's single Comment & re-assign call; with files, the files are written first. */
export async function comment(ownerId: number, id: string, request: Request): Promise<Response> {
  const parsed = isMultipart(request)
    ? await parseMultipart(request, commentBody)
    : await parseJsonBody(request, commentBody).then((b) => (b.ok ? { ...b, files: [] as AttachmentFile[] } : b));
  if (!parsed.ok) return parsed.response;
  try {
    const input = { authorKind: "user" as const, authorName: await authorName(), body: parsed.data.body };
    if (parsed.files.length > 0) {
      const done = await commentWithAttachments(
        ownerId,
        id,
        { authorName: input.authorName, body: input.body, reassign: parsed.data.reassign === true },
        parsed.files,
      );
      if (parsed.data.reassign) return json({ task: taskDto(done.task), comments: (await listTaskComments(ownerId, id)).map(commentDto) });
      return json({ comment: commentDto(done.comment!) }, { status: HTTP_CREATED });
    }
    if (parsed.data.reassign) {
      const task = await commentAndReassign(ownerId, id, input);
      return json({ task: taskDto(task), comments: (await listTaskComments(ownerId, id)).map(commentDto) });
    }
    const stored = await addTaskComment(ownerId, id, input);
    return json({ comment: commentDto(stored) }, { status: HTTP_CREATED });
  } catch (e) {
    return attachmentFailure(e);
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
