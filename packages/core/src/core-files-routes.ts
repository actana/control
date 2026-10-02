// The Core's `/v1/files` routes (#165, F2–F6, F8; re-rooted at `~` by #557).
//
// These mount on the **same mTLS HTTPS server the core-link WebSocket already
// listens on** — one port, one certificate, one bearer, two protocols. Bytes
// cross here and never over the core link (ADR 0028): a multi-gigabyte upload
// chunked into JSON frames would stutter every terminal pane sharing that
// socket through head-of-line blocking, and base64 would cost a third of the
// wire for the privilege.
//
// Every path is relative to the home of the Core's user, `~` (ADR 0041 D1), and
// confined to it: an absolute path, a `..` segment and a symlink that leads out
// are refused. There are no Projects and no id in the address.
//
//   GET    /v1/files?path=<relative>
//          A file's raw bytes, or a directory as one streamed tar.
//   HEAD   /v1/files?path=<relative>
//          The same headers, no body.
//   PUT    /v1/files?path=<relative>
//          Write. `Content-Type: application/x-tar` unpacks an archive into that
//          path, keeping its tree; anything else writes one file at it. The response
//          is a chunked NDJSON progress stream, one line per entry.
//   DELETE /v1/files?path=<relative>
//          Delete a file or a symlink. A path ending in `/` deletes a folder and
//          everything in it; a folder without the slash is refused. The home is refused.
//   POST   /v1/files/folder?path=<relative>
//          Create a folder, with its parents. One that is already there is a 200.
//   POST   /v1/files/move   {"from": …, "to": …}
//          Rename or move inside the home. Nothing is overwritten.
//   GET    /v1/files/list?path=<relative>&depth=<n>&sha256=1
//          The tree under that path, as a chunked NDJSON stream — one line per
//          entry, to arbitrary depth (#166, F7).
//
// Listing is a route of its own rather than a `?list=1` on the read above, and
// the reason is what the two answer with: one hands back a tar of a folder and
// the other hands back a manifest of it. A query parameter that a proxy,
// redirect or hand-edited URL can drop would turn "list this folder" into
// "download this folder", which for a `node_modules` is a mistake measured in
// gigabytes rather than in a 400. A path segment cannot be dropped silently.
//
// **This module decides nothing about the disk.** It checks the bearer, the route,
// the method and the write lease, and then one operation runs on `~` as `core`
// (`files-ops.ts`): in a short-lived helper started through `asCore` in the
// container (ADR 0041 D25, `core-files-helper-client.ts`), in this process outside
// it, where the daemon and `core` are the same user.
//
// Raw `node:http` handlers, `URL`-based dispatch, JSON error bodies — the same
// shape as `harness-hook-receiver.ts`, which is this repository's other HTTP
// surface. No framework enters the Core bundle for a handful of routes.
import type { IncomingMessage, ServerResponse } from "node:http";
import { freeSpaceBytes, stringRefusal } from "./files-confinement";
import { filesRunAsHelper, responseOut, runFilesOpAsCore, type CoreFilesHelperOptions } from "./core-files-helper-client";
import { refuse, runFilesOp, type FilesOpRequest, type Refusal } from "./files-ops";
import type { FileListingOptions } from "./files-listing";
import { WorkspaceWriteLocks } from "./files-transfer-locks";
import log from "@actana/shared/log";

/**
 * The home on this machine, as the daemon sees it.
 *
 * The whole of #129 F1 is behind this one method: **the filesystem is the
 * model.** There is no file index, no per-file id, no shadow table to keep in
 * step with the disk — a path plus the home is the entire address space, and
 * `readdir` is the query engine. See ADR 0027. The workspace is the home of the
 * Core's user (ADR 0041 D1); there is one. In the container the daemon cannot
 * read it: this is the path handed to the process that can, never one the daemon
 * opens.
 */
export interface CoreFilesPort {
  /** Absolute path of the home on this machine, or null when it cannot be served. */
  workspaceRoot(): string | null;
}

/** Verifies a presented bearer — the same one the core-link `auth` frame uses. */
export type FilesAuthVerifier = (
  bearer: string,
) => { ok: true; coreId: string; exp: number } | { ok: false; reason: "expired" | "bad-signature" | "malformed" };

