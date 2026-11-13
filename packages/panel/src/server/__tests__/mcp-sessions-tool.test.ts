import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_API_KEY_PERMISSIONS } from "~/shared/api-key-permissions";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";
import { McpTestClient, dataOf, textOf } from "./_mcp-client";

/** The `get_sessions` tool (#960): the same page as `GET /api/v1/sessions`, lean, with the key's Core scope. */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-mcp-sessions-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const testDb = await openPanelTestDb();
const { operatorSessionCookie, resetOperatorSessionForTests } = await import("./_operator-session");
const { createApiKey } = await import("../services/api-keys");
const { coreLinkManager, resetCoreLinkManagerForTests } = await import("../services/core-link-manager");

let frames: Record<string, unknown>[] = [];

async function client(coreIds?: string[]): Promise<McpTestClient> {
  const { key } = await createApiKey(1, { name: "k", permissions: ALL_API_KEY_PERMISSIONS, ...(coreIds ? { coreIds } : {}) });
  const c = new McpTestClient(key);
  await c.connect();
  return c;
}

beforeAll(() => fs.mkdirSync(tmpRoot, { recursive: true }));
beforeEach(async () => {
  await resetPanelState(testDb);
  resetOperatorSessionForTests();
  resetCoreLinkManagerForTests();
  await operatorSessionCookie();
  await testDb.pool.query(
    "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ('core-a', 1, 'a', 'https://a', 1, 1), ('core-b', 1, 'b', 'https://b', 1, 1)",
  );
  frames = [];
  vi.spyOn(coreLinkManager(), "client").mockImplementation(
    () =>
      ({
        request: async (frame: Record<string, unknown>) => {
          frames.push(frame);
          return {
            type: "sessionsListResult",
            sessions: [{ sessionId: "s1", ptyId: null, title: "Fix it", agent: "codex", status: "finished", pinned: false, archived: false, updatedAt: 5 }],
            nextCursor: null,
            total: 1,
          } as never;
        },
      }) as never,
  );
});
afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("get_sessions", () => {
  it("is listed as a read-only tool that needs a coreId", async () => {
    const tool = (await (await client()).listTools()).find((t) => t.name === "get_sessions")!;
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.inputSchema.required).toEqual(["coreId"]);
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(["archived", "coreId", "cursor", "harness", "limit", "q", "status"]);
  });

  it("returns the lean page with nextCursor and total, and asks the Core for exactly that page", async () => {
    const c = await client();
    const result = await c.call("get_sessions", { coreId: "core-a", limit: 10, status: "finished", q: "fix" });
    expect(dataOf(result)).toEqual({
      sessions: [{ id: "s1", title: "Fix it", harness: "codex", status: "finished", pinned: false, archived: false, live: false, updatedAt: 5 }],
      nextCursor: null,
      total: 1,
    });
    expect(frames).toEqual([{ type: "sessionsList", limit: 10, status: "finished", archived: false, q: "fix" }]);
    // Lean: nothing like a prompt or transcript comes back.
    expect(textOf(result)).not.toMatch(/prompt|transcript/i);
  });

  it("limits a key to its Cores and refuses a bad cursor", async () => {
    const c = await client(["core-a"]);
    const outside = await c.call("get_sessions", { coreId: "core-b" });
    expect(outside.isError).toBe(true);
    expect(textOf(outside)).toMatch(/^403/);
    const bad = await c.call("get_sessions", { coreId: "core-a", cursor: "garbage" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/^400/);
    expect(frames).toEqual([]);
  });
});
