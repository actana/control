// `GET /v1/projects/:projectId/files/list` over a real HTTP server (#166 F7).
//
// Plain `http` here rather than `https`, for the same reason
// `core-files-routes.test.ts` uses it: this suite is about the route, and the
// mTLS half — one listener, one certificate, one bearer, two protocols — is
// `core-files-mtls.test.ts` against a real `PtyCoreLinkServer`. Splitting them
// keeps each failure legible.
//
// Confinement has a suite of its own (`files-listing-confinement.test.ts`),
// deliberately: #166 asks for the routes ticket's rules to be **tested
// independently rather than inherited on trust**, and a listing route that
// shares a confinement call with the read route is exactly the arrangement in
// which nobody notices the day it stops sharing it.
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoreFilesRequestHandler, type CoreFilesPort } from "../core-files-routes";
import { cleanupTrees, makeTree } from "./files-fixture";

let server: http.Server;
let base: string;
let projects: Record<string, string> = {};

const filesPort: CoreFilesPort = { projectRoot: (id) => projects[id] ?? null };

function startServer(opts: Parameters<typeof createCoreFilesRequestHandler>[0] = { filesPort }): Promise<void> {
  const routes = createCoreFilesRequestHandler(opts);
  server = http.createServer();
  server.on("request", (req, res) => {
    if (routes.handle(req, res)) return;
    res.writeHead(404).end();
  });
  return new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      resolve();
    });
  });
}

beforeEach(async () => {
  projects = {};
  await startServer();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanupTrees();
});

type Response = { status: number; headers: http.IncomingHttpHeaders; body: Buffer; chunks: number };

