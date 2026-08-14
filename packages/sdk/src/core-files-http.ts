// The SDK's first HTTPS surface (#167, F12) — how a file request reaches a
// Core, and what a refusal from one means.
//
// Everything in this package before this module spoke one protocol: the
// core-link WebSocket. File bytes deliberately do not cross it (ADR 0028), so
// `project.files.*` dials the *same* mTLS server on the *same* port with the
// *same* certificate and bearer, over HTTP instead of a WebSocket upgrade.
// `CoreConnection.httpsBaseUrl` has named that origin since phase 1 precisely
// so this module would not be the thing that changed a published shape.
//
// ## The `fetch` shape is frozen, not chosen here
//
// The phase-1 spike (#151, PR 189) settled how a client certificate reaches
// `fetch` and its verdict is reused verbatim rather than rediscovered:
//
//     const agent = new Agent({ connect: { ca, cert, key } });
//     await fetch(url, { dispatcher: agent });
//
// **`fetch` is undici and ignores `options.cert` / `options.key`.** There is no
// option bag on `fetch` that reaches TLS at all — the dispatcher is the only
// seam. A client built the `https.request` way silently makes an *anonymous*
// connection, which a Core with `requestCert: true, rejectUnauthorized: true`
// refuses at the handshake with an error that names no certificate; that is a
// long debugging session, and it is the whole reason the spike exists. The
// spike's leg 2b is the control that makes the shape mean anything: the same
// `fetch` through a CA-only `Agent` is refused at the TLS layer. D12 also held
// — both legs pass on Node 22 — so this package's `engines: ">=22"` stands.
//
// ### One thing the spike could not have found, and this had to
//
// **The `fetch` above is undici's own, not the global one**, and the two are
// not interchangeable. Node embeds a *copy* of undici for its global `fetch`,
// and a `Dispatcher` only satisfies the implementation it came from: handing a
// dispatcher from the `undici` package to Node 24's built-in `fetch` fails with
// `InvalidArgumentError: invalid onRequestStart method`, because undici 8
// changed the handler interface that the embedded copy still expects. The
// spike never met this — it loaded `ws` and `undici` as a matching pair from
// one directory and used the global `fetch`, which happened to agree at those
// versions.
//
// Importing both halves from the same package is what makes that class of skew
// impossible rather than merely absent today: this package's `fetch` and its
// `Agent` are the same implementation, whatever Node bundles underneath. The
// frozen finding is untouched — the dispatcher is still the only seam, and the
// CA-only control still has to be refused — and `core-files-mtls.test.ts` holds
// both against a real handshake.
//
// ## Why `undici` is this package's second dependency
//
// `ws` is here because Node's global `WebSocket` cannot present a client
// certificate. `undici` is here for the identical reason one layer up: Node's
// global `fetch` cannot either, and the `Agent` that lets it is not exposed by
// any builtin. It is a public package on the registry, so unlike `@actana/shared`
// it is resolvable by everyone who installs this SDK — the boundary ADR 0025 D4
// draws is around *private workspace* packages, not around dependencies as such.
// A caller who never dials `https://` never constructs an `Agent`: the dispatcher
// is built lazily, on the first request that needs one.
import { Agent, fetch as undiciFetch } from "undici";

import type { CoreLinkTlsMaterial } from "./core-link-socket.ts";

/** The refusal codes the Core's file routes answer with (`docs/external-api.md`). */
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

/** Base class for everything `project.files.*` throws, so one `catch` can name it. */
export class CoreFilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreFilesError";
  }
}

/**
 * This Core has no file surface (F9, #165's `files` capability).
 *
 * Thrown *before any request goes out*, which is the point: a client that
 * called the route anyway would read a `404` off a Core that simply predates the
 * surface and report it as an outage. The `reason` is prose for an operator
 * because "unavailable" on its own sends somebody to check their network.
 */
export class CoreFilesUnavailableError extends CoreFilesError {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "CoreFilesUnavailableError";
    this.reason = reason;
  }
}

/** A refusal with a status line: the Core answered, and said no. */
export class CoreFilesRequestError extends CoreFilesError {
  readonly status: number;
  readonly code: CoreFilesErrorCode | string;

  constructor(status: number, code: CoreFilesErrorCode | string, message: string) {
    super(message);
    this.name = "CoreFilesRequestError";
    this.status = status;
    this.code = code;
  }
}

/**
 * The one-write-per-Project rule (F8), as an error and **never as a retry**.
 *
 * `409 transfer-in-progress` is a conflict a human has to resolve — some other
 * transfer is running on this Project right now, possibly a multi-gigabyte one
 * with twenty minutes left. A client that retried under the hood would convert
 * the Core's clear, immediate refusal into a hang with no output, which is
 * strictly worse than the error: the operator loses both the reason and the
 * chance to decide. So nothing in this package sleeps, backs off or re-sends —
 * this class *is* the handling, and the decision is the caller's.
 *
 * `directory-in-the-way` shares the status and the same rule: it is a refusal
 * to delete a tree, and it will still be a directory on the next attempt.
 */
