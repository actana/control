// What the Panel's delete relies on in the Core's Files API to empty `~/shared` (#564, ADR 0041 D12, D38).
//
// The Panel (`core-machine-folder.ts`) lists the home to look at `shared`, lists `shared`, and deletes each child. It
// is safe only because of what the Core does with a symlink, so that is pinned here over the real handler and a real disk,
// in the daemon's own process.
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreFilesRequestHandler } from "../core-files-routes";
import { cleanupTrees, makeTree } from "./files-fixture";

let server: http.Server;
let base: string;
let home: string;
let outside: string;

beforeEach(async () => {
  home = makeTree();
  outside = makeTree({ "keep.txt": "mine", "deep/inner.txt": "inner" });
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

async function call(method: string, url: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}${url}`, { method });
  return { status: res.status, text: await res.text() };
}

async function entries(homePath: string): Promise<Array<{ path: string; kind: string }>> {
  const answer = await call("GET", `/v1/files/list?path=${encodeURIComponent(homePath)}&depth=1`);
  expect(answer.status).toBe(200);
  return answer.text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { type: string; path: string; kind: string })
    .filter((line) => line.type === "entry");
}

describe("what the delete of a Core's ~/shared relies on", () => {
  it("lists a symlinked ~/shared as a symlink, and a symlink inside it as one, without walking through either", async () => {
    fs.mkdirSync(path.join(home, "real"));
    fs.writeFileSync(path.join(home, "real", "x.txt"), "x");
    fs.symlinkSync(path.join(home, "real"), path.join(home, "shared"));
    expect((await entries("")).find((e) => e.path === "shared")?.kind).toBe("symlink");

    fs.rmSync(path.join(home, "shared"));
    fs.mkdirSync(path.join(home, "shared"));
    fs.symlinkSync(outside, path.join(home, "shared", "out"));
    expect((await entries("")).find((e) => e.path === "shared")?.kind).toBe("directory");
    expect(await entries("shared")).toEqual([expect.objectContaining({ path: "shared/out", kind: "symlink" })]);
  });

  it("deletes a symlink in ~/shared as a link: the file or folder it points at is untouched", async () => {
    fs.mkdirSync(path.join(home, "shared"));
    fs.symlinkSync(outside, path.join(home, "shared", "to-folder"));
    fs.symlinkSync(path.join(outside, "keep.txt"), path.join(home, "shared", "to-file"));

    expect((await call("DELETE", "/v1/files?path=shared/to-folder")).status).toBe(200);
    expect((await call("DELETE", "/v1/files?path=shared/to-file")).status).toBe(200);

    expect(fs.readdirSync(path.join(home, "shared"))).toEqual([]);
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("mine");
    expect(fs.readFileSync(path.join(outside, "deep", "inner.txt"), "utf8")).toBe("inner");
  });

  it("deletes a folder with a symlink inside it without following the link", async () => {
    fs.mkdirSync(path.join(home, "shared", "sub"), { recursive: true });
    fs.symlinkSync(outside, path.join(home, "shared", "sub", "out"));
    fs.writeFileSync(path.join(home, "shared", "sub", "a.txt"), "a");

    expect((await call("DELETE", "/v1/files?path=shared/sub/")).status).toBe(200);

    expect(fs.existsSync(path.join(home, "shared", "sub"))).toBe(false);
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("mine");
    expect(fs.readFileSync(path.join(outside, "deep", "inner.txt"), "utf8")).toBe("inner");
  });

  it("refuses a path through a link that leaves the home, so a link cannot send the delete outside it", async () => {
    fs.symlinkSync(outside, path.join(home, "shared"));
    const answer = await call("DELETE", "/v1/files?path=shared/keep.txt");
    expect(answer.status).toBe(400);
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("mine");
  });

  it("follows a ~/shared link that stays inside the home, which is why the Panel looks at ~/shared first", async () => {
    fs.mkdirSync(path.join(home, "elsewhere"));
    fs.writeFileSync(path.join(home, "elsewhere", "precious.txt"), "p");
    fs.symlinkSync(path.join(home, "elsewhere"), path.join(home, "shared"));

    // The Core resolves the parent and deletes in the link's target: only the Panel's check of `shared` stops this.
    expect((await call("DELETE", "/v1/files?path=shared/precious.txt")).status).toBe(200);
    expect(fs.existsSync(path.join(home, "elsewhere", "precious.txt"))).toBe(false);
    expect((await entries("")).find((e) => e.path === "shared")?.kind).toBe("symlink");
  });
});
