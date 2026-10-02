// The Panel's `/api/cores/:coreId/projects/:projectId/files` route is retired (#580 T-404, the
// leftover of #560). A Core has no Projects, the Panel's UI has none, and the only caller left was
// the in-repo sdk's suites, which are deleted. A route the Panel no longer takes is refused the
// way ADR 0041 D27 says: a 404 `not found` from the router, with nothing resolved and nothing
// sent to any Core. (Before, the same request resolved a Core and answered `no-such-core` here.)
import { afterAll, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb } from "./_panel-test-db";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-core-project-files-retired-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const testDb = await openPanelTestDb();
const { operatorSessionCookie } = await import("./_operator-session");

async function call(pathname: string, method: string): Promise<Response> {
  const response = await handleApiRequest(
    new Request(`http://panel.example.test${pathname}`, {
      method,
      headers: { cookie: await operatorSessionCookie() },
      ...(method === "PUT" ? { body: "bytes" } : {}),
    }),
  );
  if (!response) throw new Error(`no API response for ${pathname}`);
  return response;
}

afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("the retired Panel project Files route", () => {
  it.each([
    ["GET", "/api/cores/core_1/projects/p1/files?path=a.txt"],
    ["PUT", "/api/cores/core_1/projects/p1/files?path=a.txt"],
    ["GET", "/api/cores/core_1/projects/p1/files/list?path="],
  ])("refuses %s %s with the router's 404, before any Core is looked up", async (method, url) => {
    const response = await call(url, method);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });
});
