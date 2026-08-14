// The answer's journey back, and what it survives (#225).
//
// `bin/panel.mjs` and the Vite dev middleware both hand a Web `Response` to a
// Node `ServerResponse`, and both used to do it themselves. This suite drives
// the one translation they now share, through a **real** `node:http` server and
// a real socket, because every failure it pins is about what a socket does
// rather than about what a function returns.
//
// The sharp one is the first. Production piped the answer with
// `Readable.fromWeb(body).pipe(res)`, and `pipe` installs an `error` listener on
// the destination and none on the source — so an error arriving on that
// `Readable` was an unhandled `'error'` event, which in Node ends the process.
// The Core hands one over on purpose: its read, list and write handlers all end
// an interrupted stream with `res.destroy()` so that a truncated body cannot be
// mistaken for a whole one. An operator closing a big file listing could
// therefore take the Panel down, and every request in flight on it — the upload
// they had just started, and the file view beside it — died together with the
// browser's `Failed to fetch`, having produced no response at all.
//
// A test for "the process did not die" cannot assert on a value, so it asserts
// the only thing a dead process cannot do: answer the next request.
import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import { serveNodeRequest } from "../node-http-bridge";

type Rig = {
  port: number;
  close: () => Promise<void>;
  /** Every `request.signal` the bridge handed the handler, newest last. */
  signals: AbortSignal[];
};

const running: Rig[] = [];

afterEach(async () => {
  for (const rig of running.splice(0)) await rig.close();
});

async function serve(handle: (request: Request) => Promise<Response | null>): Promise<Rig> {
  const signals: AbortSignal[] = [];
  const server = http.createServer((req, res) => {
    void serveNodeRequest(req, res, (request) => {
      signals.push(request.signal);
      return handle(request);
    }).catch(() => {
      // The hosts keep their own catch; a throw reaching here would mean the
      // bridge failed to answer, which the assertions below would see anyway.
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const rig: Rig = {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    signals,
  };
  running.push(rig);
  return rig;
}

/**
 * A chunked answer that emits `head`, then fails.
 *
 * The failure waits a tick so the head is on the wire rather than still in the
 * socket's outgoing buffer when the stream errors — this suite is about a body
 * that *started* arriving, which is the case a bare `pipe()` could not survive.
 */
function failsAfter(head: string[], error: Error): Response {
  const encoder = new TextEncoder();
  let sent = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent < head.length) {
          controller.enqueue(encoder.encode(head[sent]!));
          sent += 1;
          return;
        }
        if (head.length > 0) await new Promise((resolve) => setTimeout(resolve, 50));
        controller.error(error);
      },
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  );
}

/** One raw request/response exchange, reporting how the socket ended. */
function exchange(
  port: number,
  request: string,
  opts: { destroyAfterBytes?: number; destroyAfterMs?: number } = {},
): Promise<{ text: string; ended: "clean" | "reset" | "timeout" }> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    let text = "";
    let settled = false;
    const done = (ended: "clean" | "reset" | "timeout") => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ text, ended });
    };
    sock.on("connect", () => {
      sock.write(request);
      if (opts.destroyAfterMs !== undefined) {
        setTimeout(() => {
          sock.destroy();
          done("clean");
        }, opts.destroyAfterMs).unref();
      }
    });
    sock.on("data", (chunk) => {
      text += chunk.toString("utf8");
      if (opts.destroyAfterBytes !== undefined && text.length >= opts.destroyAfterBytes) {
        sock.destroy();
        done("clean");
      }
    });
    // A body cut short arrives as a FIN with no terminating chunk, or as an
    // RST. Either is "the server refused to end this cleanly", which is the
    // distinction being asserted.
    sock.on("close", () => done(text.includes("\r\n0\r\n\r\n") ? "clean" : "reset"));
    sock.on("error", () => done("reset"));
    setTimeout(() => done("timeout"), 10_000).unref();
  });
}

function get(path: string, extra = ""): string {
  return `GET ${path} HTTP/1.1\r\nHost: panel.test\r\nConnection: close\r\n${extra}\r\n`;
}

