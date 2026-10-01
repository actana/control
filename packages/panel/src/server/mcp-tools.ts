import { z } from "zod";
import type { ApiPrincipal } from "./api-key-auth";
import { forbidden } from "./controllers/_helpers";
import { getTaskV1, listAgentsV1, listCoreAgentsV1, listCoresV1, listTasksV1 } from "./controllers/v1.controller";
import { scopeReaches } from "./services/api-keys";
import { TASK_STATUSES } from "~/shared/tasks";

/**
 * The MCP tools (#573). Each one is a thin call into the same handlers the
 * public REST API runs (`controllers/v1.controller.ts`), with the principal the
 * key gate resolved, so the owner and Core-scope rules exist once: a tool never
 * decides who it runs as or which Cores it may see.
 */

export type ApiKeyPrincipal = Extract<ApiPrincipal, { kind: "api-key" }>;

/** What a tool did: data for the model, or a message that tells it why not (an MCP tool error, not a protocol error). */
export type ToolOutcome = { ok: true; data: Record<string, unknown> } | { ok: false; message: string };

export type McpTool = {
  name: string;
  description: string;
  readOnly: boolean;
  input: z.ZodObject;
  run(principal: ApiKeyPrincipal, args: never): Promise<ToolOutcome>;
};

/** A v1 handler's `Response` as a tool outcome: 2xx is its JSON, anything else is `"<status> <error>"`. */
export async function outcomeOf(response: Response): Promise<ToolOutcome> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.ok) return { ok: true, data: body };
  const reason = typeof body.error === "string" ? body.error : "failed";
  return { ok: false, message: `${response.status} ${reason}` };
}

function tool<S extends z.ZodObject>(def: {
  name: string;
  description: string;
  readOnly: boolean;
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
    input: z.object({}),
    run: async (principal) => outcomeOf(await listCoresV1(principal)),
  }),
  tool({
    name: "list_agents",
    description: "List the Agents (a named harness and its settings on one Core) the key can reach, optionally on one Core.",
    readOnly: true,
    input: z.object({ coreId: coreIdArg.optional() }),
    run: async (principal, { coreId }) =>
      outcomeOf(coreId === undefined ? await listAgentsV1(principal) : await listCoreAgentsV1(principal, coreId)),
  }),
  tool({
    name: "get_tasks",
    description: "List Tasks on the Cores the key can reach, optionally only one status or one Core.",
    readOnly: true,
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
    input: z.object({ taskId: taskIdArg }),
    run: async (principal, { taskId }) => outcomeOf(await getTaskV1(principal, taskId)),
  }),
];
