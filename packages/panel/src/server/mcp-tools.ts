import { z } from "zod";
import type { ApiPrincipal } from "./api-key-auth";
import { forbidden } from "./controllers/_helpers";
import {
  addTaskCommentV1,
  createAgentV1,
  createTaskV1,
  deleteAgentV1,
  deleteTaskV1,
  getTaskV1,
  listAgentsV1,
  listCoreAgentsV1,
  listCoresV1,
  listSessionsV1,
  listTasksV1,
  setTaskStatusV1,
  stopTaskV1,
  updateAgentV1,
  updateTaskV1,
} from "./controllers/v1.controller";
import { getShared, listShared } from "./mcp-shared";
import { OPERATOR_TASK_STATUSES } from "./controllers/tasks.controller";
import { scopeReaches } from "./services/api-keys";
import type { ApiKeyPermission } from "~/shared/api-key-permissions";
import { SESSION_PAGE_MAX, SESSION_STATUS_FILTERS } from "@actana/shared/session-paging";
import { AGENT_FLAGS, AGENT_NAME_MAX, HARNESSES } from "~/shared/agents";
import { TASKS_PAGE_MAX_LIMIT, TASK_STATUSES } from "~/shared/tasks";

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
export type ToolOutcome =
  | {
      ok: true;
      data: Record<string, unknown>;
      /** Send `data` as the JSON text only, not again as `structuredContent` (a large list, #896). */
      textOnly?: true;
    }
  | { ok: false; message: string };

export type McpTool = {
  name: string;
  description: string;
  readOnly: boolean;
  /** A write that cannot be undone (MCP's `destructiveHint`). */
  destructive?: boolean;
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
  // A refusal with a stable `code` (an Agent's harness check) leads with it: the model can tell "wait" from "missing".
  const code = typeof body.code === "string" ? `${body.code}: ` : "";
  return { ok: false, message: `${response.status} ${code}${reason}` };
}

