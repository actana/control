// Backpressure: **nothing here runs ahead of its consumer** (#167).
//
// This is the trap the ticket names, and it is worth being precise about why it
// matters, because an implementation that gets it wrong passes every other test
// in this directory. An async iterable that eagerly drains its source still
// yields the right values in the right order — it has simply read all of them
// into memory first. The streaming is then decorative: a caller writing each
// chunk to a slow disk, or posting each progress line to a webhook, has the
// whole transfer resident while it works through item one. On a gigabyte, that
// is the difference between a constant footprint and an OOM.
//
// So these tests assert on **how much the producer did**, not on what the
// consumer received. A slow consumer that receives correct values from an
// eager producer is the bug.
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { CoreClient } from "../core-client";
import type { CoreFilesFetch } from "../core-files-http";
import { cleanupRoots, connectedClient, startFilesRig, writeTree, type FilesRig } from "./files-rig";
import { startCoreRig, type CoreRig } from "./fake-core-link";

let rig: FilesRig | null = null;
let client: CoreClient | null = null;
let coreRig: CoreRig | null = null;

afterEach(async () => {
  client?.close();
  client = null;
  coreRig?.close();
  coreRig = null;
  await rig?.close();
  rig = null;
});

afterAll(() => cleanupRoots());

/** Yield to the event loop, the way a consumer doing real work would. */
const dawdle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

/**
 * A client whose file requests are answered by `send`, with no socket in the
 * way — so a test can watch exactly how much of a stream was produced.
 */
async function clientWith(send: CoreFilesFetch): Promise<CoreClient> {
  rig = await startFilesRig();
  coreRig = startCoreRig({ announceFiles: true });
  client = new CoreClient({
    url: `ws://${rig.host}:${rig.port}`,
    createSocket: coreRig.dialer().createSocket,
    filesFetch: send,
  });
  await client.connect();
  return client;
}

/**
 * A response body of `count` NDJSON lines, one per chunk, that **records how
 * many were asked for**.
 *
 * `pull` is called by the stream only when its queue has room, so `produced` is
 * a direct measure of how far ahead the reader ran.
 */
function countingBody(
  count: number,
  line: (index: number) => unknown,
): { body: ReadableStream<Uint8Array>; produced: () => number } {
  let produced = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (produced >= count) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(`${JSON.stringify(line(produced))}\n`));
      produced += 1;
    },
  });
  return { body, produced: () => produced };
}

