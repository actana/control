import { z } from "zod";
import type { ApiPrincipal } from "./api-key-auth";
import { listCoresV1 } from "./controllers/v1.controller";

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

export const MCP_TOOLS: readonly McpTool[] = [
  tool({
    name: "list_cores",
    description: "List the Cores this API key can reach, with their connection state.",
    readOnly: true,
    input: z.object({}),
    run: async (principal) => outcomeOf(await listCoresV1(principal)),
  }),
];
