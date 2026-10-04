// The `/v1/projects/:id/files` addresses are retired (#580 T-404, the leftover of #555 and #557).
// The published SDK builds `/v1/files`, so nothing calls the old alias any more. A Core refuses
// what it no longer takes (ADR 0041 D27) rather than answering it as the route it used to stand
// for: the handler does not claim the request, the Core answers 404 `not-found`, and nothing is
// read, listed or written. The same refusal over the real server is in `core-files-mtls.test.ts`.
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreFilesRequestHandler } from "../core-files-routes";
import { cleanupTrees, makeTree } from "./files-fixture";

let server: http.Server;
let base: string;
let home: string;

beforeEach(async () => {
  home = makeTree({ "a.txt": "from the home", "shared/r.md": "report" });
  const routes = createCoreFilesRequestHandler({ filesPort: { workspaceRoot: () => home } });
  server = http.createServer();
  server.on("request", (req, res) => {
    if (!routes.handle(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanupTrees();
});

function call(method: string, url: string, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${url}`, { method, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const RETIRED = [
  ["GET", "/v1/projects/p1/files?path=a.txt"],
  ["HEAD", "/v1/projects/p1/files?path=a.txt"],
  ["GET", "/v1/projects/p1/files/list?path=shared"],
  ["PUT", "/v1/projects/whatever/files?path=shared%2Fnew.txt"],
  ["DELETE", "/v1/projects/p1/files?path=a.txt"],
] as const;

// REGRESSION GUARDS, not fixes: these two were never part of the alias (the base's `parseRoute` gave
// them no route either) and pass on the base. They hold the line that a delete-shaped or
// folder-shaped address is not grown back under a Project-looking path.
const NEVER_ALIASED = [
  ["POST", "/v1/projects/p1/files/folder?path=x"],
  ["POST", "/v1/projects/p1/files/move"],
] as const;

describe("the retired /v1/projects/:id/files addresses", () => {
  // REGRESSION GUARD (passes on the base): the control that keeps the refusals below meaningful.
  it("still serves the home at /v1/files, which is what the published SDK builds", async () => {
    expect(await call("GET", "/v1/files?path=a.txt")).toEqual({ status: 200, text: "from the home" });
    expect((await call("GET", "/v1/files/list?path=shared")).status).toBe(200);
  });

  it.each(RETIRED)("refuses %s %s: the handler does not take it", async (method, url) => {
    const res = await call(method, url, method === "PUT" ? "written through the old address" : undefined);

    expect(res.status).toBe(404);
  });

  it.each(NEVER_ALIASED)("regression guard, passes on the base: %s %s was never served", async (method, url) => {
    expect((await call(method, url)).status).toBe(404);
  });

  it("writes nothing, deletes nothing and creates nothing through them", async () => {
    await call("PUT", "/v1/projects/whatever/files?path=shared%2Fnew.txt", "written through the old address");
    await call("DELETE", "/v1/projects/p1/files?path=a.txt");
    await call("POST", "/v1/projects/p1/files/folder?path=x");

    expect(fs.existsSync(path.join(home, "shared", "new.txt"))).toBe(false);
    expect(fs.existsSync(path.join(home, "a.txt"))).toBe(true);
    expect(fs.existsSync(path.join(home, "x"))).toBe(false);
  });

  it("does not read the id or the scope word: any `/v1/<word>/<id>/files` is the same 404", async () => {
    for (const url of ["/v1/projects/nope/files?path=a.txt", "/v1/widgets/p1/files?path=a.txt", "/v1/projects/p1"]) {
      expect((await call("GET", url)).status).toBe(404);
    }
  });
});
