// A Project's files, from the browser (#129 F6/F11, #169).
//
// Every call here goes to the Panel's own `/api/cores/:coreId/projects/:id/…`
// routes and no further. That is not a layering nicety, it is the only thing
// that works: a browser cannot present a client certificate (ADR 0002), has
// never seen the Core's CA, and in the reference deployment cannot route to the
// Core's port at all. So the browser's transport ends at the Panel, the Panel's
// transport to the Core carries the mTLS material, and **the SDK's Node
// `project.files.*` is not reachable from here** — its `fetch` rides an undici
// `Agent`, which is a Node object. ADR 0030 records that split.
//
// What *is* shared with the SDK is the shape of the answers: `CoreFileEntry` and
// `CoreFileProgress` are imported as types from `@actana/sdk/core-files` rather
// than retyped. They are erased at build time, so nothing from that module's
// runtime — undici included — reaches the bundle, and the manifest shape has one
// definition instead of a second one drifting quietly in the UI layer.
//
// ## Why a `File` is handed to `fetch` untouched
//
// `fetch(url, { body: file })` streams the bytes off the operator's disk. The
// browser does the reading, in chunks, paced by the socket — a 4 GB drop never
// becomes a 4 GB `ArrayBuffer` in the tab, and `FileReader`, `file.arrayBuffer()`
// and `FormData` all do exactly that and are all deliberately absent below. The
// same discipline as the Panel's, one hop earlier: the file crosses three
// processes and is buffered whole by none of them.
import type { CoreFileEntry, CoreFileProgress } from "@actana/sdk/core-files";

export type { CoreFileEntry, CoreFileProgress };

/** The Panel's refusals, which are about the Core rather than about the files. */
export type CoreFilesApiCode =
  | "no-such-core"
  | "core-unreachable"
  | "files-unsupported"
  | "core-credentials";

export class CoreFilesApiError extends Error {
  readonly status: number;
  /** The Core's code where the Core answered, the Panel's where it refused first. */
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CoreFilesApiError";
    this.status = status;
    this.code = code;
  }
}

function routeBase(coreId: string, projectId: string): string {
  return `/api/cores/${encodeURIComponent(coreId)}/projects/${encodeURIComponent(projectId)}`;
}

/** Where a browser sends the operator to fetch one file's bytes back out. */
export function projectFileDownloadUrl(
  coreId: string,
  projectId: string,
  filePath: string,
): string {
  return `${routeBase(coreId, projectId)}/files?path=${encodeURIComponent(filePath)}`;
}