/** `agent: false` throughout — see the note in `core-files-routes.test.ts`. */
function call(method: string, url: string, headers: Record<string, string> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${url}`, { method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
          chunks: chunks.length,
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function ndjson(body: Buffer): Array<Record<string, unknown>> {
  return body
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function json(body: Buffer): Record<string, unknown> {
  return JSON.parse(body.toString("utf8")) as Record<string, unknown>;
}

function entries(body: Buffer): Array<Record<string, unknown>> {
  return ndjson(body).filter((line) => line.type === "entry");
}

function project(id: string, tree: Parameters<typeof makeTree>[0] = {}): string {
  const root = makeTree(tree);
  projects[id] = root;
  return root;
}

const listed = (body: Buffer): string[] => entries(body).map((entry) => String(entry.path)).sort();

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

// ─── The stream ──────────────────────────────────────────────────────────────

describe("the listing stream", () => {
  it("answers NDJSON, chunked, and says which kind of transfer it is", async () => {
    project("p1", { "a.txt": "a" });

    const res = await call("GET", "/v1/projects/p1/files/list");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/x-ndjson");
    expect(res.headers["transfer-encoding"]).toBe("chunked");
    expect(res.headers["content-length"]).toBeUndefined();
    expect(res.headers["x-actana-transfer-kind"]).toBe("listing");
  });

  it("lists a Project's tree to arbitrary depth, one line per entry", async () => {
    project("p1", { "a.txt": "a", "src/index.ts": "x", "src/deep/deeper/leaf.txt": "l" });

    const res = await call("GET", "/v1/projects/p1/files/list");

    expect(listed(res.body)).toEqual(["a.txt", "src", "src/deep", "src/deep/deeper", "src/deep/deeper/leaf.txt", "src/index.ts"]);
  });

  it("carries {path, size, mtime, mode, sha256} on every entry — the shape F10 fixes", async () => {
    const root = project("p1");
    fs.writeFileSync(path.join(root, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    fs.chmodSync(path.join(root, "run.sh"), 0o755);
    const stats = fs.statSync(path.join(root, "run.sh"));

    const res = await call("GET", "/v1/projects/p1/files/list");

    expect(entries(res.body)).toEqual([
      {
        type: "entry",
        path: "run.sh",
        kind: "file",
        size: 10,
        mtime: Math.floor(stats.mtimeMs),
        mode: 0o755,
        sha256: null,
      },
    ]);
  });

  it("closes with a done line counting what it produced", async () => {
    project("p1", { "a.txt": "aaaa", "b/c.txt": "bb" });

    const res = await call("GET", "/v1/projects/p1/files/list");

    const lines = ndjson(res.body);
    expect(lines.at(-1)).toEqual({ type: "done", entries: 3, skipped: 0, bytes: 6 });
  });

  it("lists a subtree, with every path still relative to the Project root", async () => {
    project("p1", { "src/lib/util.ts": "u", "elsewhere.txt": "e" });

    const res = await call("GET", "/v1/projects/p1/files/list?path=src");

    // `src/lib/util.ts`, not `lib/util.ts`: the string that comes back is the
    // string that goes to `GET ?path=` (ADR 0027 D2).
    expect(listed(res.body)).toEqual(["src/lib", "src/lib/util.ts"]);
  });

  it("lists a single file when the path names one", async () => {
    project("p1", { "notes.md": "hello" });

    const res = await call("GET", "/v1/projects/p1/files/list?path=notes.md");

    expect(entries(res.body)).toEqual([expect.objectContaining({ path: "notes.md", kind: "file", size: 5 })]);
  });

  it("answers an empty Project with a done line and nothing else", async () => {
    project("p1");

    const res = await call("GET", "/v1/projects/p1/files/list");

    expect(ndjson(res.body)).toEqual([{ type: "done", entries: 0, skipped: 0, bytes: 0 }]);
  });

  it("answers HEAD with the headers and no body, without walking anything", async () => {
    project("p1", { "a.txt": "a" });

    const res = await call("HEAD", "/v1/projects/p1/files/list");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/x-ndjson");
    expect(res.body.length).toBe(0);
  });
});

// ─── Depth and digests ───────────────────────────────────────────────────────

describe("depth", () => {
  const tree = { "top.txt": "t", "one/mid.txt": "m", "one/two/leaf.txt": "l" };

  it("bounds the walk when asked", async () => {
    project("p1", tree);

    const res = await call("GET", "/v1/projects/p1/files/list?depth=1");

    expect(listed(res.body)).toEqual(["one", "top.txt"]);
  });

  it("takes the whole tree for depth=all, which is also the default", async () => {
    project("p1", tree);

    const explicit = await call("GET", "/v1/projects/p1/files/list?depth=all");
    const implied = await call("GET", "/v1/projects/p1/files/list");

    expect(listed(explicit.body)).toEqual(["one", "one/mid.txt", "one/two", "one/two/leaf.txt", "top.txt"]);
    expect(listed(implied.body)).toEqual(listed(explicit.body));
  });

  it("refuses a depth it does not understand rather than quietly listing everything", async () => {
    project("p1", tree);

    const res = await call("GET", "/v1/projects/p1/files/list?depth=two");

    expect(res.status).toBe(400);
    expect(json(res.body).code).toBe("bad-request");
  });

  it("refuses depth=0 and a negative depth, which name no listing at all", async () => {
    project("p1", tree);

    expect((await call("GET", "/v1/projects/p1/files/list?depth=0")).status).toBe(400);
    expect((await call("GET", "/v1/projects/p1/files/list?depth=-1")).status).toBe(400);
  });
});

describe("sha256 — on request, not eagerly (ADR 0027 D6)", () => {
  it("is null on every entry by default, because a listing does not have the bytes in hand", async () => {
    project("p1", { "a.txt": "a", "b/c.txt": "c" });

    const res = await call("GET", "/v1/projects/p1/files/list");

    expect(entries(res.body).every((entry) => entry.sha256 === null)).toBe(true);
  });

  it("is computed when the client asks for it", async () => {
    project("p1", { "a.txt": "hello" });

    const res = await call("GET", "/v1/projects/p1/files/list?sha256=1");

    expect(entries(res.body)[0]).toMatchObject({
      path: "a.txt",
      // sha256 of "hello"
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    });
  });

  it("keeps the field present either way, so a reader never has to feature-detect it", async () => {
    project("p1", { "a.txt": "hello" });

    const without = entries((await call("GET", "/v1/projects/p1/files/list")).body)[0]!;
    const with256 = entries((await call("GET", "/v1/projects/p1/files/list?sha256=1")).body)[0]!;

    expect("sha256" in without).toBe(true);
    expect(Object.keys(without).sort()).toEqual(Object.keys(with256).sort());
  });

  it("refuses a value it does not understand rather than reading it as no", async () => {
    project("p1", { "a.txt": "a" });

    const res = await call("GET", "/v1/projects/p1/files/list?sha256=yes");

    expect(res.status).toBe(400);
    expect(json(res.body).code).toBe("bad-request");
  });
});

// ─── Refusals ────────────────────────────────────────────────────────────────

describe("refusals", () => {
  it("404s an unknown Project, with the same code the read route uses", async () => {
    const res = await call("GET", "/v1/projects/nope/files/list");

    expect(res.status).toBe(404);
    expect(json(res.body).code).toBe("project-not-found");
  });

  it("404s a path that is not there, before the stream starts rather than as a line in it", async () => {
    project("p1");

    const res = await call("GET", "/v1/projects/p1/files/list?path=missing");

    expect(res.status).toBe(404);
    expect(json(res.body)).toMatchObject({ code: "not-found" });
    // A status and not an NDJSON `error` line: nothing has been written yet, so
    // the honest answer is still available.
    expect(res.headers["content-type"]).toBe("application/json");
  });

  it("405s a write to the listing route rather than creating a file called `list`", async () => {
    project("p1");

    const res = await call("PUT", "/v1/projects/p1/files/list");

    expect(res.status).toBe(405);
    expect(json(res.body)).toMatchObject({ code: "method-not-allowed" });
    expect(String(json(res.body).error)).toContain("GET, HEAD");
    expect(fs.existsSync(path.join(projects.p1!, "list"))).toBe(false);
  });

  it("404s a leaf under `files` that is not `list`, so the surface stays a closed list", async () => {
    project("p1");

    expect((await call("GET", "/v1/projects/p1/files/listing")).status).toBe(404);
    expect((await call("GET", "/v1/projects/p1/files/list/more")).status).toBe(404);
  });

  it("requires the bearer when the Core's core link does", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await startServer({
      filesPort,
      authVerifier: (bearer) =>
        bearer === "good" ? { ok: true, coreId: "c1", exp: 0 } : { ok: false, reason: "bad-signature" },
    });
    project("p1", { "a.txt": "a" });

    const anonymous = await call("GET", "/v1/projects/p1/files/list");
    const authorised = await call("GET", "/v1/projects/p1/files/list", { authorization: "Bearer good" });

    expect(anonymous.status).toBe(401);
    expect(json(anonymous.body).code).toBe("unauthorized");
    expect(authorised.status).toBe(200);
  });
});

// ─── Nothing is buffered ─────────────────────────────────────────────────────

describe("a large tree is streamed, not assembled", () => {
  /**
   * A wide, shallow tree — enough entries that a buffered answer is obvious.
   *
   * Wide rather than deep, and one directory rather than several thousand:
   * building it is the expensive part of these tests, and 4000 files in one
   * folder also exercises the `opendir` batching that keeps a single huge
   * directory from being read into memory in one go.
   */
  function wideProject(id: string, count = 4000): void {
    const tree: Record<string, string> = {};
    for (let i = 0; i < count; i += 1) tree[`pkg/module-${String(i).padStart(4, "0")}.js`] = "x";
    project(id, tree);
  }

  /** A deep tree, for the case where what leaks is a handle per level. */
  function deepProject(id: string, count = 400): void {
    const tree: Record<string, string> = {};
    for (let i = 0; i < count; i += 1) {
      tree[`pkg/module-${String(i).padStart(4, "0")}/src/lib/index.js`] = "x";
    }
    project(id, tree);
  }

  it("sends the first entries long before the walk has finished", async () => {
    wideProject("p1");

    const firstLine = await new Promise<{ line: Record<string, unknown>; complete: boolean }>((resolve, reject) => {
      const req = http.request(`${base}/v1/projects/p1/files/list`, { agent: false }, (res) => {
        res.once("data", (chunk: Buffer) => {
          // `res.complete` is false while the body is still arriving. Reading a
          // line here is reading it *during* the walk, which is the claim.
          const line = JSON.parse(chunk.toString("utf8").split("\n")[0]!) as Record<string, unknown>;
          const complete = res.complete;
          req.destroy();
          resolve({ line, complete });
        });
        res.on("error", () => {});
      });
      req.on("error", () => {});
      req.setTimeout(10_000, () => reject(new Error("no line arrived")));
      req.end();
    });

    expect(firstLine.line).toMatchObject({ type: "entry" });
    expect(firstLine.complete).toBe(false);
  }, 30_000);

  it("arrives in many chunks, which a response built in memory would not", async () => {
    wideProject("p1");

    const res = await call("GET", "/v1/projects/p1/files/list");

    // 4001 entries is a few hundred kilobytes of NDJSON. One chunk would mean
    // the whole listing was held somewhere before any of it was sent.
    expect(entries(res.body)).toHaveLength(4001);
    expect(res.chunks).toBeGreaterThan(1);
  }, 30_000);

  // The read side of the leak `core-files-abort.test.ts` found on the write
  // side: a handler suspended on a backpressured socket that is then destroyed
  // never runs its `finally`, and for a listing the resource at stake is a
  // directory handle on every level of the walk.
  it.skipIf(process.platform !== "linux")("leaves no directory handle open when the client walks away", async () => {
    deepProject("p1");
    const root = projects.p1!;

    const openUnderRoot = (): string[] =>
      fs
        .readdirSync("/proc/self/fd")
        .map((fd) => {
          try {
            return fs.readlinkSync(`/proc/self/fd/${fd}`);
          } catch {
            return "";
          }
        })
        .filter((target) => target === root || target.startsWith(`${root}/`));

    expect(openUnderRoot()).toEqual([]);
    let sawOneInFlight = false;

    await new Promise<void>((resolve) => {
      const req = http.request(`${base}/v1/projects/p1/files/list`, { agent: false }, (res) => {
        // Never read it. That is what backs the response up and parks the
        // handler inside `drained`, which is the state the abort has to unwind.
        res.pause();
        res.on("error", () => {});
        const sampling = setInterval(() => {
          if (openUnderRoot().length > 0) sawOneInFlight = true;
        }, 25);
        setTimeout(() => {
          clearInterval(sampling);
          req.destroy();
          resolve();
        }, 300);
      });
      req.on("error", () => resolve());
      req.end();
    });

    await new Promise((resolve) => setTimeout(resolve, 400));

    // The positive control, before the assertion that trusts the instrument.
    expect(sawOneInFlight).toBe(true);
    expect(openUnderRoot()).toEqual([]);
  }, 20_000);
});

// ─── A walk that stops part-way ──────────────────────────────────────────────

describe("a listing that fails after the 200 is spent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The one fault a real tree cannot be asked to produce.
   *
   * Everything a walk can blame on a single path is a `skipped` line and the
   * listing carries on — an unreadable directory, a file whose bytes will not
   * digest, an entry that vanished mid-walk — and those are tested against a
   * real filesystem in `files-listing.test.ts`. What is left is the directory
   * *read itself* failing part-way: an `EIO` off a dying disk, an `ENFILE`, a
   * network mount going away underneath the walk. There is no way to ask a
   * kernel for that on demand, so it is injected at exactly the syscall that
   * raises it in production — `opendir`'s iteration — and nothing else here is
   * faked: a real server, a real tree, real entries out of the real handle
   * until the fault lands.
   *
   * It earns a test because the response is already `200` by then, so the
   * failure has to travel as the last line of the body, and #167's reader is
   * the thing that meets it (`docs/external-api.md`, the Listing section).
   */
  function failReadingDirectoriesAfter(entries: number): void {
    const realOpendir = fs.promises.opendir.bind(fs.promises);
    vi.spyOn(fs.promises, "opendir").mockImplementation(async (dirPath: fs.PathLike, options?: fs.OpenDirOptions) => {
      const dir = await realOpendir(dirPath as string, options as fs.OpenDirOptions);
      return {
        path: dir.path,
        close: () => dir.close(),
        async *[Symbol.asyncIterator]() {
          let seen = 0;
          for await (const child of dir) {
            if (seen >= entries) {
              const err = new Error(`EIO: i/o error, scandir '${dir.path}'`);
              (err as NodeJS.ErrnoException).code = "EIO";
              throw err;
            }
            seen += 1;
            yield child;
          }
        },
      } as unknown as fs.Dir;
    });
  }

  it("sends the failure as an error line, because the status line is already gone", async () => {
    project("p1", { "a.txt": "a", "b.txt": "b", "c.txt": "c", "d.txt": "d" });
    failReadingDirectoriesAfter(2);

    const res = await call("GET", "/v1/projects/p1/files/list");

    // The 200 and its headers went out with the first line and cannot be taken
    // back — which is the whole reason this line type exists.
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/x-ndjson");
    const lines = ndjson(res.body);
    expect(lines.at(-1)).toMatchObject({ type: "error", code: "read-failed" });
    expect(String(lines.at(-1)!.message)).toContain("EIO");
  });

  it("ends there — no done line, so a truncated listing is never mistaken for a whole one", async () => {
    project("p1", { "a.txt": "a", "b.txt": "b", "c.txt": "c", "d.txt": "d" });
    failReadingDirectoriesAfter(2);

    const res = await call("GET", "/v1/projects/p1/files/list");

    const lines = ndjson(res.body);
    // The assertion #167's reader depends on: `done` is the only proof a
    // listing is complete, so it must be absent exactly when the tree is not.
    expect(lines.filter((line) => line.type === "done")).toEqual([]);
    expect(lines.filter((line) => line.type === "error")).toHaveLength(1);
  });

  it("keeps the entries it had already produced, because NDJSON is readable up to where it stops", async () => {
    project("p1", { "a.txt": "a", "b.txt": "b", "c.txt": "c", "d.txt": "d" });
    failReadingDirectoriesAfter(2);

    const res = await call("GET", "/v1/projects/p1/files/list");

    // Two real entries out of the real directory handle, then the fault. A
    // reader that stopped at the error line still has a valid partial tree —
    // it just may not call it the tree.
    expect(entries(res.body)).toHaveLength(2);
    for (const entry of entries(res.body)) {
      expect(entry).toMatchObject({ kind: "file", size: 1 });
      expect(String(entry.path)).toMatch(/^[abcd]\.txt$/);
    }
  });

  // `skipIf(isRoot)`, like the skip cases in `files-listing.test.ts`: a mode of
  // `000` does not stop uid 0 from reading the directory, and the case would
  // fail for a reason that has nothing to do with the listing.
  it.skipIf(isRoot)("is the walk stopping, not one path failing: a skip leaves the done line where it was", async () => {
    const root = project("p1", { "a.txt": "a", "vendor/locked/x.txt": "x" });
    fs.chmodSync(path.join(root, "vendor/locked"), 0o000);
    try {
      const res = await call("GET", "/v1/projects/p1/files/list");

      const lines = ndjson(res.body);
      expect(lines.filter((line) => line.type === "error")).toEqual([]);
      expect(lines.filter((line) => line.type === "skipped")).toHaveLength(1);
      // The contrast that gives `error` its meaning: a failure the walk can
      // blame on one path costs that path and nothing else.
      expect(lines.at(-1)).toMatchObject({ type: "done", skipped: 1 });
    } finally {
      fs.chmodSync(path.join(root, "vendor/locked"), 0o700);
    }
  });
});
