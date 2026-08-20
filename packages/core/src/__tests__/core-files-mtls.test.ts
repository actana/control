// One port, one certificate, one bearer, two protocols (#165 F2, ADR 0028).
//
// Every other suite in this ticket exercises the routes over plain `http` with
// the handler wired by hand. This one proves the claim the ticket actually
// makes: that the `/v1/…` routes are answered by **the same mTLS HTTPS server
// the core-link WebSocket is mounted on**, that they are behind the same client
// certificate and the same bearer, and that a folder and a file round-trip
// across it for real.
//
// So nothing here is injected. The server is built by the Core's own default
// factory, the certificates come from `generateCertMaterial` — the material
// `actana setup` writes — and the bearer is signed and verified by the shared
// codec the `auth` frame uses.
import * as fs from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import * as https from "node:https";
import { Server } from "node:net";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { generateCertMaterial } from "@actana/shared/core-cert-material";
import { signBearer, verifyBearer } from "@actana/shared/core-link-bearer";
import { PtyCoreLinkServer } from "../pty-core-link-server";
import type { PtyCore, PtyCoreEvent } from "../pty-manager";
import { createCoreFilesRequestHandler } from "../core-files-routes";
import { packDirectory } from "../files-tar";
import { cleanupTrees, collect, makeTree, readTree } from "./files-fixture";

const SECRET = "core-files-mtls-suite-secret-at-least-32-bytes";

type Rig = {
  origin: string;
  wsUrl: string;
  tls: { ca: string; cert: string; key: string };
  bearer: string;
  projectRoot: string;
};

let server: PtyCoreLinkServer | null = null;

afterEach(() => {
  server?.close();
  server = null;
  cleanupTrees();
});

function mockCore(): PtyCore {
  return {
    setEmitTarget: (_fn: ((event: PtyCoreEvent) => void) | null) => {},
    spawn: async () => ({ ptyId: "pty-1", hooksReportTurnStart: true }),
    write: () => true,
    resize: () => true,
    kill: () => true,
    killLaunchProcesses: async () => ({ ptyCount: 0, ports: [] }),
    findByTask: () => ({ ptyId: null }),
    replay: () => ({ data: "", nextSeq: 0, from: 0 }),
    killAll: () => {},
  } as unknown as PtyCore;
}

