// `/api/cores/:coreId/projects/:projectId/files…` — the Panel's half of the
// file surface (#129 F6, F11; #169).
//
// Three handlers, and between them they contain no knowledge of what a file is.
// They resolve a Core, copy an allowlist of headers, and hand the browser's
// stream to `pipeToCore`; the meaning of a path, of a tar, of an overwrite and
// of every refusal belongs to the Core (see `../services/core-files-proxy.ts`,
// which is where the reasoning lives).
//
// **Nothing here reads a request body.** That is the whole discipline of the
// module and it is easy to break by accident: `parseJsonBody`, `request.text()`
// and `request.formData()` are all one line away and all of them would put a
// multi-gigabyte upload in the Panel's heap. The write handler takes
// `request.body` — the unread stream — and passes it on.
import { jsonError } from "../http-responses";
import { HTTP_BAD_REQUEST } from "~/shared/http-status";
import {
  forwardedRequestHeaders,
  pipeToCore,
  resolveCoreFilesTarget,
  type CoreFilesResolution,
} from "../services/core-files-proxy";

/**
 * A depth or a digest flag the browser asked for, passed on only when it parses.
 *
 * This is the one place a query parameter is looked at rather than forwarded,
 * and it is not path validation: `depth` and `sha256` are the listing's own
 * knobs, `path` is not touched, and a value that is not a number is dropped
 * rather than corrected — the Core's default is a better answer than the
 * Panel's guess at what `depth=lots` meant.
 */
function listOptions(url: URL): { path?: string; depth?: number; sha256?: boolean } {
  const depth = Number(url.searchParams.get("depth"));
  return {
    path: url.searchParams.get("path") ?? "",
    ...(Number.isInteger(depth) && depth > 0 ? { depth } : {}),
    ...(url.searchParams.get("sha256") === "1" ? { sha256: true } : {}),
  };
}

function refusalResponse(resolution: Extract<CoreFilesResolution, { ok: false }>): Response {
  return new Response(
    JSON.stringify({ error: resolution.refusal.message, code: resolution.refusal.code }),
    { status: resolution.refusal.status, headers: { "content-type": "application/json" } },
  );
}

/**
 * `GET …/files/list` — the Project's tree as the Core streams it.
 *
 * NDJSON, one entry per line, handed back unparsed. A Panel that parsed it
 * would have to have an opinion about an entry it does not recognise, and the
 * shape belongs to the Core.
 */
export function list(coreId: string, projectId: string, url: URL): Promise<Response> {
  const resolved = resolveCoreFilesTarget(coreId, projectId);
  if (!resolved.ok) return Promise.resolve(refusalResponse(resolved));
  return pipeToCore({
    target: resolved.target,
    method: "GET",
    url: resolved.target.listUrl(listOptions(url)),
    headers: { accept: "application/x-ndjson" },
  });
}

/**
 * `GET …/files?path=…` — a file's raw bytes, or a folder as one streamed tar.
 *
 * The browser gets whatever the Core sent, with the transfer-kind header that
 * says which of the two it is. A `content-disposition` is deliberately *not*
 * invented here: the caller knows the name it asked for, and a Panel guessing at
 * one would be the second place a filename is decided.
 */
export function read(coreId: string, projectId: string, url: URL): Promise<Response> {
  const resolved = resolveCoreFilesTarget(coreId, projectId);
  if (!resolved.ok) return Promise.resolve(refusalResponse(resolved));
  return pipeToCore({
    target: resolved.target,
    method: "GET",
    url: resolved.target.fileUrl(url.searchParams.get("path") ?? ""),
    headers: {},
  });
}

/**
 * `PUT …/files?path=…` — the dropped bytes, streamed through to the Core, with
 * the Core's NDJSON progress stream streamed back (F5: every overwrite named).
 *
 * `request.body` is a `ReadableStream` that has not been read, and stays that
 * way: it is handed to the Core's socket and the two ends pace each other. A
 * body-less PUT is refused here rather than forwarded, because a Core answering
 * "you wrote an empty file" to a browser that meant to send a gigabyte is a
 * confusing way to learn that a proxy in between dropped the body.
 */
export function write(
  coreId: string,
  projectId: string,
  url: URL,
  request: Request,
): Promise<Response> {
  if (!request.body) {
    return Promise.resolve(jsonError(HTTP_BAD_REQUEST, "this write carried no body"));
  }
  const resolved = resolveCoreFilesTarget(coreId, projectId);
  if (!resolved.ok) return Promise.resolve(refusalResponse(resolved));
  return pipeToCore({
    target: resolved.target,
    method: "PUT",
    url: resolved.target.fileUrl(url.searchParams.get("path") ?? ""),
    headers: { accept: "application/x-ndjson", ...forwardedRequestHeaders(request.headers) },
    body: request.body,
    ...(request.signal ? { signal: request.signal } : {}),
  });
}
