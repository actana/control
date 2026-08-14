// The Panel does not buffer an upload (#169; #129 F11).
//
// This is the ticket's named trap — *"a streaming proxy is easy to write as a
// buffering one by accident, because most framework body helpers buffer"* —
// and a buffering proxy passes every functional test in
// `core-files-api.test.ts`: the bytes still arrive, the file is still `cat`-able,
// the progress stream still names the overwrite. It differs only in *when* and
// in *how much memory*. So both of those are asserted here directly.
//
// **The timing assertion is the sharp one.** A buffering proxy cannot deliver
// the first byte to the Core until the browser has sent the last, because it has
// not started the outbound request yet. So the test sends a body in chunks it
// controls, and asserts the Core has seen an early chunk *while the browser is
// still writing*. That is a structural property, not a benchmark: no timeout, no
// duration threshold, nothing that goes red on a loaded runner.
//
// The large-body assertion is the second half — bounded memory across a body far
// larger than any heap it could fit in — and the *deployed* version of it lives
// in `scripts/e2e-panel-smoke.mjs`, which pushes a body several times the size
// of a real memory-capped Panel process through the real `bin/panel.mjs`. That
// one is the answer to "verify with a file larger than the Panel container's
// memory limit"; this one keeps a cheap version of the claim inside `pnpm test`,
// where it runs on every push.
//
// The Core here is real — real mTLS server, real `ready`, real capability — but
// its `/v1/…` handler is a **sink** rather than the Core's own file routes: what
// is under test is the Panel's byte path, and writing gigabytes to a temp
// directory to prove the Panel did not hold them in memory would be measuring
// one machine's disk to make a claim about another machine's heap. The routes
// themselves are exercised for real, against a real filesystem, next door.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { Server } from "node:net";
import { PtyCoreLinkServer } from "@actana/core/pty-core-link-server";
import { generateCertMaterial } from "@actana/core/core-cert-material";
import { signBearer, verifyBearer } from "@actana/shared/core-link-bearer";
import { encodeRegistrationBlob } from "@actana/shared/registration-blob";
import type { PtyCore } from "@actana/core/pty-manager";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-core-files-stream-test-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const { closePanelDb, getPanelDb } = await import("../panel-db");
const { operatorSessionCookie } = await import("./_operator-session");
const { resetCoreLinkManagerForTests } = await import("../services/core-link-manager");
const { resetCoreFilesSendersForTests } = await import("../services/core-files-proxy");

const ORIGIN = "http://panel.example.test";
const BEARER_SECRET = "core-files-stream-test-secret-32-b";
const PROJECT_ID = "p-stream";

/**
 * What the Core saw, as it saw it.
 *
 * `firstChunkAt` and `bytes` are recorded from the socket's own `data` events,
 * so they answer "had any of this body reached the other machine yet?" — which
 * is the only question that separates a pipe from a buffer.
 */
type Sink = {
  bytes: number;
  chunks: number;
  firstChunkSeen: boolean;
  /** Resolves the moment the Core has read at least one byte of a body. */
  whenFirstChunkArrives(): Promise<void>;
  reset(): void;
};

function makeSink(): { sink: Sink; routes: { handle: (req: IncomingMessage, res: ServerResponse) => boolean; handleContinue: (req: IncomingMessage, res: ServerResponse) => boolean } } {
  let waiters: (() => void)[] = [];
  const sink: Sink = {
    bytes: 0,
    chunks: 0,
    firstChunkSeen: false,
    whenFirstChunkArrives() {
      if (sink.firstChunkSeen) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    reset() {
      sink.bytes = 0;
      sink.chunks = 0;
      sink.firstChunkSeen = false;
      waiters = [];
    },
  };

  const handle = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!req.url?.startsWith("/v1/")) return false;
    req.on("data", (chunk: Buffer) => {
      sink.bytes += chunk.byteLength;
      sink.chunks += 1;
      if (!sink.firstChunkSeen) {
        sink.firstChunkSeen = true;
        for (const resolve of waiters.splice(0)) resolve();
      }
      // Discarded on purpose: this stand-in is the far end of the pipe, not a
      // filesystem. Holding the chunks would make the *test* the thing that
      // buffers a gigabyte.
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(`${JSON.stringify({ type: "done", entries: 1, bytes: sink.bytes })}\n`);
    });
    return true;
  };
  return { sink, routes: { handle, handleContinue: handle } };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = new Server();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address && typeof address === "object") probe.close(() => resolve(address.port));
      else {
        probe.close();
        reject(new Error("no port"));
      }
    });
  });
}

function mockCore(): PtyCore {
  return {
    setEmitTarget: () => {},
    spawn: async () => ({ ptyId: "pty-1" }),
    write: () => true,
    resize: () => true,
    kill: () => true,
    killLaunchProcesses: async () => ({ ptyCount: 0, ports: [] }),
    killPtysUnderPath: async () => ({ ptyCount: 0 }),
    findByTask: () => ({ ptyId: null }),
    taskIdForPty: () => null,
    replay: () => ({ data: "", nextSeq: 0 }),
    killAll: () => {},
  } as unknown as PtyCore;
}

