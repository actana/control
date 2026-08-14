// The dev Panel streams a request body too (#169).
//
// The two hosts of the `/api/*` handler are `bin/panel.mjs` in production and
// the Vite middleware in `vite-api-plugin.ts` in development, and until #169
// they disagreed about the one thing the file routes depend on: the production
// entry has always built its `Request` with `Readable.toWeb(req)`, and the dev
// one concatenated every chunk into a `Buffer` first.
//
// That difference is invisible in a JSON-only API and fatal in a streaming one:
// `pnpm dev` is where this feature is actually written, so a Panel that buffers
// there is a Panel where nobody would notice the buffering until a deployed one
// fell over. The trap #169 names — a streaming proxy written as a buffering one
// — was already sitting in this function before a single file route existed.
import { describe, expect, it } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { nodeRequestToFetch } from "../vite-api-plugin";

/**
 * Drive one request through a real Node HTTP server and hand the converted
 * `Request` to `inspect`, which is called **while the client is still sending**.
 */
async function withRequest(
  send: (req: http.ClientRequest) => void,
  inspect: (request: Request) => Promise<void>,
): Promise<void> {
  let failure: unknown = null;
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        await inspect(nodeRequestToFetch(req));
      } catch (err) {
        failure = err;
      } finally {
        res.statusCode = 200;
        res.end("ok");
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "PUT", path: "/api/x" },
      (res) => {
        res.resume();
        res.on("end", resolve);
      },
    );
    req.on("error", reject);
    send(req);
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (failure) throw failure;
}

describe("the dev server's Node → Web request conversion", () => {
  it("hands over the body as a stream the handler pulls, not bytes it already holds", async () => {
    let sawFirstChunk = false;
    let sentLastChunk = false;

    await withRequest(
      (req) => {
        req.write("first-");
        // The second chunk goes out only once the handler has read the first,
        // which a buffering conversion can never reach — it would still be
        // waiting for this `end()` to happen.
        const waitForRead = setInterval(() => {
          if (!sawFirstChunk) return;
          clearInterval(waitForRead);
          sentLastChunk = true;
          req.end("second");
        }, 10);
      },
      async (request) => {
        expect(request.body).toBeTruthy();
        expect(request.bodyUsed).toBe(false);
        const reader = request.body!.getReader();
        const decoder = new TextDecoder();

        const first = await reader.read();
        sawFirstChunk = true;
        expect(decoder.decode(first.value)).toBe("first-");
        expect(sentLastChunk).toBe(false);

        let rest = "";
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          rest += decoder.decode(next.value);
        }
        expect(rest).toBe("second");
      },
    );
  }, 20_000);

  it("gives a GET no body at all, which is what the Request constructor demands", async () => {
    const request = nodeRequestToFetch({
      method: "GET",
      url: "/api/cores",
      headers: { host: "panel.test" },
    } as unknown as http.IncomingMessage);
    expect(request.body).toBeNull();
    expect(request.url).toBe("http://panel.test/api/cores");
  });
});
