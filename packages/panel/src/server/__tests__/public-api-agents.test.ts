import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_API_KEY_PERMISSIONS } from "~/shared/api-key-permissions";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";

/**
 * Public `/api/v1` Agents (#572 PR 2): list, get, create and delete through the
 * Agents service, with Core scope applied. Create asks the Core which harnesses
 * it has; the test fakes that answer.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-public-api-agents-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const testDb = await openPanelTestDb();
const { operatorSessionCookie, resetOperatorSessionForTests } = await import("./_operator-session");
const { coreLinkManager, resetCoreLinkManagerForTests } = await import("../services/core-link-manager");

const ORIGIN = "http://panel.example.test";

async function call(
  pathname: string,
  init: { method?: string; json?: unknown; cookie?: boolean; bearer?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = await operatorSessionCookie();
  if (init.bearer !== undefined) headers.authorization = `Bearer ${init.bearer}`;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const response = await handleApiRequest(
    new Request(`${ORIGIN}${pathname}`, {
      method: init.method ?? "GET",
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    }),
  );
  if (!response) throw new Error(`no API response for ${pathname}`);
  return response;
}

const createKey = async (body: Record<string, unknown> = { name: "k" }) => {
  const res = await call("/api/api-keys", { method: "POST", json: { permissions: ALL_API_KEY_PERMISSIONS, ...body }, cookie: true });
  expect(res.status).toBe(201);
  return (await res.json()) as { key: string };
};

beforeAll(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
});
beforeEach(async () => {
  await resetPanelState(testDb);
  resetOperatorSessionForTests();
  resetCoreLinkManagerForTests();
  await operatorSessionCookie();
  await testDb.pool.query(
    "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ('core-a', 1, 'a', 'https://a', 1, 1), ('core-b', 1, 'b', 'https://b', 1, 1)",
  );
  await testDb.pool.query(
    "insert into agents (id, owner_id, core_id, name, harness, flags, is_default, created_at, updated_at) values ('agent-a', 1, 'core-a', 'A', 'claude-code', '{}', false, 1, 1), ('agent-b', 1, 'core-b', 'B', 'claude-code', '{}', false, 1, 1)",
  );
  vi.spyOn(coreLinkManager(), "client").mockImplementation((coreId: string) => {
    if (coreId !== "core-a" && coreId !== "core-b") return null;
    return {
      request: async () =>
        ({
          type: "agentsAvailabilityListResult",
          availability: { "claude-code": { status: "available" }, codex: { status: "available" } },
        }) as never,
    } as never;
  });
});
afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("v1 Agents", () => {
  it("lists, reads and deletes an Agent", async () => {
    const { key } = await createKey();
    const list = await call("/api/v1/agents", { bearer: key });
    expect(((await list.json()) as { agents: { id: string }[] }).agents.map((a) => a.id).sort()).toEqual([
      "agent-a",
      "agent-b",
    ]);
    const one = await call("/api/v1/agents/agent-a", { bearer: key });
    expect(((await one.json()) as { agent: { name: string } }).agent.name).toBe("A");
    expect((await call("/api/v1/agents/agent-a", { method: "DELETE", bearer: key })).status).toBe(204);
    expect((await call("/api/v1/agents/agent-a", { bearer: key })).status).toBe(404);
  });

  it("creates an Agent on a Core the key reaches", async () => {
    const { key } = await createKey({ name: "a", coreIds: ["core-a"] });
    const created = await call("/api/v1/agents", {
      method: "POST",
      bearer: key,
      json: { coreId: "core-a", name: "Reviewer", harness: "claude-code", model: "claude-opus-4-1" },
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { agent: { name: string; coreId: string } }).agent).toMatchObject({
      name: "Reviewer",
      coreId: "core-a",
    });
    expect(
      (
        await call("/api/v1/agents", {
          method: "POST",
          bearer: key,
          json: { coreId: "core-b", name: "Nope", harness: "claude-code" },
        })
      ).status,
    ).toBe(403);
  });

  it("lists a Core's Agents only when the key reaches that Core", async () => {
    const { key } = await createKey({ name: "a", coreIds: ["core-a"] });
    const a = await call("/api/v1/cores/core-a/agents", { bearer: key });
    expect(a.status).toBe(200);
    expect(((await a.json()) as { agents: { id: string }[] }).agents.some((x) => x.id === "agent-a")).toBe(true);
    expect((await call("/api/v1/cores/core-b/agents", { bearer: key })).status).toBe(403);
  });
});
