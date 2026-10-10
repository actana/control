import { z } from "zod";
import pkg from "../../package.json";
import { authenticateApiKeyOnly } from "./api-key-auth";
import { jsonError } from "./http-responses";
import { MCP_TOOLS } from "./mcp-tools";
import { hasPermission, missingPermissionMessage } from "./services/api-keys";
import {
  HTTP_ACCEPTED,
  HTTP_BAD_REQUEST,
  HTTP_INTERNAL_SERVER_ERROR,
  HTTP_METHOD_NOT_ALLOWED,
  HTTP_PAYLOAD_TOO_LARGE,
} from "~/shared/http-status";

/**
 * The Panel's MCP server (#573): stateless Streamable HTTP at `POST /mcp`
 * (MCP 2025-06-18, transports › Streamable HTTP), written on the small
 * JSON-RPC surface it needs instead of an SDK.
 *
 * - **Stateless.** No `Mcp-Session-Id` is issued and nothing is kept between
 *   requests; every request carries its own key and is answered on its own.
 * - **Answers are JSON**, never an SSE stream: a request gets one
 *   `application/json` JSON-RPC response, a notification or a client response
 *   gets `202` with no body.
 * - **No server-initiated stream**: `GET /mcp` (and `DELETE`) is `405` with
 *   `Allow: POST`, the status the spec names for a server that does not offer one.
 * - **Key only.** The Bearer API key is the whole credential; the Operator's
 *   session cookie is never consulted (`authenticateApiKeyOnly`).
 * - **The key's permissions** (#688) decide the tools: `tools/list` names only
 *   the tools the key may call, and a call to any other is a tool error that
 *   says which permission is missing, the same 403 the REST route gives.
 */

export const MCP_PATH = "/mcp";

const LATEST_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [LATEST_PROTOCOL_VERSION, "2025-03-26", "2024-11-05"];
/** A JSON-RPC message from a client is a few KB; this is a ceiling, not a target. */
const MAX_BODY_BYTES = 1024 * 1024;
/**
 * Batches are a 2025-03-26 feature (2025-06-18 removed them), kept small: the messages of one are answered one after
 * another, never at once, and an array over this many is refused, so one request cannot fan out into a flood of Core
 * and database reads.
 */
const MAX_BATCH = 10;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const INSTRUCTIONS =
  "Tasks on the Operator's Cores. Every call runs as the API key's owner, sees only the Cores the key reaches, " +
  "and may use only the tools the key's permissions allow (tools/list names those). " +
  "assign_task only asks for the operator moves (assigned, draft); list_shared and get_shared read a Core's Shared folder.";

const rpcId = z.union([z.string(), z.number()]);
const rpcMessage = z.object({
  jsonrpc: z.literal("2.0"),
  id: rpcId.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
});

type RpcResponse = { jsonrpc: "2.0"; id: string | number | null } & (
  | { result: unknown }
  | { error: { code: number; message: string } }
);

const rpcError = (id: string | number | null, code: number, message: string): RpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

const NO_STORE = { "cache-control": "no-store" };

function rpcHttp(body: RpcResponse | RpcResponse[], status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...NO_STORE },
  });
}

/** The key's `tools/list` entry for one tool. */
function describeTool(t: (typeof MCP_TOOLS)[number]) {
  const { $schema: _unused, ...inputSchema } = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
  return {
    name: t.name,
    description: t.description,
    inputSchema,
    annotations: { readOnlyHint: t.readOnly },
  };
}

/** Handle one JSON-RPC message. A notification or a response from the client has nothing to answer. */
async function handleMessage(
  raw: unknown,
  principal: Parameters<(typeof MCP_TOOLS)[number]["run"]>[0],
): Promise<RpcResponse | null> {
  const parsed = rpcMessage.safeParse(raw);
  if (!parsed.success) return rpcError(null, INVALID_REQUEST, "not a JSON-RPC 2.0 message");
  const { id, method, params } = parsed.data;
  if (method === undefined) return null; // a client's response to a request we never send
  if (id === undefined) return null; // a notification (notifications/initialized, notifications/cancelled, …)

  switch (method) {
    case "initialize": {
      const asked = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const protocolVersion =
        typeof asked === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "actana-control", title: "Actana Control", version: pkg.version },
          instructions: INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: MCP_TOOLS.filter((t) => hasPermission(principal, t.permission)).map(describeTool) },
      };
    case "tools/call":
      return await callTool(id, params, principal);
    default:
      return rpcError(id, METHOD_NOT_FOUND, `method not found: ${method}`);
  }
}

