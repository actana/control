import { CoreSharedError, type CoreShared, type SharedEntry } from "@actana/sdk/shared";
import { ConflictError, DomainError, NotFoundError, ValidationError } from "../errors";
import { getStorageConfig } from "./storage";
import { coreS3Shared, CoreS3Shared, SharedFilesUnavailableError, type CoreS3Deps, type HeldCoreShared } from "./core-s3-shared";
import {
  baseName,
  checkEntryName,
  checkSharedPath,
  DEFAULT_UPLOAD_LIMIT_BYTES,
  IMAGE_CONTENT_TYPES,
  INLINE_MEDIA_MAX_BYTES,
  extensionOf,
  joinPath,
  parentOf,
  PREVIEW_TEXT_BYTES,
  previewKindOf,
  type SharedDownloadUrl,
  type SharedFileDetails,
  type SharedFileEntry,
  type SharedFilesListing,
  type SharedFilesSearchResult,
  type SharedFilesSummary,
} from "~/shared/shared-files";

/**
 * A Core's Shared folder as the Files tab reads and writes it (#565, ADR 0041 D5, D33). Every call goes to S3 with the
 * SDK's CoreShared S3 mode and a **1-hour key the Panel's issuer gave for this one Core** (limited to
 * `<prefix>/<core id>/`), so the tab works while the Core is offline and one Core's call can never name another Core's
 * folder: the client is built with that Core's own prefix, and the SDK cannot leave it.
 *
 * - **The owner.** Every call takes the owner the session runs as. The Core and its folder row are read by owner, so
 *   another owner's Core is "no such Core", never a folder.
 * - **Keys.** The master key is read only by `storageKeyIssuer`. The key of a Core is kept here, in memory, until six
 *   minutes before it ends (a 5-minute download URL needs that much), and never leaves this file: no return value, no
 *   error message and no log line carries it. The one thing a caller gets that holds credentials is the signed
 *   download URL, which is what the SDK makes for one object and which ends in at most five minutes.
 * - **Paths.** {@link cleanPath} refuses an absolute path, a `.` or `..` segment and the rest of the SDK's rules
 *   before anything is sent to S3: a path from a browser is never trusted.
 */

export const DOWNLOAD_URL_SECONDS = 300;
const COUNT_FOLDERS_MAX = 200;
const COUNT_CONCURRENCY = 8;
const SEARCH_MAX = 200;
/** The most a text preview will read: a bigger file is shown by its name, size and download alone. */
const PREVIEW_READ_MAX_BYTES = 4 * 1024 * 1024;

export class PayloadTooLargeError extends DomainError {
  constructor(readonly limitBytes: number) {
    super(`The file is larger than the upload limit of ${limitBytes} bytes.`);
    this.name = "PayloadTooLargeError";
  }
}

export { SharedFilesUnavailableError };

export type SharedFilesDeps = Partial<CoreS3Deps> & {
  /** The per-Core S3 mode. The Panel's own by default, which the Task watcher shares; a test hands in one over a fake S3. */
  modes?: CoreS3Shared;
  /** The most one upload may be, read again on every request. The limit stored in Storage settings by default. */
  uploadLimit: (ownerId: number) => Promise<number>;
};

/**
 * The upload limit the owner set in Storage settings (`uploadSizeLimitBytes`), read on each request so a change applies
 * at once. {@link DEFAULT_UPLOAD_LIMIT_BYTES} when none is stored (storage not set up yet) or the stored value is not a
 * positive number.
 */
export async function storedUploadLimit(ownerId: number): Promise<number> {
  const stored = (await getStorageConfig(ownerId)).uploadSizeLimitBytes;
  return stored !== null && Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_UPLOAD_LIMIT_BYTES;
}

/** A path a browser sent, checked here first. Throws a 400; returns it unchanged when it is good. */
export function cleanPath(raw: unknown, want: "file" | "folder" | "either" = "either"): string {
  const checked = checkSharedPath(raw, want);
  if (!checked.ok) throw new ValidationError(`Refused: ${checked.reason}.`);
  return checked.path;
}

/** A folder path as a browser writes it, with or without the trailing `/`: checked, then given the `/` the SDK wants. */
export function cleanFolder(raw: unknown): string {
  const path = cleanPath(raw, "either");
  return path === "" || path.endsWith("/") ? path : `${path}/`;
}

