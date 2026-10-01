import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";

/**
 * API keys over HTTP (#572), through the real router: create, list and revoke
 * with the Operator's session, then the Cores routes with a key. The Done-when
 * lines live here: a key restricted to Core A gets a 403 on Core B, and a
 * revoked key gets a 401.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-api-keys-api-test-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const testDb = await openPanelTestDb();
const { operatorSessionCookie } = await import("./_operator-session");
const { resetOperatorSessionForTests } = await import("./_operator-session");

const ORIGIN = "http://panel.example.test";

async function call(
  pathname: string,
  init: { method?: string; json?: unknown; cookie?: boolean; bearer?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...init.headers };
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

const createKey = async (body: Record<string, unknown>) => {
  const res = await call("/api/api-keys", { method: "POST", json: body, cookie: true });
  expect(res.status).toBe(201);
  return (await res.json()) as { key: string; apiKey: { id: string; prefix: string; coreIds: string[] } };
};

async function seedCores() {
  await operatorSessionCookie();
  await testDb.pool.query("alter table operator drop constraint if exists operator_single_row");
  await testDb.pool.query(
    "insert into operator (id, name, password_hash, created_at, password_changed_at) values (2, 'B', 'h', 1, 1) on conflict do nothing",
  );
  for (const [id, owner] of [["core-a", 1], ["core-b", 1], ["core-x", 2]] as const) {
    await testDb.pool.query(
      "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ($1, $2, $1, $3, 1, 1)",
      [id, owner, `https://${id}`],
    );
  }
}

beforeAll(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
});
beforeEach(async () => {
  await resetPanelState(testDb);
  resetOperatorSessionForTests();
  await seedCores();
});
afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("creating, listing and revoking keys", () => {
  it("needs the Operator's session", async () => {
    expect((await call("/api/api-keys")).status).toBe(401);
    expect((await call("/api/api-keys", { method: "POST", json: { name: "k" } })).status).toBe(401);
    expect((await call("/api/api-keys/key-x/revoke", { method: "POST" })).status).toBe(401);
  });

  it("returns the plaintext once, with no-store, and never again", async () => {
    const res = await call("/api/api-keys", { method: "POST", json: { name: "ci" }, cookie: true });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { key, apiKey } = (await res.json()) as { key: string; apiKey: Record<string, unknown> };
    expect(key).toMatch(/^ak_1_/);
    expect(apiKey).toMatchObject({ name: "ci", allCores: true, coreIds: [], revokedAt: null });
    expect(Object.keys(apiKey).sort()).toEqual(["allCores", "coreIds", "createdAt", "id", "name", "prefix", "revokedAt"]);
    const listed = await (await call("/api/api-keys", { cookie: true })).text();
    expect(listed).not.toContain(key);
    expect(listed).not.toContain(key.slice("ak_1_".length));
    expect(JSON.parse(listed).apiKeys).toHaveLength(1);
  });

  it("refuses a bad body and a Core that is not the Operator's", async () => {
    expect((await call("/api/api-keys", { method: "POST", json: { name: "" }, cookie: true })).status).toBe(400);
    expect((await call("/api/api-keys", { method: "POST", json: { name: "k", coreIds: [] }, cookie: true })).status).toBe(400);
    expect((await call("/api/api-keys", { method: "POST", json: { name: "k", coreIds: ["core-x"] }, cookie: true })).status).toBe(400);
    expect((await call("/api/api-keys/nope/revoke", { method: "POST", cookie: true })).status).toBe(404);
  });

  it("never lets a key manage keys, not even its own", async () => {
    const { key, apiKey } = await createKey({ name: "k" });
    expect((await call("/api/api-keys", { bearer: key })).status).toBe(403);
    expect((await call("/api/api-keys", { method: "POST", json: { name: "more" }, bearer: key })).status).toBe(403);
    expect((await call(`/api/api-keys/${apiKey.id}/revoke`, { method: "POST", bearer: key })).status).toBe(403);
    expect((await call("/api/cores", { bearer: key })).status).toBe(200);
  });
});

describe("a key restricted to Core A", () => {
  it("lists Core A only, reads Core A, and gets a 403 on Core B", async () => {
    const { key } = await createKey({ name: "a only", coreIds: ["core-a"] });
    const list = await call("/api/cores", { bearer: key });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { cores: { id: string }[] }).cores.map((c) => c.id)).toEqual(["core-a"]);
    const a = await call("/api/cores/core-a", { bearer: key });
    expect(a.status).toBe(200);
    expect(((await a.json()) as { core: { id: string } }).core.id).toBe("core-a");
    const b = await call("/api/cores/core-b", { bearer: key });
    expect(b.status).toBe(403);
    expect(((await b.json()) as { error: string }).error).toMatch(/does not reach/);
  });

  it("gets the same 403 on a Core that does not exist, and on another owner's Core", async () => {
    const { key } = await createKey({ name: "a only", coreIds: ["core-a"] });
    expect((await call("/api/cores/core-nope", { bearer: key })).status).toBe(403);
    expect((await call("/api/cores/core-x", { bearer: key })).status).toBe(403);
  });
});

describe("a key with no restriction", () => {
  it("reaches every Core of its owner and no other owner's", async () => {
    const { key } = await createKey({ name: "all" });
    const list = await call("/api/cores", { bearer: key });
    expect(((await list.json()) as { cores: { id: string }[] }).cores.map((c) => c.id).sort()).toEqual(["core-a", "core-b"]);
    expect((await call("/api/cores/core-b", { bearer: key })).status).toBe(200);
    expect((await call("/api/cores/core-x", { bearer: key })).status).toBe(404);
  });
});

describe("a revoked key", () => {
  it("gets a 401 at once on every route, and a restricted one too", async () => {
    const all = await createKey({ name: "all" });
    const one = await createKey({ name: "one", coreIds: ["core-a"] });
    expect((await call("/api/cores", { bearer: all.key })).status).toBe(200);
    for (const k of [all, one]) {
      const revoked = await call(`/api/api-keys/${k.apiKey.id}/revoke`, { method: "POST", cookie: true });
      expect(revoked.status).toBe(200);
      expect(((await revoked.json()) as { apiKey: { revokedAt: number } }).apiKey.revokedAt).toBeGreaterThan(0);
    }
    for (const k of [all, one]) {
      expect((await call("/api/cores", { bearer: k.key })).status).toBe(401);
      expect((await call("/api/cores/core-a", { bearer: k.key })).status).toBe(401);
      expect((await call("/api/api-keys", { bearer: k.key })).status).toBe(401);
    }
  });

  it("is not un-revoked by revoking again, and stays revoked in the list", async () => {
    const k = await createKey({ name: "k" });
    const first = await call(`/api/api-keys/${k.apiKey.id}/revoke`, { method: "POST", cookie: true });
    const second = await call(`/api/api-keys/${k.apiKey.id}/revoke`, { method: "POST", cookie: true });
    expect(((await second.json()) as { apiKey: { revokedAt: number } }).apiKey.revokedAt).toBe(
      ((await first.json()) as { apiKey: { revokedAt: number } }).apiKey.revokedAt,
    );
    expect((await call("/api/cores", { bearer: k.key })).status).toBe(401);
  });
});

describe("what a key presents is judged by the key alone", () => {
  it("answers 401 to an unknown or malformed key, even with a valid session cookie beside it", async () => {
    const real = await createKey({ name: "k" });
    for (const bearer of ["ak_1_" + "A".repeat(43), "ak_", "ak_1_short", "ak_9_" + "A".repeat(43), real.key + "x"]) {
      expect((await call("/api/cores", { bearer, cookie: true })).status, bearer).toBe(401);
      expect((await call("/api/cores", { bearer })).status, bearer).toBe(401);
    }
  });

  it("leaves a Bearer token that is not key-shaped to the session gate, as before", async () => {
    for (const bearer of ["garbage", ""]) {
      expect((await call("/api/cores", { bearer })).status, bearer).toBe(401);
      expect((await call("/api/cores", { bearer, cookie: true })).status, bearer).toBe(200);
    }
  });

  it("answers 403, not the Operator's surface, to a key on a route that does not accept keys", async () => {
    const { key } = await createKey({ name: "k" });
    expect((await call("/api/cores/core-a", { method: "DELETE", bearer: key })).status).toBe(403);
    expect((await call("/api/cores/core-a", { method: "PATCH", json: { label: "x" }, bearer: key })).status).toBe(403);
    expect((await call("/api/cores/pairing", { method: "POST", json: {}, bearer: key })).status).toBe(403);
    expect((await call("/api/settings", { bearer: key })).status).toBe(403);
    expect((await call("/api/projects", { bearer: key })).status).toBe(403);
    const left = await call("/api/cores/core-a", { cookie: true });
    expect(left.status).toBe(200);
  });

  it("runs the call as the key's owner, not as the session", async () => {
    // Owner 2's key, presented with the Operator's cookie beside it: the key wins.
    const { key } = await (async () => {
      const { createApiKey } = await import("../services/api-keys");
      return createApiKey(2, { name: "b" });
    })();
    const list = await call("/api/cores", { bearer: key, cookie: true });
    expect(((await list.json()) as { cores: { id: string }[] }).cores.map((c) => c.id)).toEqual(["core-x"]);
    expect((await call("/api/cores/core-a", { bearer: key, cookie: true })).status).toBe(404);
  });
});

describe("the session cookie path", () => {
  it("is unchanged: 401 without a session, and the whole fleet with one", async () => {
    expect((await call("/api/cores")).status).toBe(401);
    expect((await call("/api/cores/core-a")).status).toBe(401);
    const list = await call("/api/cores", { cookie: true });
    expect(((await list.json()) as { cores: { id: string }[] }).cores.map((c) => c.id).sort()).toEqual(["core-a", "core-b"]);
    expect((await call("/api/cores/core-b", { cookie: true })).status).toBe(200);
    expect((await call("/api/cores/core-x", { cookie: true })).status).toBe(404);
    expect((await call("/api/cores/core-b", { method: "PATCH", json: { label: "renamed" }, cookie: true })).status).toBe(200);
  });
});

describe("the plaintext in the logs", () => {
  it("is in no stored row and in no console line, whatever the outcome", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const { key, apiKey } = await createKey({ name: "quiet", coreIds: ["core-a"] });
    await call("/api/cores", { bearer: key });
    await call("/api/cores/core-b", { bearer: key });
    await call("/api/settings", { bearer: key });
    await call(`/api/api-keys/${apiKey.id}/revoke`, { method: "POST", cookie: true });
    await call("/api/cores", { bearer: key });
    await call("/api/cores", { bearer: `${key}x` });
    const logged = spies.flatMap((s) => s.mock.calls).map((args) => args.map(String).join(" ")).join("\n");
    for (const s of spies) s.mockRestore();
    const secret = key.slice("ak_1_".length);
    expect(logged).not.toContain(secret);
    for (const table of ["api_keys", "api_key_cores", "cores", "operator", "panel_sessions"]) {
      const { rows } = await testDb.pool.query(`select * from ${table}`);
      expect(JSON.stringify(rows), table).not.toContain(secret);
    }
  });
});
