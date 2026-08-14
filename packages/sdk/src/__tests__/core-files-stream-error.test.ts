// The failure that arrives as the stream's **last line**, not as a status code
// (#167).
//
// This is the path #216's review handed to this ticket. Its Core-side half is
// `core-files-routes.ts`, which answers a mid-transfer failure with
// `{"type":"error","code":"read-failed","message":…}` and then simply stops —
// no `done` line, and no chance of a `500`, because the `200` was spent on the
// first entry long before anything went wrong. So the whole burden of not
// losing that failure sits on the reader in this package.
//
// Three things can go wrong there and only one of them is loud:
//
//   1. the error line is read and thrown as `CoreFilesStreamError` — correct;
//   2. the error line is ignored and the generator ends — a **silent success**
//      on a transfer that did not happen, which is the worst outcome available
//      because the caller goes on to depend on files that are not there;
//   3. the reader waits for a `done` line that is never coming — a hang, which
//      an operator reads as a network problem.
//
// A test that only asserts "it throws" catches (2) and can be satisfied by (3)
// timing out somewhere else, so every case here runs under an explicit
// deadline: the rejection has to arrive, and it has to arrive *promptly*.
//
// **Over a real socket, with the response chunked**, because the property is
// about a body that arrives in pieces over time. The lines are written with a
// gap between them so the error genuinely follows entries the consumer has
// already seen, rather than landing in the same read as them.
import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { CoreClient } from "../core-client";
import { CoreFilesError, CoreFilesStreamError } from "../core-files-http";
import type { CoreFileEntry, CoreFileProgress } from "../core-files";
import { startCoreRig, type CoreRig } from "./fake-core-link";

let server: http.Server | null = null;
let client: CoreClient | null = null;
let coreRig: CoreRig | null = null;

afterEach(async () => {
  client?.close();
  client = null;
  coreRig?.close();
  coreRig = null;
  const running = server;
  server = null;
  if (running) {
    running.closeAllConnections();
    await new Promise<void>((resolve) => running.close(() => resolve()));
  }
});

/** The `entry` line the Core emits per file, in the shape the write route uses. */
function entryLine(path: string, result = "written"): string {
  return JSON.stringify({
    type: "entry",
    path,
    kind: "file",
    size: 4,
    mtime: 1_700_000_000,
    mode: 0o644,
    sha256: "a".repeat(64),
    result,
  });
}

/**
 * A Core that streams `lines` as NDJSON, one chunk each, then stops.
 *
 * Written raw rather than through the real handler because what is under test
 * is a Core that *died* — and a rig that could only produce well-formed streams
 * could not express the failure. Every shape here is one the Core's own code
 * can emit: `core-files-routes.ts:438` writes the `error` line and returns
 * without a `done`, and a process killed mid-`res.write` leaves a fragment.
 */