describe("an answer whose body fails half-written", () => {
  it("does not take the process down, and answers the next request", async () => {
    const rig = await serve(async (request) =>
      new URL(request.url).pathname === "/api/boom"
        ? failsAfter(['{"type":"entry","path":"a"}\n'], new Error("the Core destroyed the stream"))
        : new Response("alive", { headers: { "content-type": "text/plain" } }),
    );

    const broken = await exchange(rig.port, get("/api/boom"));
    // The first entry did reach the client — this is a stream that started
    // fine, which is the case `.pipe()` could not survive.
    expect(broken.text).toContain('{"type":"entry","path":"a"}');
    // …and it was not ended cleanly, because it is not the whole answer. A
    // terminating `0\r\n\r\n` here would mean a truncated listing reads as a
    // complete one.
    expect(broken.ended).toBe("reset");

    // The assertion the whole suite exists for. An unhandled `'error'` event on
    // the source stream ends the Node process, so this exchange is what tells
    // the two implementations apart: the old one never gets here.
    const after = await exchange(rig.port, get("/api/alive"));
    expect(after.text).toContain("alive");
  }, 30_000);

  it("becomes a refusal with a status when it fails before the first byte", async () => {
    const rig = await serve(async () => failsAfter([], new Error("the Core hung up")));

    const answer = await exchange(rig.port, get("/api/boom"));
    // The status line was still ours to write, so the operator reads a reason
    // instead of watching the connection evaporate — "a real refusal with a
    // code" rather than the browser's `Failed to fetch`.
    expect(answer.text).toContain("502");
    expect(answer.text).toContain("ended before it was complete");
    // The upstream's own content-type must not survive onto a body that is now
    // this module's JSON.
    expect(answer.text).not.toContain("x-ndjson");
  }, 30_000);
});

describe("a client that walks away", () => {
  it("cancels the upstream body instead of parking on a drain that never comes", async () => {
    let cancelled: unknown = undefined;
    const encoder = new TextEncoder();
    const rig = await serve(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              // Comfortably past the socket's high-water mark, so the pump is
              // waiting on `drain` when the client disappears — the state the
              // dev writer used to sit in for the life of the process.
              controller.enqueue(encoder.encode("x".repeat(64 * 1024)));
            },
            cancel(reason) {
              cancelled = reason ?? new Error("cancelled");
            },
          }),
          { headers: { "content-type": "application/x-ndjson" } },
        ),
    );

    await exchange(rig.port, get("/api/endless"), { destroyAfterBytes: 4096 });
    await expect
      .poll(() => cancelled !== undefined, { timeout: 10_000 })
      .toBe(true);
  }, 30_000);

  it("aborts the handler's signal, which is what frees a Core's write lease", async () => {
    let seen: AbortSignal | null = null;
    const rig = await serve(
      (request) =>
        new Promise<Response>((resolve) => {
          seen = request.signal;
          // Never answers on its own: the only way out is the client leaving,
          // exactly as a `PUT` waiting on a Core's progress stream behaves.
          request.signal.addEventListener("abort", () => resolve(new Response(null, { status: 499 })));
        }),
    );

    await exchange(rig.port, get("/api/hangs"), { destroyAfterMs: 100 });
    await expect.poll(() => seen?.aborted === true, { timeout: 10_000 }).toBe(true);
  }, 30_000);

  it("leaves the signal alone when the answer completed normally", async () => {
    const rig = await serve(async () => new Response("done"));
    const answer = await exchange(rig.port, get("/api/fine"));
    expect(answer.text).toContain("done");
    // A response nobody lost has no caller to have lost it — aborting here
    // would tear down transfers that had already succeeded.
    expect(rig.signals.at(-1)?.aborted).toBe(false);
  }, 30_000);
});

describe("the bridge declines rather than answering", () => {
  it("touches nothing when the handler returns null, so the dev server can fall through", async () => {
    let served: boolean | null = null;
    const server = http.createServer((req, res) => {
      void serveNodeRequest(req, res, async () => null).then((result) => {
        served = result;
        res.statusCode = 418;
        res.end("next() would have run here");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const answer = await exchange(port, get("/not-api"));
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(served).toBe(false);
    expect(answer.text).toContain("418");
  }, 30_000);
});
