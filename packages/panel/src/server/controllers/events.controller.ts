import { events } from "../events";
import { HTTP_OK } from "~/shared/http-status";

const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Server-sent event stream. Authenticated by the Operator session cookie the
 * browser attaches automatically — EventSource can't set headers, but it does
 * send same-origin cookies, so the old single-use ticket handshake is gone.
 */
export function stream(): Response {
  let cleanup: (() => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (data: unknown) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* swallow */
        }
      };
      send({ type: "hello", at: Date.now() });
      const off = events.onAny((e) => {
        send(e);
      });
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": ping\n\n"));
        } catch {
          /* swallow */
        }
      }, SSE_HEARTBEAT_INTERVAL_MS);
      cleanup = () => {
        clearInterval(heartbeat);
        off();
      };
    },
    cancel() {
      cleanup?.();
    },
  });
  return new Response(stream, {
    status: HTTP_OK,
    headers: {
      "content-type": "text/event-stream",
      // no-store: a per-Operator live stream must never sit in a browser or
      // intermediary cache. no-transform stops a proxy buffering the frames.
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
    },
  });
}
