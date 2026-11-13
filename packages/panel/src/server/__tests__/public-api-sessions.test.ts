import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_API_KEY_PERMISSIONS } from "~/shared/api-key-permissions";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";

/**
 * Public `/api/v1/sessions` (#960): one page of a Core's Sessions through the
 * Core link, with the key's Core scope and the owner applied.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-public-api-sessions-"));
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
let frames: Record<string, unknown>[] = [];
let answer: (frame: Record<string, unknown>) => unknown;

beforeEach(async () => {
  await resetPanelState(testDb);
  resetOperatorSessionForTests();
  resetCoreLinkManagerForTests();
  await operatorSessionCookie();
  await testDb.pool.query(
    "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ('core-a', 1, 'a', 'https://a', 1, 1), ('core-b', 1, 'b', 'https://b', 1, 1)",
  );
  frames = [];
  answer = () => ({
    type: "sessionsListResult",
    sessions: [
      { sessionId: "s1", ptyId: "pty-1", title: "Fix it", agent: "codex", status: "running", pinned: false, archived: false, updatedAt: 5, lock: { writable: true, state: "unlocked" } },
      { sessionId: "s2", ptyId: null, title: "Done", agent: "claude-code", status: "finished", pinned: true, archived: false, updatedAt: 4 },
    ],
    nextCursor: "next-1",
    total: 42,
  });
  vi.spyOn(coreLinkManager(), "client").mockImplementation((coreId: string) => {
    if (coreId !== "core-a" && coreId !== "core-b") return null;
    return {
      request: async (frame: Record<string, unknown>) => {
        frames.push(frame);
        // Like the SDK client: an error frame is an answer, not a rejection.
        return answer(frame) as never;
      },
    } as never;
  });
});
afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("GET /api/v1/sessions", () => {
  it("needs a key or a session", async () => {
    expect((await call("/api/v1/sessions?coreId=core-a")).status).toBe(401);
  });

  it("returns one lean page with nextCursor and the true total", async () => {
    const { key } = await createKey();
    const res = await call("/api/v1/sessions?coreId=core-a&limit=2&status=running&archived=false&harness=codex&q=fix", { bearer: key });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Record<string, unknown>[]; nextCursor: string | null; total: number };
    expect(body.nextCursor).toBe("next-1");
    expect(body.total).toBe(42);
    expect(body.sessions).toEqual([
      { id: "s1", title: "Fix it", harness: "codex", status: "running", pinned: false, archived: false, live: true, updatedAt: 5 },
      { id: "s2", title: "Done", harness: "claude-code", status: "finished", pinned: true, archived: false, live: false, updatedAt: 4 },
    ]);
    expect(frames).toEqual([
      { type: "sessionsList", limit: 2, status: "running", archived: false, harness: "codex", q: "fix" },
    ]);
  });

  it("passes the cursor through and defaults the page to 25 rows", async () => {
    const { key } = await createKey();
    // A cursor this API issued: the Core's own encoding.
    const cursor = Buffer.from(JSON.stringify([1, 10, "s1"])).toString("base64url");
    await call(`/api/v1/sessions?coreId=core-a&cursor=${cursor}`, { bearer: key });
    expect(frames[0]).toMatchObject({ type: "sessionsList", limit: 25, cursor });
  });

  it.each([
    ["no coreId", "/api/v1/sessions?limit=5"],
    ["limit 0", "/api/v1/sessions?coreId=core-a&limit=0"],
    ["limit 101", "/api/v1/sessions?coreId=core-a&limit=101"],
    ["limit abc", "/api/v1/sessions?coreId=core-a&limit=abc"],
    ["a bad status", "/api/v1/sessions?coreId=core-a&status=bogus"],
    ["a bad archived", "/api/v1/sessions?coreId=core-a&archived=maybe"],
    ["a bad cursor", "/api/v1/sessions?coreId=core-a&cursor=garbage"],
  ])("answers 400 for %s, without asking the Core", async (_name, url) => {
    const { key } = await createKey();
    const res = await call(url, { bearer: key });
    expect(res.status).toBe(400);
    expect(frames).toEqual([]);
  });

  it("answers 400 when the Core itself refuses the cursor", async () => {
    const { key } = await createKey();
    answer = () => ({ type: "error", message: "invalid cursor" });
    const cursor = Buffer.from(JSON.stringify([1, 10, "s1"])).toString("base64url");
    expect((await call(`/api/v1/sessions?coreId=core-a&cursor=${cursor}`, { bearer: key })).status).toBe(400);
  });

  it("answers 502 when an older Core refuses the paging fields, not an empty list", async () => {
    const { key } = await createKey();
    answer = () => ({ type: "error", message: 'sessionsList does not take "limit": a Session belongs to the Core' });
    const res = await call("/api/v1/sessions?coreId=core-a", { bearer: key });
    expect(res.status).toBe(502);
    expect(await res.json()).not.toHaveProperty("sessions");
  });

  it("keeps to the owner and the key's Cores", async () => {
    const { key } = await createKey({ name: "a", coreIds: ["core-a"] });
    expect((await call("/api/v1/sessions?coreId=core-a", { bearer: key })).status).toBe(200);
    expect((await call("/api/v1/sessions?coreId=core-b", { bearer: key })).status).toBe(403);
    const open = await createKey({ name: "open" });
    expect((await call("/api/v1/sessions?coreId=no-such", { bearer: open.key })).status).toBe(404);
  });

  it("needs the read permission", async () => {
    const { key } = await createKey({ name: "w", permissions: ["tasks:write"] });
    expect((await call("/api/v1/sessions?coreId=core-a", { bearer: key })).status).toBe(403);
  });

  it("answers 503 when the Core is not connected", async () => {
    const { key } = await createKey();
    vi.spyOn(coreLinkManager(), "client").mockReturnValue(null);
    expect((await call("/api/v1/sessions?coreId=core-a", { bearer: key })).status).toBe(503);
  });
});
