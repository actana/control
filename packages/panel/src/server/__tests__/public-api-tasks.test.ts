import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";

/**
 * Public `/api/v1` Tasks and comments (#572 PR 2): create, list, status moves
 * (only assigned and draft), comments and Comment & re-assign, all as the
 * key's owner through the Tasks service.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-public-api-tasks-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const testDb = await openPanelTestDb();
const { operatorSessionCookie, resetOperatorSessionForTests } = await import("./_operator-session");
const tasksService = await import("../services/tasks");

const ORIGIN = "http://panel.example.test";
const A = 1;

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
  const res = await call("/api/api-keys", { method: "POST", json: body, cookie: true });
  expect(res.status).toBe(201);
  return (await res.json()) as { key: string };
};

beforeAll(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
});
beforeEach(async () => {
  await resetPanelState(testDb);
  resetOperatorSessionForTests();
  await operatorSessionCookie();
  await testDb.pool.query(
    "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ('core-a', 1, 'a', 'https://a', 1, 1), ('core-b', 1, 'b', 'https://b', 1, 1)",
  );
  await testDb.pool.query(
    "insert into agents (id, owner_id, core_id, name, harness, flags, is_default, created_at, updated_at) values ('agent-a', 1, 'core-a', 'A', 'claude-code', '{}', true, 1, 1)",
  );
});
afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("v1 Tasks", () => {
  it("creates a draft and an assigned Task, and lists them", async () => {
    const { key } = await createKey();
    const draft = await call("/api/v1/tasks", {
      method: "POST",
      bearer: key,
      json: { title: " Draft ", coreId: "core-a", agent: "agent-a" },
    });
    expect(draft.status).toBe(201);
    expect(((await draft.json()) as { task: { status: string; title: string } }).task).toMatchObject({
      title: "Draft",
      status: "draft",
    });
    const started = await call("/api/v1/tasks", {
      method: "POST",
      bearer: key,
      json: { title: "Go", coreId: "core-a", agent: "agent-a", startNow: true },
    });
    expect(((await started.json()) as { task: { status: string } }).task.status).toBe("assigned");
    const list = await call("/api/v1/tasks", { bearer: key });
    expect(((await list.json()) as { tasks: unknown[] }).tasks.length).toBe(2);
  });

  it("takes only assigned and draft on the status route", async () => {
    const { key } = await createKey();
    const t = (
      (await (
        await call("/api/v1/tasks", {
          method: "POST",
          bearer: key,
          json: { title: "m", coreId: "core-a", agent: "agent-a" },
        })
      ).json()) as { task: { id: string } }
    ).task;
    expect(
      (
        await (
          await call(`/api/v1/tasks/${t.id}/status`, { method: "POST", bearer: key, json: { status: "assigned" } })
        ).json()
      ).task.status,
    ).toBe("assigned");
    expect(
      (
        await (
          await call(`/api/v1/tasks/${t.id}/status`, { method: "POST", bearer: key, json: { status: "draft" } })
        ).json()
      ).task.status,
    ).toBe("draft");
    for (const status of ["in_progress", "done", "failed", "partial"]) {
      expect(
        (await call(`/api/v1/tasks/${t.id}/status`, { method: "POST", bearer: key, json: { status } })).status,
      ).toBe(400);
    }
  });

  it("adds a comment and lists it, and Comment & re-assign goes through the service", async () => {
    const { key } = await createKey();
    const t = (
      (await (
        await call("/api/v1/tasks", {
          method: "POST",
          bearer: key,
          json: { title: "talk", coreId: "core-a", agent: "agent-a", startNow: true },
        })
      ).json()) as { task: { id: string } }
    ).task;
    const added = await call(`/api/v1/tasks/${t.id}/comments`, {
      method: "POST",
      bearer: key,
      json: { body: "first" },
    });
    expect(added.status).toBe(201);
    const listed = await call(`/api/v1/tasks/${t.id}/comments`, { bearer: key });
    expect(((await listed.json()) as { comments: { body: string }[] }).comments.map((c) => c.body)).toEqual([
      "first",
    ]);

    const refused = await call(`/api/v1/tasks/${t.id}/comments`, {
      method: "POST",
      bearer: key,
      json: { body: "again", reassign: true },
    });
    expect(refused.status).toBe(409);

    await tasksService.claimTask(A, t.id);
    await tasksService.applyTaskResult(A, t.id, {
      to: "failed",
      authorName: "claude-code",
      body: "broke",
      sourceFile: "fail.md",
    });
    const ok = await (
      await call(`/api/v1/tasks/${t.id}/comments`, {
        method: "POST",
        bearer: key,
        json: { body: "try again", reassign: true },
      })
    ).json();
    expect(ok.task.status).toBe("assigned");
    expect(ok.comments.map((c: { body: string }) => c.body)).toEqual(["first", "broke", "try again"]);
  });

  it("answers 409 when the service refuses an illegal move", async () => {
    const { key } = await createKey();
    const t = (
      (await (
        await call("/api/v1/tasks", {
          method: "POST",
          bearer: key,
          json: { title: "m", coreId: "core-a", agent: "agent-a" },
        })
      ).json()) as { task: { id: string } }
    ).task;
    const bad = await call(`/api/v1/tasks/${t.id}/status`, {
      method: "POST",
      bearer: key,
      json: { status: "draft" },
    });
    expect(bad.status).toBe(409);
  });
});
