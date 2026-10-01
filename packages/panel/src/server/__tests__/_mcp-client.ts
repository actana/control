import { expect } from "vitest";

/**
 * A client of the Panel's `/mcp` endpoint that speaks the way `claude mcp add
 * --transport http` does (MCP 2025-06-18, Streamable HTTP): every message is a
 * `POST /mcp` with `Authorization: Bearer <key>`, `Accept: application/json,
 * text/event-stream` and `Content-Type: application/json`; `initialize` goes
 * first, `notifications/initialized` after it, and later requests carry the
 * negotiated `MCP-Protocol-Version`. It keeps no session id because the server
 * issues none.
 */

const ORIGIN = "http://panel.example.test";

export type ToolResult = {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
};

export type RpcReply = { jsonrpc: "2.0"; id: number | string | null; result?: any; error?: { code: number; message: string } };

export async function postMcp(
  key: string | null,
  body: unknown,
  extraHeaders: Record<string, string> = {},
  method = "POST",
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...extraHeaders,
  };
  if (key !== null) headers.authorization = `Bearer ${key}`;
  // Loaded here, not at the top: the test file sets the data-dir env before the router is first imported.
  const { handleApiRequest } = await import("../api-router");
  const response = await handleApiRequest(
    new Request(`${ORIGIN}/mcp`, {
      method,
      headers,
      ...(method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }),
  );
  if (!response) throw new Error("no response for /mcp");
  return response;
}

export class McpTestClient {
  private nextId = 1;
  private protocolVersion: string | null = null;

  constructor(private readonly key: string) {}

  private headers(): Record<string, string> {
    return this.protocolVersion ? { "mcp-protocol-version": this.protocolVersion } : {};
  }

  async rpc(method: string, params?: unknown): Promise<RpcReply> {
    const res = await postMcp(
      this.key,
      { jsonrpc: "2.0", id: this.nextId++, method, ...(params === undefined ? {} : { params }) },
      this.headers(),
    );
    expect(res.status, `${method} status`).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("mcp-session-id")).toBeNull();
    return (await res.json()) as RpcReply;
  }

  /** `initialize` then `notifications/initialized`, as a client does on connect. */
  async connect(): Promise<RpcReply> {
    const init = await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "test" },
    });
    this.protocolVersion = init.result.protocolVersion;
    const note = await postMcp(this.key, { jsonrpc: "2.0", method: "notifications/initialized" }, this.headers());
    expect(note.status).toBe(202);
    return init;
  }

  async listTools(): Promise<{ name: string; description: string; inputSchema: any; annotations?: any }[]> {
    return (await this.rpc("tools/list")).result.tools;
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const reply = await this.rpc("tools/call", { name, arguments: args });
    if (reply.error) throw new Error(`protocol error ${reply.error.code}: ${reply.error.message}`);
    return reply.result as ToolResult;
  }
}

/** The parsed JSON a tool returned, or the text of its error. */
export const dataOf = (r: ToolResult): any => JSON.parse(r.content[0]!.text);
export const textOf = (r: ToolResult): string => r.content[0]!.text;