/** The SDK's refusals as the Panel's: the message is the SDK's own (it never carries a key or a URL). */
function mapError(err: unknown): never {
  if (!(err instanceof CoreSharedError)) throw err;
  switch (err.code) {
    case "invalid-path":
    case "invalid-argument":
    case "invalid-move":
    case "invalid-cursor":
      throw new ValidationError(err.message);
    case "not-found":
      throw new NotFoundError("No such file or folder.");
    case "exists":
      throw new ConflictError("Something with that name is already there.");
    case "is-folder":
    case "not-folder":
      throw new ConflictError(err.message);
    case "partial":
      throw new ConflictError(`${err.message} Some of it may have been done: reload the folder.`);
    default:
      // forbidden, expired, unavailable: the store said no, or could not be reached.
      throw new ConflictError(`The Shared folder's storage did not answer: ${err.code}.`);
  }
}

type Held = HeldCoreShared;

export class SharedFiles {
  private readonly deps: { now: () => number; uploadLimit: (ownerId: number) => Promise<number> };
  private readonly modes: CoreS3Shared;

  constructor(deps: Partial<SharedFilesDeps> = {}) {
    // A test that hands in its own issuer, S3 or fetch gets a mode of its own; otherwise the Panel's shared one.
    this.modes = deps.modes ?? (deps.issuer || deps.s3 || deps.fetch ? new CoreS3Shared(deps) : coreS3Shared());
    this.deps = { now: deps.now ?? Date.now, uploadLimit: deps.uploadLimit ?? storedUploadLimit };
  }

  /** The S3 client for this owner's Core, from a live key. Throws when the owner has no such Core or it has no folder. */
  private open(ownerId: number, coreId: string): Promise<Held> {
    return this.modes.open(ownerId, coreId);
  }

  private async run<T>(ownerId: number, coreId: string, fn: (shared: CoreShared, held: Held) => Promise<T>): Promise<T> {
    const held = await this.open(ownerId, coreId);
    try {
      return await fn(held.shared, held);
    } catch (err) {
      return mapError(err);
    }
  }

  // ─── Reading ─────────────────────────────────────────────────────────────

  async list(ownerId: number, coreId: string, rawPath: string): Promise<SharedFilesListing> {
    const folder = cleanFolder(rawPath);
    return this.run(ownerId, coreId, async (shared) => {
      const children = await shared.list(folder);
      const entries = children.map(toEntry);
      await this.countItems(shared, entries);
      return { path: folder.replace(/\/+$/, ""), entries };
    });
  }

  /** Each folder's item count, one listing apiece, a few at a time and no more than a page of folders. */
  private async countItems(shared: CoreShared, entries: SharedFileEntry[]): Promise<void> {
    const folders = entries.filter((e) => e.kind === "folder").slice(0, COUNT_FOLDERS_MAX);
    for (let i = 0; i < folders.length; i += COUNT_CONCURRENCY) {
      await Promise.all(
        folders.slice(i, i + COUNT_CONCURRENCY).map(async (f) => {
          try {
            f.itemCount = (await shared.list(`${f.path}/`)).length;
          } catch {
            // A count is a courtesy: a folder that cannot be counted is shown without one.
          }
        }),
      );
    }
  }

  async details(ownerId: number, coreId: string, rawPath: string): Promise<SharedFileDetails> {
    const path = cleanPath(rawPath, "file");
    return this.run(ownerId, coreId, async (shared) => {
      const entry = await this.statFile(shared, path);
      const kind = previewKindOf(entry.name);
      if (kind === "image" || kind === "pdf" || kind === "none") return { entry, preview: { kind } };
      if ((entry.size ?? 0) > PREVIEW_READ_MAX_BYTES) return { entry, preview: { kind, truncated: true } };
      const body = (await shared.get(path)).body;
      // A log is read from its end, anything else from its start.
      const tail = kind === "log" && body.byteLength > PREVIEW_TEXT_BYTES;
      const slice = tail ? body.subarray(body.byteLength - PREVIEW_TEXT_BYTES) : body.subarray(0, PREVIEW_TEXT_BYTES);
      return { entry, preview: { kind, text: new TextDecoder().decode(slice), truncated: body.byteLength > PREVIEW_TEXT_BYTES } };
    });
  }

  private async statFile(shared: CoreShared, path: string): Promise<SharedFileEntry> {
    const found = (await shared.list(parentOf(path) ? `${parentOf(path)}/` : "")).find((e) => e.path === path && e.kind === "file");
    if (!found) throw new CoreSharedError("not-found", "not found");
    return toEntry(found);
  }

