// One bridge, two hosts (#225).
//
// The Panel's `/api/*` surface is a Web `Request → Response` handler, and
// neither process that hosts it speaks that shape: `bin/panel.mjs` in
// production and the Vite middleware in development both hold a Node
// `IncomingMessage`/`ServerResponse` pair and have to translate. Until this
// module they each did it themselves, and they had already drifted once — #169
// found the dev half concatenating every request body into a `Buffer` while the
// production half streamed the same request correctly, which is invisible in a
// JSON-only API and fatal in a streaming one (ADR 0030 D2 records it).
//
// The half nobody had written twice is the one that broke next: the **answer's
// journey back**. Both hosts pumped the handler's `Response` into their
// `ServerResponse` by hand, and both got the same two things wrong.
//
// ## What was wrong, and why it looked like a Panel that had died
//
// **A failing upstream body took the whole process down.** Production piped it
// with `Readable.fromWeb(body).pipe(res)`. `pipe` installs an `error` listener
// on the *destination* and none on the source, so an error reaching that
// `Readable` is an unhandled `'error'` event — and an unhandled `'error'` event
// is a process-ending exception in Node. The Core hands one over deliberately:
// its read, list and write handlers all end an interrupted stream with
// `res.destroy()`, precisely so a truncated body cannot be mistaken for a whole
// one. So an operator who closed a file listing mid-stream could take the Panel
// down, and every request in flight on that process — the upload they had just
// started, and the file listing beside it — died at the same instant with the
// browser's `Failed to fetch`, having produced no response at all.
//
// **Nothing told the Core to stop.** Neither host noticed the browser going
// away: `pipe` merely unpipes, and the dev writer parked forever on a `drain`
// event that a destroyed socket never emits. Either way the Core's answer was
// left unread and uncancelled, so a Project's write lease (F8) stayed held for
// the whole of a transfer nobody was listening to — and the operator's next
// drop was refused `409 transfer-in-progress` by a transfer the Panel had
// already reported dead.
//
// Both are fixed here, once, in the path both hosts run.
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
// Relative, not `~/…`: this module is reached from `vite.config.ts` through
// `vite-api-plugin.ts`, and Vite loads its own config before any alias exists.
import { HTTP_BAD_GATEWAY } from "../shared/http-status";

const LOOPBACK_HOST_FALLBACK = "127.0.0.1";

/**
 * The browser hung up while this answer was still being written.
 *
 * A named error rather than a bare one, and for the same reason the Core gives
 * it one (`core-files-routes.ts`): it is the ordinary end of a stream somebody
 * stopped reading, not a failure to log, but it still has to *throw* so the
 * pump unwinds — cancelling the upstream body on its way out, which is what
 * releases whatever the far end was holding open for a reader.
 */
export class ClientGoneError extends Error {
  constructor() {
    super("the client closed the connection before this answer finished");
    this.name = "ClientGoneError";
  }
}

/**
 * A Node request as a Web `Request`, **without reading its body** (#169).
 *
 * This used to `await` every byte into a `Buffer` on the dev side. That was
 * invisible for the JSON bodies the `/api/*` surface carried at the time and
 * fatal for the one it carries now: the file routes stream a dropped file
 * through to a Core (#129 F11), and a Panel that concatenated a multi-gigabyte
 * upload would die of it.
 *
 * `duplex: "half"` is mandatory with a stream body and is not optional
 * decoration — without it the `Request` constructor rejects the body outright.
 * It is absent from the DOM `RequestInit` this file is typechecked against and
 * present on every runtime that accepts a stream, hence the cast.
 */