/** A free TCP port on 127.0.0.1, found by briefly binding port 0. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = new Server();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address && typeof address === "object") {
        const { port } = address;
        probe.close(() => resolve(port));
      } else {
        probe.close();
        reject(new Error("no port"));
      }
    });
  });
}

async function startCore(entries: Parameters<typeof makeTree>[0] = {}): Promise<Rig> {
  const material = await generateCertMaterial({ host: "127.0.0.1" });
  const port = await freePort();
  const projectRoot = makeTree(entries);

  // No `createServer` override. The default factory is what mounts the routes,
  // so overriding it would test a rig instead of the Core.
  server = new PtyCoreLinkServer(mockCore(), {
    port,
    host: "127.0.0.1",
    tls: { caCert: material.ca.cert, serverCert: material.server.cert, serverKey: material.server.key },
    authVerifier: (bearer) => verifyBearer(bearer, SECRET),
    httpRoutes: createCoreFilesRequestHandler({
      filesPort: { projectRoot: (id: string) => (id === "p1" ? projectRoot : null) },
      authVerifier: (bearer) => verifyBearer(bearer, SECRET),
    }),
  });

  const rig: Rig = {
    origin: `https://127.0.0.1:${port}`,
    wsUrl: `wss://127.0.0.1:${port}`,
    tls: { ca: material.ca.cert, cert: material.client.cert, key: material.client.key },
    bearer: signBearer({ coreId: "core_files", exp: Date.now() + 60_000 }, SECRET),
    projectRoot,
  };

  // `listen` is fired without a callback inside the factory, so readiness is
  // observed rather than awaited: poll until a request completes.
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await request(rig, "GET", "/v1/projects/p1/files?path=");
      return rig;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

type Response = { status: number; headers: IncomingHttpHeaders; body: Buffer };

function request(
  rig: Rig,
  method: string,
  url: string,
  opts: { body?: Buffer; headers?: Record<string, string>; omitBearer?: boolean; omitClientCert?: boolean } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${rig.origin}${url}`,
      {
        method,
        agent: false,
        ca: rig.tls.ca,
        ...(opts.omitClientCert ? {} : { cert: rig.tls.cert, key: rig.tls.key }),
        headers: {
          ...(opts.omitBearer ? {} : { authorization: `Bearer ${rig.bearer}` }),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

function ndjson(body: Buffer): Array<Record<string, unknown>> {
  return body
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The one `ready` frame this Core sends a WebSocket client on the same port. */
function readyFrame(rig: Rig): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(rig.wsUrl, { ca: rig.tls.ca, cert: rig.tls.cert, key: rig.tls.key });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("no ready frame"));
    }, 10_000);
    socket.on("message", (data: unknown) => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      if (frame.type !== "ready") return;
      clearTimeout(timer);
      socket.close();
      resolve(frame);
    });
    socket.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("the file routes and the core link share one mTLS server", () => {
  it("answers both a WebSocket upgrade and a /v1 request on the same port", async () => {
    const rig = await startCore({ "a.txt": "hello" });

    const ready = await readyFrame(rig);
    const read = await request(rig, "GET", "/v1/projects/p1/files?path=a.txt");

    expect(ready.type).toBe("ready");
    expect(ready.files).toEqual({ version: 1 });
    expect(read.status).toBe(200);
    expect(read.body.toString("utf8")).toBe("hello");
  }, 30_000);

  it("refuses a /v1 request that presents no client certificate — the handshake fails first", async () => {
    const rig = await startCore({ "a.txt": "hello" });

    await expect(request(rig, "GET", "/v1/projects/p1/files?path=a.txt", { omitClientCert: true })).rejects.toThrow(
      /ECONNRESET|EPIPE|socket hang up|ERR_SSL|SSL routines|alert|handshake/i,
    );
  }, 30_000);

  it("refuses a /v1 request that presents the certificate but no bearer", async () => {
    // mTLS alone is not the gate. The certificate says a Panel talked to this
    // Core once; the bearer says the pairing is still current.
    const rig = await startCore({ "a.txt": "hello" });

    const res = await request(rig, "GET", "/v1/projects/p1/files?path=a.txt", { omitBearer: true });

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body.toString("utf8")).code).toBe("unauthorized");
  }, 30_000);

  it("404s a path outside the file surface rather than leaving the request hanging", async () => {
    const rig = await startCore();
    const res = await request(rig, "GET", "/healthz");
    expect(res.status).toBe(404);
  }, 30_000);
});

