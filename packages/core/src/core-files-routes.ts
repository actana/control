// The Core's `/v1/…` file routes (#165, F2–F6, F8).
//
// These mount on the **same mTLS HTTPS server the core-link WebSocket already
// listens on** — one port, one certificate, one bearer, two protocols. Bytes
// cross here and never over the core link (ADR 0028): a multi-gigabyte upload
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
//   GET  /v1/projects/:projectId/files/list?path=<relative>&depth=<n>&sha256=1
//        The tree under that path, as a chunked NDJSON stream — one line per
//        entry, to arbitrary depth (#166, F7).
//
// Listing is a route of its own rather than a `?list=1` on the read above, and
// the reason is what the two answer with: one hands back a tar of a folder and
// the other hands back a manifest of it. A query parameter that a proxy,
// redirect or hand-edited URL can drop would turn "list this folder" into
// "download this folder", which for a `node_modules` is a mistake measured in
// gigabytes rather than in a 400. A path segment cannot be dropped silently.
//
// Raw `node:http` handlers, `URL`-based dispatch, JSON error bodies — the same
// shape as `harness-hook-receiver.ts`, which is this repository's other HTTP
// surface. No framework enters the Core bundle for three routes.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { confineToProjectRoot, confineWriteTarget, freeSpaceBytes } from "./files-confinement";
import { listTree, type FileListingOptions } from "./files-listing";
import { packDirectory, TarError, unpackTarInto, type TarEntryReport, type TarWriteOutcome } from "./files-tar";
import { ProjectWriteLocks } from "./files-transfer-locks";
import log from "./log";

