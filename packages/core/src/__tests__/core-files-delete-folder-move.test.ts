// `DELETE /v1/files`, `POST /v1/files/folder` and `POST /v1/files/move` (issue 557).
//
// Over a real HTTP server and a real disk, in the daemon's own process (the metal shape);
// that the same operations run as `core` in the container is `core-files-as-core.test.ts`'s.
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreFilesRequestHandler } from "../core-files-routes";
import { WorkspaceWriteLocks } from "../files-transfer-locks";
import { cleanupTrees, makeTree } from "./files-fixture";

let server: http.Server;
let base: string;
let home: string;
let locks: WorkspaceWriteLocks;

beforeEach(async () => {
  home = makeTree();
  locks = new WorkspaceWriteLocks();
  const routes = createCoreFilesRequestHandler({ filesPort: { workspaceRoot: () => home }, locks });
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

type Answer = { status: number; body: Record<string, unknown> };

function call(method: string, url: string, body?: unknown): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = http.request(`${base}${url}`, { method, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

const exists = (...segments: string[]): boolean => fs.existsSync(path.join(home, ...segments));

describe("DELETE /v1/files", () => {
  it("deletes a file", async () => {
    fs.writeFileSync(path.join(home, "a.txt"), "a");

    const answer = await call("DELETE", "/v1/files?path=a.txt");

    expect(answer).toEqual({ status: 200, body: { path: "a.txt", kind: "file", deleted: true } });
    expect(exists("a.txt")).toBe(false);
  });

  it("deletes a folder and everything in it when the path ends in a slash", async () => {
    fs.mkdirSync(path.join(home, "shared", "old", "deep"), { recursive: true });
    fs.writeFileSync(path.join(home, "shared", "old", "deep", "x.txt"), "x");
    fs.writeFileSync(path.join(home, "shared", "keep.txt"), "k");

    const answer = await call("DELETE", "/v1/files?path=shared%2Fold%2F");

    expect(answer).toEqual({ status: 200, body: { path: "shared/old", kind: "directory", deleted: true } });
    expect(exists("shared", "old")).toBe(false);
    expect(exists("shared", "keep.txt")).toBe(true);
  });

  it("refuses a folder named without the trailing slash, and deletes nothing", async () => {
    fs.mkdirSync(path.join(home, "src"));
    fs.writeFileSync(path.join(home, "src", "a.ts"), "a");

    const answer = await call("DELETE", "/v1/files?path=src");

    expect(answer.status).toBe(400);
    expect(answer.body.code).toBe("bad-request");
    expect(String(answer.body.error)).toContain("end the path with /");
    expect(exists("src", "a.ts")).toBe(true);
  });

  it("refuses a slash on a file", async () => {
    fs.writeFileSync(path.join(home, "a.txt"), "a");

    const answer = await call("DELETE", "/v1/files?path=a.txt%2F");

    expect(answer.status).toBe(400);
    expect(String(answer.body.error)).toContain("is not a folder");
    expect(exists("a.txt")).toBe(true);
  });

  it.each(["", ".", "./", "%2F.", "shared%2F..%2F"])("refuses the home itself, spelt %j", async (spelt) => {
    fs.mkdirSync(path.join(home, "shared"));
    fs.writeFileSync(path.join(home, "shared", "x.txt"), "x");
    fs.writeFileSync(path.join(home, "a.txt"), "a");

    const answer = await call("DELETE", `/v1/files?path=${spelt}`);

    // `%2F.` is absolute and `shared/../` has a `..`: either way it is refused, and the
    // home and its contents are all still there.
    expect(answer.status).toBe(400);
    expect(["malformed-path", "absolute-path", "dot-dot-segment"]).toContain(answer.body.code);
    expect(exists("shared", "x.txt")).toBe(true);
    expect(exists("a.txt")).toBe(true);
  });

  it("says the home cannot be deleted when the path is empty or a dot", async () => {
    for (const spelt of ["", ".", "./", "%2E%2F"]) {
      const answer = await call("DELETE", `/v1/files?path=${spelt}`);
      expect(answer.status, spelt).toBe(400);
      expect(answer.body.code, spelt).toBe("malformed-path");
      expect(String(answer.body.error), spelt).toContain("the home itself cannot be deleted");
    }
    expect(fs.existsSync(home)).toBe(true);
  });

  it("404s a path that is not there", async () => {
    const answer = await call("DELETE", "/v1/files?path=missing.txt");

    expect(answer.status).toBe(404);
    expect(answer.body.code).toBe("not-found");
  });

  it("is refused while a transfer holds the write lease, and deletes nothing", async () => {
    fs.writeFileSync(path.join(home, "a.txt"), "a");
    locks.acquire("shared/big");

    const answer = await call("DELETE", "/v1/files?path=a.txt");

    expect(answer.status).toBe(409);
    expect(answer.body.code).toBe("transfer-in-progress");
    expect(exists("a.txt")).toBe(true);
  });

  it("releases the lease when it is done", async () => {
    fs.writeFileSync(path.join(home, "a.txt"), "a");
    await call("DELETE", "/v1/files?path=a.txt");
    expect(locks.current()).toBeNull();
  });
});

describe("POST /v1/files/folder", () => {
  it("creates a folder and its parents", async () => {
    const answer = await call("POST", "/v1/files/folder?path=shared%2Freports%2F2026");

    expect(answer).toEqual({ status: 201, body: { path: "shared/reports/2026", created: true } });
    expect(fs.statSync(path.join(home, "shared", "reports", "2026")).isDirectory()).toBe(true);
  });

  it("answers 200 and changes nothing for a folder that is already there", async () => {
    fs.mkdirSync(path.join(home, "shared"));
    fs.writeFileSync(path.join(home, "shared", "x.txt"), "x");

    const answer = await call("POST", "/v1/files/folder?path=shared");

    expect(answer).toEqual({ status: 200, body: { path: "shared", created: false } });
    expect(exists("shared", "x.txt")).toBe(true);
  });

  it("refuses a name that is a file, and the home", async () => {
    fs.writeFileSync(path.join(home, "a.txt"), "a");

    const file = await call("POST", "/v1/files/folder?path=a.txt");
    const root = await call("POST", "/v1/files/folder?path=");

    expect(file.status).toBe(400);
    expect(String(file.body.error)).toContain("is not a folder");
    expect(root.status).toBe(400);
    expect(root.body.code).toBe("malformed-path");
    expect(fs.readFileSync(path.join(home, "a.txt"), "utf8")).toBe("a");
  });

  it("is POST only", async () => {
    const answer = await call("GET", "/v1/files/folder?path=x");
    expect(answer.status).toBe(405);
    expect(exists("x")).toBe(false);
  });
});

describe("POST /v1/files/move", () => {
  it("renames a file in place", async () => {
    fs.writeFileSync(path.join(home, "a.txt"), "a");

    const answer = await call("POST", "/v1/files/move", { from: "a.txt", to: "b.txt" });

    expect(answer).toEqual({ status: 200, body: { from: "a.txt", to: "b.txt", moved: true } });
    expect(exists("a.txt")).toBe(false);
    expect(fs.readFileSync(path.join(home, "b.txt"), "utf8")).toBe("a");
  });

  it("moves a folder, with its contents, into another folder", async () => {
    fs.mkdirSync(path.join(home, "inbox", "batch"), { recursive: true });
    fs.writeFileSync(path.join(home, "inbox", "batch", "r.md"), "r");
    fs.mkdirSync(path.join(home, "shared"));

    const answer = await call("POST", "/v1/files/move", { from: "inbox/batch", to: "shared/batch" });

    expect(answer.status).toBe(200);
    expect(fs.readFileSync(path.join(home, "shared", "batch", "r.md"), "utf8")).toBe("r");
    expect(exists("inbox", "batch")).toBe(false);
  });

  it("does not overwrite: an existing destination is refused and both sides are untouched", async () => {
    fs.writeFileSync(path.join(home, "a.txt"), "a");
    fs.writeFileSync(path.join(home, "b.txt"), "b");

    const answer = await call("POST", "/v1/files/move", { from: "a.txt", to: "b.txt" });

    expect(answer.status).toBe(409);
    expect(String(answer.body.error)).toContain("does not overwrite");
    expect(fs.readFileSync(path.join(home, "a.txt"), "utf8")).toBe("a");
    expect(fs.readFileSync(path.join(home, "b.txt"), "utf8")).toBe("b");
  });

  it("refuses a folder into itself, a missing source, a missing destination folder and the home", async () => {
    fs.mkdirSync(path.join(home, "d"));
    fs.writeFileSync(path.join(home, "a.txt"), "a");

    expect((await call("POST", "/v1/files/move", { from: "d", to: "d/inside" })).status).toBe(400);
    expect((await call("POST", "/v1/files/move", { from: "missing", to: "x" })).status).toBe(404);
    expect((await call("POST", "/v1/files/move", { from: "a.txt", to: "nope/a.txt" })).status).toBe(404);
    expect((await call("POST", "/v1/files/move", { from: "", to: "x" })).body.code).toBe("malformed-path");
    expect((await call("POST", "/v1/files/move", { from: "a.txt", to: "." })).body.code).toBe("malformed-path");
    expect(exists("d")).toBe(true);
    expect(exists("a.txt")).toBe(true);
  });

  it("refuses a body that is not {from, to}", async () => {
    expect((await call("POST", "/v1/files/move", "not json")).status).toBe(400);
    expect((await call("POST", "/v1/files/move", { from: "a" })).status).toBe(400);
    expect((await call("POST", "/v1/files/move", { from: 1, to: 2 })).status).toBe(400);
  });
});