async function callTool(
  id: string | number,
  params: unknown,
  principal: Parameters<(typeof MCP_TOOLS)[number]["run"]>[0],
): Promise<RpcResponse> {
  const call = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() }).safeParse(params);
  if (!call.success) return rpcError(id, INVALID_PARAMS, "tools/call needs a tool name and object arguments");
  const tool = MCP_TOOLS.find((t) => t.name === call.data.name);
  if (!tool) return rpcError(id, INVALID_PARAMS, `unknown tool: ${call.data.name}`);
  if (!hasPermission(principal, tool.permission)) {
    return toolResult(id, { ok: false, message: `403 ${missingPermissionMessage(tool.permission)}` });
  }

  const args = tool.input.safeParse(call.data.arguments ?? {});
  if (!args.success) {
    const why = args.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ");
    return toolResult(id, { ok: false, message: `invalid arguments — ${why}` });
  }
  try {
    return toolResult(id, await tool.run(principal, args.data as never));
  } catch (err) {
    // Never echo the thrown message: it can carry a path, a URL or a credential.
    console.error(`[mcp] tool ${tool.name} failed: ${err instanceof Error ? err.name : "error"}`);
    return rpcError(id, INTERNAL_ERROR, "internal error");
  }
}

function toolResult(
  id: string | number,
  outcome: { ok: true; data: Record<string, unknown> } | { ok: false; message: string },
): RpcResponse {
  if (!outcome.ok) {
    return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: outcome.message }] } };
  }
  return {
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: JSON.stringify(outcome.data) }], structuredContent: outcome.data },
  };
}

async function readBounded(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  return Buffer.byteLength(text) > MAX_BODY_BYTES ? null : text;
}

async function serve(request: Request): Promise<Response> {
  const auth = await authenticateApiKeyOnly(request);
  if (!auth.ok) return auth.response;

  if (request.method.toUpperCase() !== "POST") {
    return jsonError(HTTP_METHOD_NOT_ALLOWED, "this MCP server answers POST only (no server stream, no session)", {
      allow: "POST",
    });
  }
  const version = request.headers.get("mcp-protocol-version");
  if (version !== null && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    return jsonError(HTTP_BAD_REQUEST, `unsupported MCP-Protocol-Version: ${version.slice(0, 40)}`);
  }

  const text = await readBounded(request);
  if (text === null) return jsonError(HTTP_PAYLOAD_TOO_LARGE, "request body is too large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return rpcHttp(rpcError(null, PARSE_ERROR, "invalid JSON"), HTTP_BAD_REQUEST);
  }

  if (Array.isArray(body)) {
    if (body.length === 0) return rpcHttp(rpcError(null, INVALID_REQUEST, "empty batch"), HTTP_BAD_REQUEST);
    if (body.length > MAX_BATCH) {
      return rpcHttp(rpcError(null, INVALID_REQUEST, `a batch holds at most ${MAX_BATCH} messages`), HTTP_BAD_REQUEST);
    }
    const answers: RpcResponse[] = [];
    for (const message of body) {
      const answer = await handleMessage(message, auth.principal);
      if (answer) answers.push(answer);
    }
    return answers.length === 0 ? new Response(null, { status: HTTP_ACCEPTED, headers: NO_STORE }) : rpcHttp(answers);
  }
  const answer = await handleMessage(body, auth.principal);
  return answer ? rpcHttp(answer) : new Response(null, { status: HTTP_ACCEPTED, headers: NO_STORE });
}

export async function handleMcpRequest(request: Request): Promise<Response> {
  try {
    return await serve(request);
  } catch (err) {
    console.error(`[mcp] unhandled: ${err instanceof Error ? err.name : "error"}`);
    return jsonError(HTTP_INTERNAL_SERVER_ERROR, "internal error");
  }
}
