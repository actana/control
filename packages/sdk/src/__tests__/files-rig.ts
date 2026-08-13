// A real Core file surface, on a real socket, for the `project.files.*` suites
// (#167).
//
// **Real HTTP against the Core's own handler**, not a stand-in. The SDK's other
// suites drive `PtyCoreLinkServer` over an in-memory socket pair, which is the
// right trade for frames; it is the wrong one here, because everything #167 is
// about lives *below* the frame level — chunked transfer encoding, a response
// body that arrives in pieces, a socket that backpressures, a status line that
// comes back while a request body is still going out. None of those exist
// without a kernel in the path.
//
// So: `node:http` on loopback, with `createCoreFilesRequestHandler` mounted
// exactly as `core-files-wiring.ts` mounts it, over a real directory on a real
// disk.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import {
  createCoreFilesRequestHandler,
  type FilesAuthVerifier,
} from "@actana/core/core-files-routes";
import { CoreClient } from "../core-client";
import { startCoreRig, type CoreRig } from "./fake-core-link";

/** Every temp root and server this module made, so a suite can drop them all. */
const roots: string[] = [];

export type FilesRig = {
  /** `http://127.0.0.1:<port>` — what a `CoreClient` derives as its `httpsBaseUrl`. */
  baseUrl: string;
  host: string;
  port: number;
  /** The Project's root on disk. */
  root: string;
  projectId: string;
  /** Every request the server took, in order — how "it did not retry" is proven. */
  requests: { method: string; url: string }[];
  close(): Promise<void>;
};

export type FilesRigOptions = {
  projectId?: string;
  /** Files to seed the Project with. `dir/` keys make empty directories. */
  seed?: Record<string, string | { content?: string; mode?: number }>;
  authVerifier?: FilesAuthVerifier;
  /**
   * Answer `?list=1` with an NDJSON manifest — **the #166 stand-in**.
   *
   * Issue 166 owns the Core's listing route and is being built in parallel, so
   * nothing here creates or modifies one. What this serves is the contract that
   * ticket inherits: the manifest shape PR 215 established — `{path, size,
   * mtime, mode, sha256}` per entry — streamed as NDJSON on the file route's
   * origin. That is enough to prove the *reader* in `CoreFiles.list`, which is
   * the SDK's half and the only half #167 owns. The live wiring lands when #166
   * merges; what changes then is a URL, not this shape.
   */
  listing?: boolean;
};

/** Stand up a Core file surface on loopback. */
export async function startFilesRig(opts: FilesRigOptions = {}): Promise<FilesRig> {
  const projectId = opts.projectId ?? "proj_1";
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "actana-sdk-files-")));
  roots.push(root);
  writeTree(root, opts.seed ?? {});

  const routes = createCoreFilesRequestHandler({
    filesPort: { projectRoot: (id) => (id === projectId ? root : null) },
    ...(opts.authVerifier ? { authVerifier: opts.authVerifier } : {}),
  });
  const requests: { method: string; url: string }[] = [];

  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? "?", url: req.url ?? "" });
    if (opts.listing && serveListing(req, res, root, projectId)) return;
    if (routes.handle(req, res)) return;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "not-found", error: "no route" }));
  });
  // The `Expect: 100-continue` half, wired as the Core wires it. Nothing in the
  // SDK sends the header today — undici's `fetch` has no 100-continue wait to
  // hang the request on — but a rig that mounted only half the surface would
  // quietly stop being the Core the moment that changed.
  server.on("checkContinue", (req, res) => {
    requests.push({ method: req.method ?? "?", url: req.url ?? "" });
    if (routes.handleContinue(req, res)) return;
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the rig did not bind a port");
  const { port } = address;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    host: "127.0.0.1",
    port,
    root,
    projectId,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * A `CoreClient` connected to a fake core link, whose **HTTPS origin is the
 * rig's real server**.
 *
 * The two halves of a Core are separate here for the same reason they are
 * separate in production: the file surface is a second protocol on the same
 * origin (ADR 0028), and what binds them is the URL. Dialing
 * `ws://127.0.0.1:<the rig's port>` makes `httpsBaseUrl` resolve to the rig by
 * the client's own scheme-swap rather than by a test reaching in and setting
 * it — so this exercises `coreConnectionFromBlob`'s mapping too.
 */
export async function connectedClient(
  rig: FilesRig,
  opts: { announceFiles?: boolean; bearer?: string } = {},
): Promise<{ client: CoreClient; coreRig: CoreRig }> {
  const coreRig = startCoreRig({ announceFiles: opts.announceFiles ?? true });
  const dialer = coreRig.dialer();
  const client = new CoreClient({
    url: `ws://${rig.host}:${rig.port}`,
    createSocket: dialer.createSocket,
    ...(opts.bearer ? { bearer: opts.bearer } : {}),
  });
  await client.connect();
  return { client, coreRig };
}

/**
 * The #166 stand-in: walk the tree and stream it as NDJSON.
 *
 * Answers `true` when it took the request. `sha256` is computed eagerly here
 * because a fixture can afford it and the reader under test must cope with the
 * field being present — #166 gets to decide whether a real Core computes it
 * eagerly or on request, and `CoreFileEntry.sha256` is nullable so that either
 * answer is readable.
 */
function serveListing(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  root: string,
  projectId: string,
): boolean {
  const url = new URL(req.url ?? "/", "http://rig.invalid");
  if (!url.searchParams.has("list")) return false;
  if (url.pathname !== `/v1/projects/${encodeURIComponent(projectId)}/files`) return false;

  const base = url.searchParams.get("path") ?? "";
  const maxDepth = url.searchParams.has("depth") ? Number(url.searchParams.get("depth")) : Infinity;
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
  for (const entry of walk(root, base, maxDepth)) res.write(`${JSON.stringify(entry)}\n`);
  res.write(`${JSON.stringify({ type: "done" })}\n`);
  res.end();
  return true;
}

function* walk(
  root: string,
  base: string,
  maxDepth: number,
  depth = 1,
): Generator<Record<string, unknown>> {
  const absolute = path.join(root, base);
  for (const name of fs.readdirSync(absolute).sort()) {
    const child = path.join(absolute, name);
    const relative = base.length > 0 ? `${base}/${name}` : name;
    const stats = fs.lstatSync(child);
    const directory = stats.isDirectory();
    yield {
      path: relative,
      kind: directory ? "directory" : stats.isSymbolicLink() ? "symlink" : "file",
      size: stats.size,
      mtime: Math.floor(stats.mtimeMs),
      mode: stats.mode & 0o777,
      sha256: directory ? null : createHash("sha256").update(fs.readFileSync(child)).digest("hex"),
    };
    if (directory && depth < maxDepth) yield* walk(root, relative, maxDepth, depth + 1);
  }
}

/** Seed a directory. A `dir/` key makes an empty directory. */
export function writeTree(
  root: string,
  entries: Record<string, string | { content?: string; mode?: number }>,
): void {
  for (const [relative, value] of Object.entries(entries)) {
    const target = path.join(root, relative);
    if (relative.endsWith("/")) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const spec = typeof value === "string" ? { content: value } : value;
    fs.writeFileSync(target, spec.content ?? "");
    if (spec.mode !== undefined) fs.chmodSync(target, spec.mode);
  }
}

/** Every byte of an async iterable, for the assertions that are about content. */
export async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Drop every temp root this module made. Call from a suite's `afterAll`. */
export function cleanupRoots(): void {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.length = 0;
}