describe("a slow consumer sets the pace", () => {
  it("holds an upload's progress stream back rather than draining it", async () => {
    const TOTAL = 500;
    const { body, produced } = countingBody(TOTAL, (index) => ({
      type: "entry",
      path: `file-${index}.txt`,
      kind: "file",
      size: 1,
      mtime: 1,
      mode: 0o644,
      sha256: "x",
      result: "written",
    }));
    const core = await clientWith(() =>
      Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } }),
      ),
    );

    let consumed = 0;
    for await (const _line of core.project(rig!.projectId).files.upload({
      path: "tree",
      kind: "tar",
      body: (async function* () {
        yield new TextEncoder().encode("tar");
      })(),
    })) {
      consumed += 1;
      await dawdle();
      if (consumed === 5) break;
    }

    // Five lines read, five-ish lines produced. The stream's own queue is
    // allowed one in hand — that is what a high-water mark of one means — but
    // 500 would mean the reader had raced to the end of the response while the
    // consumer was on line one, which is the failure this whole file is about.
    expect(consumed).toBe(5);
    expect(produced()).toBeLessThanOrEqual(consumed + 2);
    expect(produced()).toBeLessThan(TOTAL);
  });

  it("holds a listing back the same way", async () => {
    const TOTAL = 400;
    const { body, produced } = countingBody(TOTAL, (index) => ({
      path: `src/file-${index}.ts`,
      size: 10,
      mtime: 1,
      mode: 0o644,
      sha256: "abc",
    }));
    const core = await clientWith(() =>
      Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } }),
      ),
    );

    let consumed = 0;
    for await (const _entry of core.project(rig!.projectId).files.list()) {
      consumed += 1;
      await dawdle();
      if (consumed === 4) break;
    }

    expect(produced()).toBeLessThanOrEqual(consumed + 2);
    expect(produced()).toBeLessThan(TOTAL);
  });

  it("reads an upload's body one chunk at a time, rather than racing it off the disk", async () => {
    // The same property on the way out. A source that was drained eagerly would
    // put the caller's whole file in memory before the socket had taken any of
    // it — which is the upload half of the gigabyte claim.
    const TOTAL = 1000;
    let produced = 0;
    const source = (async function* () {
      for (let index = 0; index < TOTAL; index += 1) {
        produced += 1;
        yield new TextEncoder().encode(`chunk-${index}`);
      }
    })();

    const core = await clientWith(async (req) => {
      // A sender that takes three chunks and stops — a stalled network, or a
      // Core that refused part-way through.
      const reader = req.body!.getReader();
      for (let i = 0; i < 3; i += 1) {
        await reader.read();
        await dawdle();
      }
      await reader.cancel();
      return new Response('{"type":"done","entries":0,"bytes":0}\n', { status: 200 });
    });

    const progress = core.project(rig!.projectId).files.upload({ path: "big.bin", body: source });
    for await (const _line of progress) break;

    expect(produced).toBeLessThanOrEqual(5);
    expect(produced).toBeLessThan(TOTAL);
  });

  it("closes the source stream when the consumer walks away", async () => {
    // A caller that breaks out of the loop must not leave the generator — and
    // in the real world, the file handle behind it — open for the life of the
    // process.
    let closed = false;
    const source = (async function* () {
      try {
        for (;;) yield new TextEncoder().encode("x");
      } finally {
        closed = true;
      }
    })();
    const core = await clientWith(async (req) => {
      const reader = req.body!.getReader();
      await reader.read();
      await reader.cancel();
      return new Response('{"type":"done","entries":0,"bytes":0}\n', { status: 200 });
    });

    for await (const _line of core.project(rig!.projectId).files.upload({
      path: "abandoned.bin",
      body: source,
    })) {
      break;
    }

    expect(closed).toBe(true);
  });
});

describe("over a real socket, the whole chain backpressures", () => {
  it("stops the Core mid-unpack while the consumer dawdles over its progress", async () => {
    // The end-to-end version of the property, with a kernel in the path: a slow
    // reader here becomes a full socket buffer, which becomes a `res.write`
    // returning false on the Core, which parks its unpack loop in `drained`.
    // If any link in that chain buffered instead, the Core would run to
    // completion regardless of how slowly this consumer read.
    const ENTRIES = 400;
    rig = await startFilesRig();
    const connected = await connectedClient(rig);
    client = connected.client;
    coreRig = connected.coreRig;

    const source = fs.mkdtempSync(`${rig.root}-src-`);
    const seed: Record<string, string> = {};
    for (let index = 0; index < ENTRIES; index += 1) seed[`file-${index}.txt`] = `body-${index}`;
    writeTree(source, seed);
    const { packDirectory } = await import("@actana/core/files-tar");

    let consumed = 0;
    const progress = client.project(rig.projectId).files.upload({
      path: "tree",
      kind: "tar",
      body: packDirectory(source),
    });
    for await (const _line of progress) {
      consumed += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (consumed === 3) break;
    }

    const written = fs.readdirSync(`${rig.root}/tree`).length;
    fs.rmSync(source, { recursive: true, force: true });

    // Generous on purpose — the socket, the kernel and undici each hold some
    // number of lines, and pinning an exact figure would make this a test of
    // buffer sizes on one machine. What it refuses is the unbounded case: the
    // Core finishing all 400 while this consumer had read three.
    expect(written).toBeLessThan(ENTRIES);
  });
});
