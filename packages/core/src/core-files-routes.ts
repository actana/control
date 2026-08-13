// The Core's `/v1/…` file routes (#165, F2–F6, F8).
//
// These mount on the **same mTLS HTTPS server the core-link WebSocket already
// listens on** — one port, one certificate, one bearer, two protocols. Bytes
// cross here and never over the core link (ADR 0030): a multi-gigabyte upload
// chunked into JSON frames would stutter every terminal pane sharing that
// socket through head-of-line blocking, and base64 would cost a third of the
// wire for the privilege.
//
// The surface:
//
//   GET  /v1/projects/:projectId/files?path=<relative>
//        A file's raw bytes, or a directory as one streamed tar.
//   HEAD /v1/projects/:projectId/files?path=<relative>
//        The same headers, no body.
//   PUT  /v1/projects/:projectId/files?path=<relative>
//        Write. `Content-Type: application/x-tar` unpacks an archive into that
//        path; anything else writes one file at it. The response is a chunked
//        NDJSON progress stream, one line per entry.
//
// Raw `node:http` handlers, `URL`-based dispatch, JSON error bodies — the same
// shape as `harness-hook-receiver.ts`, which is this repository's other HTTP
// surface. No framework enters the Core bundle for three routes.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { confineToProjectRoot, confineWriteTarget, freeSpaceBytes } from "./files-confinement";
import { packDirectory, TarError, unpackTarInto, type TarEntryReport, type TarWriteOutcome } from "./files-tar";
import { ProjectWriteLocks } from "./files-transfer-locks";
import log from "./log";

/**
 * A Project's root on this machine.
 *
 * The whole of #129 F1 is behind this one method: **the filesystem is the
 * model.** There is no file index, no per-file id, no shadow table to keep in
 * step with the disk — a path plus a Project root is the entire address space,
 * and `readdir` is the query engine. See ADR 0029.
 */