const running: PtyCoreLinkServer[] = [];
let sink: Sink;

async function pairSinkCore(): Promise<string> {
  const material = await generateCertMaterial({ host: "127.0.0.1" });
  const port = await freePort();
  const made = makeSink();
  sink = made.sink;
  const server = new PtyCoreLinkServer(mockCore(), {
    port,
    host: "127.0.0.1",
    tls: {
      caCert: material.ca.cert,
      serverCert: material.server.cert,
      serverKey: material.server.key,
    },
    authVerifier: (bearer) => verifyBearer(bearer, BEARER_SECRET),
    httpRoutes: made.routes,
  });
  running.push(server);

  const registrationBlob = encodeRegistrationBlob({
    endpoint: `wss://127.0.0.1:${port}`,
    label: "stream-vm",
    caCert: material.ca.cert,
    clientCert: material.client.cert,
    clientKey: material.client.key,
    bearer: signBearer({ coreId: "core_stream", exp: Date.now() + 600_000 }, BEARER_SECRET),
  });
  const added = await handleApiRequest(
    new Request(`${ORIGIN}/api/cores`, {
      method: "POST",
      headers: { cookie: operatorSessionCookie(), "content-type": "application/json" },
      body: JSON.stringify({ registrationBlob }),
    }),
  );
  const body = (await added!.json()) as { core: { id: string } };
  await vi.waitFor(
    async () => {
      const list = (await (
        await handleApiRequest(
          new Request(`${ORIGIN}/api/cores`, { headers: { cookie: operatorSessionCookie() } }),
        )
      )!.json()) as { cores: { id: string; dial: { state: string; files?: unknown } }[] };
      const core = list.cores.find((c) => c.id === body.core.id);
      expect(core?.dial.state).toBe("connected");
      expect(core?.dial.files).toEqual({ version: 1 });
    },
    { timeout: 15_000 },
  );
  return body.core.id;
}

/** A PUT whose body this test drives chunk by chunk. */
function putStreamed(
  coreId: string,
  filePath: string,
  body: ReadableStream<Uint8Array>,
): Promise<Response> {
  return handleApiRequest(
    new Request(
      `${ORIGIN}/api/cores/${coreId}/projects/${PROJECT_ID}/files?path=${encodeURIComponent(filePath)}`,
      {
        method: "PUT",
        headers: { cookie: operatorSessionCookie(), "content-type": "application/octet-stream" },
        body,
        // Mandatory for a stream body, and the same flag `bin/panel.mjs` sets
        // when it turns the operator's socket into a `Request`.
        duplex: "half",
      } as RequestInit,
    ),
  ) as Promise<Response>;
}

afterEach(() => {
  resetCoreLinkManagerForTests();
  resetCoreFilesSendersForTests();
  for (const server of running.splice(0)) server.close();
  const db = getPanelDb();
  db.prepare("DELETE FROM core_secrets").run();
  db.prepare("DELETE FROM cores").run();
});

afterAll(() => {
  closePanelDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("an upload crosses the Panel without stopping in it", () => {
  it("reaches the Core while the browser is still writing", async () => {
    const coreId = await pairSinkCore();

    // The body is opened but not finished. A buffering Panel is *defined* by
    // being unable to send anything until this stream closes.
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const chunk = new Uint8Array(64 * 1024).fill(7);

    const answer = putStreamed(coreId, "slow.bin", body);
    controller.enqueue(chunk);

    // No timeout, no sleep, no threshold: either the Core reads a byte while
    // this stream is open, or this promise never settles and the test times out
    // — which is exactly the failure a buffering proxy deserves.
    await sink.whenFirstChunkArrives();
    expect(sink.bytes).toBeGreaterThan(0);

    controller.enqueue(chunk);
    controller.close();
    const response = await answer;
    expect(response.status).toBe(200);
    expect(sink.bytes).toBe(chunk.byteLength * 2);
  }, 40_000);

  it("holds its memory flat across a body far bigger than it", async () => {
    const coreId = await pairSinkCore();

    // 1 GiB, generated a chunk at a time and never assembled. Small enough to
    // stay a unit test, large enough that buffering it is unmissable: the
    // ceiling below is 384 MiB of *growth*, so a Panel holding even a third of
    // this body fails.
    const CHUNK = 1024 * 1024;
    const CHUNKS = 1024;
    const CEILING = 384 * 1024 * 1024;

    let sent = 0;
    let peakRss = 0;
    const baselineRss = process.memoryUsage().rss;
    const sample = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 25);

    // One buffer, reused. A fresh allocation per chunk would make the *test*
    // the thing under memory pressure and would say nothing about the Panel.
    const filler = new Uint8Array(CHUNK).fill(0xab);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= CHUNKS) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(filler);
      },
    });

    const response = await putStreamed(coreId, "big.bin", body);
    // Drain the answer: the transfer is not over until the Core's progress
    // stream has been read, and an unread body would end the test early.
    await response.text();
    clearInterval(sample);

    expect(response.status).toBe(200);
    expect(sink.bytes).toBe(CHUNK * CHUNKS);
    expect(peakRss - baselineRss).toBeLessThan(CEILING);
  }, 180_000);
});
