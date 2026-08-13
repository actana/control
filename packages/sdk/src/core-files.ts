// `project.files.list / upload / download` — the SDK half of #129 F12 (#167).
//
// A Project's files are reached over the Core's `/v1/…` HTTPS routes, never
// over the core link (ADR 0028). What this module adds on top of those routes
// is the shape a caller should actually hold:
//
//     const project = client.project(projectId);
//     for await (const entry of project.files.list()) …
//     for await (const line of project.files.upload({ path, body })) …
//     const { stream } = await project.files.download({ path });
//
// ## Everything here streams, and streams *lazily*
//
// The three methods have one property in common and it is the reason the module
// exists rather than four `fetch` calls at a call site: **nothing runs ahead of
// its consumer.** Each is a pull-driven async generator or a stream handed
// straight through — no background pump, no queue that fills while the caller is
// busy, no `await res.arrayBuffer()` anywhere on a success path.
//
// This is a correctness property, not a tidiness one. An async iterable that
// eagerly drains its source has *defeated the streaming it appears to offer*:
// the bytes are all in memory, the only thing being paced is the handing-out.
// A caller writing each downloaded chunk to a slow disk, or posting each upload
// progress line to a webhook, is the ordinary case — and it is exactly the case
// an eager implementation turns into unbounded memory growth. `for await` over
// a generator suspends it at the `yield` until the consumer asks again, and the
// Core's own `res.write` backpressures once the socket buffer fills, so a slow
// consumer here becomes a slow reader on the socket and eventually a paused
// writer on the Core. That chain is what `core-files-backpressure.test.ts`
// pins, with a consumer that deliberately dawdles.
//
// ## What this module does not do
//
// **It does not build tar archives.** A folder crosses as one streamed tar
// (ADR 0029) and the packing lives on the Core, which is the side with the
// files. `upload` takes whatever stream it is given and labels it; a caller
// uploading a folder hands it a tar stream and says `kind: "tar"`.
//
// **It does not retry.** See {@link CoreFilesConflictError} — the one-write-
// per-Project rule (F8) is a conflict for a human to resolve, and a silent
// retry loop would turn the Core's immediate, well-worded refusal into a hang.
import {
  CoreFilesStreamError,
  CoreFilesUnavailableError,
  refusalFrom,
  type CoreFilesErrorCode,
  type CoreFilesFetch,
} from "./core-files-http.ts";

/**
 * Whether this Core's file surface may be used at all, and — when it may not —
 * why, in words an operator can act on (F9).
 */
export type CoreFilesAvailability = { available: true } | { available: false; reason: string };

/** How a written entry landed. `overwritten` names a file that was already there (F5). */
export type CoreFileWriteResult = "written" | "overwritten";

/**
 * One entry of a listing, in the manifest shape PR 215 established: `{path,
 * size, mtime, mode, sha256}`.
 *
 * `path` is **Project-relative**, which is the address space F1 gives the
 * operator — the same string that goes back to `download`.
 *
 * `sha256` is nullable on purpose. #166's own trap is that hashing every entry
 * of a large tree is expensive, and whether it is computed eagerly or on request
 * is that ticket's call to make; a type that promised the digest would have to
 * change if it decides "on request", so it promises the field and not the value.
 */
export type CoreFileEntry = {
  path: string;
  size: number;
  mtime: number;
  mode: number;
  sha256: string | null;
  /** Present when the listing distinguishes them; absent listings read as files. */
  kind?: "file" | "directory" | "symlink";
};

/** One line of a write's NDJSON progress stream. */
export type CoreFileProgress =
  | ({ type: "entry"; result: CoreFileWriteResult } & CoreFileEntry)
  | { type: "done"; entries: number; bytes: number };

/**
 * What a read hands back: metadata, and **a stream**.
 *
 * There is no `bytes` or `buffer` field here and that absence is the feature.
 * A gigabyte file must not materialise in memory, so the only way to get at the
 * content is to consume `stream` — a caller who wants it whole has to write
 * that themselves and own the decision. `size` is what the Core declared, which
 * is `null` for a folder, whose tar length is not known until it has been walked.
 */
