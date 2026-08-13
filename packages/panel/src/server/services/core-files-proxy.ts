// The Panel is a dumb pipe (#129 F11, #169).
//
// A browser cannot reach a Core. It holds no client certificate (ADR 0002), it
// has never seen the Core's CA, and the Core's HTTPS origin is normally not
// routable from the operator's laptop at all — the compose network in
// `deploy/docker-compose.yml` publishes no Core port on purpose. So the bytes
// of a dropped file go browser → Panel → Core, and this module is the middle
// arrow. **The mTLS credentials for the file routes live on the Panel service,
// beside the ones it already dials every core link with; ADR 0030 records why,
// and what it costs.**
//
// ## What "dumb pipe" is worth, precisely
//
// Three things this module does not do, each of them a decision rather than an
// omission:
//
// **It does not buffer.** The browser's request body is handed to the Core's
// socket as a stream and the Core's answer is handed back the same way. Nothing
// on either path calls `arrayBuffer`, `text`, `json`, `formData` or `blob` — the
// helpers that make this easy to get wrong, because every one of them is a
// one-word change that turns a gigabyte crossing a socket into a gigabyte in the
// Panel's heap. `core-files-streaming.test.ts` pushes a body larger than a
// deliberately small heap cap through a real Panel process to hold that.
//
// **It does not unpack.** A folder crosses as one tar (ADR 0029) and the tar is
// opened on the machine that owns the disk. A Panel that unpacked would be a
// second implementation of the hardened unpacker PR 215 wrote, running on the
// wrong machine, with no filesystem to validate against.
//
// **It does not validate paths.** `..`, an absolute path, a symlink escaping the
// Project root — all of them go down the wire exactly as the browser wrote them,
// and the Core refuses them with the code it chose (F3, ADR 0027 D5). One place
// validates paths: the machine that owns the disk. A Panel that pre-checked
// would be guessing about a filesystem it cannot see, and the day the two checks
// disagreed the Panel's would be the wrong one — while still being the one that
// answered.
//
// The one thing it *does* enforce is the F9 capability gate, and that is not
// path validation: it is refusing to send at all to a Core that has told us it
// has no file surface, so an operator reads "this Core has no file surface"
// rather than a `404` that looks like an outage.
import { httpsBaseUrlFor } from "@actana/sdk/core-registration-blob";
import { createCoreFilesFetch, type CoreFilesFetch } from "@actana/sdk/core-files-http";
import { CoreFiles } from "@actana/sdk/core-files";
import { getCore, getCoreSecrets } from "./cores";
import { coreLinkManager } from "./core-link-manager";

/** Everything the pipe needs about one Core, resolved once per request. */
export type CoreFilesTarget = {
  /** `…/v1/projects/:projectId/files?path=…` — the read and write route. */
  fileUrl(path: string): string;
  /** `…/v1/projects/:projectId/files/list?path=…&depth=…&sha256=…` */
  listUrl(opts: { path?: string; depth?: number; sha256?: boolean }): string;
  /** The bearer the core link presents, as an `authorization` header, or `{}`. */
  authHeaders(): Record<string, string>;
  fetch: CoreFilesFetch;
};

/** Why a Core cannot be piped to right now, in words an operator can act on. */
export type CoreFilesRefusal = {
  status: number;
  code: "no-such-core" | "core-unreachable" | "files-unsupported" | "core-credentials";
  message: string;
};

export type CoreFilesResolution =
  | { ok: true; target: CoreFilesTarget }
  | { ok: false; refusal: CoreFilesRefusal };