export interface CoreFilesPort {
  /** Absolute path of a Project on this machine, or null when the id is unknown. */
  projectRoot(projectId: string): string | null;
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
  /** One write transfer per Project (F8). A fresh table is made when omitted. */
  locks?: ProjectWriteLocks;
  /** Injectable for tests. Defaults to a real `statfs`. */
  freeSpace?: (target: string) => Promise<number | null>;
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

/** Machine-readable refusal codes. The Panel forwards them; it reads none of them. */
export type CoreFilesErrorCode =
  | "unauthorized"
  | "not-found"
  | "project-not-found"
  | "method-not-allowed"
  | "bad-request"
  | "absolute-path"
  | "dot-dot-segment"
  | "outside-project-root"
  | "malformed-path"
  | "transfer-in-progress"
  | "insufficient-storage"
  | "corrupt-archive"
  | "absolute-entry-path"
  | "dot-dot-entry-path"
  | "entry-outside-root"
  | "unsupported-entry-type"
  | "hardlink-outside-root"
  | "symlink-outside-root"
  | "write-failed"
  | "read-failed";

type Refusal = { status: number; code: CoreFilesErrorCode; message: string };

/**
 * Build the request handler.
 *
 * Returns `true` when it took the request and `false` when the path is none of
 * its business, so the caller keeps the 404 for everything else — the Core's
 * HTTP surface stays a closed list rather than a prefix this module owns.
 */
export function createCoreFilesRequestHandler(
  opts: CoreFilesRoutesOptions,
): CoreHttpRoutes & { locks: ProjectWriteLocks } {
  const locks = opts.locks ?? new ProjectWriteLocks();
  const freeSpace = opts.freeSpace ?? freeSpaceBytes;

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
    // the Project, and — the point of the exercise — whether some other
    // transfer already holds this Project's write lease.
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
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "PUT") {
      return {
        status: 405,
        code: "method-not-allowed",
        message: `${req.method ?? "?"} is not allowed here — use GET, HEAD or PUT`,
      };
    }
    if (!opts.filesPort.projectRoot(target.projectId)) {
      return { status: 404, code: "project-not-found", message: `no Project ${target.projectId} on this Core` };
    }
    return null;
  }

  /**
   * Is this Project already being written?
   *
   * A **peek, not a claim**. The lease is taken in `handlePut` and nowhere
   * else, so this cannot leave one stranded when a client that asked for
   * 100-continue then hangs up without sending its body. The window it leaves —
   * a second transfer starting between this answer and that claim — is closed
   * by the claim itself, which is the check that decides. This one only saves
   * the loser a gigabyte of upload.
   */
  function peekWriteLease(req: IncomingMessage, url: URL): Refusal | null {
    if (req.method !== "PUT") return null;
    const target = parseRoute(url);
    if (!target) return null;
    const held = locks.current(target.projectId);
    if (!held) return null;
    return transferInProgress(held.path, held.startedAt);
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const refusal = precheck(req, url);
    if (refusal) return sendRefusal(res, refusal);

    const target = parseRoute(url)!;
    const root = opts.filesPort.projectRoot(target.projectId)!;
    const requested = url.searchParams.get("path") ?? "";
    // A read follows every symlink, including the last component — the
    // operator asked for what the path names. A write follows the parents and
    // not the last component, so `PUT path=notes.txt` replaces `notes.txt`
    // rather than the file a `notes.txt` symlink happens to point at.
    const confined =
      req.method === "PUT" ? confineWriteTarget(root, requested) : confineToProjectRoot(root, requested);
    if (!confined.ok) {
      // 400, not 403. This is an accident guard and the honest status for
      // "the path you sent does not name anything inside this Project" is that
      // the request was malformed. A 403 would claim a permission model that
      // does not exist here — `core shell` is the sanctioned way onto this
      // machine's disk and it is not gated by anything this module knows about.
      return sendRefusal(res, { status: 400, code: confined.reason, message: confined.message });
    }

    if (req.method === "PUT") return await handlePut(req, res, target.projectId, root, confined.absolute, confined.relative);
    return await handleGet(req, res, confined.absolute, confined.relative);
  }

  async function handleGet(
    req: IncomingMessage,
    res: ServerResponse,
    absolute: string,
    relative: string,
  ): Promise<void> {
    let stats: fs.Stats;
    try {
      // `stat`, not `lstat`: `confineToProjectRoot` has already resolved the
      // path through every symlink and refused any that left the Project, so
      // what is left points somewhere legitimate and the operator asked for
      // what is *there*.
      stats = await fs.promises.stat(absolute);
    } catch {
      return sendRefusal(res, { status: 404, code: "not-found", message: `no such path in this Project: ${relative || "."}` });
    }

    if (stats.isDirectory()) {
      res.writeHead(200, {
        "content-type": "application/x-tar",
        // No content-length: the tar is produced as it is walked, and the
        // alternative — walking the tree twice to measure it — is the second
        // pass over every byte this design exists to not do.
        "transfer-encoding": "chunked",
        "cache-control": "no-store",
        "x-actana-transfer-kind": "tar",
      });
      if (req.method === "HEAD") return void res.end();
      try {
        for await (const chunk of packDirectory(absolute)) {
          if (!res.write(chunk)) await once(res, "drain");
        }
        res.end();
      } catch (err) {
        // The status line went out long ago. Destroying the socket is the only
        // way left to tell the client this body is not the whole folder — a
        // truncated tar that ended cleanly would unpack as a short one.
        log.error("core-files.pack-failed", { path: relative, error: err instanceof Error ? err.message : String(err) });
        res.destroy();
      }
      return;
    }

    if (!stats.isFile()) {
      return sendRefusal(res, {
        status: 400,
        code: "bad-request",
        message: `${relative || "."} is neither a file nor a directory`,
      });
    }

    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(stats.size),
      "cache-control": "no-store",
      "x-actana-transfer-kind": "file",
      // The four cheap fields of #129 F10 that a single-file read can carry
      // without a second pass. The fifth, `sha256`, is the one the reader
      // computes as the bytes arrive — the same digest, one pass, at the end
      // that has the bytes anyway.
      "x-actana-file-mode": String(stats.mode & 0o777),
      "x-actana-file-mtime": String(Math.floor(stats.mtimeMs)),
      "x-actana-file-size": String(stats.size),
    });
    if (req.method === "HEAD") return void res.end();
    try {
      for await (const chunk of fs.createReadStream(absolute)) {
        if (!res.write(chunk as Uint8Array)) await once(res, "drain");
      }
      res.end();
    } catch (err) {
      log.error("core-files.read-failed", { path: relative, error: err instanceof Error ? err.message : String(err) });
      res.destroy();
    }
  }

  async function handlePut(
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
    root: string,
    absolute: string,
    relative: string,
  ): Promise<void> {
    // The lease is taken before anything is read, and refused without reading.
    // "Immediate" is the requirement (F8), and a refusal that first drains a
    // multi-gigabyte body is not one.
    const acquisition = locks.acquire(projectId, relative);
    if (!acquisition.ok) {
      return sendRefusal(res, transferInProgress(acquisition.held.path, acquisition.held.startedAt));
    }
    const lease = acquisition.lease;

    try {
      const declared = Number(req.headers["content-length"] ?? Number.NaN);
      if (Number.isFinite(declared) && declared > 0) {
        // No size cap — a Project takes whatever fits. What is checked is
        // whether it fits, and the request's own length is the bound: a tar is
        // never smaller than the files inside it, so the declared body length
        // is an upper bound on the bytes about to land in both modes.
        const available = await freeSpace(root);
        if (available !== null && available < declared) {
          return sendRefusal(res, {
            status: 507,
            code: "insufficient-storage",
            message:
              `this transfer declares ${declared} bytes and the filesystem holding this Project ` +
              `has ${available} available`,
          });
        }
      }
      // A chunked upload declares nothing, so there is nothing to check against
      // and the transfer proceeds. Said out loud rather than silently skipped:
      // the precheck is an early, cheaper ENOSPC, never a guarantee.

      const contentType = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      const asTar = contentType === "application/x-tar" || contentType === "application/tar";

      res.writeHead(200, {
        "content-type": "application/x-ndjson",
        "transfer-encoding": "chunked",
        "cache-control": "no-store",
        "x-actana-transfer-kind": asTar ? "tar" : "file",
      });

      const writeLine = async (value: unknown): Promise<void> => {
        if (!res.write(`${JSON.stringify(value)}\n`)) await once(res, "drain");
      };

      try {
        if (asTar) {
          await fs.promises.mkdir(absolute, { recursive: true });
          const result = await unpackTarInto(req, absolute, root, async (entry) => {
            await writeLine({ type: "entry", ...prefixed(relative, entry) });
          });
          await writeLine({ type: "done", entries: result.entries, bytes: result.bytes });
        } else {
          const entry = await writeSingleFile(req, absolute, relative);
          await writeLine({ type: "entry", ...entry });
          await writeLine({ type: "done", entries: 1, bytes: entry.size });
        }
      } catch (err) {
        // Mid-stream failure. The 200 is spent, so the failure is a *line* —
        // which is exactly why the progress stream is NDJSON and not a JSON
        // document: a document would have to be well-formed to be read at all,
        // and this one stops in the middle by design.
        const code: CoreFilesErrorCode = err instanceof TarError ? err.code : "write-failed";
        const message = err instanceof Error ? err.message : String(err);
        log.warn("core-files.write-failed", { projectId, path: relative, code, error: message });
        await writeLine({ type: "error", code, message }).catch(() => {});
      }
      res.end();
    } finally {
      lease.release();
    }
  }

  return { handle, handleContinue, locks };
}

