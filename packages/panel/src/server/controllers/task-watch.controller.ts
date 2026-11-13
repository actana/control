import { HTTP_GONE, HTTP_INTERNAL_SERVER_ERROR, HTTP_NOT_FOUND } from "~/shared/http-status";
import { json, jsonError } from "../http-responses";
import { taskWatchGlobalLimit, taskWatchTokenLimit } from "../services/rate-limits";
import { readWatch, verifyWatchToken, watchTokenHash } from "../services/task-watch";

const NO_STORE = { "cache-control": "no-store" } as const;

function noStore(response: Response): Response {
  response.headers.set("cache-control", NO_STORE["cache-control"]);
  return response;
}

/**
 * `GET /api/watch/<token>` (#950): a Task attempt's status, with no session and no key. The signed token in the
 * path is the whole credential. What it opens is status only: no title, description, comments or report text.
 *
 * Order: the global ceiling first (so made-up tokens are capped too), then the signature (404), and only then the
 * per-token limit, so a token that does not verify never gets a bucket. Expired or replaced is 410. A failure after
 * the global limit is a no-store 500 and a log line without the token, never an error that reaches the Panel handler
 * (which logs the URL).
 */
export async function read(rawToken: string): Promise<Response> {
  const global = taskWatchGlobalLimit();
  if (!global.ok) return noStore(global.response);
  try {
    if (rawToken.includes("/") || !verifyWatchToken(rawToken)) return noStore(jsonError(HTTP_NOT_FOUND, "not found"));
    const limited = taskWatchTokenLimit(watchTokenHash(rawToken));
    if (!limited.ok) return noStore(limited.response);
    const result = await readWatch(rawToken);
    switch (result.kind) {
      case "ok":
        return json(result.payload, { headers: NO_STORE });
      case "gone":
        return jsonError(HTTP_GONE, "this status link has expired or been replaced", NO_STORE);
      case "not-found":
        return jsonError(HTTP_NOT_FOUND, "not found", NO_STORE);
    }
  } catch (err) {
    // Never log the request URL or the token: the token is the whole credential.
    console.error("[task-watch] read failed:", err instanceof Error ? err.name : "error");
    return noStore(jsonError(HTTP_INTERNAL_SERVER_ERROR, "internal error"));
  }
}