async function refusalFrom(response: Response, what: string): Promise<CoreFilesApiError> {
  let code = `http-${response.status}`;
  let message = `${what} failed with HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { code?: unknown; error?: unknown };
    if (typeof body.code === "string") code = body.code;
    if (typeof body.error === "string") message = body.error;
  } catch {
    // A refusal that is not JSON — a proxy's error page, a dropped connection.
    // Say what is known rather than inventing a code.
  }
  return new CoreFilesApiError(response.status, code, message);
}

/**
 * NDJSON off a `fetch` body, one parsed line at a time, **pulled**.
 *
 * The same shape the SDK reads its streams with, and for the same reason: a
 * generator suspended at its `yield` is not reading, so a caller rendering a
 * hundred thousand listing rows sets the pace rather than racing them into an
 * array. A `response.text()` here would undo the streaming on both sides of the
 * Panel in one line.
 */
async function* ndjsonLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) yield JSON.parse(line) as Record<string, unknown>;
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
    }
    const rest = (buffered + decoder.decode()).trim();
    if (rest) yield JSON.parse(rest) as Record<string, unknown>;
  } finally {
    // Runs when a caller breaks out of its `for await` — which is what tells the
    // Panel, and through it the Core, that nobody is reading any more.
    await reader.cancel().catch(() => {});
  }
}

function entryFrom(record: Record<string, unknown>): CoreFileEntry | null {
  if (typeof record.path !== "string") return null;
  const kind = record.kind;
  return {
    path: record.path,
    size: typeof record.size === "number" ? record.size : 0,
    mtime: typeof record.mtime === "number" ? record.mtime : 0,
    mode: typeof record.mode === "number" ? record.mode : 0,
    sha256: typeof record.sha256 === "string" ? record.sha256 : null,
    ...(kind === "file" || kind === "directory" || kind === "symlink" ? { kind } : {}),
  };
}

export type ListProjectFilesOptions = {
  path?: string;
  depth?: number;
  signal?: AbortSignal;
};

/**
 * The Project's tree, one entry at a time, as the Core walks it.
 *
 * `sha256` is not asked for and the field comes back null: a listing does not
 * have the bytes in hand and a digest means reading every one of them (ADR 0027
 * D6). A file view shows names, sizes and times; nothing on this screen is worth
 * a full read of a `node_modules`.
 */
export async function* listProjectFiles(
  coreId: string,
  projectId: string,
  opts: ListProjectFilesOptions = {},
): AsyncGenerator<CoreFileEntry, void, undefined> {
  const params = new URLSearchParams({ path: opts.path ?? "" });
  if (opts.depth !== undefined) params.set("depth", String(opts.depth));
  const response = await fetch(`${routeBase(coreId, projectId)}/files/list?${params}`, {
    credentials: "same-origin",
    headers: { accept: "application/x-ndjson" },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!response.ok) throw await refusalFrom(response, "listing this Project's files");
  if (!response.body) return;

  for await (const record of ndjsonLines(response.body)) {
    const type = typeof record.type === "string" ? record.type : "entry";
    if (type === "done") return;
    if (type === "error") {
      throw new CoreFilesApiError(
        200,
        typeof record.code === "string" ? record.code : "read-failed",
        typeof record.message === "string" ? record.message : "the listing stopped part-way through",
      );
    }
    if (type !== "entry") continue;
    const entry = entryFrom(record);
    if (entry) yield entry;
  }
}

export type UploadProjectFileOptions = {
  coreId: string;
  projectId: string;
  /** Project-relative destination, including the file's own name. */
  path: string;
  file: File;
  signal?: AbortSignal;
};

/**
 * Write one dropped file into the Project, and watch it land.
 *
 * The returned iterable is the Core's own NDJSON progress stream, parsed: an
 * `entry` line carrying `result: "written" | "overwritten"` — so an overwrite is
 * **named** rather than guessed at from a second success (F5) — and then a
 * `done` line with the totals.
 *
 * No `content-length` is set here and that is deliberate: the browser sets it
 * from `file.size` for a `Blob` body and refuses to let script do it, so the
 * Core's free-space precheck gets a real number without this module claiming
 * one. Nothing retries — `409 transfer-in-progress` means another transfer holds
 * this Project's write lease (F8) and is a conflict for the operator to resolve,
 * not a wait to hide.
 */
export async function* uploadProjectFile(
  opts: UploadProjectFileOptions,
): AsyncGenerator<CoreFileProgress, void, undefined> {
  const url = `${routeBase(opts.coreId, opts.projectId)}/files?path=${encodeURIComponent(opts.path)}`;
  const response = await fetch(url, {
    method: "PUT",
    credentials: "same-origin",
    headers: {
      "content-type": "application/octet-stream",
      accept: "application/x-ndjson",
      // The Core writes the file with the mtime it is told, so a dropped file
      // keeps the timestamp it had on the operator's machine rather than the
      // moment it crossed the wire.
      "x-actana-file-mtime": String(opts.file.lastModified),
    },
    // The whole point: a `File`, handed over unread.
    body: opts.file,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!response.ok) throw await refusalFrom(response, `writing ${opts.path}`);
  if (!response.body) return;

  for await (const record of ndjsonLines(response.body)) {
    if (record.type === "error") {
      throw new CoreFilesApiError(
        200,
        typeof record.code === "string" ? record.code : "write-failed",
        typeof record.message === "string" ? record.message : "the write failed part-way through",
      );
    }
    if (record.type === "done") {
      yield {
        type: "done",
        entries: typeof record.entries === "number" ? record.entries : 0,
        bytes: typeof record.bytes === "number" ? record.bytes : 0,
      };
      continue;
    }
    const entry = entryFrom(record);
    if (entry) {
      yield {
        type: "entry",
        ...entry,
        result: record.result === "overwritten" ? "overwritten" : "written",
      };
    }
  }
}

/** One file the operator dropped, with the Project-relative path it should land at. */
export type DroppedFile = { path: string; file: File };

/**
 * The files inside a drop, with the paths they should keep.
 *
 * A plain file drop is `event.dataTransfer.files` and its name. A *folder* drop
 * is only reachable through `webkitGetAsEntry` — the non-standard API every
 * browser implements and none has replaced — so it is walked here, and each file
 * inside keeps its path relative to the dropped folder.
 *
 * **Each of those files then crosses on its own request**, rather than as one
 * tar. That is a real difference from the CLI, which packs a folder (F4, ADR
 * 0029) precisely so a `node_modules` is bandwidth-bound rather than
 * latency-bound — and the same argument applies here, so this is a known
 * shortfall rather than a settled shape. Packing a tar in a browser tab is a
 * piece of work with its own memory story; what is here first is the drop that
 * #129's done-means actually asks for. A folder of a few dozen files is fine; a
 * folder of ten thousand will be slow, and says so in the progress list rather
 * than pretending otherwise.
 */
export async function filesFromDrop(dataTransfer: DataTransfer): Promise<DroppedFile[]> {
  const items = [...dataTransfer.items].filter((item) => item.kind === "file");
  const entries = items
    .map((item) => (typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => entry !== null);

  if (entries.length === 0) {
    // No entry API (or a synthetic drop, as in the tests): the flat file list is
    // all there is, and a flat list is the common case anyway.
    return [...dataTransfer.files].map((file) => ({ path: file.name, file }));
  }

  const collected: DroppedFile[] = [];
  for (const entry of entries) await walkEntry(entry, "", collected);
  return collected;
}

async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  into: DroppedFile[],
): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      (entry as FileSystemFileEntry).file(resolve, () => resolve(null));
    });
    // A file the browser cannot open — moved, or permission-denied since the
    // drag started — is skipped rather than allowed to fail the whole drop.
    if (file) into.push({ path, file });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    // `readEntries` answers in batches and signals the end with an empty one;
    // a single call returns only the first slice of a large directory.
    const batch = await new Promise<FileSystemEntry[]>((resolve) => {
      reader.readEntries(resolve, () => resolve([]));
    });
    if (batch.length === 0) return;
    for (const child of batch) await walkEntry(child, path, into);
  }
}
