// The Files API's operations: what is done to `~`, once a request has been accepted.
//
// Issue 557, ADR 0041 D25. The daemon holds no right to read or write `core`'s home
// (in the container it is another user), so it does not do these itself: the HTTP
// layer (`core-files-routes.ts`) checks the bearer, the route, the method and the
// write lease, then hands one {@link FilesOpRequest} and the request's body to
// `core-files-helper-client.ts`, which runs this module in a short-lived process
// started through `asCore`. Outside the container there is no second user and the
// same function runs in the daemon. Either way this is the only code that touches
// the disk on the Files API's behalf, and it always has the home as its root.
//
// **The filesystem is the model** (ADR 0027): a path plus the home is the whole
// address space, there is no index, and `readdir` is the query engine.
//
// An answer is a head (status and headers) and a body, written through
// {@link FilesOut}. A refusal is a head with a 4xx status and a JSON body, never a
// throw, so the daemon relays it as it would any other answer.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CoreFilesErrorCode } from "@actana/sdk/core";
import { confineToWorkspace, confineWriteTarget, freeSpaceBytes, type ConfinedPath } from "./files-confinement";
import { listTree, type FileListingOptions } from "./files-listing";
import { packDirectory, TarError, unpackTarInto, type TarEntryReport, type TarWriteOutcome } from "./files-tar";
import log from "@actana/shared/log";

/** One thing to do to the home. Everything in it is data; a path is hostile until confined. */
export type FilesOpRequest =
  | { op: "read"; path: string; headOnly: boolean }
  | { op: "list"; path: string; headOnly: boolean; depth?: number; sha256?: boolean }
  | {
      op: "write";
      path: string;
      /** `Content-Type: application/x-tar`: unpack an archive into `path`. */
      tar: boolean;
      /** The request's `Content-Length`, or null for a chunked body. */
      contentLength: number | null;
      /** `X-Actana-File-Mode`, a single-file write's mode bits. */
      fileMode: number | null;
      /** `X-Actana-File-Mtime`, epoch milliseconds. */
      fileMtime: number | null;
    }
  | {
      op: "delete";
      path: string;
      /** The Shared folder's sync (#562): remove a folder only if nothing is in it, never its contents. */
      emptyOnly?: boolean;
    }
  | { op: "mkdir"; path: string }
  | { op: "move"; from: string; to: string };

export type FilesOpName = FilesOpRequest["op"];

export type Refusal = { status: number; code: CoreFilesErrorCode; message: string };

/**
 * Where an answer goes. The daemon's in-process path wraps a `ServerResponse`; the
 * helper wraps its stdout, and the daemon relays that into the `ServerResponse`.
 */
export interface FilesOut {
  /** The status line and headers. Sent once, before any body. */
  head(status: number, headers: Record<string, string>): void;
  /** One chunk of body. Resolves when the sink has taken it; throws {@link ClientGoneError} when nobody is reading. */
  write(chunk: Uint8Array | string): Promise<void>;
  /** The body is complete. */
  end(): void;
  /** The body is not complete and must not look it: cut the connection (a truncated tar must not end cleanly). */
  destroy(): void;
  readonly headSent: boolean;
}

export type FilesOpContext = {
  /** The home, absolute. Every path in a request is resolved under it. */
  root: string;
  /** Injectable for tests. Defaults to a real `statfs`. */
  freeSpace?: (target: string) => Promise<number | null>;
};

/**
 * The reader hung up while an operation was still writing to it.
 *
 * A named error because the call sites treat it differently from a failure: it is
 * the ordinary end of an aborted download and not logged at error level, but it
 * still has to *throw*, so that every `finally` between the sink and the top of
 * the operation runs (a file handle, a directory handle).
 */
export class ClientGoneError extends Error {
  constructor() {
    super("the client hung up before this transfer finished");
    this.name = "ClientGoneError";
  }
}

/** A refusal as the JSON body the Files API has always sent, with the code beside the prose. */
export function refuse(out: FilesOut, refusal: Refusal): void {
  if (out.headSent) {
    out.destroy();
    return;
  }
  const body = JSON.stringify({ code: refusal.code, error: refusal.message });
  out.head(refusal.status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
  });
  void out.write(body).then(() => out.end(), () => out.destroy());
}

/** A confinement failure is a 400, not a 403: an accident guard has no permission model to claim. */
function confinementRefusal(confined: Extract<ConfinedPath, { ok: false }>): Refusal {
  return { status: 400, code: confined.reason, message: confined.message };
}