  /** A file's bytes for the browser to show inline (an image or a PDF). Anything else is not served inline. */
  async media(ownerId: number, coreId: string, rawPath: string): Promise<{ body: Uint8Array; contentType: string; name: string }> {
    const path = cleanPath(rawPath, "file");
    const name = baseName(path);
    const kind = previewKindOf(name);
    if (kind !== "image" && kind !== "pdf") throw new ValidationError("Only an image or a PDF is shown inline: download the file instead.");
    return this.run(ownerId, coreId, async (shared) => {
      const entry = await this.statFile(shared, path);
      if ((entry.size ?? 0) > INLINE_MEDIA_MAX_BYTES) throw new PayloadTooLargeError(INLINE_MEDIA_MAX_BYTES);
      const file = await shared.get(path);
      const contentType = kind === "pdf" ? "application/pdf" : (IMAGE_CONTENT_TYPES[extensionOf(name)] ?? "application/octet-stream");
      return { body: file.body, contentType, name };
    });
  }

  /** A URL for this one object, valid five minutes, minted here and handed to the browser for the download. */
  async downloadUrl(ownerId: number, coreId: string, rawPath: string): Promise<SharedDownloadUrl> {
    const path = cleanPath(rawPath, "file");
    return this.run(ownerId, coreId, async (shared) => {
      // `signedUrl` signs locally and asks nothing: look the file up first so a path that is not there is a 404.
      await this.statFile(shared, path);
      const signed = await shared.signedUrl(path, { expiresInSeconds: DOWNLOAD_URL_SECONDS });
      return { url: signed.url, expiresAt: signed.expiresAt.getTime() };
    });
  }

  async search(ownerId: number, coreId: string, query: string): Promise<SharedFilesSearchResult> {
    const q = query.trim().toLowerCase();
    if (!q) return { query, entries: [], truncated: false };
    return this.run(ownerId, coreId, async (shared) => {
      const { changes } = await shared.watch();
      // An object store has a folder only where something is inside it: take each file's ancestors as folders too.
      const names = new Map<string, SharedFileEntry>();
      for (const c of changes) {
        if (c.deleted) continue;
        names.set(`${c.kind}:${c.path}`, toEntry(c as SharedEntry));
        const parts = c.path.split("/");
        for (let i = 1; i < parts.length; i += 1) {
          const folder = parts.slice(0, i).join("/");
          names.set(`folder:${folder}`, { path: folder, name: parts[i - 1]!, kind: "folder" });
        }
      }
      const hits = [...names.values()]
        .filter((e) => e.name.toLowerCase().includes(q))
        .sort((a, b) => (a.kind === b.kind ? (a.path < b.path ? -1 : 1) : a.kind === "folder" ? -1 : 1));
      return { query, entries: hits.slice(0, SEARCH_MAX), truncated: hits.length > SEARCH_MAX };
    });
  }

  /**
   * What the tree's footer and the "new" badges need, from the store's change feed (the SDK's `watch`): the bytes used,
   * and every file written after `since`, the operator's last visit. One listing of the Core's folder.
   */
  async summary(ownerId: number, coreId: string, since: number): Promise<SharedFilesSummary> {
    return this.run(ownerId, coreId, async (shared, held) => {
      const { changes } = await shared.watch();
      let usedBytes = 0;
      let fileCount = 0;
      const newPaths: string[] = [];
      for (const c of changes) {
        if (c.deleted || c.kind !== "file") continue;
        fileCount += 1;
        usedBytes += c.size ?? 0;
        if ((c.modifiedAt?.getTime() ?? 0) > since) newPaths.push(c.path);
      }
      return { backend: held.backend, usedBytes, fileCount, newPaths: newPaths.sort(), uploadLimitBytes: await this.deps.uploadLimit(ownerId) };
    });
  }

  // ─── Writing ─────────────────────────────────────────────────────────────

  async mkdir(ownerId: number, coreId: string, rawPath: string): Promise<{ path: string }> {
    const path = cleanFolder(rawPath);
    if (path === "") throw new ValidationError("The Shared folder itself already exists.");
    return this.run(ownerId, coreId, async (shared) => {
      await shared.mkdir(path);
      return { path: path.replace(/\/+$/, "") };
    });
  }