export type CoreFilesRoutesOptions = {
  filesPort: CoreFilesPort;
  /**
   * When set, every request must carry `Authorization: Bearer <bearer>` and it
   * is verified exactly as the core-link `auth` frame's is. When omitted — the
   * loopback `ws://` Core, and tests — the surface is as trusted as the rest of
   * that Core, which is the same trade the core link already makes.
   *
   * mTLS is not enough on its own and is not treated as if it were: the client
   * certificate says a Panel talked to this Core once, the bearer says the
   * pairing is still current and has not been revoked by a reissue.
   */
  authVerifier?: FilesAuthVerifier;
  /** One write transfer into the home at a time (F8). A fresh one is made when omitted. */
  locks?: WorkspaceWriteLocks;
  /** Injectable for tests, on the in-process path. Defaults to a real `statfs`. */
  freeSpace?: (target: string) => Promise<number | null>;
  /** How the helper that runs the operations as `core` is started. Tests point it at a bundle they built. */
  helper?: CoreFilesHelperOptions;
};

/** Every route this module answers lives under here. */
export const CORE_FILES_ROUTE_PREFIX = "/v1/";

/**
 * The Core's HTTP surface, as the server factory mounts it.
 *
 * Both methods answer `true` when they took the request and `false` when the
 * path is none of this surface's business — so the factory keeps the 404 and
 * the Core's HTTP routes stay a closed list.
 */
export type CoreHttpRoutes = {
  handle(req: IncomingMessage, res: ServerResponse): boolean;
  handleContinue(req: IncomingMessage, res: ServerResponse): boolean;
};

// The refusal vocabulary has one definition and it is not here (#224).
//
// It lives in `@actana/sdk/core-files-error-codes`, and the Core — which is the
// *server* answering these codes — imports it from the *client* package. That
// arrow is deliberate and it is ADR 0025 D2's, widened by #224 from the
// core-link frames to this module: what the Core depends on is the protocol,
// not the client, and the module it reaches for imports nothing at all. The
// alternative is the mirror this file used to hold, and D3 says why that is not
// an option — a hand-copied contract does not fail, it disagrees at runtime
// between two processes that each believe they are correct.
//
// `import type` erases, so the Core's esbuild bundle gains no runtime edge into
// the SDK from this line.
//
// Re-exported because this module already exported the type and a consumer may
// be naming it from here. A re-export is not a second copy: it cannot disagree
// with what it aliases.
export type { CoreFilesErrorCode } from "@actana/sdk/core";

/** What a request is for, and which methods may ask it. */
type Leaf = "files" | "list" | "folder" | "move";
type Target = { leaf: Leaf; methods: readonly string[] };

const METHODS_BY_LEAF: Record<Leaf, readonly string[]> = {
  files: ["GET", "HEAD", "PUT", "DELETE"],
  // A listing is a read and only a read. `PUT /files/list` is refused here
  // rather than falling through to the write path, which would otherwise create
  // a *file called `list`* in the home — the one request on this surface where a
  // typo's consequence is a write.
  list: ["GET", "HEAD"],
  folder: ["POST"],
  move: ["POST"],
};

/** The JSON body of a move: two paths. A kilobyte of sentences is generous. */
const MAX_JSON_BODY_BYTES = 16 * 1024;

/**
 * Build the request handler.
 *
 * Returns `true` when it took the request and `false` when the path is none of
 * its business, so the caller keeps the 404 for everything else — the Core's
 * HTTP surface stays a closed list rather than a prefix this module owns.
 */
