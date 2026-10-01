import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";
import { operatorSessionCookie } from "./_operator-session";

/**
 * `src/server.ts` is the deployed entry: its `fetch` must await the document
 * gate (#567). A dropped `await` leaves a Promise, which is always truthy, so
 * a signed-in browser would get the Promise's result (nothing) instead of the
 * app, and the gate's answer would no longer be the one that is returned.
 */

vi.mock("@tanstack/react-start/server", () => ({
  createStartHandler: () => async () => new Response("the app", { status: 200 }),
  defaultStreamHandler: () => new Response(null),
}));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-server-entry-test-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const testDb = await openPanelTestDb();
const entry = (await import("../../server")).default;

beforeEach(async () => {
  await resetPanelState(testDb);
});
afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const page = (cookie?: string) =>
  new Request("http://panel.example.test/", {
    headers: { accept: "text/html", ...(cookie ? { cookie } : {}) },
  });

describe("the server entry's document gate", () => {
  it("sends an anonymous browser to login (or setup) instead of the app", async () => {
    const res = await entry.fetch(page());
    expect(res?.status).toBe(303);
    expect(res?.headers.get("location")).toBe("/setup");
  });

  it("serves the app to a signed-in browser", async () => {
    const cookie = await operatorSessionCookie();
    const res = await entry.fetch(page(cookie));
    expect(res?.status).toBe(200);
    expect(await res?.text()).toBe("the app");
  });
});
