// What happens when the client walks away mid-transfer (#165 F8).
//
// These are the cases the rest of the file suites do not reach, and the gap was
// not an oversight about *coverage* — it was an oversight about **which socket
// closes**. `core-files-routes.test.ts` has "releases the lease even when the
// transfer failed mid-stream", but that request completes normally and only its
// *content* is bad: the socket closes cleanly, the iterator throws, the
// `finally` runs. Nothing anywhere destroyed a request socket while the handler
// was suspended.
//
// It matters because `'drain'` is never emitted on a destroyed stream. A
// handler awaiting it and nothing else parks forever, and every `finally`
// between there and the top of the call stack — the one releasing the Project's
// write lease, the one closing a file handle — never runs. The lease is the bad
// one: it outlives the request, so a single aborted upload made the Project
// answer `409 transfer-in-progress` to every later write for the lifetime of
// the process. F8 asks for that refusal to be *immediate*; stranded, it is
// permanent.
//
// Backpressure is what makes it reachable, and it is ordinary rather than
// pathological: a folder upload's NDJSON progress stream passes the 16 KB
// high-water mark within about a hundred entries, so any client that reads its
// progress at the end rather than as it arrives gets there.
import * as fs from "node:fs";
import * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreFilesRequestHandler, type CoreFilesPort } from "../core-files-routes";
import { ProjectWriteLocks } from "../files-transfer-locks";
import { packDirectory } from "../files-tar";
import { cleanupTrees, collect, makeTree } from "./files-fixture";

let server: http.Server;
let base: string;
let projects: Record<string, string> = {};
let locks: ProjectWriteLocks;

const filesPort: CoreFilesPort = { projectRoot: (id) => projects[id] ?? null };