export type CoreFileDownload = {
  /** `file` for raw bytes, `tar` for a folder crossing as one archive (ADR 0029). */
  kind: "file" | "tar";
  size: number | null;
  mode: number | null;
  mtime: number | null;
  stream: ReadableStream<Uint8Array>;
};

/**
 * Anything a caller can upload.
 *
 * A Node `Readable` — `fs.createReadStream(…)` — is an async iterable of
 * `Buffer`, so it is accepted directly and without this package importing
 * `node:stream` to say so. A web `ReadableStream` passes through untouched.
 */
export type CoreFileSource = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>;

export type CoreFileUploadOptions = {
  /** Project-relative destination. `""` is the Project root, which only a tar may target. */
  path: string;
  body: CoreFileSource;
  /**
   * `file` writes one file at `path`; `tar` unpacks an archive into it
   * (ADR 0029). Default `file`.
   */
  kind?: "file" | "tar";
  /** Unix permission bits for a single-file write. The Core defaults to `0o644`. */
  mode?: number;
  /** Modification time in epoch milliseconds, preserved across the wire. */
  mtime?: number;
  /**
   * Declared body length, when the caller knows it.
   *
   * Worth passing: it is what lets the Core run its free-space precheck and
   * refuse `507 insufficient-storage` before the transfer rather than fail with
   * `ENOSPC` half-way through. Omitted, the upload is chunked and there is
   * nothing to check against.
   */
  contentLength?: number;
  signal?: AbortSignal;
};

export type CoreFileDownloadOptions = {
  /** Project-relative path. A directory comes back as one streamed tar. */
  path: string;
  signal?: AbortSignal;
};

export type CoreFileListOptions = {
  /** Subtree to list, Project-relative. Default: the whole Project. */
  path?: string;
  /** Maximum depth to descend. Default: the whole tree. */
  depth?: number;
  signal?: AbortSignal;
};

export type CoreFilesOptions = {
  projectId: string;
  /** The Core's HTTPS origin — `CoreConnection.httpsBaseUrl`. No trailing slash. */
  baseUrl: string;
  /** The same signed bearer the core link's `auth` frame presents, or null on a loopback rig. */
  bearer: string | null;
  /**
   * Read at the top of every call rather than once at construction: a Core can
   * be downgraded and a client survives reconnects, so the answer belongs to
   * the *current* connection and a remembered one would send a caller at a route
   * that is no longer there.
   */
  availability: () => CoreFilesAvailability;
  fetch: CoreFilesFetch;
};

/**
 * A Project's files, over the Core's HTTPS routes.
 *
 * Reached as `client.project(id).files` rather than constructed directly.
 */
export class CoreFiles {
  private readonly opts: CoreFilesOptions;

  constructor(opts: CoreFilesOptions) {
    this.opts = opts;
  }