export class CoreFilesConflictError extends CoreFilesRequestError {
  constructor(status: number, code: CoreFilesErrorCode | string, message: string) {
    super(status, code, message);
    this.name = "CoreFilesConflictError";
  }
}

/**
 * A failure that arrived as the **last line of a progress stream** rather than
 * as a status code, because the `200` was spent on the first entry.
 *
 * This is why the progress stream is NDJSON and not a JSON document: a document
 * would have to be well-formed to be read at all, and this one stops in the
 * middle by design.
 */
export class CoreFilesStreamError extends CoreFilesError {
  readonly code: CoreFilesErrorCode | string;

  constructor(code: CoreFilesErrorCode | string, message: string) {
    super(message);
    this.name = "CoreFilesStreamError";
    this.code = code;
  }
}

/** One request, in the terms this surface actually uses. */
export type CoreFilesRequest = {
  method: "GET" | "HEAD" | "PUT";
  url: string;
  headers: Record<string, string>;
  /** A stream, never a buffer — see {@link CoreFiles.upload}. */
  body?: ReadableStream<Uint8Array> | null;
  signal?: AbortSignal;
};

/**
 * How a file request is actually sent.
 *
 * Injected rather than reached for, on the same terms as
 * {@link CoreLinkSocketFactory}: it is what lets a suite drive this surface
 * over a plain loopback server, and what lets a runtime with its own
 * dispatcher — a proxy, a recorder, a browser — supply one. The default is
 * {@link createCoreFilesFetch}.
 */
export type CoreFilesFetch = (req: CoreFilesRequest) => Promise<Response>;

/**
 * The default sender: `fetch`, with the client certificate carried in on a
 * dispatcher.
 *
 * The `Agent` is built **once, lazily, and only when there is TLS material** —
 * a `http://` loopback Core needs no dispatcher, and building one per request
 * would open a fresh connection pool for every upload.
 */
export function createCoreFilesFetch(tls: CoreLinkTlsMaterial | null): CoreFilesFetch {
  let dispatcher: Agent | null = null;
  return async (req: CoreFilesRequest): Promise<Response> => {
    if (tls && !dispatcher) {
      dispatcher = new Agent({ connect: { ca: tls.ca, cert: tls.cert, key: tls.key } });
    }
    // `duplex: "half"` is mandatory for a streamed request body and is not a
    // detail that can be left out: without it `fetch` rejects the body outright,
    // which would take this surface straight back to buffering an upload in
    // memory — the one thing #167 exists to not do.
    //
    // The casts are the type-level shadow of the same two-copies problem the
    // header describes: `@types/node` declares the global `fetch` with its own
    // bundled `undici-types`, and this module deliberately uses the real
    // package's `fetch` instead. The two `Response` and `RequestInit`
    // declarations are structurally near-identical and neither is wrong — they
    // are simply not the same declaration. Everything this package reads off a
    // response (`ok`, `status`, `headers.get`, `json`, `body`) is common to
    // both, and the global `Response` is what callers and tests hold, so that
    // is the type this surface promises.
    const init: Record<string, unknown> = {
      method: req.method,
      headers: req.headers,
      ...(req.body ? { body: req.body, duplex: "half" } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
      ...(dispatcher ? { dispatcher } : {}),
    };
    const res = await undiciFetch(req.url, init as Parameters<typeof undiciFetch>[1]);
    return res as unknown as Response;
  };
}

/**
 * Turn a non-2xx answer into the right error class, reading the `code` beside
 * the prose rather than the prose.
 *
 * A client branches on `code` because a message is a sentence somebody will
 * reword — and `transfer-in-progress` in particular *has* to stay
 * distinguishable (F8). The body is read to completion here, and only here: a
 * refusal body is a short JSON object, which is why buffering it does not
 * violate the streaming rule the success paths keep.
 */
export async function refusalFrom(res: Response, what: string): Promise<CoreFilesRequestError> {
  let code = "";
  let message = "";
  try {
    const body = (await res.json()) as { code?: unknown; error?: unknown };
    if (typeof body.code === "string") code = body.code;
    if (typeof body.error === "string") message = body.error;
  } catch {
    // A refusal that is not the Core's JSON shape — a proxy's HTML error page,
    // a truncated body. Say what is actually known rather than inventing a code.
  }
  const described = message || `${what} was refused with HTTP ${res.status}`;
  const withCode = code ? `${described} (${code})` : described;
  if (res.status === 409) return new CoreFilesConflictError(res.status, code || "conflict", withCode);
  return new CoreFilesRequestError(res.status, code || `http-${res.status}`, withCode);
}