  /**
   * Write one file. The body is read from the browser's stream with the limit counted as it arrives, so a file over the
   * limit is refused before it is all read; the SDK's `put` takes the bytes, so one file is held in memory while it is
   * written (at most the limit).
   */
  async upload(ownerId: number, coreId: string, rawPath: string, body: ReadableStream<Uint8Array> | null, declaredLength: number | null): Promise<SharedFileEntry> {
    const path = cleanPath(rawPath, "file");
    const limit = await this.deps.uploadLimit(ownerId);
    if (declaredLength !== null && declaredLength > limit) {
      await body?.cancel().catch(() => undefined);
      throw new PayloadTooLargeError(limit);
    }
    // Resolve the Core before reading a byte: an owner with no such Core is refused without a read.
    const held = await this.open(ownerId, coreId);
    const bytes = await readLimited(body, limit, declaredLength);
    try {
      await held.shared.put(path, bytes);
    } catch (err) {
      mapError(err);
    }
    return { path, name: baseName(path), kind: "file", size: bytes.byteLength, modifiedAt: this.deps.now() };
  }

  async rename(ownerId: number, coreId: string, rawPath: string, rawName: string): Promise<{ path: string }> {
    const path = cleanPath(rawPath);
    if (path === "") throw new ValidationError("The Shared folder itself cannot be renamed.");
    const name = checkEntryName(rawName);
    if (!name.ok) throw new ValidationError(name.reason);
    const isFolder = path.endsWith("/");
    const to = joinPath(parentOf(path), name.name) + (isFolder ? "/" : "");
    return this.run(ownerId, coreId, async (shared) => {
      await shared.move(path, to);
      return { path: to.replace(/\/+$/, "") };
    });
  }

  async move(ownerId: number, coreId: string, rawPath: string, rawTo: string): Promise<{ path: string }> {
    const path = cleanPath(rawPath);
    if (path === "") throw new ValidationError("The Shared folder itself cannot be moved.");
    const toFolder = cleanFolder(rawTo);
    const isFolder = path.endsWith("/");
    const to = joinPath(toFolder, baseName(path)) + (isFolder ? "/" : "");
    return this.run(ownerId, coreId, async (shared) => {
      await shared.move(path, to);
      return { path: to.replace(/\/+$/, "") };
    });
  }

  async remove(ownerId: number, coreId: string, rawPath: string): Promise<void> {
    const path = cleanPath(rawPath);
    if (path === "") throw new ValidationError("The Shared folder itself cannot be deleted.");
    await this.run(ownerId, coreId, (shared) => shared.rm(path));
  }
}

function toEntry(e: SharedEntry): SharedFileEntry {
  return {
    path: e.path,
    name: baseName(e.path),
    kind: e.kind,
    ...(e.kind === "file" && e.size !== undefined ? { size: e.size } : {}),
    ...(e.kind === "file" && e.modifiedAt ? { modifiedAt: e.modifiedAt.getTime() } : {}),
  };
}

/**
 * Read a stream into one array, refusing as soon as it has gone over `limit`. The bytes are held once: into an array of
 * the declared length when there is one (a body that is longer or shorter than it says is refused), otherwise into one
 * that doubles up to the limit, and what is returned is a view of it, never a second copy.
 */
export async function readLimited(stream: ReadableStream<Uint8Array> | null, limit: number, declaredLength: number | null = null): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  let buffer = new Uint8Array(declaredLength !== null ? declaredLength : Math.min(limit, 64 * 1024));
  let total = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new PayloadTooLargeError(limit);
      }
      if (total > buffer.byteLength) {
        if (declaredLength !== null) {
          await reader.cancel().catch(() => undefined);
          throw new ValidationError("The body is longer than its declared length.");
        }
        const grown = new Uint8Array(Math.min(limit, Math.max(total, buffer.byteLength * 2)));
        grown.set(buffer.subarray(0, total - value.byteLength));
        buffer = grown;
      }
      buffer.set(value, total - value.byteLength);
    }
  } finally {
    reader.releaseLock();
  }
  if (declaredLength !== null && total !== declaredLength) throw new ValidationError("The body is shorter than its declared length.");
  return buffer.subarray(0, total);
}

let singleton: SharedFiles | null = null;

export function sharedFiles(): SharedFiles {
  if (!singleton) singleton = new SharedFiles();
  return singleton;
}

/** @internal */
export function resetSharedFilesForTests(next: SharedFiles | null = null): void {
  singleton = next;
}
