import { z } from "zod";
import type { ApiPrincipal } from "./api-key-auth";
import { forbidden } from "./controllers/_helpers";
import {
  addTaskCommentV1,
  createTaskV1,
  getTaskV1,
  listAgentsV1,
  listCoreAgentsV1,
  listCoresV1,
  listTasksV1,
  setTaskStatusV1,
} from "./controllers/v1.controller";
import { getShared, listShared } from "./mcp-shared";
import { OPERATOR_TASK_STATUSES } from "./controllers/tasks.controller";
import { scopeReaches } from "./services/api-keys";
import type { ApiKeyPermission } from "~/shared/api-key-permissions";
import { TASK_STATUSES } from "~/shared/tasks";

/**
 * The MCP tools (#573). Each one is a thin call into the same handlers the
 * public REST API runs (`controllers/v1.controller.ts`), with the principal the
 * key gate resolved, so the owner and Core-scope rules exist once: a tool never
 * decides who it runs as or which Cores it may see. Each tool names the one
 * permission it needs (#688), the same one its REST route needs; the server
 * lists a key only the tools it may call and refuses the rest.
 */

export type ApiKeyPrincipal = Extract<ApiPrincipal, { kind: "api-key" }>;

/** What a tool did: data for the model, or a message that tells it why not (an MCP tool error, not a protocol error). */
export type ToolOutcome = { ok: true; data: Record<string, unknown> } | { ok: false; message: string };

export type McpTool = {
  name: string;
  description: string;
  readOnly: boolean;
  /** The API key permission a call needs. */
  permission: ApiKeyPermission;
  input: z.ZodObject;
  run(principal: ApiKeyPrincipal, args: never): Promise<ToolOutcome>;
};

/** A v1 handler's `Response` as a tool outcome: 2xx is its JSON, anything else is `"<status> <error>"`. */
async function outcomeOf(response: Response): Promise<ToolOutcome> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.ok) return { ok: true, data: body };
  const reason = typeof body.error === "string" ? body.error : "failed";
  return { ok: false, message: `${response.status} ${reason}` };
}

/** The JSON body a v1 write handler reads, as the `Request` it takes: the tool's arguments are its body, validated by the same schema. */
function asJsonRequest(body: Record<string, unknown>): Request {
  return new Request("http://mcp.invalid/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function tool<S extends z.ZodObject>(def: {
  name: string;
  description: string;
  readOnly: boolean;
  permission: ApiKeyPermission;
  input: S;
  run: (principal: ApiKeyPrincipal, args: z.infer<S>) => Promise<ToolOutcome>;
}): McpTool {
  return def as McpTool;
}

const taskIdArg = z.string().min(1).describe("The Task's id, from get_tasks.");
const coreIdArg = z.string().min(1).describe("A Core's id, from list_cores.");

export const MCP_TOOLS: readonly McpTool[] = [
  tool({
    name: "list_cores",
    description: "List the Cores this API key can reach, with their connection state.",
    readOnly: true,
    permission: "read",
    input: z.object({}),
    run: async (principal) => outcomeOf(await listCoresV1(principal)),
  }),
  tool({
    name: "list_agents",
    description: "List the Agents (a named harness and its settings on one Core) the key can reach, optionally on one Core.",
    readOnly: true,
    permission: "read",
    input: z.object({ coreId: coreIdArg.optional() }),
    run: async (principal, { coreId }) =>
      outcomeOf(coreId === undefined ? await listAgentsV1(principal) : await listCoreAgentsV1(principal, coreId)),
  }),
  tool({
    name: "get_tasks",
    description: "List Tasks on the Cores the key can reach, optionally only one status or one Core.",
    readOnly: true,
    permission: "read",
    input: z.object({ status: z.enum(TASK_STATUSES).optional(), coreId: coreIdArg.optional() }),
    run: async (principal, { status, coreId }) => {
      if (coreId !== undefined && !scopeReaches(principal.scope, coreId)) {
        return outcomeOf(forbidden("this API key does not reach that Core"));
      }
      const listed = await outcomeOf(await listTasksV1(principal));
      if (!listed.ok) return listed;
      const tasks = (listed.data.tasks as { status: string; coreId: string | null }[]).filter(
        (t) => (status === undefined || t.status === status) && (coreId === undefined || t.coreId === coreId),
      );
      return { ok: true, data: { tasks } };
    },
  }),
  tool({
    name: "get_task",
    description: "One Task with its comment thread (the agent's report arrives here as a comment).",
    readOnly: true,
    permission: "read",
    input: z.object({ taskId: taskIdArg }),
    run: async (principal, { taskId }) => outcomeOf(await getTaskV1(principal, taskId)),
  }),
  tool({
    name: "create_task",
    description:
      "Create a Task. It is a draft unless startNow is true, which creates it assigned so its Agent starts on it (needs coreId and agent).",
    readOnly: false,
    permission: "tasks:write",
    input: z.object({
      title: z.string().min(1).describe("A short title."),
      description: z.string().optional().describe("What to do, in Markdown."),
      coreId: coreIdArg.nullable().optional(),
      agent: z.string().min(1).nullable().optional().describe("An Agent's id on that Core, from list_agents."),
      startNow: z.boolean().optional(),
    }),
    run: async (principal, args) => outcomeOf(await createTaskV1(principal, asJsonRequest(args))),
  }),
  tool({
    name: "assign_task",
    description:
      "Move a Task to assigned (its Agent starts on it) or back to draft. These are the only moves an operator makes; " +
      "in_progress, done, failed and partial belong to the dispatcher and the Agent's report.",
    readOnly: false,
    permission: "tasks:write",
    input: z.object({ taskId: taskIdArg, status: z.enum(OPERATOR_TASK_STATUSES).default("assigned") }),
    run: async (principal, { taskId, status }) =>
      outcomeOf(await setTaskStatusV1(principal, taskId, asJsonRequest({ status }))),
  }),
  tool({
    name: "comment_task",
    description: "Add a comment to a Task's thread. With reassign true, also send a finished Task back to its Agent (Comment & re-assign).",
    readOnly: false,
    permission: "tasks:write",
    input: z.object({ taskId: taskIdArg, body: z.string().min(1), reassign: z.boolean().optional() }),
    run: async (principal, { taskId, body, reassign }) =>
      outcomeOf(await addTaskCommentV1(principal, taskId, asJsonRequest({ body, ...(reassign === undefined ? {} : { reassign }) }))),
  }),
  tool({
    name: "list_shared",
    description:
      "List a folder in a Core's Shared folder (read-only), where Agents leave their results. path is relative to the " +
      "Shared folder, with no .. and no leading /; omit it for the top.",
    readOnly: true,
    permission: "read",
    input: z.object({ coreId: coreIdArg, path: z.string().optional() }),
    run: (principal, args) => listShared(principal, args),
  }),
  tool({
    name: "get_shared",
    description:
      "Read one text file from a Core's Shared folder (read-only). path is relative to the Shared folder, with no .. and no " +
      "leading /. A file over 256 KiB is refused.",
    readOnly: true,
    permission: "read",
    input: z.object({ coreId: coreIdArg, path: z.string() }),
    run: (principal, args) => getShared(principal, args),
  }),
];