/** The JSON body a v1 write handler reads, as the `Request` it takes: the tool's arguments are its body, validated by the same schema. */
function asJsonRequest(body: Record<string, unknown>, method = "POST"): Request {
  return new Request("http://mcp.invalid/", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function tool<S extends z.ZodObject>(def: {
  name: string;
  description: string;
  readOnly: boolean;
  destructive?: boolean;
  permission: ApiKeyPermission;
  input: S;
  run: (principal: ApiKeyPrincipal, args: z.infer<S>) => Promise<ToolOutcome>;
}): McpTool {
  return def as McpTool;
}

const taskIdArg = z.string().min(1).describe("The Task's id, from get_tasks.");
const timeoutMinutesArg = z
  .number()
  .int()
  .min(1)
  .max(43200)
  .nullable()
  .optional()
  .describe("Time limit in minutes per attempt (1–43200). Omit for 60; null = No limit: the attempt runs until the agent reports or exits.");
const coreIdArg = z.string().min(1).describe("A Core's id, from list_cores.");
const agentIdArg = z.string().min(1).describe("An Agent's id, from list_agents.");
const agentNameArg = z.string().describe(`The Agent's name: one line of at most ${AGENT_NAME_MAX} characters, unique on its Core.`);
const agentModelArg = z
  .string()
  .nullable()
  .optional()
  .describe("A model id for the harness (letters, digits and . _ : / @ + -), e.g. opus. null or omitted = the harness's own default.");
const agentFlagsArg = z
  .array(z.string())
  .optional()
  .describe(`Flags from this closed set: ${AGENT_FLAGS.join(", ")}. Nothing else is accepted: an Agent has no command, arguments, script or environment.`);

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
    name: "create_agent",
    description:
      "Create an Agent: a named harness with a model and flags on one Core. The Core must be online and report the harness ready. " +
      "Refusals are 409 and start with a code: core_harnesses_unavailable (the Core cannot be asked right now: it is offline, try again later), " +
      "harness_missing_on_core (not available there; when its text says 'not ready yet' the Core is still checking the harness: ask again shortly, otherwise it is not installed, outdated or needs setup).",
    readOnly: false,
    permission: "agents:write",
    input: z.strictObject({
      coreId: coreIdArg,
      name: agentNameArg,
      harness: z.enum(HARNESSES).describe("The harness this Agent runs, e.g. claude-code."),
      model: agentModelArg,
      flags: agentFlagsArg,
    }),
    run: async (principal, args) => outcomeOf(await createAgentV1(principal, asJsonRequest(args))),
  }),
  tool({
    name: "update_agent",
    description:
      "Change an Agent's name, model and/or flags in place: its id stays, so briefs and Tasks that name it keep working, and the next Task sent to it runs with the new settings. " +
      "A field you leave out is kept; model null clears the model. The harness and the Core cannot be changed, and a default Agent (one a Core made for itself) is refused with 409.",
    readOnly: false,
    permission: "agents:write",
    input: z
      .strictObject({ agentId: agentIdArg, name: agentNameArg.optional(), model: agentModelArg, flags: agentFlagsArg })
      .refine((a) => a.name !== undefined || a.model !== undefined || a.flags !== undefined, {
        message: "give a name, a model or flags",
      }),
    run: async (principal, { agentId, ...fields }) => outcomeOf(await updateAgentV1(principal, agentId, asJsonRequest(fields, "PATCH"))),
  }),
  tool({
    name: "delete_agent",
    description:
      "Delete an Agent. A default Agent (one a Core made for itself) is refused with 409. Tasks that named the Agent keep their text; they cannot be sent to it again.",
    readOnly: false,
    permission: "agents:write",
    destructive: true,
    input: z.strictObject({ agentId: agentIdArg }),
    run: async (principal, { agentId }) => {
      const deleted = await outcomeOf(await deleteAgentV1(principal, agentId));
      return deleted.ok ? { ok: true, data: { deleted: agentId } } : deleted;
    },
  }),
  tool({
    name: "get_tasks",
    description:
      "List Tasks on the Cores the key can reach, optionally only one status or one Core. With no limit, every matching Task with its full description. " +
      "With a limit (1-100) you get one page, newest update first, without descriptions (use get_task for those), plus nextCursor: pass it back as cursor for the next page; null on the last.",
    readOnly: true,
    permission: "read",
    input: z.object({
      status: z.enum(TASK_STATUSES).optional(),
      coreId: coreIdArg.optional(),
      limit: z.number().int().min(1).max(TASKS_PAGE_MAX_LIMIT).optional().describe("Page size, 1-100. Omit to get every Task with its description."),
      cursor: z.string().min(1).optional().describe("The nextCursor of the previous page. Needs limit."),
    }),
    run: async (principal, { status, coreId, limit, cursor }) => {
      if (coreId !== undefined && !scopeReaches(principal.scope, coreId)) {
        return outcomeOf(forbidden("this API key does not reach that Core"));
      }
      const listed = await outcomeOf(
        await listTasksV1(principal, {
          ...(status === undefined ? {} : { status }),
          ...(coreId === undefined ? {} : { coreId }),
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      // The rows are in the JSON text only: a list can be megabytes, so it is not repeated as structuredContent.
      return listed.ok ? { ...listed, textOnly: true } : listed;
    },
  }),
  tool({
    name: "get_sessions",
    description:
      "List one Core's Sessions, one page at a time: running and waiting-for-input first, then newest activity. Lean rows (id, title, harness, status, pinned, archived, live, updatedAt): no prompt text, no transcript. " +
      "Pass the returned nextCursor back as cursor for the next page; it is null on the last. total counts every Session the filters match on that Core.",
    readOnly: true,
    permission: "read",
    input: z.object({
      coreId: coreIdArg,
      limit: z.number().int().min(1).max(SESSION_PAGE_MAX).optional().describe("Page size, 1-100. Default 25."),
      cursor: z.string().min(1).optional().describe("The nextCursor of the previous page."),
      status: z.enum(SESSION_STATUS_FILTERS).optional().describe("Only Sessions in this state."),
      archived: z.boolean().optional().describe("true lists archived Sessions instead of active ones."),
      harness: z.string().min(1).optional().describe("Only Sessions of this harness, e.g. claude-code."),
      q: z.string().min(1).optional().describe("Only Sessions whose name contains this text."),
    }),
    run: async (principal, args) => {
      const listed = await outcomeOf(await listSessionsV1(principal, args));
      return listed.ok ? { ...listed, textOnly: true } : listed;
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
      "Create a Task. It is a draft unless startNow is true, which creates it assigned so its Agent starts on it (needs coreId and agent). " +
      "timeoutMinutes sets its time limit per attempt (default 60 minutes; null = No limit).",
    readOnly: false,
    permission: "tasks:write",
    input: z.object({
      title: z.string().min(1).describe("A short title."),
      description: z.string().optional().describe("What to do, in Markdown."),
      coreId: coreIdArg.nullable().optional(),
      agent: z.string().min(1).nullable().optional().describe("An Agent's id on that Core, from list_agents."),
      startNow: z.boolean().optional(),
      timeoutMinutes: timeoutMinutesArg,
    }),
    run: async (principal, args) => outcomeOf(await createTaskV1(principal, asJsonRequest(args))),
  }),
  tool({
    name: "assign_task",
    description:
      "Move a Task to assigned (its Agent starts on it) or back to draft. These are the only moves an operator makes; " +
      "in_progress, done, failed and partial belong to the dispatcher and the Agent's report. A Task that is in_progress " +
      "cannot be moved: stop_task it first.",
    readOnly: false,
    permission: "tasks:write",
    input: z.object({ taskId: taskIdArg, status: z.enum(OPERATOR_TASK_STATUSES).default("assigned") }),
    run: async (principal, { taskId, status }) =>
      outcomeOf(await setTaskStatusV1(principal, taskId, asJsonRequest({ status }))),
  }),
  tool({
    name: "comment_task",
    description: "Add a comment to a Task's thread. With reassign true, also send a finished Task back to its Agent (Comment & re-assign). " +
      "A Task that is in_progress is refused: stop_task it first, then comment again with reassign true.",
    readOnly: false,
    permission: "tasks:write",
    input: z.object({ taskId: taskIdArg, body: z.string().min(1), reassign: z.boolean().optional() }),
    run: async (principal, { taskId, body, reassign }) =>
      outcomeOf(await addTaskCommentV1(principal, taskId, asJsonRequest({ body, ...(reassign === undefined ? {} : { reassign }) }))),
  }),
  tool({
    name: "stop_task",
    description:
      "Stop a Task that is in_progress: stops its Session, fails it with a system comment; then comment_task reassign works. " +
      "The result says whether the Session was stopped (a Core that is offline leaves it running).",
    readOnly: false,
    permission: "tasks:write",
    destructive: true,
    input: z.object({ taskId: taskIdArg, reason: z.string().max(2000).optional().describe("Why it is stopped; recorded in the Task's comment.") }),
    run: async (principal, { taskId, reason }) =>
      outcomeOf(await stopTaskV1(principal, taskId, asJsonRequest({ ...(reason === undefined ? {} : { reason }) }))),
  }),
  tool({
    name: "update_task",
    description:
      "Change a Task's title, description, time limit or any of them. The title and description are refused while the " +
      "Task is in_progress, because its Session already has the prompt; the time limit can be changed at any status, " +
      "including in_progress, and applies to the running attempt within a minute.",
    readOnly: false,
    permission: "tasks:write",
    input: z
      .object({
        taskId: taskIdArg,
        title: z.string().min(1).optional().describe("The new title."),
        description: z.string().optional().describe("The new description, in Markdown. It replaces the old one."),
        timeoutMinutes: timeoutMinutesArg,
      })
      .refine((a) => a.title !== undefined || a.description !== undefined || a.timeoutMinutes !== undefined, {
        message: "give a title, a description or a time limit",
      }),
    run: async (principal, { taskId, ...fields }) =>
      outcomeOf(await updateTaskV1(principal, taskId, asJsonRequest(fields, "PATCH"))),
  }),
  tool({
    name: "delete_task",
    description:
      "Delete a Task with its comments and history. Refused while the Task is in_progress; files it left in the Shared " +
      "folder stay.",
    readOnly: false,
    permission: "tasks:write",
    destructive: true,
    input: z.object({ taskId: taskIdArg }),
    run: async (principal, { taskId }) => {
      const deleted = await outcomeOf(await deleteTaskV1(principal, taskId));
      return deleted.ok ? { ok: true, data: { deleted: taskId } } : deleted;
    },
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