export function createCoreFilesRequestHandler(
  opts: CoreFilesRoutesOptions,
): CoreHttpRoutes & { locks: WorkspaceWriteLocks } {
  const locks = opts.locks ?? new WorkspaceWriteLocks();

  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? "/", "https://core.invalid");
    if (!url.pathname.startsWith(CORE_FILES_ROUTE_PREFIX)) return false;
    void route(req, res, url).catch((err: unknown) => {
      // Anything reaching here is a bug in this file, not bad input — every
      // expected refusal is returned rather than thrown. Log it and say as
      // little as possible on the wire.
      log.error("core-files.unhandled", { error: err instanceof Error ? err.message : String(err) });
      sendRefusal(res, { status: 500, code: "write-failed", message: "the Core failed to handle this request" });
    });
    return true;
  }

  /**
   * The `Expect: 100-continue` half of the same surface.
   *
   * Wired to the server's `checkContinue` event so a client that asks first is
   * refused *before* it sends a byte — which is what makes "refused
   * immediately" (F8) true for a multi-gigabyte upload rather than merely
   * quick. A client that does not ask gets the same refusal once its body has
   * started; the answer is identical, only the wasted bandwidth differs.
   */
  function handleContinue(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? "/", "https://core.invalid");
    if (!url.pathname.startsWith(CORE_FILES_ROUTE_PREFIX)) return false;
    // Everything that can be known before the body is checked here: the bearer,
    // the home, and — the point of the exercise — whether some other transfer
    // already holds the write lease.
    const refusal = precheck(req, url) ?? peekWriteLease(req, url);
    if (refusal) {
      sendRefusal(res, refusal);
      return true;
    }
    res.writeContinue();
    void route(req, res, url).catch((err: unknown) => {
      log.error("core-files.unhandled", { error: err instanceof Error ? err.message : String(err) });
      sendRefusal(res, { status: 500, code: "write-failed", message: "the Core failed to handle this request" });
    });
    return true;
  }

  /** The half of validation that needs no request body. Returns null when it passes. */
  function precheck(req: IncomingMessage, url: URL): Refusal | null {
    if (opts.authVerifier) {
      const refusal = checkBearer(req, opts.authVerifier);
      if (refusal) return refusal;
    }
    const target = parseRoute(url);
    if (!target) return { status: 404, code: "not-found", message: `no route for ${url.pathname}` };
    if (!target.methods.includes(req.method ?? "")) {
      return {
        status: 405,
        code: "method-not-allowed",
        message: `${req.method ?? "?"} is not allowed here — use ${target.methods.join(", ")}`,
      };
    }
    if (!opts.filesPort.workspaceRoot()) {
      return { status: 404, code: "not-found", message: "this Core has no home to serve" };
    }
    return null;
  }

  /**
   * Is the home already being written?
   *
   * A **peek, not a claim**. The lease is taken in `route` and nowhere else, so
   * this cannot leave one stranded when a client that asked for 100-continue then
   * hangs up without sending its body. The window it leaves — a second transfer
   * starting between this answer and that claim — is closed by the claim itself,
   * which is the check that decides. This one only saves the loser a gigabyte of
   * upload.
   */
  function peekWriteLease(req: IncomingMessage, url: URL): Refusal | null {
    if (!isWrite(req.method, parseRoute(url))) return null;
    const held = locks.current();
    if (!held) return null;
    return transferInProgress(held.path, held.startedAt);
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const refusal = precheck(req, url);
    if (refusal) return sendRefusal(res, refusal);

    const target = parseRoute(url)!;
    const root = opts.filesPort.workspaceRoot()!;
    const requested = url.searchParams.get("path") ?? "";

    const built = await buildRequest(req, url, target, requested);
    if (!built.ok) return sendRefusal(res, built.refusal);
    const request = built.request;

    // Everything that changes the disk takes the one write lease, and takes it
    // before anything is read, and is refused without reading. "Immediate" is the
    // requirement (F8), and a refusal that first drains a multi-gigabyte body is
    // not one. The key is the *lexical* path: this process may not be able to
    // look at the disk, and the lease is only there to say what is being written.
    let release = (): void => {};
    if (isWrite(req.method, target)) {
      const acquisition = locks.acquire(lexicalRelative(request.op === "move" ? request.from : requested));
      if (!acquisition.ok) {
        return sendRefusal(res, transferInProgress(acquisition.held.path, acquisition.held.startedAt));
      }
      release = acquisition.lease.release;
      // Belt and braces, and deliberately not the only guarantee. The operation
      // throws when the connection dies, so the `finally` below runs — but the lease
      // is the one piece of state whose leak outlives the request (the home stays
      // unwritable until the Core restarts), so it is also released the moment the
      // socket closes, whatever the operation happens to be awaiting. `release` is
      // idempotent and compares identity before deleting.
      res.on("close", release);
    }

    try {
      if (filesRunAsHelper(opts.helper)) {
        await runFilesOpAsCore(request, req, res, opts.helper);
      } else {
        await runFilesOp(request, req, responseOut(res), {
          root,
          freeSpace: opts.freeSpace ?? freeSpaceBytes,
        });
      }
    } finally {
      release();
    }
  }

  return { handle, handleContinue, locks };
}