  /**
   * The Project's tree, one entry at a time.
   *
   * ### Live wiring lands with #166
   *
   * The Core's listing route is #166's to build and this module deliberately
   * does not create or modify it. What is written against here is the contract
   * that ticket inherits and cannot really move: the manifest shape PR 215
   * established — `{path, size, mtime, mode, sha256}` per entry, streamed as
   * NDJSON — on the file route's own origin. The suites drive it against an
   * in-process fixture answering exactly that, so this reader is proven today
   * and the remaining risk is one URL.
   *
   * That URL is {@link listUrl}, kept as a single override-able method for the
   * same reason: when #166 merges, agreeing with it is a one-line change here
   * and the parsing, the laziness and the error handling below are unaffected.
   * Both plausible line shapes are accepted — a bare manifest entry and one
   * wrapped as `{type: "entry", …}`, which is what the write route already
   * emits — so whichever #166 picks, this reads it.
   */
  async *list(opts: CoreFileListOptions = {}): AsyncGenerator<CoreFileEntry, void, undefined> {
    this.requireAvailable("listing a Project's files");
    const res = await this.opts.fetch({
      method: "GET",
      url: this.listUrl(opts),
      headers: { ...this.authHeaders(), accept: "application/x-ndjson" },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok) throw await refusalFrom(res, "listing this Project");
    if (!res.body) return;

    for await (const line of ndjsonLines(res.body)) {
      const record = line as Record<string, unknown>;
      const type = typeof record.type === "string" ? record.type : "entry";
      if (type === "done") return;
      if (type === "error") {
        throw new CoreFilesStreamError(
          typeof record.code === "string" ? record.code : "read-failed",
          typeof record.message === "string" ? record.message : "the listing failed part-way through",
        );
      }
      if (type !== "entry") continue;
      const entry = readEntry(record);
      if (entry) yield entry;
    }
  }

  /**
   * Write a stream into the Project, and watch it land.
   *
   * The returned iterable is the Core's NDJSON progress stream, parsed: one
   * `entry` line per file — each carrying `result: "written" | "overwritten"`,
   * so **every overwrite is named** rather than inferred — then one `done` line
   * with the totals.
   *
   * **Lazy, like everything else here.** Calling `upload` sends nothing; the
   * request goes out on the first `next()`. A caller who does not care about
   * progress still has to drain the iterable, and that is the honest shape: the
   * alternative is a method that returns a promise and quietly buffers a
   * gigabyte of progress nobody read.
   *
   * Throws {@link CoreFilesConflictError} when another write already holds this
   * Project's lease (F8) — immediately, and without retrying. Throws
   * {@link CoreFilesStreamError} when the write fails part-way through, which
   * arrives as the stream's last line rather than as a status code, the `200`
   * having been spent on the first entry.
   */
  async *upload(opts: CoreFileUploadOptions): AsyncGenerator<CoreFileProgress, void, undefined> {
    this.requireAvailable("writing files to a Project");
    const headers: Record<string, string> = {
      ...this.authHeaders(),
      // `application/x-tar` is what tells the Core to unpack rather than to
      // write one file — the route branches on this header and nothing else.
      "content-type": opts.kind === "tar" ? "application/x-tar" : "application/octet-stream",
      accept: "application/x-ndjson",
    };
    if (opts.mode !== undefined) headers["x-actana-file-mode"] = String(opts.mode & 0o777);
    if (opts.mtime !== undefined) headers["x-actana-file-mtime"] = String(Math.floor(opts.mtime));
    if (opts.contentLength !== undefined) headers["content-length"] = String(opts.contentLength);

    const res = await this.opts.fetch({
      method: "PUT",
      url: this.fileUrl(opts.path),
      headers,
      body: sourceStream(opts.body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    // The refusal a large upload cares about arrives here, while the body is
    // still going out: the Core takes the write lease before it reads a byte,
    // so `409 transfer-in-progress` is answered from the status line rather
    // than after a gigabyte has crossed.
    if (!res.ok) throw await refusalFrom(res, `writing ${opts.path || "this Project"}`);
    if (!res.body) return;

    for await (const line of ndjsonLines(res.body)) {
      const record = line as Record<string, unknown>;
      if (record.type === "error") {
        throw new CoreFilesStreamError(
          typeof record.code === "string" ? (record.code as CoreFilesErrorCode) : "write-failed",
          typeof record.message === "string" ? record.message : "the write failed part-way through",
        );
      }
      if (record.type === "done") {
        yield {
          type: "done",
          entries: numberOr(record.entries, 0),
          bytes: numberOr(record.bytes, 0),
        };
        continue;
      }
      const entry = readEntry(record);
      if (entry) {
        yield {
          type: "entry",
          ...entry,
          result: record.result === "overwritten" ? "overwritten" : "written",
        };
      }
    }
  }

  /**
   * Read a file — or a folder, as one streamed tar — **as a stream**.
   *
   * The response body is handed through untouched. Nothing on this path calls
   * `arrayBuffer`, `text` or `blob`, so a gigabyte file crosses in whatever
   * chunks the socket delivers and only ever occupies what the consumer has not
   * yet read. `core-files-streaming.test.ts` holds that claim to a real
   * gigabyte and watches the heap while it crosses.
   *
   * The metadata comes off headers the Core already had — `stat` on the file it
   * was about to open — so nothing is read twice to produce it.
   */
  async download(opts: CoreFileDownloadOptions): Promise<CoreFileDownload> {
    this.requireAvailable("reading a Project's files");
    const res = await this.opts.fetch({
      method: "GET",
      url: this.fileUrl(opts.path),
      headers: this.authHeaders(),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok) throw await refusalFrom(res, `reading ${opts.path || "this Project"}`);
    if (!res.body) {
      throw new CoreFilesStreamError("read-failed", `the Core answered ${opts.path} with no body`);
    }
    return {
      kind: res.headers.get("x-actana-transfer-kind") === "tar" ? "tar" : "file",
      size: headerNumber(res, "x-actana-file-size") ?? headerNumber(res, "content-length"),
      mode: headerNumber(res, "x-actana-file-mode"),
      mtime: headerNumber(res, "x-actana-file-mtime"),
      stream: res.body,
    };
  }

  /**
   * The listing URL — the one line #166 gets to disagree with.
   *
   * A query parameter on the existing route rather than a new path segment,
   * because the Core's `parseRoute` matches `/v1/projects/:id/files` on an exact
   * four-segment split: a `…/files/list` leaf is a change to that parser, and a
   * parameter is not. `protected` so a caller pinned to a Core that chose
   * otherwise can subclass rather than wait for a release.
   */
  protected listUrl(opts: CoreFileListOptions): string {
    const url = new URL(this.fileUrl(opts.path ?? ""));
    url.searchParams.set("list", "1");
    if (opts.depth !== undefined) url.searchParams.set("depth", String(opts.depth));
    return url.toString();
  }

  /** `…/v1/projects/:projectId/files?path=<relative>`. */
  protected fileUrl(filePath: string): string {
    const base = this.opts.baseUrl.replace(/\/+$/, "");
    const project = encodeURIComponent(this.opts.projectId);
    const url = new URL(`${base}/v1/projects/${project}/files`);
    url.searchParams.set("path", filePath);
    return url.toString();
  }

  private authHeaders(): Record<string, string> {
    // mTLS is not the gate on its own and is not treated as if it were: the
    // client certificate says a Panel talked to this Core once, the bearer says
    // the pairing is still current. A loopback rig configures no bearer, and
    // the Core with no `authVerifier` asks for none.
    return this.opts.bearer ? { authorization: `Bearer ${this.opts.bearer}` } : {};
  }

  /**
   * The F9 gate, checked before every call and *before any byte leaves*.
   *
   * The reason is carried into the error rather than flattened to a boolean,
   * because the two ways this fails want different actions from an operator: a
   * Core that has not finished connecting is a wait, and a Core that announced
   * no `files` capability is a Core that predates the surface — which is a
   * supported state, not a fault and not a needs-update.
   */
  private requireAvailable(what: string): void {
    const availability = this.opts.availability();
    if (availability.available) return;
    throw new CoreFilesUnavailableError(`${what} is unavailable on this Core: ${availability.reason}`);
  }
}

/**
 * NDJSON, one parsed line at a time, **pulled**.
 *
 * The generator reads from the socket only when its buffer holds no complete
 * line *and* the consumer has asked for another value. Between those two
 * conditions sits the whole backpressure story: suspended at a `yield`, this
 * function is not reading, so the response body's queue fills, so the TCP window
 * closes, so the Core's `res.write` returns false and its handler parks in
 * `drained`. A background pump feeding an array — the obvious alternative —
 * would break that chain at the first link and read the entire stream into
 * memory while the consumer worked through line one.
 */
async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        // Yield before looking for the next line, and before reading: this is
        // the suspension point that makes the consumer set the pace.
        if (line.length > 0) yield parseLine(line);
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
    }
    // A final line with no trailing newline is still a line. The Core always
    // sends one, but a stream that ended mid-write may not have.
    const rest = (buffered + decoder.decode()).trim();
    if (rest.length > 0) yield parseLine(rest);
  } finally {
    // Runs on an early `break` out of the caller's `for await` too, which is
    // what tells the Core the reader walked away — without it an abandoned
    // upload would leave the Core's handler parked in `drained` until its
    // socket timed out, still holding the Project's write lease.
    await reader.cancel().catch(() => {});
  }
}

/**
 * One NDJSON line, parsed **into this module's error taxonomy**.
 *
 * The comment above the last-line case anticipates exactly this shape: a stream
 * that ended mid-write leaves a fragment of JSON behind, and `JSON.parse` on it
 * throws a bare `SyntaxError`. That escapes {@link CoreFilesError} entirely, so
 * a caller who had correctly written one `catch (e) { e instanceof
 * CoreFilesError }` around the surface would see the one failure the module
 * itself predicted come out as an unrelated language error, with no `code` and
 * a message about a character position. Wrapping it here is what makes that
 * single `catch` sufficient, which is the whole point of having a taxonomy.
 *
 * `read-failed` rather than `write-failed` because the failure is in reading
 * this stream — whatever the Core was doing when it stopped, what is known here
 * is that the progress line did not arrive whole.
 */
function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new CoreFilesStreamError(
      "read-failed",
      `the Core's progress stream ended mid-line — ${truncate(line)} is not a complete NDJSON record, ` +
        "which is what a transfer that died part-way through leaves behind",
    );
  }
}

