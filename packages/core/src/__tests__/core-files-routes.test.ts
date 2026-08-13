import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreFilesRequestHandler, type CoreFilesPort } from "../core-files-routes";
import { ProjectWriteLocks } from "../files-transfer-locks";
import { packDirectory } from "../files-tar";
import { cleanupTrees, collect, makeTree, readTree } from "./files-fixture";

// The `/v1/…` routes over a real HTTP server (#165 F2–F6, F8).
//
// Plain `http` here rather than `https`: this suite is about the routes, and
// the mTLS half — the certificate, the bearer, the fact that both protocols
// share one listener — is `core-files-mtls.test.ts`, against a real
// `PtyCoreLinkServer`. Splitting them keeps each failure legible.

let server: http.Server;
let base: string;
let projects: Record<string, string> = {};
let locks: ProjectWriteLocks;

const filesPort: CoreFilesPort = { projectRoot: (id) => projects[id] ?? null };

beforeEach(async () => {
  projects = {};
  locks = new ProjectWriteLocks();
  const routes = createCoreFilesRequestHandler({ filesPort, locks });
  server = http.createServer();
  server.on("request", (req, res) => {
    if (routes.handle(req, res)) return;
    res.writeHead(404).end();
  });
  server.on("checkContinue", (req, res) => {
    if (routes.handleContinue(req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanupTrees();
});

type Response = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

function call(
  method: string,
  url: string,
  opts: { body?: Buffer | AsyncIterable<Uint8Array>; headers?: Record<string, string> } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    // `agent: false`, in every request in this file: the global agent keeps a
    // socket pooled after the response, and `server.close()` then waits out the
    // keep-alive timeout in `afterEach` — four seconds per test, for nothing.
    const req = http.request(`${base}${url}`, { method, headers: opts.headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on("error", reject);
    if (!opts.body) return void req.end();
    if (Buffer.isBuffer(opts.body)) return void req.end(opts.body);
    void (async () => {
      for await (const chunk of opts.body as AsyncIterable<Uint8Array>) req.write(chunk);
      req.end();
    })();
  });
}

/** Parse an NDJSON progress body into its lines. */
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

function project(id: string, entries: Parameters<typeof makeTree>[0] = {}): string {
  const root = makeTree(entries);
  projects[id] = root;
  return root;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

describe("GET a file", () => {
  it("returns its raw bytes", async () => {
    project("p1", { "a.txt": "hello" });
    const res = await call("GET", "/v1/projects/p1/files?path=a.txt");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.body.toString("utf8")).toBe("hello");
  });

  it("returns the Project root as a tar when the path is a directory", async () => {
    project("p1", { "src/a.txt": "a" });
    const res = await call("GET", "/v1/projects/p1/files?path=src");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/x-tar");
    expect(res.headers["x-actana-transfer-kind"]).toBe("tar");
    // A ustar magic at the usual offset is enough to say "this is a tar" —
    // the round-trip itself is asserted in the tar suites.
    expect(res.body.subarray(257, 262).toString("ascii")).toBe("ustar");
  });

  it("carries the file's mode, mtime and size in headers so a single file round-trips too", async () => {
    const root = project("p1");
    fs.writeFileSync(path.join(root, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    fs.chmodSync(path.join(root, "run.sh"), 0o755);

    const res = await call("GET", "/v1/projects/p1/files?path=run.sh");

    expect(res.headers["x-actana-file-mode"]).toBe(String(0o755));
    expect(res.headers["x-actana-file-size"]).toBe("10");
    expect(Number(res.headers["x-actana-file-mtime"])).toBeGreaterThan(0);
  });

  it("answers HEAD with the headers and no body", async () => {
    project("p1", { "a.txt": "hello" });
    const res = await call("HEAD", "/v1/projects/p1/files?path=a.txt");

    expect(res.status).toBe(200);
    expect(res.headers["content-length"]).toBe("5");
    expect(res.body).toHaveLength(0);
  });

  it("answers HEAD on a directory with the tar headers and no body", async () => {
    // The chunked branch, without the chunks. Worth its own case because a
    // `HEAD` that starts packing a `node_modules` to answer a question about
    // whether it exists is the shape of bug that only shows up on a big tree.
    project("p1", { "src/a.txt": "a" });
    const res = await call("HEAD", "/v1/projects/p1/files?path=src");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/x-tar");
    expect(res.body).toHaveLength(0);
  });

  it("404s a path that is not there", async () => {
    project("p1");
    const res = await call("GET", "/v1/projects/p1/files?path=missing.txt");

    expect(res.status).toBe(404);
    expect(json(res.body).code).toBe("not-found");
  });

  it("404s a Project this Core does not have", async () => {
    const res = await call("GET", "/v1/projects/nope/files?path=a.txt");

    expect(res.status).toBe(404);
    expect(json(res.body).code).toBe("project-not-found");
  });

  it("follows a symlink that stays inside the Project, because a read asked for what it names", async () => {
    const root = project("p1", { "real.txt": "real" });
    fs.symlinkSync("real.txt", path.join(root, "alias.txt"));

    const res = await call("GET", "/v1/projects/p1/files?path=alias.txt");

    expect(res.body.toString("utf8")).toBe("real");
  });
});

describe("reads are unrestricted and concurrent (F8)", () => {
  it("serves many reads of one Project at once", async () => {
    project("p1", { "a.txt": "a".repeat(5000) });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => call("GET", "/v1/projects/p1/files?path=a.txt")),
    );
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
  });

  it("serves a read while a write holds the Project's lease", async () => {
    project("p1", { "a.txt": "a" });
    const lease = locks.acquire("p1", "elsewhere");
    expect(lease.ok).toBe(true);

    const read = await call("GET", "/v1/projects/p1/files?path=a.txt");

    expect(read.status).toBe(200);
    expect(read.body.toString("utf8")).toBe("a");
  });
});

// ─── Confinement, at the route ───────────────────────────────────────────────

describe("confinement (F3)", () => {
  it("refuses an absolute path with 400 and a distinguishable code", async () => {
    project("p1");
    const res = await call("GET", "/v1/projects/p1/files?path=%2Fetc%2Fpasswd");

    expect(res.status).toBe(400);
    expect(json(res.body).code).toBe("absolute-path");
  });

  it("refuses a `..` escape", async () => {
    project("p1");
    const res = await call("GET", "/v1/projects/p1/files?path=..%2F..%2Fetc%2Fpasswd");

    expect(res.status).toBe(400);
    expect(json(res.body).code).toBe("dot-dot-segment");
  });

  it("refuses a symlink resolving outside the Project root", async () => {
    const outside = makeTree({ "secret.txt": "not yours" });
    const root = project("p1");
    fs.symlinkSync(outside, path.join(root, "escape"));

    const res = await call("GET", "/v1/projects/p1/files?path=escape%2Fsecret.txt");

    expect(res.status).toBe(400);
    expect(json(res.body).code).toBe("outside-project-root");
  });

  it("refuses the same three on a write, and writes nothing", async () => {
    const outside = makeTree();
    const root = project("p1");
    fs.symlinkSync(outside, path.join(root, "escape"));

    for (const [requested, code] of [
      ["%2Fetc%2Fcron.d%2Fx", "absolute-path"],
      ["..%2F..%2Fpwned.txt", "dot-dot-segment"],
      ["escape%2Fpwned.txt", "outside-project-root"],
    ] as const) {
      const res = await call("PUT", `/v1/projects/p1/files?path=${requested}`, { body: Buffer.from("owned") });
      expect(res.status).toBe(400);
      expect(json(res.body).code).toBe(code);
    }
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("is a 400, not a 403 — this is an accident guard and not a permission model", async () => {
    project("p1");
    const res = await call("GET", "/v1/projects/p1/files?path=..%2Fx");
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(403);
  });
});

// ─── Writes ──────────────────────────────────────────────────────────────────

describe("PUT a single file", () => {
  it("writes it and reports one NDJSON entry plus a done line", async () => {
    const root = project("p1");
    const res = await call("PUT", "/v1/projects/p1/files?path=notes.txt", { body: Buffer.from("hello") });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/x-ndjson");
    expect(fs.readFileSync(path.join(root, "notes.txt"), "utf8")).toBe("hello");

    const lines = ndjson(res.body);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      type: "entry",
      path: "notes.txt",
      kind: "file",
      size: 5,
      result: "written",
      // sha256("hello")
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    });
    expect(typeof lines[0]!.mode).toBe("number");
    expect(typeof lines[0]!.mtime).toBe("number");
    expect(lines[1]).toEqual({ type: "done", entries: 1, bytes: 5 });
  });

  it("creates missing parent directories", async () => {
    const root = project("p1");
    await call("PUT", "/v1/projects/p1/files?path=a%2Fb%2Fc.txt", { body: Buffer.from("deep") });
    expect(fs.readFileSync(path.join(root, "a/b/c.txt"), "utf8")).toBe("deep");
  });

  it("overwrites by default and says `overwritten` (F5)", async () => {
    const root = project("p1", { "notes.txt": "old" });
    const res = await call("PUT", "/v1/projects/p1/files?path=notes.txt", { body: Buffer.from("new") });

    expect(fs.readFileSync(path.join(root, "notes.txt"), "utf8")).toBe("new");
    expect(ndjson(res.body)[0]).toMatchObject({ result: "overwritten" });
  });

  it("carries an executable bit sent as a header", async () => {
    const root = project("p1");
    await call("PUT", "/v1/projects/p1/files?path=run.sh", {
      body: Buffer.from("#!/bin/sh\n"),
      headers: { "x-actana-file-mode": String(0o755) },
    });
    expect(fs.statSync(path.join(root, "run.sh")).mode & 0o777).toBe(0o755);
  });

  it("does not write through a symlink sitting at the target path", async () => {
    const outside = makeTree({ "target.txt": "original" });
    const root = project("p1");
    fs.symlinkSync(path.join(outside, "target.txt"), path.join(root, "notes.txt"));

    await call("PUT", "/v1/projects/p1/files?path=notes.txt", { body: Buffer.from("replaced") });

    expect(fs.readFileSync(path.join(outside, "target.txt"), "utf8")).toBe("original");
    expect(fs.readFileSync(path.join(root, "notes.txt"), "utf8")).toBe("replaced");
    expect(fs.lstatSync(path.join(root, "notes.txt")).isSymbolicLink()).toBe(false);
  });
});

describe("PUT a folder as one tar (F4)", () => {
  async function tarOf(entries: Parameters<typeof makeTree>[0]): Promise<Buffer> {
    return await collect(packDirectory(makeTree(entries)));
  }

  it("unpacks it and reports one NDJSON line per entry", async () => {
    const root = project("p1");
    const archive = await tarOf({ "a.txt": "a", "sub/b.txt": "b" });

    const res = await call("PUT", "/v1/projects/p1/files?path=drop", {
      body: archive,
      headers: { "content-type": "application/x-tar" },
    });

    expect(res.status).toBe(200);
    expect(readTree(path.join(root, "drop"))).toEqual({
      "a.txt": { content: "a", mode: 0o644 },
      "sub/b.txt": { content: "b", mode: 0o644 },
    });

    const entries = ndjson(res.body).filter((line) => line.type === "entry");
    expect(entries.map((e) => e.path).sort()).toEqual(["drop/a.txt", "drop/sub", "drop/sub/b.txt"]);
    expect(ndjson(res.body).at(-1)).toMatchObject({ type: "done" });
  });

  it("reports every entry's path relative to the Project, not to the folder it landed in", async () => {
    project("p1");
    const archive = await tarOf({ "x.txt": "x" });

    const res = await call("PUT", "/v1/projects/p1/files?path=vendor%2Fdeep", {
      body: archive,
      headers: { "content-type": "application/x-tar" },
    });

    expect(ndjson(res.body)[0]).toMatchObject({ path: "vendor/deep/x.txt" });
  });

  it("keeps the executable bit through the whole route", async () => {
    const root = project("p1");
    const archive = await tarOf({ "bin/run.sh": { content: "#!/bin/sh\n", mode: 0o755 } });

    await call("PUT", "/v1/projects/p1/files?path=", {
      body: archive,
      headers: { "content-type": "application/x-tar" },
    });

    expect(fs.statSync(path.join(root, "bin/run.sh")).mode & 0o777).toBe(0o755);
  });

  it("reports a refusal as an NDJSON error line, because the 200 is already spent", async () => {
    // The status line goes out before the first entry is read, which is what a
    // streamed unpack means. A mid-stream failure is therefore a line in the
    // stream — which is why the progress format is NDJSON and not a document.
    project("p1");
    const malicious = Buffer.alloc(1536);
    const header = malicious.subarray(0, 512);
    header.write("../pwned.txt", 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("00000000000\0", 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.write("        ", 148, 8, "ascii");
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += header[i]!;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");

    const res = await call("PUT", "/v1/projects/p1/files?path=", {
      body: malicious,
      headers: { "content-type": "application/x-tar" },
    });

    expect(res.status).toBe(200);
    const last = ndjson(res.body).at(-1)!;
    expect(last).toMatchObject({ type: "error", code: "dot-dot-entry-path" });
  });
});

// ─── One write per Project ───────────────────────────────────────────────────

describe("a second concurrent write is refused immediately (F8)", () => {
  it("answers 409 with `transfer-in-progress`, distinguishable from every other refusal", async () => {
    project("p1");
    const held = locks.acquire("p1", "src/vendor");
    expect(held.ok).toBe(true);

    const res = await call("PUT", "/v1/projects/p1/files?path=notes.txt", { body: Buffer.from("x") });

    expect(res.status).toBe(409);
    const body = json(res.body);
    expect(body.code).toBe("transfer-in-progress");
    expect(String(body.error)).toContain("src/vendor");
    expect(String(body.error)).toContain("reads are unrestricted");
  });

  it("refuses without writing anything", async () => {
    const root = project("p1");
    locks.acquire("p1", "elsewhere");

    await call("PUT", "/v1/projects/p1/files?path=notes.txt", { body: Buffer.from("x") });

    expect(fs.existsSync(path.join(root, "notes.txt"))).toBe(false);
  });

  it("refuses before reading the body when the client asks with Expect: 100-continue", async () => {
    project("p1");
    locks.acquire("p1", "elsewhere");

    const res = await call("PUT", "/v1/projects/p1/files?path=notes.txt", {
      body: Buffer.from("x".repeat(4096)),
      headers: { expect: "100-continue" },
    });

    expect(res.status).toBe(409);
    expect(json(res.body).code).toBe("transfer-in-progress");
  });

  it("lets a write through once the other transfer releases", async () => {
    const root = project("p1");
    const held = locks.acquire("p1", "elsewhere");
    if (!held.ok) throw new Error("unreachable");
    held.lease.release();

    const res = await call("PUT", "/v1/projects/p1/files?path=notes.txt", { body: Buffer.from("x") });

    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(root, "notes.txt"), "utf8")).toBe("x");
  });

  it("lets a write to a different Project through at the same time", async () => {
    project("p1");
    const two = project("p2");
    locks.acquire("p1", "elsewhere");

    const res = await call("PUT", "/v1/projects/p2/files?path=notes.txt", { body: Buffer.from("x") });

    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(two, "notes.txt"), "utf8")).toBe("x");
  });

  it("releases the lease when the transfer finishes, so the next one is not refused forever", async () => {
    project("p1");
    await call("PUT", "/v1/projects/p1/files?path=a.txt", { body: Buffer.from("a") });
    expect(locks.current("p1")).toBeNull();

    const second = await call("PUT", "/v1/projects/p1/files?path=b.txt", { body: Buffer.from("b") });
    expect(second.status).toBe(200);
  });

  it("releases the lease even when the transfer failed mid-stream", async () => {
    project("p1");
    await call("PUT", "/v1/projects/p1/files?path=", {
      body: Buffer.from("this is not a tar at all, not even close"),
      headers: { "content-type": "application/x-tar" },
    });
    expect(locks.current("p1")).toBeNull();
  });
});

// ─── The free-space precheck ─────────────────────────────────────────────────

describe("the free-space precheck (F8: no size cap, but a precheck)", () => {
  async function withFreeSpace(available: number | null): Promise<{ close: () => Promise<void>; url: string }> {
    const routes = createCoreFilesRequestHandler({ filesPort, locks: new ProjectWriteLocks(), freeSpace: async () => available });
    const small = http.createServer();
    small.on("request", (req, res) => {
      if (routes.handle(req, res)) return;
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => small.listen(0, "127.0.0.1", resolve));
    const address = small.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    return { url, close: () => new Promise<void>((resolve) => small.close(() => resolve())) };
  }

  function callAt(url: string, path: string, body: Buffer): Promise<Response> {
    return new Promise((resolve, reject) => {
      const req = http.request(`${url}${path}`, { method: "PUT", agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end(body);
    });
  }

  it("refuses with 507 when the declared length does not fit", async () => {
    project("p1");
    const rig = await withFreeSpace(4);
    try {
      const res = await callAt(rig.url, "/v1/projects/p1/files?path=big.bin", Buffer.alloc(100));
      expect(res.status).toBe(507);
      expect(json(res.body).code).toBe("insufficient-storage");
    } finally {
      await rig.close();
    }
  });

  it("proceeds when it fits — there is no size cap, only a fit check", async () => {
    const root = project("p1");
    const rig = await withFreeSpace(1_000_000);
    try {
      const res = await callAt(rig.url, "/v1/projects/p1/files?path=big.bin", Buffer.alloc(100));
      expect(res.status).toBe(200);
      expect(fs.statSync(path.join(root, "big.bin")).size).toBe(100);
    } finally {
      await rig.close();
    }
  });

  it("proceeds when the disk cannot be measured — null is `do not know`, never `full`", async () => {
    const root = project("p1");
    const rig = await withFreeSpace(null);
    try {
      const res = await callAt(rig.url, "/v1/projects/p1/files?path=a.bin", Buffer.alloc(10));
      expect(res.status).toBe(200);
      expect(fs.existsSync(path.join(root, "a.bin"))).toBe(true);
    } finally {
      await rig.close();
    }
  });

  it("proceeds on a chunked upload, which declares no length to check", async () => {
    const root = project("p1");
    const rig = await withFreeSpace(4);
    try {
      const res = await new Promise<Response>((resolve, reject) => {
        const req = http.request(`${rig.url}/v1/projects/p1/files?path=chunked.bin`, { method: "PUT", agent: false }, (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (chunk: Buffer) => chunks.push(chunk));
          r.on("end", () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks) }));
        });
        req.on("error", reject);
        req.write(Buffer.alloc(100));
        req.end();
      });
      expect(res.status).toBe(200);
      expect(fs.statSync(path.join(root, "chunked.bin")).size).toBe(100);
    } finally {
      await rig.close();
    }
  });
});

// ─── The rest of the surface ─────────────────────────────────────────────────

describe("the surface is a closed list", () => {
  it("404s a `/v1/` path this build does not serve", async () => {
    const res = await call("GET", "/v1/projects/p1/somethingelse");
    expect(res.status).toBe(404);
    expect(json(res.body).code).toBe("not-found");
  });

  it("hands anything outside `/v1/` back to the caller, which 404s it", async () => {
    const res = await call("GET", "/healthz");
    expect(res.status).toBe(404);
  });

  it("405s a method it does not answer", async () => {
    project("p1");
    const res = await call("DELETE", "/v1/projects/p1/files?path=a.txt");
    expect(res.status).toBe(405);
    expect(json(res.body).code).toBe("method-not-allowed");
  });
});

describe("the bearer gate", () => {
  async function withAuth(): Promise<{ url: string; close: () => Promise<void> }> {
    const routes = createCoreFilesRequestHandler({
      filesPort,
      locks: new ProjectWriteLocks(),
      authVerifier: (bearer) =>
        bearer === "good" ? { ok: true, coreId: "core-1", exp: 1 } : { ok: false, reason: "bad-signature" },
    });
    const guarded = http.createServer();
    guarded.on("request", (req, res) => {
      if (routes.handle(req, res)) return;
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => guarded.listen(0, "127.0.0.1", resolve));
    const address = guarded.address();
    return {
      url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`,
      close: () => new Promise<void>((resolve) => guarded.close(() => resolve())),
    };
  }

  function callAt(url: string, headers: Record<string, string> = {}): Promise<Response> {
    return new Promise((resolve, reject) => {
      const req = http.request(`${url}/v1/projects/p1/files?path=a.txt`, { method: "GET", headers, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("401s a request with no Authorization header", async () => {
    project("p1", { "a.txt": "a" });
    const rig = await withAuth();
    try {
      const res = await callAt(rig.url);
      expect(res.status).toBe(401);
      expect(json(res.body).code).toBe("unauthorized");
    } finally {
      await rig.close();
    }
  });

  it("401s a bearer the Core refuses, and says why", async () => {
    project("p1", { "a.txt": "a" });
    const rig = await withAuth();
    try {
      const res = await callAt(rig.url, { authorization: "Bearer wrong" });
      expect(res.status).toBe(401);
      expect(String(json(res.body).error)).toContain("bad-signature");
    } finally {
      await rig.close();
    }
  });

  it("serves a request carrying the right bearer", async () => {
    project("p1", { "a.txt": "a" });
    const rig = await withAuth();
    try {
      const res = await callAt(rig.url, { authorization: "Bearer good" });
      expect(res.status).toBe(200);
      expect(res.body.toString("utf8")).toBe("a");
    } finally {
      await rig.close();
    }
  });
});

describe("a single-file PUT onto a path that holds a directory", () => {
  // F5's overwrite-by-default is about replacing a *file*. Recursively deleting
  // a subtree to make room for one is a different promise, and it was made
  // nowhere: not in the ticket, not in ADR 0029 D6, not in
  // `docs/external-api.md`. The old behaviour deleted the tree and reported an
  // ordinary `overwritten` line, so a `PUT ?path=src` meant for `src/x.ts` cost
  // the operator `src` and the progress stream said nothing unusual happened.

  it("refuses a non-empty directory rather than deleting the tree", async () => {
    const root = project("p1", {
      "src/index.ts": "export const x = 1;\n",
      "src/nested/deep.ts": "still here",
    });

    const res = await call("PUT", "/v1/projects/p1/files?path=src", {
      body: Buffer.from("a regular file called src"),
      headers: { "content-type": "text/plain" },
    });

    expect(res.status).toBe(409);
    expect(json(res.body).code).toBe("directory-in-the-way");
    // A refusal that happens after the delete is not one.
    expect(fs.readFileSync(path.join(root, "src/index.ts"), "utf8")).toBe("export const x = 1;\n");
    expect(fs.readFileSync(path.join(root, "src/nested/deep.ts"), "utf8")).toBe("still here");
  });

  it("refuses before the 200, so it is a status and not an error line", async () => {
    // The distinction matters to a client: a 409 is branchable in the same
    // place `transfer-in-progress` is, whereas an error line arrives after a
    // success status and after the client has uploaded its body.
    project("p1", { "src/index.ts": "x" });

    const res = await call("PUT", "/v1/projects/p1/files?path=src", {
      body: Buffer.from("clobber"),
      headers: { "content-type": "text/plain" },
    });

    expect(res.status).not.toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.toString("utf8")).not.toContain("overwritten");
  });

  it("is distinguishable by code from the other 409 this surface has", async () => {
    project("p1", { "src/index.ts": "x" });

    const res = await call("PUT", "/v1/projects/p1/files?path=src", {
      body: Buffer.from("clobber"),
      headers: { "content-type": "text/plain" },
    });

    expect(res.status).toBe(409);
    expect(json(res.body).code).not.toBe("transfer-in-progress");
    expect(json(res.body).code).toBe("directory-in-the-way");
  });

  it("still replaces an empty directory, which has nothing to lose", async () => {
    const root = project("p1", { "placeholder/": "" });

    const res = await call("PUT", "/v1/projects/p1/files?path=placeholder", {
      body: Buffer.from("now a file"),
      headers: { "content-type": "text/plain" },
    });

    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(root, "placeholder"), "utf8")).toBe("now a file");
  });

  it("releases the write lease after refusing", async () => {
    // The refusal returns from inside the `try` that holds the lease, so the
    // `finally` is what frees it. Worth pinning: a refusal that stranded the
    // lease would be the same defect this branch just fixed, by another route.
    project("p1", { "src/index.ts": "x" });

    await call("PUT", "/v1/projects/p1/files?path=src", {
      body: Buffer.from("clobber"),
      headers: { "content-type": "text/plain" },
    });

    expect(locks.current("p1")).toBeNull();
  });
});

describe("a single-file PUT that resolves to the Project root", () => {
  // The empty-directory carve-out above — "there is nothing to lose" — is true
  // of a subfolder and false of the root. A `PUT` with no `path` confines to
  // the root itself, and on an *empty* Project `directoryInTheWay` finds
  // nothing to refuse over, so the old code deleted the Project root and
  // created a regular file at its path: listing, transfers and the harness's
  // working directory all broken until someone fixed it by hand on the Core
  // machine. A missing parameter is the plainest bad input this surface can
  // receive and it must never be destructive.
  //
  // Both spellings reach the same place — `path` omitted entirely and
  // `?path=` — and so does `?path=.`, because confinement answers `""` for all
  // of them. Each is asserted against an empty root *and* a populated one: the
  // populated case would have been caught by `directory-in-the-way`, and
  // pinning both is what keeps the refusal about the root rather than about
  // the root's contents.

  async function tarOf(entries: Parameters<typeof makeTree>[0]): Promise<Buffer> {
    return await collect(packDirectory(makeTree(entries)));
  }

  const spellings: Array<[string, string]> = [
    ["no path parameter at all", "/v1/projects/p1/files"],
    ["an explicitly empty path", "/v1/projects/p1/files?path="],
    ["a path of `.`", "/v1/projects/p1/files?path=."],
  ];

  for (const [label, url] of spellings) {
    it(`refuses ${label} against an empty Project, leaving the root a directory`, async () => {
      const root = project("p1");

      const res = await call("PUT", url, {
        body: Buffer.from("a regular file at the Project root"),
        headers: { "content-type": "text/plain" },
      });

      expect(res.status).toBe(400);
      expect(fs.lstatSync(root).isDirectory()).toBe(true);
      expect(readTree(root)).toEqual({});
    });

    it(`refuses ${label} against a populated Project, losing nothing`, async () => {
      const root = project("p1", { "a.txt": "a", "src/index.ts": "export const x = 1;\n" });

      const res = await call("PUT", url, {
        body: Buffer.from("a regular file at the Project root"),
        headers: { "content-type": "text/plain" },
      });

      expect(res.status).toBe(400);
      expect(fs.lstatSync(root).isDirectory()).toBe(true);
      expect(readTree(root)).toEqual({
        "a.txt": { content: "a", mode: 0o644 },
        "src/index.ts": { content: "export const x = 1;\n", mode: 0o644 },
      });
    });
  }

  it("is distinguishable by code, and says what a single-file write is missing", async () => {
    // 400 with `malformed-path`, the code the other path refusals already use
    // — a client branching on "the path you sent does not name a file" needs
    // this to be neither the 409 of `directory-in-the-way` nor a bare 400.
    project("p1");

    const res = await call("PUT", "/v1/projects/p1/files", {
      body: Buffer.from("x"),
      headers: { "content-type": "text/plain" },
    });

    const body = json(res.body);
    expect(body.code).toBe("malformed-path");
    expect(body.code).not.toBe("directory-in-the-way");
    expect(String(body.error)).toContain("a single-file write needs a name");
  });

  it("refuses before the 200, and without taking the write lease", async () => {
    project("p1");

    const res = await call("PUT", "/v1/projects/p1/files", {
      body: Buffer.from("x"),
      headers: { "content-type": "text/plain" },
    });

    expect(res.status).not.toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(locks.current("p1")).toBeNull();
  });

  it("still unpacks a tar at the root, which is the legitimate empty-path write", async () => {
    // The guard is about a *single file* named nothing. `PUT` a tar with no
    // path is "unpack into the Project root" and stays exactly as it was.
    const root = project("p1");
    const archive = await tarOf({ "a.txt": "a", "sub/b.txt": "b" });

    const res = await call("PUT", "/v1/projects/p1/files", {
      body: archive,
      headers: { "content-type": "application/x-tar" },
    });

    expect(res.status).toBe(200);
    expect(fs.lstatSync(root).isDirectory()).toBe(true);
    expect(readTree(root)).toEqual({
      "a.txt": { content: "a", mode: 0o644 },
      "sub/b.txt": { content: "b", mode: 0o644 },
    });
  });

  it("still writes a named file at the top level of the Project", async () => {
    // The other half of the guard's boundary: one segment is a name, and a
    // write to it is untouched.
    const root = project("p1");

    const res = await call("PUT", "/v1/projects/p1/files?path=notes.txt", {
      body: Buffer.from("kept"),
      headers: { "content-type": "text/plain" },
    });

    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(root, "notes.txt"), "utf8")).toBe("kept");
  });
});