type Built = { ok: true; request: FilesOpRequest } | { ok: false; refusal: Refusal };

/** The operation a request asks for, or the refusal that needs no disk. */
async function buildRequest(req: IncomingMessage, url: URL, target: Target, requested: string): Promise<Built> {
  const method = req.method ?? "";
  if (target.leaf === "move") {
    const body = await readJsonBody(req);
    if (!body.ok) return body;
    const { from, to } = body.value as { from?: unknown; to?: unknown };
    if (typeof from !== "string" || typeof to !== "string") {
      return bad("a move needs a JSON body of the form {\"from\": <path>, \"to\": <path>}");
    }
    for (const candidate of [from, to]) {
      const unsafe = stringRefusal(candidate);
      if (unsafe) return { ok: false, refusal: { status: 400, code: unsafe.reason, message: unsafe.message } };
    }
    return { ok: true, request: { op: "move", from, to } };
  }

  const unsafe = stringRefusal(requested);
  if (unsafe) return { ok: false, refusal: { status: 400, code: unsafe.reason, message: unsafe.message } };

  if (target.leaf === "folder") return { ok: true, request: { op: "mkdir", path: requested } };
  if (target.leaf === "list") {
    const query = parseListingQuery(url);
    if (!query.ok) return { ok: false, refusal: query.refusal };
    return { ok: true, request: { op: "list", path: requested, headOnly: method === "HEAD", ...query.options } };
  }
  if (method === "PUT") {
    return {
      ok: true,
      request: {
        op: "write",
        path: requested,
        tar: isTarUpload(req),
        contentLength: finiteHeader(req, "content-length"),
        fileMode: finiteHeader(req, "x-actana-file-mode"),
        fileMtime: finiteHeader(req, "x-actana-file-mtime"),
      },
    };
  }
  if (method === "DELETE") return { ok: true, request: { op: "delete", path: requested } };
  return { ok: true, request: { op: "read", path: requested, headOnly: method === "HEAD" } };
}

function bad(message: string): { ok: false; refusal: Refusal } {
  return { ok: false, refusal: { status: 400, code: "bad-request", message } };
}

function finiteHeader(req: IncomingMessage, name: string): number | null {
  const value = Number(req.headers[name] ?? Number.NaN);
  return Number.isFinite(value) ? value : null;
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false; refusal: Refusal }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > MAX_JSON_BODY_BYTES) return bad("the JSON body is too large");
    chunks.push(buf);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof value !== "object" || value === null) throw new Error("not an object");
    return { ok: true, value };
  } catch {
    return bad("the body is not a JSON object");
  }
}

/** Does this method, on this route, change the disk? */
function isWrite(method: string | undefined, target: Target | null): boolean {
  if (!target) return false;
  if (target.leaf === "folder" || target.leaf === "move") return true;
  return target.leaf === "files" && (method === "PUT" || method === "DELETE");
}

/** A request path as the lease names it: its segments, with no disk consulted. */
function lexicalRelative(requested: string): string {
  return requested
    .trim()
    .split("/")
    .filter((s) => s.length > 0 && s !== ".")
    .join("/");
}

/**
 * The one refusal a client is guaranteed to be able to tell apart (F8).
 *
 * 409 plus `transfer-in-progress`: distinguishable by status from a bad path
 * (400) and a missing home (404), and by code from any other 409 this
 * surface might ever grow. The prose says which transfer and since when,
 * because "try again" is useless advice without it.
 */
