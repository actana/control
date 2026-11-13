import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";

/**
 * The Panel's own Agent routes (#893 p2): create, change and delete one Agent
 * of one Core, as the signed-in owner, with a second owner's Core and Agent in
 * the same tables. The rules are the service's; what is asserted here is that
 * the routes ask it as the right owner, for the Core in the path, and report
 * the same `code`s the v1 routes do.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-panel-agents-api-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const testDb = await openPanelTestDb();
const { operatorSessionCookie, resetOperatorSessionForTests } = await import("./_operator-session");
const { coreLinkManager, resetCoreLinkManagerForTests } = await import("../services/core-link-manager");

type Availability = Record<string, { status: string; reason?: string }>;
let availability: Availability = {};
let linkUp = true;

async function call(pathname: string, init: { method?: string; json?: unknown; anonymous?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (!init.anonymous) headers.cookie = await operatorSessionCookie();
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const res = await handleApiRequest(
    new Request(`http://panel.example.test${pathname}`, {
      method: init.method ?? "GET",
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    }),
  );
  if (!res) throw new Error(`no API response for ${pathname}`);
  return res;
}

async function seedAgent(id: string, owner: number, coreId: string, name: string, isDefault = false) {
  await testDb.pool.query(
    "insert into agents (id, owner_id, core_id, name, harness, model, flags, is_default, created_at, updated_at) values ($1,$2,$3,$4,'claude-code','opus','{}',$5,1,1)",
    [id, owner, coreId, name, isDefault],
  );
}

beforeAll(async () => {
  await operatorSessionCookie();
});

beforeEach(async () => {
  await resetPanelState(testDb);
  resetOperatorSessionForTests();
  resetCoreLinkManagerForTests();
  await operatorSessionCookie();
  await testDb.pool.query("alter table operator drop constraint if exists operator_single_row");
  await testDb.pool.query(
    "insert into operator (id, name, password_hash, created_at, password_changed_at) values (2, 'owner-2', 'h', 1, 1) on conflict do nothing",
  );
  await testDb.pool.query(
    "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ('core-a', 1, 'a', 'https://a', 1, 1), ('core-a2', 1, 'a2', 'https://a2', 1, 1), ('core-b', 2, 'b', 'https://b', 1, 1)",
  );
  await seedAgent("agent-a", 1, "core-a", "Mine");
  await seedAgent("agent-a-default", 1, "core-a", "claude-code", true);
  await seedAgent("agent-a2", 1, "core-a2", "Other Core");
  await seedAgent("agent-b", 2, "core-b", "Theirs");
  availability = { "claude-code": { status: "available" }, codex: { status: "available" } };
  linkUp = true;
  vi.spyOn(coreLinkManager(), "client").mockImplementation(
    () =>
      (linkUp
        ? { request: async () => ({ type: "agentsAvailabilityListResult", availability }) }
        : null) as never,
  );
});

afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("POST /api/cores/:id/agents", () => {
  it("needs the operator's session", async () => {
    const res = await call("/api/cores/core-a/agents", {
      anonymous: true,
      method: "POST",
      json: { name: "X", harness: "claude-code" },
    });
    expect(res.status).toBe(401);
  });

  it("creates an Agent on the Core in the path, for the signed-in owner", async () => {
    const res = await call("/api/cores/core-a/agents", {
      method: "POST",
      json: { name: "Reviewer", harness: "claude-code", model: "claude-opus-4-1", flags: ["skip-permissions"] },
    });
    expect(res.status).toBe(201);
    const { agent } = (await res.json()) as { agent: Record<string, unknown> };
    expect(agent).toMatchObject({
      coreId: "core-a",
      name: "Reviewer",
      harness: "claude-code",
      model: "claude-opus-4-1",
      flags: ["skip-permissions"],
      isDefault: false,
    });
    const rows = await testDb.pool.query("select owner_id from agents where id = $1", [agent.id]);
    expect(rows.rows[0].owner_id).toBe(1);
  });

  it("is a 404 on another owner's Core and writes nothing", async () => {
    const res = await call("/api/cores/core-b/agents", { method: "POST", json: { name: "X", harness: "claude-code" } });
    expect(res.status).toBe(404);
    const rows = await testDb.pool.query("select count(*)::int as n from agents where core_id = 'core-b'");
    expect(rows.rows[0].n).toBe(1);
  });

  it("answers 409 core_harnesses_unavailable when the Core cannot be asked", async () => {
    linkUp = false;
    const res = await call("/api/cores/core-a/agents", { method: "POST", json: { name: "X", harness: "claude-code" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "core_harnesses_unavailable" });
  });

  it("answers 409 harness_missing_on_core, and says 'not ready yet' for a harness still checking", async () => {
    availability = { "claude-code": { status: "available" }, codex: { status: "checking" }, pi: { status: "missing", reason: "not-found" } };
    const checking = await call("/api/cores/core-a/agents", { method: "POST", json: { name: "X", harness: "codex" } });
    expect(checking.status).toBe(409);
    const checkingBody = (await checking.json()) as { code: string; error: string };
    expect(checkingBody.code).toBe("harness_missing_on_core");
    expect(checkingBody.error).toContain("not ready yet (checking)");
    const missing = await call("/api/cores/core-a/agents", { method: "POST", json: { name: "X", harness: "pi" } });
    const missingBody = (await missing.json()) as { code: string; error: string };
    expect(missingBody.code).toBe("harness_missing_on_core");
    expect(missingBody.error).not.toContain("not ready yet");
  });

  it("refuses a name already on the Core (409) and bad input (400), including a free-form command", async () => {
    expect((await call("/api/cores/core-a/agents", { method: "POST", json: { name: "Mine", harness: "claude-code" } })).status).toBe(409);
    expect((await call("/api/cores/core-a/agents", { method: "POST", json: { name: "", harness: "claude-code" } })).status).toBe(400);
    expect((await call("/api/cores/core-a/agents", { method: "POST", json: { name: "X", harness: "nope" } })).status).toBe(400);
    expect(
      (await call("/api/cores/core-a/agents", { method: "POST", json: { name: "X", harness: "claude-code", flags: ["rm -rf"] } })).status,
    ).toBe(400);
    for (const extra of [{ command: "rm -rf /" }, { args: ["-x"] }, { env: { A: "b" } }, { coreId: "core-b" }]) {
      const res = await call("/api/cores/core-a/agents", { method: "POST", json: { name: "X", harness: "claude-code", ...extra } });
      expect(res.status).toBe(400);
    }
  });
});

describe("PATCH /api/cores/:id/agents/:agentId", () => {
  it("changes name, model and flags in place; the id stays; null clears the model", async () => {
    const res = await call("/api/cores/core-a/agents/agent-a", {
      method: "PATCH",
      json: { name: "Renamed", model: "claude-sonnet-4-5", flags: ["skip-permissions"] },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agent: unknown }).agent).toMatchObject({
      id: "agent-a",
      name: "Renamed",
      model: "claude-sonnet-4-5",
      flags: ["skip-permissions"],
      harness: "claude-code",
      coreId: "core-a",
    });
    const cleared = await call("/api/cores/core-a/agents/agent-a", { method: "PATCH", json: { model: null } });
    expect(((await cleared.json()) as { agent: { model: unknown; name: string } }).agent).toMatchObject({ model: null, name: "Renamed" });
  });

  it("refuses a harness or Core change and unknown fields (400)", async () => {
    for (const json of [{ harness: "codex" }, { coreId: "core-a2" }, { command: "x" }, {}]) {
      expect((await call("/api/cores/core-a/agents/agent-a", { method: "PATCH", json })).status).toBe(400);
    }
  });

  it("refuses a default Agent (409), and a name already on the Core (409)", async () => {
    const def = await call("/api/cores/core-a/agents/agent-a-default", { method: "PATCH", json: { model: "x" } });
    expect(def.status).toBe(409);
    expect(((await def.json()) as { error: string }).error).toContain("default Agent");
    await seedAgent("agent-a-3", 1, "core-a", "Third");
    expect((await call("/api/cores/core-a/agents/agent-a-3", { method: "PATCH", json: { name: "Mine" } })).status).toBe(409);
  });

  it("is a 404 for another owner's Agent, an unknown Agent, and an Agent on a different Core than the path", async () => {
    expect((await call("/api/cores/core-b/agents/agent-b", { method: "PATCH", json: { model: "x" } })).status).toBe(404);
    expect((await call("/api/cores/core-a/agents/agent-b", { method: "PATCH", json: { model: "x" } })).status).toBe(404);
    expect((await call("/api/cores/core-a/agents/nope", { method: "PATCH", json: { model: "x" } })).status).toBe(404);
    expect((await call("/api/cores/core-a/agents/agent-a2", { method: "PATCH", json: { model: "x" } })).status).toBe(404);
    const rows = await testDb.pool.query("select model from agents where id in ('agent-b','agent-a2')");
    expect(rows.rows.map((r) => (r as { model: string }).model)).toEqual(["opus", "opus"]);
  });

  it("needs the operator's session", async () => {
    expect((await call("/api/cores/core-a/agents/agent-a", { anonymous: true, method: "PATCH", json: { model: "x" } })).status).toBe(401);
  });
});

describe("DELETE /api/cores/:id/agents/:agentId", () => {
  it("deletes an Agent (204)", async () => {
    expect((await call("/api/cores/core-a/agents/agent-a", { method: "DELETE" })).status).toBe(204);
    const rows = await testDb.pool.query("select id from agents where id = 'agent-a'");
    expect(rows.rows).toEqual([]);
  });

  it("refuses a default Agent (409) with its reason", async () => {
    const res = await call("/api/cores/core-a/agents/agent-a-default", { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("default Agent");
  });

  it("is a 404 for another owner's Agent and one on a different Core than the path, and deletes nothing", async () => {
    expect((await call("/api/cores/core-b/agents/agent-b", { method: "DELETE" })).status).toBe(404);
    expect((await call("/api/cores/core-a/agents/agent-a2", { method: "DELETE" })).status).toBe(404);
    const rows = await testDb.pool.query("select id from agents where id in ('agent-b','agent-a2')");
    expect(rows.rows).toHaveLength(2);
  });

  it("needs the operator's session", async () => {
    expect((await call("/api/cores/core-a/agents/agent-a", { anonymous: true, method: "DELETE" })).status).toBe(401);
  });
});

describe("GET /api/cores/:id/agents", () => {
  it("carries each Agent's flags, so the edit form starts from what is stored", async () => {
    await testDb.pool.query("update agents set flags = '{skip-permissions}' where id = 'agent-a'");
    const { agents } = (await (await call("/api/cores/core-a/agents")).json()) as { agents: { id: string; flags?: string[] }[] };
    expect(agents.find((a) => a.id === "agent-a")?.flags).toEqual(["skip-permissions"]);
  });
});