async function serveLines(lines: string[]): Promise<{ host: string; port: number }> {
  server = http.createServer((req, res) => {
    // The request body has to be drained or the upload's `PUT` never completes
    // and the test would be measuring the wrong stall.
    req.resume();
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
    let index = 0;
    const pump = (): void => {
      if (index >= lines.length) {
        res.end();
        return;
      }
      res.write(lines[index]);
      index += 1;
      // A gap between chunks, so an `error` line is genuinely *mid-stream*:
      // it reaches the reader after the entries before it were consumed, not
      // packed into the same TCP segment.
      setTimeout(pump, 5);
    };
    pump();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the rig did not bind a port");
  return { host: "127.0.0.1", port: address.port };
}

async function clientFor(where: { host: string; port: number }): Promise<CoreClient> {
  coreRig = startCoreRig({ announceFiles: true });
  client = new CoreClient({
    url: `ws://${where.host}:${where.port}`,
    createSocket: coreRig.dialer().createSocket,
  });
  await client.connect();
  return client;
}

/**
 * Whatever the work does, within `ms` — or a failure that names the hang.
 *
 * The difference between "threw" and "threw quickly" is the difference between
 * case (1) and case (3) above, and only this makes the suite able to tell them
 * apart rather than leaving it to the runner's own timeout.
 */
async function withDeadline<T>(work: Promise<T>, ms = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the reader hung: nothing settled within ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const source = async function* (): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode("body");
};

describe("an upload whose stream ends in an error line", () => {
  it("throws CoreFilesStreamError carrying the Core's own code and message", async () => {
    const core = await clientFor(
      await serveLines([
        `${entryLine("src/one.ts")}\n`,
        `${JSON.stringify({
          type: "error",
          code: "read-failed",
          message: "reading tree/two.ts failed part-way through: EIO",
        })}\n`,
        // …and then nothing. No `done` — this is the shape #216 flagged.
      ]),
    );

    const seen: CoreFileProgress[] = [];
    const error = await withDeadline(
      (async () => {
        try {
          for await (const line of core.project("proj_1").files.upload({
            path: "tree",
            kind: "tar",
            body: source(),
          })) {
            seen.push(line);
          }
          return null;
        } catch (err: unknown) {
          return err;
        }
      })(),
    );

    // Not a silent success: the failure reached the caller.
    expect(error).toBeInstanceOf(CoreFilesStreamError);
    // And reached it as *this module's* error, so a caller who wrote the one
    // `catch (e) { e instanceof CoreFilesError }` the surface documents does
    // not have to know that NDJSON was involved.
    expect(error).toBeInstanceOf(CoreFilesError);
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect((error as CoreFilesStreamError).name).toBe("CoreFilesStreamError");
    // The Core's own words, not the generic fallback: the machine-readable code
    // it chose and the prose that says which file and why. Replacing either
    // with "the write failed part-way through" would leave the operator with a
    // failure and no way to act on it.
    expect((error as CoreFilesStreamError).code).toBe("read-failed");
    expect((error as CoreFilesStreamError).message).toBe(
      "reading tree/two.ts failed part-way through: EIO",
    );

    // The progress before the failure is still progress, and was delivered.
    expect(seen.map((line) => line.type)).toEqual(["entry"]);
    expect(seen[0]).toMatchObject({ path: "src/one.ts", result: "written" });
    // Nothing claimed the transfer finished.
    expect(seen.some((line) => line.type === "done")).toBe(false);
  });

  it("falls back to write-failed when the Core names no code", async () => {
    const core = await clientFor(
      await serveLines([`${JSON.stringify({ type: "error" })}\n`]),
    );

    const error = await withDeadline(
      drainError(core.project("proj_1").files.upload({ path: "one.txt", body: source() })),
    );

    expect(error).toBeInstanceOf(CoreFilesStreamError);
    // An error line with nothing in it is still an error line — it must not
    // become a success on its way through the fallback.
    expect((error as CoreFilesStreamError).code).toBe("write-failed");
    expect((error as CoreFilesStreamError).message).toContain("part-way through");
  });
});

describe("a listing whose stream ends in an error line", () => {
  it("throws CoreFilesStreamError rather than ending the tree early", async () => {
    const core = await clientFor(
      await serveLines([
        `${JSON.stringify({ path: "src/one.ts", size: 1, mtime: 1, mode: 0o644, sha256: null })}\n`,
        `${JSON.stringify({
          type: "error",
          code: "read-failed",
          message: "the listing stopped at src/: EACCES",
        })}\n`,
      ]),
    );

    const seen: CoreFileEntry[] = [];
    const error = await withDeadline(
      (async () => {
        try {
          for await (const entry of core.project("proj_1").files.list()) seen.push(entry);
          return null;
        } catch (err: unknown) {
          return err;
        }
      })(),
    );

    // A truncated tree that ends cleanly is the failure mode that matters here:
    // a caller diffing against it would conclude the missing files were deleted.
    expect(error).toBeInstanceOf(CoreFilesStreamError);
    expect((error as CoreFilesStreamError).code).toBe("read-failed");
    expect((error as CoreFilesStreamError).message).toBe("the listing stopped at src/: EACCES");
    expect(seen.map((entry) => entry.path)).toEqual(["src/one.ts"]);
  });
});

describe("a stream cut mid-JSON", () => {
  // The reader's own comment anticipates this — "a stream that ended mid-write
  // may not have" a trailing newline — and the shape it names is a fragment of
  // a record, not a whole one. Parsing it unguarded threw a bare `SyntaxError`:
  // outside the module's taxonomy, no `code`, and a message about a character
  // offset. These pin it inside.
  it("surfaces as CoreFilesStreamError from an upload, not a raw SyntaxError", async () => {
    const core = await clientFor(
      await serveLines([`${entryLine("src/one.ts")}\n`, '{"type":"entry","path":"src/tw']),
    );

    const error = await withDeadline(
      drainError(
        core.project("proj_1").files.upload({ path: "tree", kind: "tar", body: source() }),
      ),
    );

    expect(error).toBeInstanceOf(CoreFilesStreamError);
    expect(error).toBeInstanceOf(CoreFilesError);
    // The specific regression: one `catch (e) { e instanceof CoreFilesError }`
    // has to be enough, and a `SyntaxError` walks straight through it.
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect((error as CoreFilesStreamError).code).toBe("read-failed");
    // The fragment itself is in the message — without it the operator is told
    // only that something was malformed, which is not enough to file a bug. It
    // is quoted rather than spliced in raw, so where it starts and stops is
    // unambiguous even when the fragment ends in whitespace.
    expect((error as CoreFilesStreamError).message).toContain(
      JSON.stringify('{"type":"entry","path":"src/tw'),
    );
    expect((error as CoreFilesStreamError).message).toContain("ended mid-line");
  });

  it("surfaces the same way from a listing", async () => {
    const core = await clientFor(await serveLines(['{"path":"src/one']));

    const error = await withDeadline(
      (async () => {
        try {
          for await (const _entry of core.project("proj_1").files.list()) void _entry;
          return null;
        } catch (err: unknown) {
          return err;
        }
      })(),
    );

    expect(error).toBeInstanceOf(CoreFilesStreamError);
    expect((error as CoreFilesStreamError).code).toBe("read-failed");
  });

  it("keeps a long fragment out of the error message", async () => {
    const fragment = `{"type":"entry","path":"${"deep/".repeat(80)}`;
    const core = await clientFor(await serveLines([fragment]));

    const error = (await withDeadline(
      drainError(core.project("proj_1").files.upload({ path: "tree", kind: "tar", body: source() })),
    )) as CoreFilesStreamError;

    expect(error).toBeInstanceOf(CoreFilesStreamError);
    // Enough to recognise, not the whole thing: an error message is read in a
    // terminal, and a truncated stream can leave a very large fragment behind.
    // No closing quote to match against: this fragment was cut, so the quoted
    // rendering in the message is cut too and ends in an ellipsis.
    expect(error.message).toContain(JSON.stringify('{"type":"entry","path":"deep/').slice(0, -1));
    expect(error.message).toContain("…");
    expect(error.message.length).toBeLessThan(400);
    // The tail was dropped, not merely wrapped.
    expect(error.message).not.toContain("deep/".repeat(40));
  });
});

describe("a stream that stops after entries, with neither done nor error", () => {
  // The residue named in #217's review, pinned rather than left to be
  // rediscovered. It is barely reachable — a Core that dies mid-response leaves
  // a chunked body without its terminating chunk, which undici surfaces as a
  // rejected `read()` rather than as a clean EOF, so getting here needs the
  // error-line write itself to have failed after a clean `res.end()`. The
  // reader completes normally, which is a silent success in the literal sense.
  //
  // This asserts today's behaviour so that changing it is a deliberate act with
  // a failing test attached, not an accident.
  it("completes without a done frame and without throwing", async () => {
    const core = await clientFor(
      await serveLines([`${entryLine("src/one.ts")}\n`, `${entryLine("src/two.ts")}\n`]),
    );

    const seen = await withDeadline(
      (async () => {
        const lines: CoreFileProgress[] = [];
        for await (const line of core.project("proj_1").files.upload({
          path: "tree",
          kind: "tar",
          body: source(),
        })) {
          lines.push(line);
        }
        return lines;
      })(),
    );

    expect(seen.map((line) => line.type)).toEqual(["entry", "entry"]);
    // The tell a caller has, and the reason `done` carries the totals: no
    // `done` line means no assurance the transfer finished.
    expect(seen.some((line) => line.type === "done")).toBe(false);
  });
});

describe("a stream that ends properly", () => {
  it("is left alone by all of the above", async () => {
    const core = await clientFor(
      await serveLines([
        `${entryLine("src/one.ts", "overwritten")}\n`,
        `${JSON.stringify({ type: "done", entries: 1, bytes: 4 })}\n`,
      ]),
    );

    const seen = await withDeadline(
      (async () => {
        const lines: CoreFileProgress[] = [];
        for await (const line of core.project("proj_1").files.upload({
          path: "src/one.ts",
          body: source(),
        })) {
          lines.push(line);
        }
        return lines;
      })(),
    );

    expect(seen).toEqual([
      {
        type: "entry",
        path: "src/one.ts",
        kind: "file",
        size: 4,
        mtime: 1_700_000_000,
        mode: 0o644,
        sha256: "a".repeat(64),
        result: "overwritten",
      },
      { type: "done", entries: 1, bytes: 4 },
    ]);
  });
});

/** Drain a progress stream and hand back whatever it threw, or `null`. */
async function drainError(progress: AsyncIterable<CoreFileProgress>): Promise<unknown> {
  try {
    for await (const _line of progress) void _line;
    return null;
  } catch (err: unknown) {
    return err;
  }
}