describe("a file and a folder both round-trip over the real transport", () => {
  it("uploads a file and reads the same bytes back", async () => {
    const rig = await startCore();

    const put = await request(rig, "PUT", "/v1/projects/p1/files?path=notes%2Fhello.txt", {
      body: Buffer.from("round trip"),
    });
    const get = await request(rig, "GET", "/v1/projects/p1/files?path=notes%2Fhello.txt");

    expect(put.status).toBe(200);
    expect(ndjson(put.body)[0]).toMatchObject({ type: "entry", path: "notes/hello.txt", result: "written" });
    expect(get.body.toString("utf8")).toBe("round trip");
  }, 30_000);

  it("uploads a folder as one tar, downloads it as one tar, and keeps the executable bits", async () => {
    const rig = await startCore();
    const source = makeTree({
      "bin/run.sh": { content: "#!/bin/sh\necho hi\n", mode: 0o755 },
      "bin/data.txt": { content: "not executable", mode: 0o644 },
      "docs/readme.md": "# hi",
    });
    fs.chmodSync(path.join(source, "bin"), 0o750);
    const archive = await collect(packDirectory(source));

    const put = await request(rig, "PUT", "/v1/projects/p1/files?path=dropped", {
      body: archive,
      headers: { "content-type": "application/x-tar" },
    });

    expect(put.status).toBe(200);
    expect(readTree(path.join(rig.projectRoot, "dropped"))).toEqual(readTree(source));
    expect(fs.statSync(path.join(rig.projectRoot, "dropped/bin/run.sh")).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(rig.projectRoot, "dropped/bin")).mode & 0o777).toBe(0o750);

    // And back out again, through the download half of the same surface.
    const get = await request(rig, "GET", "/v1/projects/p1/files?path=dropped");
    expect(get.headers["content-type"]).toBe("application/x-tar");

    const returned = makeTree();
    const { unpackTarInto } = await import("../files-tar");
    await unpackTarInto(
      (async function* () {
        yield get.body;
      })(),
      returned,
      returned,
      () => {},
    );
    expect(readTree(returned)).toEqual(readTree(source));
    expect(fs.statSync(path.join(returned, "bin/run.sh")).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(returned, "bin")).mode & 0o777).toBe(0o750);
  }, 30_000);

  it("names every overwrite in the progress stream (F5)", async () => {
    const rig = await startCore({ "kept.txt": "old" });
    const source = makeTree({ "kept.txt": "new", "fresh.txt": "new" });
    const archive = await collect(packDirectory(source));

    const put = await request(rig, "PUT", "/v1/projects/p1/files?path=", {
      body: archive,
      headers: { "content-type": "application/x-tar" },
    });

    const entries = ndjson(put.body).filter((line) => line.type === "entry");
    expect(entries.find((e) => e.path === "kept.txt")).toMatchObject({ result: "overwritten" });
    expect(entries.find((e) => e.path === "fresh.txt")).toMatchObject({ result: "written" });
  }, 30_000);

  it("refuses a second concurrent write immediately, over the real transport", async () => {
    const rig = await startCore();
    // A tar big enough that the first transfer is still in flight when the
    // second request arrives. The refusal is the point, not the timing: the
    // first has the lease from the instant its body starts.
    const source = makeTree(
      Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`f${i}.bin`, "x".repeat(4096)])),
    );
    const archive = await collect(packDirectory(source));

    const first = request(rig, "PUT", "/v1/projects/p1/files?path=bulk", {
      body: archive,
      headers: { "content-type": "application/x-tar" },
    });
    // Give the first request time to be accepted and take the lease.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await request(rig, "PUT", "/v1/projects/p1/files?path=other.txt", { body: Buffer.from("x") });

    expect(second.status).toBe(409);
    expect(JSON.parse(second.body.toString("utf8")).code).toBe("transfer-in-progress");
    expect((await first).status).toBe(200);

    // And once it is done, the next write is served.
    const third = await request(rig, "PUT", "/v1/projects/p1/files?path=other.txt", { body: Buffer.from("x") });
    expect(third.status).toBe(200);
  }, 30_000);

  it("refuses a confinement violation over the real transport, and writes nothing", async () => {
    const outside = makeTree();
    const rig = await startCore();
    fs.symlinkSync(outside, path.join(rig.projectRoot, "escape"));

    for (const [requested, code] of [
      ["%2Fetc%2Fpasswd", "absolute-path"],
      ["..%2F..%2Fpwned.txt", "dot-dot-segment"],
      ["escape%2Fpwned.txt", "outside-project-root"],
    ] as const) {
      const res = await request(rig, "PUT", `/v1/projects/p1/files?path=${requested}`, { body: Buffer.from("owned") });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body.toString("utf8")).code).toBe(code);
    }
    expect(fs.readdirSync(outside)).toEqual([]);
  }, 30_000);
});