export function nodeRequestToFetch(
  req: IncomingMessage,
  opts: { hostFallback?: string; signal?: AbortSignal } = {},
): Request {
  const host = req.headers.host || opts.hostFallback || LOOPBACK_HOST_FALLBACK;
  const url = `http://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) {
      for (const vv of v) headers.append(k, vv);
    } else if (typeof v === "string") {
      headers.set(k, v);
    }
  }
  const method = (req.method || "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    ...(hasBody
      ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half" }
      : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  } as RequestInit);
}

/**
 * Serve one Node request with a Web fetch handler.
 *
 * Returns `false` when the handler declined the request (`null`), **having
 * touched `res` not at all** — which is what lets the Vite middleware fall
 * through to `next()` and Vite's own routes.
 *
 * The `AbortSignal` this hands the handler is the whole of #225's second half.
 * `request.signal` is the only way a controller can learn that the operator's
 * browser is gone, and the file routes forward it to the Core: a `PUT` whose
 * tab was closed takes the Core-bound transfer down with it rather than leaving
 * that Project's write lease held until a doomed upload finishes. It fires only
 * when the socket closes **before the answer was finished** — a response that
 * completed normally has no caller to have lost.
 */
export async function serveNodeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handle: (request: Request) => Promise<Response | null> | Response | null,
  opts: { hostFallback?: string } = {},
): Promise<boolean> {
  const gone = new AbortController();
  const abortIfUnanswered = (): void => {
    if (!res.writableFinished && !gone.signal.aborted) gone.abort(new ClientGoneError());
  };
  res.on("close", abortIfUnanswered);
  req.on("aborted", abortIfUnanswered);

  const request = nodeRequestToFetch(req, {
    ...(opts.hostFallback ? { hostFallback: opts.hostFallback } : {}),
    signal: gone.signal,
  });
  const response = await handle(request);
  if (!response) return false;
  await writeResponseToNode(response, res);
  return true;
}

/**
 * Write one `Response` to a Node `ServerResponse`, and survive both ends.
 *
 * Never throws for a client that walked away, and never lets a failing upstream
 * body reach Node as an unhandled `'error'` event. The three endings, in the
 * order they matter:
 *
 * - **The body ran out early and nothing has been sent yet.** The status line
 *   is still ours to write, so the caller gets a `502` with a sentence in it —
 *   "a real refusal with a code", which is what #225 asked for in place of a
 *   connection that produces no response at all.
 * - **The body ran out early and bytes are already on the wire.** The status is
 *   spent; the only honest ending left is to destroy the socket, because a
 *   truncated chunked body that terminated cleanly would read as the whole
 *   answer. Same reasoning as the Core's own `res.destroy()` on a half-written
 *   tar.
 * - **The client hung up.** The upstream body is cancelled on the way out.
 *   That cancellation is the message: it destroys the Panel's request to the
 *   Core, which closes the Core's response, which runs the `finally` that frees
 *   that Project's write lease (F8). Without it the Core keeps writing for a
 *   reader that no longer exists.
 */
export async function writeResponseToNode(
  response: Response,
  res: ServerResponse,
): Promise<void> {
  res.statusCode = response.status;
  const setCookies = getSetCookieHeaders(response.headers);
  response.headers.forEach((value, key) => {
    const name = key.toLowerCase();
    // `content-encoding` describes how the *upstream* framed its body, and the
    // body handed over here has already been decoded — copying it would tell
    // the browser to decode plain bytes a second time. `set-cookie` is appended
    // below instead, because `Headers.forEach` folds several into one value.
    if (name === "content-encoding" || name === "set-cookie") return;
    res.setHeader(key, value);
  });
  if (setCookies.length) res.setHeader("set-cookie", setCookies);

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  // A client that leaves while this pump is parked in `reader.read()` — an SSE
  // stream, a listing of a `node_modules`, an upload's progress — settles that
  // read as `done` rather than leaving it pending forever, and cancels upstream
  // on the way.
  const cancelOnClose = (): void => {
    if (!res.writableFinished) void reader.cancel(new ClientGoneError()).catch(() => {});
  };
  res.on("close", cancelOnClose);

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!chunk.value) continue;
      if (res.destroyed || res.writableEnded) throw new ClientGoneError();
      if (!res.write(chunk.value)) await drained(res);
    }
    // A cancelled reader reports `done` rather than throwing, so the loop can
    // also arrive here with the socket already gone — `end()` on a destroyed
    // response is an error event nobody is listening for.
    if (!res.writableEnded && !res.destroyed) res.end();
  } catch (err) {
    await reader.cancel(err).catch(() => undefined);
    if (err instanceof ClientGoneError || res.destroyed) return;
    if (!res.headersSent) {
      sendUpstreamFailure(res, err);
      return;
    }
    // The status line is spent. Destroying is the only way left to say that
    // this body is not the whole answer.
    res.destroy();
  } finally {
    res.off("close", cancelOnClose);
  }
}

/**
 * Wait for a backpressured response to drain — or for the connection to die.
 *
 * **`'drain'` is never emitted on a destroyed stream.** A promise that waits
 * for that event alone never settles once the client hangs up, and the pump
 * awaiting it parks forever: the upstream body is never cancelled, so the Core
 * keeps a Project's write lease for a transfer with no reader left. The Core
 * learned this in its own `drained()`; the Panel's copy is here for the same
 * reason and settles the same way — by throwing, so the `catch` above cancels.
 */
function drained(res: ServerResponse): Promise<void> {
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

/** The answer for a body that failed before a single byte reached the client. */
function sendUpstreamFailure(res: ServerResponse, err: unknown): void {
  for (const name of res.getHeaderNames()) res.removeHeader(name);
  const body = JSON.stringify({
    error: `this answer ended before it was complete: ${err instanceof Error ? err.message : String(err)}`,
  });
  res.statusCode = HTTP_BAD_GATEWAY;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", String(Buffer.byteLength(body)));
  res.end(body);
}

export function getSetCookieHeaders(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const values = withGetSetCookie.getSetCookie?.();
  if (values?.length) return values;
  const value = headers.get("set-cookie");
  return value ? value.split(/,(?=\s*[^;,]+=)/) : [];
}