/** Enough of a bad line to recognise it, never a megabyte of it in an error message. */
function truncate(line: string): string {
  return line.length <= 120 ? JSON.stringify(line) : `${JSON.stringify(line.slice(0, 120))}…`;
}

/**
 * A caller's source as a `ReadableStream`, **one chunk per pull**.
 *
 * The upload side of the same property the reader above keeps. `pull` is called
 * by the stream only when the consumer — here, `fetch` writing to the socket —
 * has room, so a slow network reads slowly from the caller's file rather than
 * racing a gigabyte off the disk into a queue.
 */
function sourceStream(source: CoreFileSource): ReadableStream<Uint8Array> {
  if (isReadableStream(source)) return source;
  const iterator = source[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) {
        controller.close();
        return;
      }
      const value = next.value;
      controller.enqueue(typeof value === "string" ? encoder.encode(value) : value);
    },
    async cancel(reason) {
      // An aborted upload has to reach the caller's stream, or a file handle
      // stays open for the life of the process.
      await iterator.return?.(reason);
    },
  });
}

function isReadableStream(source: CoreFileSource): source is ReadableStream<Uint8Array> {
  return typeof (source as ReadableStream<Uint8Array>).getReader === "function";
}

/**
 * A manifest entry off the wire, or null when the line is not one.
 *
 * `path` is the only field worth refusing a line over — an entry with no path
 * names nothing and is unusable. The rest default, because a listing that
 * decided `sha256` is computed on request (#166's open question) or that a
 * directory has no meaningful size is still a listing.
 */
function readEntry(record: Record<string, unknown>): CoreFileEntry | null {
  if (typeof record.path !== "string") return null;
  const kind = record.kind;
  return {
    path: record.path,
    size: numberOr(record.size, 0),
    mtime: numberOr(record.mtime, 0),
    mode: numberOr(record.mode, 0),
    sha256: typeof record.sha256 === "string" ? record.sha256 : null,
    ...(kind === "file" || kind === "directory" || kind === "symlink" ? { kind } : {}),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function headerNumber(res: Response, name: string): number | null {
  const raw = res.headers.get(name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