beforeEach(async () => {
  projects = {};
  locks = new ProjectWriteLocks();
  const routes = createCoreFilesRequestHandler({ filesPort, locks });
  server = http.createServer();
  server.on("request", (req, res) => {
    if (routes.handle(req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanupTrees();
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until a condition holds, or give up. Returns whether it held. */
async function eventually(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(10);
  }
  return predicate();
}

/**
 * A tar big enough that unpacking it backs the progress stream up.
 *
 * Long names on purpose: every entry is one NDJSON line carrying `path`, and
 * the point is to push the *response* past its high-water mark and the
 * loopback socket buffer, not to move a lot of file bytes. 900 entries of ~250
 * bytes is roughly 220 KB of progress for 9 KB of payload.
 */
async function backpressuringTar(): Promise<Buffer> {
  const entries: Record<string, string> = {};
  for (let i = 0; i < 900; i += 1) {
    const name = `deeply/nested/folder/with/a/long/enough/path/to/fatten/every/progress/line/entry-${String(i).padStart(4, "0")}.txt`;
    entries[name] = "x".repeat(10);
  }
  return await collect(packDirectory(makeTree(entries)));
}

/**
 * `PUT` a body and never read the response, then abort the socket.
 *
 * Not reading is the whole point — it is what backs the progress stream up and
 * parks the handler. `res.pause()` rather than merely not attaching a `data`
 * listener, so the intent survives someone later adding one for debugging.
 */
function abortableUpload(url: string, body: Buffer): { abort: () => void; responded: () => boolean } {
  let responded = false;
  const req = http.request(`${base}${url}`, {
    method: "PUT",
    headers: { "content-type": "application/x-tar", "content-length": String(body.length) },
    agent: false,
  });
  // The abort surfaces here as ECONNRESET. Expected, and not this test's subject.
  req.on("error", () => {});
  req.on("response", (res) => {
    responded = true;
    res.pause();
    res.on("error", () => {});
  });
  req.end(body);
  return { abort: () => req.destroy(), responded: () => responded };
}

describe("a client that hangs up mid-transfer", () => {
  it("releases the write lease when it aborts with the progress stream backpressured", async () => {
    projects.p1 = makeTree();
    const tar = await backpressuringTar();

    const upload = abortableUpload("/v1/projects/p1/files?path=drop", tar);

    // Wait for the handler to be genuinely in the middle of the transfer: the
    // lease taken, the 200 sent, and enough entries written that the response
    // has stopped accepting them.
    expect(await eventually(() => locks.current("p1") !== null)).toBe(true);
    expect(await eventually(() => upload.responded())).toBe(true);
    await delay(250);

    upload.abort();

    // The assertion the review asked for. Before the fix this stayed held for
    // the lifetime of the process, because the handler was parked inside
    // `writeLine` awaiting a `'drain'` that a destroyed socket never emits.
    expect(await eventually(() => locks.current("p1") === null)).toBe(true);
    expect(locks.current("p1")).toBeNull();
  });

  it("leaves the Project writable, rather than 409 for the lifetime of the process", async () => {
    projects.p1 = makeTree();
    const tar = await backpressuringTar();

    const upload = abortableUpload("/v1/projects/p1/files?path=drop", tar);
    expect(await eventually(() => locks.current("p1") !== null)).toBe(true);
    await delay(250);
    upload.abort();
    expect(await eventually(() => locks.current("p1") === null)).toBe(true);

    // The refusal F8 asks to be immediate must not have become permanent: a
    // later write to the same Project is served, not refused.
    const after = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        `${base}/v1/projects/p1/files?path=after.txt`,
        { method: "PUT", headers: { "content-type": "text/plain" }, agent: false },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("error", reject);
      req.end("written after an abort");
    });

    expect(after.status).toBe(200);
    expect(after.body).not.toContain("transfer-in-progress");
    expect(fs.readFileSync(`${projects.p1}/after.txt`, "utf8")).toBe("written after an abort");
  });

  // The read-side instance of the same root cause. `/proc/self/fd` is the only
  // honest way to see it — the server runs in this process, so a descriptor the
  // suspended `packDirectory` generator is holding is one of ours.
  //
  // Counted by *what the descriptor points at* rather than by how many there
  // are: a total count is noise (sockets the runtime has not reaped, lazily
  // opened modules) and it hid the leak when this test was first written, which
  // passed against the unfixed code. Descriptors resolving inside the Project
  // root are unambiguous — the only thing that opens those is the packer.
  //
  // A few large files rather than many small ones, so the abort lands *inside*
  // a file's read loop with its handle open, which is where the leak is. With
  // small files the packer is usually between them and there is nothing to leak.
  it.skipIf(process.platform !== "linux")("does not leak a file descriptor when a download is aborted", async () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < 6; i += 1) entries[`payload/chunk-${i}.bin`] = "y".repeat(4 * 1024 * 1024);
    projects.p1 = makeTree(entries);
    const root = projects.p1;

    const openUnderRoot = (): string[] =>
      fs
        .readdirSync("/proc/self/fd")
        .map((fd) => {
          try {
            return fs.readlinkSync(`/proc/self/fd/${fd}`);
          } catch {
            return "";
          }
        })
        .filter((target) => target.startsWith(`${root}/`));

    // The positive control, per review: both the precondition and the assertion
    // below expect `[]`, so if `openUnderRoot` ever stopped matching — a moved
    // Project root, a `/proc` shape change, a symlinked tmpdir — this test would
    // go vacuously green rather than red, which is the same failure mode as the
    // version that passed against the unfixed code. Sampling while a download is
    // genuinely in flight pins the instrument as well as the result: the packer
    // is parked inside a 4 MB file's read loop with its handle open, so a
    // counter that works sees it.
    let sawOneInFlight = false;

    const abortOneDownload = async (): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(`${base}/v1/projects/p1/files?path=payload`, { method: "GET", agent: false }, (res) => {
          res.pause();
          res.on("error", () => {});
          // Long enough for the server to fill the socket and park mid-file.
          const sampling = setInterval(() => {
            if (openUnderRoot().length > 0) sawOneInFlight = true;
          }, 25);
          setTimeout(() => {
            clearInterval(sampling);
            req.destroy();
            resolve();
          }, 300);
        });
        req.on("error", () => resolve());
        req.setTimeout(5000, () => reject(new Error("the download never started")));
        req.end();
      });
      await delay(200);
    };

    expect(openUnderRoot()).toEqual([]);
    for (let i = 0; i < 3; i += 1) await abortOneDownload();
    await delay(400);

    // Fails if the counter has gone blind, before the assertion that trusts it.
    expect(sawOneInFlight).toBe(true);

    // Before the fix each aborted download left one descriptor open on a file
    // in `payload/`, and they accumulated — the generator stayed suspended, so
    // its `finally { handle.close() }` never ran and garbage collection does
    // not run a suspended generator's `finally` either.
    expect(openUnderRoot()).toEqual([]);
  }, 20_000);
});