/**
 * The Core's route shapes, borrowed from the SDK rather than rewritten.
 *
 * `CoreFiles` keeps `fileUrl` and `listUrl` `protected` and says in as many
 * words that a caller who needs them subclasses. This is that caller, and the
 * reason to take the SDK's copy is #218: the SDK and the Core had drifted to
 * two different listing URLs, and the fix was a contract test pinning them
 * together. A third hand-rolled `/v1/projects/${id}/files` in the Panel would
 * be a third thing to keep in that agreement — and the one furthest from the
 * test.
 *
 * Nothing else on `CoreFiles` is used here. Its `list`/`upload`/`download`
 * parse NDJSON into typed progress objects, which is exactly right for an SDK
 * caller and exactly wrong for a pipe: parsing and re-serialising a stream is
 * how a Panel ends up owning a shape it is meant to be forwarding.
 */
class CoreFileRoutes extends CoreFiles {
  urlForFile(path: string): string {
    return this.fileUrl(path);
  }

  urlForList(opts: { path?: string; depth?: number; sha256?: boolean }): string {
    return this.listUrl(opts);
  }
}

/**
 * Resolve one Core into something the pipe can send to, or into the refusal to
 * answer with.
 *
 * The order of the four refusals is the order an operator can act on them:
 * unknown Core, unreadable credentials, a link that is down, a Core with no
 * file surface. The last one is checked **before any byte leaves** for the same
 * reason the SDK checks it there — a `404` off a Core that predates the surface
 * reads as an outage, and it is not one.
 */
export function resolveCoreFilesTarget(
  coreId: string,
  projectId: string,
  deps: {
    getCore?: typeof getCore;
    getCoreSecrets?: typeof getCoreSecrets;
    dialState?: (coreId: string) => string;
    filesCapability?: (coreId: string) => { version: 1 } | null;
    createFetch?: typeof createCoreFilesFetch;
  } = {},
): CoreFilesResolution {
  const readCore = deps.getCore ?? getCore;
  const readSecrets = deps.getCoreSecrets ?? getCoreSecrets;
  const dialState = deps.dialState ?? ((id: string) => coreLinkManager().status(id).state);
  const capability = deps.filesCapability ?? ((id: string) => coreLinkManager().filesCapability(id));
  const makeFetch = deps.createFetch ?? createCoreFilesFetch;

  const core = readCore(coreId);
  if (!core) {
    return refuse(404, "no-such-core", "no such Core is registered with this Panel");
  }
  const secrets = readSecrets(coreId);
  if (!secrets?.bearer) {
    return refuse(
      502,
      "core-credentials",
      "this Core's stored credentials could not be read — pair it again",
    );
  }
  // Connectivity before capability, which is the SDK's order and the honest one:
  // a Core that has not finished connecting has announced nothing yet, and
  // reporting that as "no file surface" would send an operator to upgrade a Core
  // that is merely still dialing.
  const state = dialState(coreId);
  if (state !== "connected") {
    return refuse(503, "core-unreachable", `this Core's link is ${state} — its files are not reachable`);
  }
  if (!capability(coreId)) {
    return refuse(
      501,
      "files-unsupported",
      "this Core announces no file surface — it predates project files, so there is nothing to show",
    );
  }

  const fetch = filesFetchFor(coreId, secrets, makeFetch);
  const routes = new CoreFileRoutes({
    projectId,
    baseUrl: httpsBaseUrlFor(core.endpoint),
    bearer: secrets.bearer,
    // Already gated above, and the SDK's own gate would be a second answer to
    // the same question. These URL builders never consult it.
    availability: () => ({ available: true }),
    fetch,
  });

  return {
    ok: true,
    target: {
      fileUrl: (path) => routes.urlForFile(path),
      listUrl: (opts) => routes.urlForList(opts),
      authHeaders: () => ({ authorization: `Bearer ${secrets.bearer}` }),
      fetch,
    },
  };
}

function refuse(
  status: number,
  code: CoreFilesRefusal["code"],
  message: string,
): CoreFilesResolution {
  return { ok: false, refusal: { status, code, message } };
}