/**
 * The one refusal a client is guaranteed to be able to tell apart (F8).
 *
 * 409 plus `transfer-in-progress`: distinguishable by status from a bad path
 * (400) and a missing Project (404), and by code from any other 409 this
 * surface might ever grow. The prose says which transfer and since when,
 * because "try again" is useless advice without it.
 */
function transferInProgress(heldPath: string, startedAt: number): Refusal {
  return {
    status: 409,
    code: "transfer-in-progress",
    message:
      "another write transfer is already running on this Project " +
      `(${heldPath || "."}, started ${new Date(startedAt).toISOString()}) — ` +
      "one write at a time per Project; reads are unrestricted and concurrent",
  };
}

/** `PUT` of a single file: write it, hash it as it goes, report the five fields. */
async function writeSingleFile(
  req: IncomingMessage,
  absolute: string,
  relative: string,
): Promise<TarEntryReport & { result: TarWriteOutcome }> {
  await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
  const existing = await fs.promises.lstat(absolute).catch(() => null);
  if (existing && !existing.isFile()) {
    await fs.promises.rm(absolute, { force: true, recursive: true });
  }
  const result: TarWriteOutcome = existing ? "overwritten" : "written";

  // The executable bit crosses on a single-file write too, out of a header
  // rather than a tar entry. Absent, 0o644 — the mode a file gets from any
  // other tool that creates one.
  const requestedMode = Number(req.headers["x-actana-file-mode"] ?? Number.NaN);
  const mode = Number.isFinite(requestedMode) ? requestedMode & 0o777 : 0o644;

  const hash = createHash("sha256");
  let size = 0;
  const handle = await fs.promises.open(absolute, "w", mode);
  try {
    for await (const chunk of req) {
      const bytes = chunk as Uint8Array;
      hash.update(bytes);
      size += bytes.length;
      await handle.write(bytes);
    }
  } finally {
    await handle.close();
  }
  // `open(…, mode)` applies the mode only when it creates the file, so an
  // overwrite would otherwise keep the old bits.
  await fs.promises.chmod(absolute, mode);

  const mtimeHeader = Number(req.headers["x-actana-file-mtime"] ?? Number.NaN);
  if (Number.isFinite(mtimeHeader) && mtimeHeader > 0) {
    await fs.promises.utimes(absolute, mtimeHeader / 1000, mtimeHeader / 1000);
  }
  const stats = await fs.promises.stat(absolute);

  return {
    path: relative,
    kind: "file",
    size,
    mtime: Math.floor(stats.mtimeMs),
    mode: stats.mode & 0o777,
    sha256: hash.digest("hex"),
    result,
  };
}

/**
 * Report an unpacked entry's path relative to the *Project*, not to the folder
 * the archive was unpacked into.
 *
 * Every path on this surface is Project-relative — that is the address space
 * F1 gives the operator — so a tar landing in `vendor/` reports
 * `vendor/lib/x.js`, which is the string they would pass back to `GET`.
 */
function prefixed<T extends { path: string }>(base: string, entry: T): T {
  if (base.length === 0) return entry;
  return { ...entry, path: `${base}/${entry.path}` };
}

/** `/v1/projects/:projectId/files` → `{ projectId }`. Anything else → null. */
function parseRoute(url: URL): { projectId: string } | null {
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length !== 4) return null;
  const [v1, projects, projectId, leaf] = segments;
  if (v1 !== "v1" || projects !== "projects" || leaf !== "files") return null;
  if (!projectId || projectId.length === 0) return null;
  return { projectId: decodeURIComponent(projectId) };
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
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ code: refusal.code, error: refusal.message });
  res.writeHead(refusal.status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
  });
  res.end(body);
}

function once(emitter: NodeJS.EventEmitter, event: string): Promise<void> {
  return new Promise((resolve) => emitter.once(event, () => resolve()));
}