/** Run one operation. Resolves when the answer is complete; never rejects for a refusal. */
export async function runFilesOp(
  request: FilesOpRequest,
  body: AsyncIterable<Uint8Array>,
  out: FilesOut,
  ctx: FilesOpContext,
): Promise<void> {
  switch (request.op) {
    case "read":
    case "list": {
      // A read follows every symlink, the last component included: the reader
      // asked for what the path names, and confinement has already refused any
      // link that leaves the home.
      const confined = confineToWorkspace(ctx.root, request.path);
      if (!confined.ok) return refuse(out, confinementRefusal(confined));
      if (request.op === "list") return await handleList(out, confined.absolute, confined.relative, request);
      return await handleRead(out, confined.absolute, confined.relative, request.headOnly);
    }
    case "write": {
      // A file write follows the parents and not the last component, so `path=notes.txt`
      // replaces `notes.txt` rather than the file a `notes.txt` symlink names. A tar is
      // unpacked *into* its path, so there the path is a folder to be looked through, and
      // a link that leaves the home is refused up front rather than entry by entry.
      const confined = request.tar
        ? confineToWorkspace(ctx.root, request.path)
        : confineWriteTarget(ctx.root, request.path);
      if (!confined.ok) return refuse(out, confinementRefusal(confined));
      return await handleWrite(body, out, ctx, confined.absolute, confined.relative, request);
    }
    case "delete":
      return await handleDelete(out, ctx.root, request.path, request.emptyOnly === true);
    case "mkdir":
      return await handleMkdir(out, ctx.root, request.path);
    case "move":
      return await handleMove(out, ctx.root, request.from, request.to);
  }
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * The tree under a path as NDJSON (#166 F7).
 *
 * Chunked from the first entry and buffered nowhere: `listTree` yields a line at
 * a time and each is written straight out, so a `node_modules` costs the same
 * memory as an empty folder, and a reader who stops closes the walk rather than
 * leaving it running against the disk.
 */
async function handleList(
  out: FilesOut,
  absolute: string,
  relative: string,
  request: Extract<FilesOpRequest, { op: "list" }>,
): Promise<void> {
  // `lstat` before the 200, so "no such path" is a status code rather than an
  // error line at the end of an otherwise empty stream.
  const exists = await fs.promises.lstat(absolute).catch(() => null);
  if (!exists) {
    return refuse(out, { status: 404, code: "not-found", message: `no such path in the home: ${relative || "."}` });
  }

  out.head(200, {
    "content-type": "application/x-ndjson",
    // No content-length, and no way to have one: measuring the tree is walking it.
    "transfer-encoding": "chunked",
    "cache-control": "no-store",
    "x-actana-transfer-kind": "listing",
  });
  if (request.headOnly) return out.end();

  const options: FileListingOptions = {};
  if (request.depth !== undefined) options.depth = request.depth;
  if (request.sha256) options.sha256 = true;
  const writeLine = (value: unknown): Promise<void> => out.write(`${JSON.stringify(value)}\n`);

  let entries = 0;
  let skipped = 0;
  let bytes = 0;
  try {
    for await (const line of listTree(absolute, relative, options)) {
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
      // The `for await` has already closed the walk, and every directory handle
      // it held, on its way out through here.
      log.info("core-files.list-aborted", { path: relative, entries });
      return out.destroy();
    }
    // The 200 is spent, so the failure is the last line rather than a status.
    const message = err instanceof Error ? err.message : String(err);
    log.warn("core-files.list-failed", { path: relative, error: message });
    await writeLine({ type: "error", code: "read-failed", message }).catch(() => {});
  }
  out.end();
}

async function handleRead(out: FilesOut, absolute: string, relative: string, headOnly: boolean): Promise<void> {
  let stats: fs.Stats;
  try {
    // `stat`, not `lstat`: confinement resolved the path through every symlink
    // and refused any that left the home, so what is left points somewhere
    // legitimate and the reader asked for what is *there*.
    stats = await fs.promises.stat(absolute);
  } catch {
    return refuse(out, { status: 404, code: "not-found", message: `no such path in the home: ${relative || "."}` });
  }

  if (stats.isDirectory()) {
    out.head(200, {
      "content-type": "application/x-tar",
      // The tar is produced as it is walked; walking twice to measure it is the
      // second pass over every byte this design exists to not do.
      "transfer-encoding": "chunked",
      "cache-control": "no-store",
      "x-actana-transfer-kind": "tar",
    });
    if (headOnly) return out.end();
    try {
      for await (const chunk of packDirectory(absolute)) await out.write(chunk);
      out.end();
    } catch (err) {
      if (err instanceof ClientGoneError) {
        log.info("core-files.pack-aborted", { path: relative });
        return out.destroy();
      }
      // The status line went out long ago. Cutting the connection is the only way
      // left to say this body is not the whole folder.
      log.error("core-files.pack-failed", { path: relative, error: err instanceof Error ? err.message : String(err) });
      out.destroy();
    }
    return;
  }

  if (!stats.isFile()) {
    return refuse(out, {
      status: 400,
      code: "bad-request",
      message: `${relative || "."} is neither a file nor a directory`,
    });
  }

  out.head(200, {
    "content-type": "application/octet-stream",
    "content-length": String(stats.size),
    "cache-control": "no-store",
    "x-actana-transfer-kind": "file",
    // The cheap fields of #129 F10 a single-file read carries without a second
    // pass. The digest is the reader's, computed as the bytes arrive.
    "x-actana-file-mode": String(stats.mode & 0o777),
    "x-actana-file-mtime": String(Math.floor(stats.mtimeMs)),
    "x-actana-file-size": String(stats.size),
  });
  if (headOnly) return out.end();
  try {
    for await (const chunk of fs.createReadStream(absolute)) await out.write(chunk as Uint8Array);
    out.end();
  } catch (err) {
    if (err instanceof ClientGoneError) {
      log.info("core-files.read-aborted", { path: relative });
      return out.destroy();
    }
    log.error("core-files.read-failed", { path: relative, error: err instanceof Error ? err.message : String(err) });
    out.destroy();
  }
}

// ─── Writes ──────────────────────────────────────────────────────────────────

async function handleWrite(
  body: AsyncIterable<Uint8Array>,
  out: FilesOut,
  ctx: FilesOpContext,
  absolute: string,
  relative: string,
  request: Extract<FilesOpRequest, { op: "write" }>,
): Promise<void> {
  const asTar = request.tar;

  // A single-file write has to name a file, and the home is not one. `?path=`,
  // `?path=.` and no `path` at all confine to an empty `relative`, which *is* the
  // root; without this guard `writeSingleFile` would remove whatever is there and
  // put a regular file at the root's path, and only a hand-fix on the Core's
  // machine brings that back. The *tar* branch is not guarded: an empty path
  // there is the legitimate "unpack into the home", and an archive entry that
  // names the root is refused inside `unpackTarInto` as `root-entry-path`.
  if (!asTar && relative === "") {
    return refuse(out, {
      status: 400,
      code: "malformed-path",
      message:
        "a single-file write needs a name — this path resolves to the home itself. " +
        "Send `?path=<file>` for a file, or `Content-Type: application/x-tar` to unpack an archive into the home.",
    });
  }

  const declared = request.contentLength;
  if (declared !== null && declared > 0) {
    // No size cap: the home takes whatever fits. The request's own length is the
    // bound, since a tar is never smaller than the files inside it.
    const available = await (ctx.freeSpace ?? freeSpaceBytes)(ctx.root);
    if (available !== null && available < declared) {
      return refuse(out, {
        status: 507,
        code: "insufficient-storage",
        message: `this transfer declares ${declared} bytes and the filesystem holding the home has ${available} available`,
      });
    }
  }

  // F5's overwrite-by-default is about replacing a *file*. A `PUT ?path=src` meant
  // for `src/x.ts` is a typo, and answering it by deleting `src` would be silent
  // damage reported as an ordinary `overwritten`. Checked before the 200 so the
  // answer is a status and a code. An *empty* directory is still replaced.
  if (!asTar) {
    const refusal = await directoryInTheWay(absolute, relative);
    if (refusal) return refuse(out, refusal);
  }

  out.head(200, {
    "content-type": "application/x-ndjson",
    "transfer-encoding": "chunked",
    "cache-control": "no-store",
    "x-actana-transfer-kind": asTar ? "tar" : "file",
  });
  const writeLine = (value: unknown): Promise<void> => out.write(`${JSON.stringify(value)}\n`);

  try {
    if (asTar) {
      await fs.promises.mkdir(absolute, { recursive: true });
      const result = await unpackTarInto(body, absolute, ctx.root, async (entry) => {
        await writeLine({ type: "entry", ...prefixed(relative, entry) });
      });
      await writeLine({ type: "done", entries: result.entries, bytes: result.bytes });
    } else {
      const entry = await writeSingleFile(body, absolute, relative, request);
      await writeLine({ type: "entry", ...entry });
      await writeLine({ type: "done", entries: 1, bytes: entry.size });
    }
  } catch (err) {
    if (err instanceof ClientGoneError) {
      log.info("core-files.write-aborted", { path: relative });
      return out.destroy();
    }
    // Mid-stream failure. The 200 is spent, so the failure is a *line*, which is
    // why the progress stream is NDJSON and not a JSON document.
    const code: CoreFilesErrorCode = err instanceof TarError ? err.code : "write-failed";
    const message = err instanceof Error ? err.message : String(err);
    log.warn("core-files.write-failed", { path: relative, code, error: message });
    await writeLine({ type: "error", code, message }).catch(() => {});
  }
  out.end();
}

/** Is a non-empty directory sitting where this single-file write wants to land? */
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
  body: AsyncIterable<Uint8Array>,
  absolute: string,
  relative: string,
  request: Extract<FilesOpRequest, { op: "write" }>,
): Promise<TarEntryReport & { result: TarWriteOutcome }> {
  await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
  const existing = await fs.promises.lstat(absolute).catch(() => null);
  if (existing && !existing.isFile()) {
    // Only an empty directory, a symlink or another odd node reaches here: a
    // non-empty directory was refused before the 200 went out.
    await fs.promises.rm(absolute, { force: true, recursive: true });
  }
  const result: TarWriteOutcome = existing ? "overwritten" : "written";

  // The executable bit crosses on a single-file write too. Absent, 0o644.
  const mode = request.fileMode !== null ? request.fileMode & 0o777 : 0o644;

  const hash = createHash("sha256");
  let size = 0;
  const handle = await fs.promises.open(absolute, "w", mode);
  try {
    for await (const chunk of body) {
      hash.update(chunk);
      size += chunk.length;
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
  // `open(…, mode)` applies the mode only when it creates the file.
  await fs.promises.chmod(absolute, mode);

  if (request.fileMtime !== null && request.fileMtime > 0) {
    await fs.promises.utimes(absolute, request.fileMtime / 1000, request.fileMtime / 1000);
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

/** Report an unpacked entry's path relative to the *home*, the string a caller passes back to `GET`. */
function prefixed<T extends { path: string }>(base: string, entry: T): T {
  if (base.length === 0) return entry;
  return { ...entry, path: `${base}/${entry.path}` };
}

// ─── Delete, create folder, move ─────────────────────────────────────────────

/** A small JSON answer. */
function answerJson(out: FilesOut, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  out.head(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
  });
  void out.write(body).then(() => out.end(), () => out.destroy());
}

/**
 * `DELETE ?path=` — a file or symlink, or with a trailing `/` a folder and everything in it.
 *
 * **The slash is the operator saying "and everything in it".** A folder without it is
 * refused, so a `DELETE ?path=src` that was meant for `src/old.ts` costs a 400 and not a
 * tree; and a slash on a file is refused too, so the two spellings cannot be confused the
 * other way. The home itself is refused whatever it is spelt as, and so is the path that
 * is the target of nothing.
 *
 * The last component is *not* followed (`confineWriteTarget`): deleting `link` removes the
 * link, never what it points at, and `fs.rm` does not follow links inside a tree it removes.
 * A link's parents are resolved, so `link/file` with `link` leading out of the home is
 * refused before anything is touched.
 */
async function handleDelete(out: FilesOut, root: string, requested: string, emptyOnly = false): Promise<void> {
  const folderIntent = requested.trim().endsWith("/");
  const confined = confineWriteTarget(root, requested);
  if (!confined.ok) return refuse(out, confinementRefusal(confined));
  if (confined.relative === "") {
    return refuse(out, {
      status: 400,
      code: "malformed-path",
      message: "the home itself cannot be deleted — name something inside it",
    });
  }

  const existing = await fs.promises.lstat(confined.absolute).catch(() => null);
  if (!existing) {
    return refuse(out, { status: 404, code: "not-found", message: `no such path in the home: ${confined.relative}` });
  }
  if (existing.isDirectory() && !folderIntent) {
    return refuse(out, {
      status: 400,
      code: "bad-request",
      message: `${confined.relative} is a folder — end the path with / to delete it and everything in it`,
    });
  }
  if (!existing.isDirectory() && folderIntent) {
    return refuse(out, { status: 400, code: "bad-request", message: `${confined.relative} is not a folder` });
  }

  if (emptyOnly) {
    // `rmdir` cannot remove a folder that holds anything, so a file made a moment ago is never lost to it.
    if (!existing.isDirectory()) {
      return refuse(out, { status: 400, code: "bad-request", message: `${confined.relative} is not a folder` });
    }
    try {
      await fs.promises.rmdir(confined.absolute);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST") {
        return answerJson(out, 200, { path: confined.relative, kind: "directory", deleted: false, reason: "not-empty" });
      }
      const message = err instanceof Error ? err.message : String(err);
      log.warn("core-files.delete-failed", { path: confined.relative, error: message });
      return refuse(out, { status: 500, code: "write-failed", message: `could not delete ${confined.relative}: ${message}` });
    }
    return answerJson(out, 200, { path: confined.relative, kind: "directory", deleted: true });
  }

  try {
    await fs.promises.rm(confined.absolute, { recursive: existing.isDirectory(), force: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("core-files.delete-failed", { path: confined.relative, error: message });
    return refuse(out, { status: 500, code: "write-failed", message: `could not delete ${confined.relative}: ${message}` });
  }
  answerJson(out, 200, { path: confined.relative, kind: existing.isDirectory() ? "directory" : "file", deleted: true });
}

/** `POST /folder?path=` — make a folder and its parents. One that is already there answers 200, not 201. */
async function handleMkdir(out: FilesOut, root: string, requested: string): Promise<void> {
  const confined = confineWriteTarget(root, requested);
  if (!confined.ok) return refuse(out, confinementRefusal(confined));
  if (confined.relative === "") {
    return refuse(out, { status: 400, code: "malformed-path", message: "the home exists — name a folder inside it" });
  }

  const existing = await fs.promises.lstat(confined.absolute).catch(() => null);
  if (existing) {
    if (existing.isDirectory()) return answerJson(out, 200, { path: confined.relative, created: false });
    return refuse(out, {
      status: 400,
      code: "bad-request",
      message: `${confined.relative} already exists and is not a folder`,
    });
  }
  try {
    await fs.promises.mkdir(confined.absolute, { recursive: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("core-files.mkdir-failed", { path: confined.relative, error: message });
    return refuse(out, { status: 500, code: "write-failed", message: `could not create ${confined.relative}: ${message}` });
  }
  answerJson(out, 201, { path: confined.relative, created: true });
}

/**
 * `POST /move {from, to}` — rename or move inside the home.
 *
 * Nothing is overwritten and nothing is created on the way: the destination must not
 * exist and its folder must. A folder cannot go into itself. Both ends are confined as
 * writes (parents resolved, last component literal), so a link is moved as a link and
 * never as what it points at.
 */
async function handleMove(out: FilesOut, root: string, from: string, to: string): Promise<void> {
  const source = confineWriteTarget(root, from);
  if (!source.ok) return refuse(out, confinementRefusal(source));
  const target = confineWriteTarget(root, to);
  if (!target.ok) return refuse(out, confinementRefusal(target));
  if (source.relative === "" || target.relative === "") {
    return refuse(out, { status: 400, code: "malformed-path", message: "the home cannot be moved, or moved onto" });
  }

  const existing = await fs.promises.lstat(source.absolute).catch(() => null);
  if (!existing) {
    return refuse(out, { status: 404, code: "not-found", message: `no such path in the home: ${source.relative}` });
  }
  if (target.absolute === source.absolute || target.absolute.startsWith(source.absolute + path.sep)) {
    return refuse(out, {
      status: 400,
      code: "bad-request",
      message: `${source.relative} cannot be moved onto itself or into itself`,
    });
  }
  if (await fs.promises.lstat(target.absolute).catch(() => null)) {
    return refuse(out, {
      status: 409,
      code: "bad-request",
      message: `${target.relative} already exists — a move does not overwrite`,
    });
  }
  const parent = await fs.promises.stat(path.dirname(target.absolute)).catch(() => null);
  if (!parent?.isDirectory()) {
    return refuse(out, {
      status: 404,
      code: "not-found",
      message: `the folder for ${target.relative} does not exist — create it first`,
    });
  }

  try {
    await fs.promises.rename(source.absolute, target.absolute);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("core-files.move-failed", { from: source.relative, to: target.relative, error: message });
    return refuse(out, { status: 500, code: "write-failed", message: `could not move ${source.relative}: ${message}` });
  }
  answerJson(out, 200, { from: source.relative, to: target.relative, moved: true });
}
