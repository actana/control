// The `/v1/projects/:id/files` alias (issue 557): the published SDK's Files client still builds
// that address from a Project id, and the Panel and the image smoke reach the Core through it.
// It is kept as a thin alias onto the `/v1/files` handlers, ignores the id, and is removed with
// actana/client#10 part 4. These tests are the alias's whole contract and go with it.
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

describe("the /v1/projects/:id/files alias", () => {
  it("reads, lists and writes the home under any id, as /v1/files does: the id names nothing", async () => {
    // The alias answers what the route it stands for answers.
    expect(await call("GET", "/v1/files?path=a.txt")).toEqual({ status: 200, text: "from the home" });
    for (const id of ["p1", "nope", "any-id-at-all"]) {
      const read = await call("GET", `/v1/projects/${id}/files?path=a.txt`);
      expect(read).toEqual({ status: 200, text: "from the home" });

      const list = await call("GET", `/v1/projects/${id}/files/list?path=shared`);
      expect(list.status).toBe(200);
      expect(list.text).toContain('"path":"shared/r.md"');
    }
    const write = await call("PUT", "/v1/projects/whatever/files?path=shared%2Fnew.txt", "written through the alias");
    expect(write.status).toBe(200);
    expect(fs.readFileSync(path.join(home, "shared", "new.txt"), "utf8")).toBe("written through the alias");
  });

  it("is the same handler as /v1/files: the same refusals, with the same codes", async () => {
    const viaAlias = await call("GET", "/v1/projects/p1/files?path=..%2Fx");
    const direct = await call("GET", "/v1/files?path=..%2Fx");

    expect(viaAlias).toEqual(direct);
    expect(viaAlias.status).toBe(400);
    expect(JSON.parse(viaAlias.text).code).toBe("dot-dot-segment");
  });

  it("does not offer what the SDK never sent: no delete, no folder, no move through an address that implies a Project", async () => {
    // /v1/files has all three; the alias has none of them.
    expect((await call("POST", "/v1/files/folder?path=made")).status).toBe(201);
    const del = await call("DELETE", "/v1/projects/p1/files?path=a.txt");
    const folder = await call("POST", "/v1/projects/p1/files/folder?path=x");
    const move = await call("POST", "/v1/projects/p1/files/move", JSON.stringify({ from: "a.txt", to: "b.txt" }));

    expect(del.status).toBe(405);
    expect([folder.status, move.status]).toEqual([404, 404]);
    expect(fs.existsSync(path.join(home, "a.txt"))).toBe(true);
    expect(fs.existsSync(path.join(home, "x"))).toBe(false);
  });

  it("is only the two addresses the SDK builds", async () => {
    expect((await call("GET", "/v1/files/list?path=")).status).toBe(200);
    expect((await call("GET", "/v1/projects/p1/files/other")).status).toBe(404);
    expect((await call("GET", "/v1/projects/p1")).status).toBe(404);
    expect((await call("GET", "/v1/projects/files?path=a.txt")).status).toBe(404);
    expect((await call("GET", "/v1/widgets/p1/files?path=a.txt")).status).toBe(404);
  });
});