/**
 * A Project's root on this machine.
 *
 * The whole of #129 F1 is behind this one method: **the filesystem is the
 * model.** There is no file index, no per-file id, no shadow table to keep in
 * step with the disk — a path plus a Project root is the entire address space,
 * and `readdir` is the query engine. See ADR 0027.
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
  | "root-entry-path"
  | "entry-outside-root"
  | "unsupported-entry-type"
  | "hardlink-outside-root"
  | "symlink-outside-root"
  | "directory-in-the-way"
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
    // A listing is a read and only a read. `PUT /files/list` is refused here
    // rather than falling through to the write path, which would otherwise
    // create a *file called `list`* inside the Project — the one request on
    // this surface where a typo's consequence is a write.
    const allowed = target.leaf === "list" ? ["GET", "HEAD"] : ["GET", "HEAD", "PUT"];
    if (!allowed.includes(req.method ?? "")) {
      return {
        status: 405,
        code: "method-not-allowed",
        message: `${req.method ?? "?"} is not allowed here — use ${allowed.join(", ")}`,
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
    if (target.leaf === "list") return await handleList(req, res, url, confined.absolute, confined.relative);
    return await handleGet(req, res, confined.absolute, confined.relative);
  }

  /**
   * `GET /v1/projects/:projectId/files/list` — the tree as NDJSON (#166 F7).
   *
   * Chunked from the first entry and buffered nowhere: `listTree` yields a line
   * at a time and this loop writes each one straight out, waiting on
   * {@link drained} when the socket stops accepting them. A `node_modules`
   * costs the same memory here as an empty folder, which is the requirement,
   * and an operator who stops reading closes the walk rather than leaving it
   * running against the disk.
   */
  async function handleList(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    absolute: string,
    relative: string,
  ): Promise<void> {
    const query = parseListingQuery(url);
    if (!query.ok) return sendRefusal(res, query.refusal);

    // `lstat` before the 200, so "no such path" is a status code rather than an
    // error line at the end of an otherwise empty stream.
    const exists = await fs.promises.lstat(absolute).catch(() => null);
    if (!exists) {
      return sendRefusal(res, {
        status: 404,
        code: "not-found",
        message: `no such path in this Project: ${relative || "."}`,
      });
    }

    res.writeHead(200, {
      "content-type": "application/x-ndjson",
      // No content-length, and no way to have one: the tree is measured by
      // walking it, and walking it twice to say how long the answer will be is
      // the whole of what this design refuses to do.
      "transfer-encoding": "chunked",
      "cache-control": "no-store",
      "x-actana-transfer-kind": "listing",
    });
    if (req.method === "HEAD") return void res.end();

    const writeLine = async (value: unknown): Promise<void> => {
      if (!res.write(`${JSON.stringify(value)}\n`)) await drained(res);
    };

    let entries = 0;
    let skipped = 0;
    let bytes = 0;
    try {
      for await (const line of listTree(absolute, relative, query.options)) {
        if (line.type === "entry") {
          entries += 1;
          if (line.kind === "file") bytes += line.size;
        } else {
          skipped += 1;
        }
        await writeLine(line);
      }
      await writeLine({ type: "done", entries, skipped, bytes });
    } catch (err) {
      if (err instanceof ClientGoneError) {
        // The ordinary end of a listing somebody stopped reading. The `for
        // await` above has already closed the walk — and with it every
        // directory handle it was holding — on its way out through here.
        log.info("core-files.list-aborted", { path: relative, entries });
        res.destroy();
        return;
      }
      // The 200 is spent, so the failure is the last line rather than a status.
      // Same reasoning as the write stream: NDJSON is readable up to the point
      // it stops, and a JSON document would have to be complete to be read.
      const message = err instanceof Error ? err.message : String(err);
      log.warn("core-files.list-failed", { path: relative, error: message });
      await writeLine({ type: "error", code: "read-failed", message }).catch(() => {});
    }
    res.end();
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
          if (!res.write(chunk)) await drained(res);
        }
        res.end();
      } catch (err) {
        // A client that walked away is the ordinary end of a download — an
        // operator hitting Ctrl-C on a `node_modules` — so it is not logged as
        // a failure. It still had to throw to get here: that is what closed the
        // `packDirectory` generator and, with it, the file handle in its own
        // `finally`.
        if (err instanceof ClientGoneError) {
          log.info("core-files.pack-aborted", { path: relative });
          res.destroy();
          return;
        }
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
        if (!res.write(chunk as Uint8Array)) await drained(res);
      }
      res.end();
    } catch (err) {
      if (err instanceof ClientGoneError) {
        log.info("core-files.read-aborted", { path: relative });
        res.destroy();
        return;
      }
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
    const asTar = isTarUpload(req);

    // A single-file write has to name a file, and the Project root is not one.
    //
    // `?path=` — and `path` omitted altogether, and `?path=.` — all confine to
    // an empty `relative`, which *is* the Project root. Without this guard the
    // empty-directory carve-out below reasons about it as it would about any
    // other directory ("nothing to lose") and `writeSingleFile` then removes
    // whatever is not a file and creates one in its place: on an empty Project
    // that is `rm -r` of the root followed by a regular file at the root's
    // path. Nothing is lost in bytes, and everything is lost in shape —
    // listing, transfers and the harness's working directory all fail against
    // a Project whose root is a file, and only a hand-fix on the Core machine
    // brings it back.
    //
    // Refused here rather than inside `writeSingleFile`, for the reason the
    // directory check gives: before the 200, so the answer is a status and a
    // code rather than an error line at the end of a stream. Before the lease,
    // too — a request this malformed should not so much as touch the lock
    // table. 400 `malformed-path` puts it with the other "that path names
    // nothing writable" refusals of this surface rather than with the 409s,
    // which are about what is on the disk.
    //
    // The *tar* branch is not guarded here, and deliberately: an empty path
    // there is the legitimate "unpack into the Project root", which is a write
    // of the root's contents and not a write of the root. The archive can still
    // *name* the root as an entry, which is the same defect one branch over —
    // that one is refused inside `unpackTarInto`, as `root-entry-path`, on the
    // resolved entry path rather than here on the request's.
    if (!asTar && relative === "") {
      return sendRefusal(res, {
        status: 400,
        code: "malformed-path",
        message:
          "a single-file write needs a name — this path resolves to the Project root itself. " +
          "Send `?path=<file>` for a file, or `Content-Type: application/x-tar` to unpack an archive into the root.",
      });
    }

    // The lease is taken before anything is read, and refused without reading.
    // "Immediate" is the requirement (F8), and a refusal that first drains a
    // multi-gigabyte body is not one.
    const acquisition = locks.acquire(projectId, relative);
    if (!acquisition.ok) {
      return sendRefusal(res, transferInProgress(acquisition.held.path, acquisition.held.startedAt));
    }
    const lease = acquisition.lease;
    // Belt and braces, and deliberately not the only guarantee. `drained` now
    // throws when the connection dies, so the `finally` below runs and this
    // listener finds nothing left to do — but the lease is the one piece of
    // state whose leak outlives the request (the Project stays unwritable until
    // the Core restarts), so it is also released the moment the socket closes,
    // whatever this handler happens to be awaiting at the time. `release` is
    // idempotent and compares identity before deleting, so the two paths cannot
    // free each other's entry.
    res.on("close", () => lease.release());

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

      // A single-file write onto a path that currently holds a **non-empty
      // directory** is refused, not performed.
      //
      // F5's overwrite-by-default is about replacing a *file*. Recursively
      // deleting a subtree is a different promise, and one nobody made: not the
      // ticket, not ADR 0029 D6, not `docs/external-api.md`. A `PUT ?path=src`
      // meant for `src/x.ts` is a typo, and answering it by deleting `src` and
      // reporting an ordinary `overwritten` line is the worst of both — the
      // damage is silent and the progress stream says nothing happened out of
      // the ordinary. `tar(1)` refuses this case too.
      //
      // Checked here rather than in `writeSingleFile` because here the 200 has
      // not gone out yet, so the operator gets a status and a code instead of an
      // error line at the end of a stream. An *empty* directory is still
      // replaced: there is nothing to lose, and a stray `mkdir` should not
      // wedge a path forever.
      //
      // "Nothing to lose" is true of a subfolder and false of the Project root,
      // which has its shape to lose even when it holds no bytes. The root never
      // reaches this check — the guard at the top of `handlePut` refused it —
      // and that ordering is the point: this check reasons about *contents*,
      // and the root is refused for *being the root*.
      if (!asTar) {
        const refusal = await directoryInTheWay(absolute, relative);
        if (refusal) return sendRefusal(res, refusal);
      }

      res.writeHead(200, {
        "content-type": "application/x-ndjson",
        "transfer-encoding": "chunked",
        "cache-control": "no-store",
        "x-actana-transfer-kind": asTar ? "tar" : "file",
      });

      // Throws `ClientGoneError` rather than parking when the client stops
      // reading and hangs up — a folder upload backs this stream up past the
      // 16 KB high-water mark within ~100 entries, so a client that only reads
      // its progress at the end is the ordinary case and not a pathological
      // one.
      const writeLine = async (value: unknown): Promise<void> => {
        if (!res.write(`${JSON.stringify(value)}\n`)) await drained(res);
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
        if (err instanceof ClientGoneError) {
          // Nothing to report to a client that is gone, and nothing to log as a
          // failure — the operator aborted their own upload. What matters is
          // that it *threw*, so the `finally` below releases the lease.
          log.info("core-files.write-aborted", { projectId, path: relative });
          res.destroy();
          return;
        }
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

/**
 * Is this `PUT` an archive to unpack, or one file's bytes?
 *
 * The content type decides, and it decides twice — once for the root guard in
 * `handlePut` and once for the write itself — so it is read in one place. A
 * charset or boundary parameter is ignored; only the media type is the answer.
 */
function isTarUpload(req: IncomingMessage): boolean {
  const contentType = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  return contentType === "application/x-tar" || contentType === "application/tar";
}

/**
 * Is a non-empty directory sitting where this single-file write wants to land?
 *
 * 409 rather than 400: the request is well-formed and the path is legal, the
 * disk just holds something this surface will not delete. Distinguishable from
 * the other 409 by `code`, which is the contract F8 already establishes for
 * `transfer-in-progress`.
 */
async function directoryInTheWay(absolute: string, relative: string): Promise<Refusal | null> {
  const existing = await fs.promises.lstat(absolute).catch(() => null);
  if (!existing?.isDirectory()) return null;
  const contents = await fs.promises.readdir(absolute).catch(() => [] as string[]);
  if (contents.length === 0) return null;
  return {
    status: 409,
    code: "directory-in-the-way",
    message:
      `${relative || "."} is a directory holding ${contents.length} entr${contents.length === 1 ? "y" : "ies"} — ` +
      "writing a file over it would delete the whole tree, which this surface does not do. " +
      "Remove it first if that is what you meant.",
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
    // Only an empty directory, a symlink or another odd node reaches here — a
    // non-empty directory was refused before the 200 went out, by
    // `directoryInTheWay`.
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

/**
 * `/v1/projects/:projectId/files[/list]` → the Project and which leaf.
 * Anything else → null, and the caller keeps its 404.
 */
function parseRoute(url: URL): { projectId: string; leaf: "files" | "list" } | null {
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length !== 4 && segments.length !== 5) return null;
  const [v1, projects, projectId, files, list] = segments;
  if (v1 !== "v1" || projects !== "projects" || files !== "files") return null;
  if (!projectId || projectId.length === 0) return null;
  if (segments.length === 5 && list !== "list") return null;
  return { projectId: decodeURIComponent(projectId), leaf: segments.length === 5 ? "list" : "files" };
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

/**
 * The client hung up while this handler was still writing to it.
 *
 * A named error rather than a bare one because the two call sites treat it
 * differently from a real failure: it is the ordinary end of an aborted
 * download and not something to log at error level, but it still has to
 * *throw*, so that every `finally` between here and the top of the handler
 * runs. That is the whole fix — see {@link drained}.
 */
class ClientGoneError extends Error {
  constructor() {
    super("the client hung up before this transfer finished");
    this.name = "ClientGoneError";
  }
}

/**
 * Wait for a backpressured response to drain — or for the connection to die.
 *
 * **`'drain'` is never emitted on a destroyed stream.** A promise that waits
 * for that event alone therefore never settles once the client hangs up, and
 * the handler awaiting it parks forever: no `finally` between here and the top
 * of the call stack ever runs. On the write side that stranded the Project's
 * write lease for the lifetime of the process, so every later `PUT` answered
 * `409 transfer-in-progress` — the refusal F8 asks to be *immediate* became
 * permanent. On the read side it suspended the `packDirectory` generator, so
 * its own `finally { handle.close() }` never ran and every aborted download
 * leaked a file descriptor.
 *
 * So `close` and `error` settle it too, and they settle it by throwing. That
 * unwinds the transfer exactly the way any other mid-stream failure does: the
 * `for await` closes the generator it is draining (running its `finally`), the
 * `catch` reports, and the `finally` releases the lease.
 */
function drained(res: ServerResponse): Promise<void> {
  // Already gone. Registering a listener on a destroyed stream would wait for
  // an event that has already been emitted.
  if (res.destroyed || res.writableEnded) return Promise.reject(new ClientGoneError());
  return new Promise<void>((resolve, reject) => {
    const settle = (err: Error | null): void => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
      if (err) reject(err);
      else resolve();
    };
    const onDrain = (): void => settle(null);
    const onClose = (): void => settle(new ClientGoneError());
    const onError = (err: Error): void => settle(err);
    res.on("drain", onDrain);
    res.on("close", onClose);
    res.on("error", onError);
  });
}