/**
 * One sender per Core, kept for the life of the process.
 *
 * `createCoreFilesFetch` builds an undici `Agent` on first use and an `Agent`
 * *is* a connection pool. One per request would mean a fresh TLS handshake for
 * every listing a Files view refreshes, and would leave the pools behind to be
 * collected — which is a slow leak rather than an error, and therefore the kind
 * that survives review.
 *
 * Keyed by the credentials as well as the Core id: re-pairing a Core writes new
 * material under the same id, and a cached sender presenting the retired
 * certificate would be refused at the handshake with an error naming no cause.
 */
const sendersByCore = new Map<string, { fingerprint: string; fetch: CoreFilesFetch }>();

function filesFetchFor(
  coreId: string,
  secrets: { caCert: string; clientCert: string; clientKey: string },
  makeFetch: typeof createCoreFilesFetch,
): CoreFilesFetch {
  // The client certificate identifies the pairing and the CA pins the server;
  // both change together on a re-pair, and neither is a secret this Panel does
  // not already hold. The key is deliberately not part of the fingerprint — it
  // never travels alone.
  const fingerprint = `${secrets.caCert.length}:${secrets.clientCert}`;
  const cached = sendersByCore.get(coreId);
  if (cached && cached.fingerprint === fingerprint) return cached.fetch;
  const fetch = makeFetch({ ca: secrets.caCert, cert: secrets.clientCert, key: secrets.clientKey });
  sendersByCore.set(coreId, { fingerprint, fetch });
  return fetch;
}

/** @internal — a fresh process-wide sender table, for suites that re-pair a Core. */
export function resetCoreFilesSendersForTests(): void {
  sendersByCore.clear();
}

/**
 * The headers a request carries **through** the Panel, and nothing else.
 *
 * An allowlist rather than a copy of the browser's headers: forwarding them all
 * would send the Operator's session cookie to a Core that has no business
 * holding it, plus a `host` naming the Panel and a `content-length` that a
 * proxy in front may have already changed. Every name here is one the Core's
 * routes actually read (`docs/external-api.md`).
 */
const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "content-length",
  "accept",
  "x-actana-file-mode",
  "x-actana-file-mtime",
] as const;

/**
 * The headers an answer carries **back**, and nothing else.
 *
 * Same rule in the other direction. `content-length` is deliberately absent for
 * a reason worth stating: a chunked NDJSON progress stream has none, and copying
 * one from a Core that sent it for a different body length is how a browser ends
 * up waiting forever for bytes that already arrived.
 */
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "x-actana-transfer-kind",
  "x-actana-file-size",
  "x-actana-file-mode",
  "x-actana-file-mtime",
] as const;

export function forwardedRequestHeaders(from: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = from.get(name);
    if (value !== null) headers[name] = value;
  }
  return headers;
}

export function forwardedResponseHeaders(from: Headers): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = from.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

/**
 * Send one request at a Core and hand its answer straight back.
 *
 * This is the whole pipe, and its shortness is the feature: the request body is
 * the browser's `ReadableStream` — the *same object*, not a copy of its bytes —
 * and the response body is the Core's, likewise. A `Response` constructed around
 * a stream is not read until something reads it, and the thing that eventually
 * reads it is the operator's socket.
 *
 * The Core's status code is passed through unchanged, including the ones this
 * Panel has no opinion about: `409 transfer-in-progress` (F8), `507
 * insufficient-storage`, and every path refusal (F3). Rewriting any of them
 * would be the Panel claiming to know something about a filesystem it cannot
 * see.
 */
export async function pipeToCore(opts: {
  target: CoreFilesTarget;
  method: "GET" | "HEAD" | "PUT";
  url: string;
  headers: Record<string, string>;
  body?: ReadableStream<Uint8Array> | null;
  signal?: AbortSignal;
}): Promise<Response> {
  const answer = await opts.target.fetch({
    method: opts.method,
    url: opts.url,
    headers: { ...opts.target.authHeaders(), ...opts.headers },
    ...(opts.body ? { body: opts.body } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return new Response(answer.body, {
    status: answer.status,
    statusText: answer.statusText,
    headers: forwardedResponseHeaders(answer.headers),
  });
}