function transferInProgress(heldPath: string, startedAt: number): Refusal {
  return {
    status: 409,
    code: "transfer-in-progress",
    message:
      "another write is already running in the home " +
      `(${heldPath || "."}, started ${new Date(startedAt).toISOString()}) — ` +
      "one write at a time; reads are unrestricted and concurrent",
  };
}

/**
 * Is this `PUT` an archive to unpack, or one file's bytes?
 *
 * The content type decides. A charset or boundary parameter is ignored; only the
 * media type is the answer.
 */
function isTarUpload(req: IncomingMessage): boolean {
  const contentType = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  return contentType === "application/x-tar" || contentType === "application/tar";
}

/**
 * `/v1/files[/list|/folder|/move]` → which leaf.
 *
 * The old `/v1/projects/:id/files[/list]` address is **retired** (#580 T-404): the published SDK
 * builds `/v1/files`, so nothing calls it. It is not recognised, so a Core refuses it with the
 * 404 every unknown route gets (ADR 0041 D27), and reads, lists or writes nothing.
 *
 * Anything else → null, and the caller keeps its 404.
 */
function parseRoute(url: URL): Target | null {
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments[0] !== "v1" || segments[1] !== "files") return null;

  if (segments.length === 2) return { leaf: "files", methods: METHODS_BY_LEAF.files };
  if (segments.length === 3 && segments[2] === "list") return { leaf: "list", methods: METHODS_BY_LEAF.list };
  if (segments.length === 3 && segments[2] === "folder") return { leaf: "folder", methods: METHODS_BY_LEAF.folder };
  if (segments.length === 3 && segments[2] === "move") return { leaf: "move", methods: METHODS_BY_LEAF.move };
  return null;
}

/**
 * `?depth=` and `?sha256=` on the listing route.
 *
 * Refused rather than defaulted when they are not understood. A `depth=two`
 * silently read as "the whole tree" is the request an operator meant to bound
 * answering with a `node_modules`, and `sha256=yes` silently read as "no" is
 * the request a diff meant to be exact answering with nulls it would then read
 * as unchanged. Both are cheap to get right and expensive to guess at.
 */
function parseListingQuery(url: URL): { ok: true; options: FileListingOptions } | { ok: false; refusal: Refusal } {
  const options: FileListingOptions = {};

  const depth = url.searchParams.get("depth");
  if (depth !== null && depth !== "" && depth !== "all") {
    const value = Number(depth);
    if (!Number.isInteger(value) || value < 1) {
      return {
        ok: false,
        refusal: {
          status: 400,
          code: "bad-request",
          message: `depth must be a whole number of levels (1 or more) or \`all\`, got ${JSON.stringify(depth)}`,
        },
      };
    }
    options.depth = value;
  }

  const sha256 = url.searchParams.get("sha256");
  if (sha256 !== null && sha256 !== "") {
    if (sha256 === "1" || sha256 === "true") options.sha256 = true;
    else if (sha256 !== "0" && sha256 !== "false") {
      return {
        ok: false,
        refusal: {
          status: 400,
          code: "bad-request",
          message: `sha256 must be 1, 0, true or false, got ${JSON.stringify(sha256)}`,
        },
      };
    }
  }

  return { ok: true, options };
}

function checkBearer(req: IncomingMessage, verify: FilesAuthVerifier): Refusal | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.toLowerCase().startsWith("bearer ")) {
    return { status: 401, code: "unauthorized", message: "this Core requires `Authorization: Bearer <bearer>`" };
  }
  const presented = header.slice("bearer ".length).trim();
  if (presented.length === 0) {
    return { status: 401, code: "unauthorized", message: "the presented bearer is empty" };
  }
  const verdict = verify(presented);
  if (!verdict.ok) {
    return { status: 401, code: "unauthorized", message: `the presented bearer is ${verdict.reason}` };
  }
  return null;
}

/**
 * A refusal, as a JSON body with a machine-readable `code` beside the prose.
 *
 * `code` is what a client branches on — `transfer-in-progress` has to be
 * distinguishable from every other 4xx (F8), and reading a sentence to find
 * that out is how a client ends up matching on a message somebody later
 * rewords. The prose is for the operator.
 */
function sendRefusal(res: ServerResponse, refusal: Refusal): void {
  refuse(responseOut(res), refusal);
}
