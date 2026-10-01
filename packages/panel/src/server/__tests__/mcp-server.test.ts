import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";
import { McpTestClient, postMcp } from "./_mcp-client";

/**
 * The Panel's MCP server (#573), driven the way an MCP client drives it:
 * initialize, notifications/initialized, tools/list, tools/call over
 * `POST /mcp` with a Bearer API key. This file is the transport and the gate;
 * the tools have their own files.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-mcp-server-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const testDb = await openPanelTestDb();
const { operatorSessionCookie, resetOperatorSessionForTests } = await import("./_operator-session");

const ORIGIN = "http://panel.example.test";

async function createKey(body: Record<string, unknown> = { name: "k" }) {
  const res = await handleApiRequest(
    new Request(`${ORIGIN}/api/api-keys`, {
      method: "POST",
      headers: { cookie: await operatorSessionCookie(), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(res!.status).toBe(201);
  return (await res!.json()) as { key: string; apiKey: { id: string } };
}

beforeAll(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
});
beforeEach(async () => {
  await resetPanelState(testDb);
  resetOperatorSessionForTests();
  await operatorSessionCookie();
  await testDb.pool.query(
    "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ('core-a', 1, 'a', 'https://a', 1, 1), ('core-b', 1, 'b', 'https://b', 1, 1)",
  );
});
afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("stub: an MCP client connects end to end", () => {
  it("initializes, lists the tools and calls one, with a key", async () => {
    const { key } = await createKey();
    const client = new McpTestClient(key);
    const init = await client.connect();
    expect(init.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "actana-control" },
    });
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("list_cores");
    const cores = await client.call("list_cores");
    expect(cores.isError).toBeUndefined();
    expect(cores.structuredContent!.cores).toHaveLength(2);
  });
});

describe("401: the key is the whole credential", () => {
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };

  it("refuses a request with no key, with a WWW-Authenticate challenge", async () => {
    const res = await postMcp(null, initialize);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("never falls back to the Operator's session cookie", async () => {
    const res = await postMcp(null, initialize, { cookie: await operatorSessionCookie() });
    expect(res.status).toBe(401);
  });

  it("refuses a Bearer that is not a key, an unknown key and a malformed one", async () => {
    for (const bearer of ["not-a-key", "ak_unknown", "ak_"]) {
      expect((await postMcp(bearer, initialize)).status, bearer).toBe(401);
    }
  });

  it("does not let a cookie rescue a bad key", async () => {
    const res = await postMcp("ak_unknown", initialize, { cookie: await operatorSessionCookie() });
    expect(res.status).toBe(401);
  });

  it("refuses a revoked key on every method, after it worked", async () => {
    const { key, apiKey } = await createKey();
    expect((await postMcp(key, initialize)).status).toBe(200);
    const revoke = await handleApiRequest(
      new Request(`${ORIGIN}/api/api-keys/${apiKey.id}/revoke`, {
        method: "POST",
        headers: { cookie: await operatorSessionCookie() },
      }),
    );
    expect(revoke!.status).toBe(200);
    expect((await postMcp(key, initialize)).status).toBe(401);
    expect((await postMcp(key, { jsonrpc: "2.0", id: 2, method: "tools/list" })).status).toBe(401);
    expect((await postMcp(key, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_cores" } })).status).toBe(401);
    expect((await postMcp(key, "", {}, "GET")).status).toBe(401);
  });
});

describe("the transport is stateless Streamable HTTP", () => {
  it("answers GET and DELETE with 405 and Allow: POST (no server stream, no session)", async () => {
    const { key } = await createKey();
    for (const method of ["GET", "DELETE"]) {
      const res = await postMcp(key, "", { accept: "text/event-stream" }, method);
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  it("gives a notification 202 and no body, and issues no session id", async () => {
    const { key } = await createKey();
    const res = await postMcp(key, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });

  it("serves a request with no earlier initialize: nothing is remembered between requests", async () => {
    const { key } = await createKey();
    const res = await postMcp(key, { jsonrpc: "2.0", id: 7, method: "tools/list" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: number }).id).toBe(7);
  });

  it("answers a batch with a batch, and a batch of notifications with 202", async () => {
    const { key } = await createKey();
    const res = await postMcp(key, [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: number }[]).map((r) => r.id)).toEqual([1, 2]);
    expect((await postMcp(key, [{ jsonrpc: "2.0", method: "notifications/initialized" }])).status).toBe(202);
  });

  it("negotiates down to a version it supports and refuses an unsupported header", async () => {
    const { key } = await createKey();
    const old = await postMcp(key, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    expect(((await old.json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2024-11-05");
    const future = await postMcp(key, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01" } });
    expect(((await future.json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-06-18");
    const bad = await postMcp(key, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { "mcp-protocol-version": "1999-01-01" });
    expect(bad.status).toBe(400);
  });

  it("reports malformed JSON, a non-JSON-RPC body, an unknown method and an unknown tool as JSON-RPC errors", async () => {
    const { key } = await createKey();
    const garbage = await postMcp(key, "{nope");
    expect(garbage.status).toBe(400);
    expect(((await garbage.json()) as { error: { code: number } }).error.code).toBe(-32700);
    const notRpc = await postMcp(key, { hello: "world" });
    expect(((await notRpc.json()) as { error: { code: number } }).error.code).toBe(-32600);
    const method = await postMcp(key, { jsonrpc: "2.0", id: 1, method: "resources/list" });
    expect(((await method.json()) as { error: { code: number } }).error.code).toBe(-32601);
    const tool = await postMcp(key, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope" } });
    expect(((await tool.json()) as { error: { code: number } }).error.code).toBe(-32602);
  });

  it("refuses a body over the cap with 413", async () => {
    const { key } = await createKey();
    const res = await postMcp(key, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(1024 * 1024) } }));
    expect(res.status).toBe(413);
  });
});
