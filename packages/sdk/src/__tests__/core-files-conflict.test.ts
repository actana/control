// The one-write-per-Project rule (F8), as it reaches a caller: **an error, and
// never a retry** (#167).
//
// The trap this suite exists to pin is not "does the Core refuse" — it does,
// and `files-transfer-locks.test.ts` proves it. It is what the *client* does
// with the refusal. A client that retried under the hood would turn the Core's
// immediate, well-worded 409 into a hang: the operator waits, sees nothing, and
// has lost both the reason and the chance to decide. That failure is silent,
// looks like a network problem, and is exactly the shape a well-meaning
// "resilient client" grows by accident.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { CoreClient } from "../core-client";
import { CoreFilesConflictError } from "../core-files-http";
import type { CoreFilesFetch } from "../core-files-http";
import type { CoreFileProgress } from "../core-files";
import { cleanupRoots, connectedClient, startFilesRig, type FilesRig } from "./files-rig";
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

async function drain(progress: AsyncIterable<CoreFileProgress>): Promise<CoreFileProgress[]> {
  const lines: CoreFileProgress[] = [];
  for await (const line of progress) lines.push(line);
  return lines;
}

describe("a second write while one is running", () => {
  it("is refused as a conflict, immediately, over a real socket", async () => {
    rig = await startFilesRig();
    const connected = await connectedClient(rig);
    client = connected.client;
    coreRig = connected.coreRig;
    const project = client.project(rig.projectId);

    // A body that has started but will not finish until this suite says so —
    // which is what holds the Project's write lease open.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = drain(
      project.files.upload({
        path: "slow.bin",
        body: (async function* () {
          yield new TextEncoder().encode("first");
          await held;
          yield new TextEncoder().encode("last");
        })(),
      }),
    );
    // The lease is taken before a byte is read and the file is opened right
    // after, so the file appearing is the signal that the Core is holding it.
    await vi.waitFor(() => expect(fs.existsSync(path.join(rig!.root, "slow.bin"))).toBe(true));

    const error = (await drain(
      project.files.upload({ path: "second.bin", body: chunk("nope") }),
    ).catch((err: unknown) => err)) as CoreFilesConflictError;

    expect(error).toBeInstanceOf(CoreFilesConflictError);
    expect(error.status).toBe(409);
    // The code, not the prose: a message is a sentence somebody will reword,
    // and this is the one refusal a client is guaranteed to be able to tell
    // apart from every other 4xx.
    expect(error.code).toBe("transfer-in-progress");
    // "Try again" is useless advice without which transfer and since when.
    expect(error.message).toContain("slow.bin");
    expect(error.message).toContain("one write at a time per Project");
    // Nothing was written for the loser — the refusal came off the status line,
    // not after the body had crossed.
    expect(fs.existsSync(path.join(rig.root, "second.bin"))).toBe(false);

    release();
    await slow;

    // And the lease is released with the request, so the conflict is never
    // permanent: the same write now succeeds.
    const after = await drain(project.files.upload({ path: "second.bin", body: chunk("yes") }));
    expect(after[0]).toMatchObject({ type: "entry", result: "written" });
  });

  it("makes exactly one request — there is no retry loop anywhere in the client", async () => {
    // Timing-free and unambiguous: a sender that answers 409 to everything.
    // A client with a retry loop — even a single-shot "try once more" — shows
    // up here as a second call, whatever its backoff, and no amount of waiting
    // changes the count.
    const sent: string[] = [];
    const alwaysConflicts: CoreFilesFetch = (req) => {
      sent.push(`${req.method} ${req.url}`);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            code: "transfer-in-progress",
            error: "another write transfer is already running on this Project",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      );
    };
    rig = await startFilesRig();
    coreRig = startCoreRig({ announceFiles: true });
    client = new CoreClient({
      url: `ws://${rig.host}:${rig.port}`,
      createSocket: coreRig.dialer().createSocket,
      filesFetch: alwaysConflicts,
    });
    await client.connect();

    await expect(
      drain(client.project(rig.projectId).files.upload({ path: "a.bin", body: chunk("a") })),
    ).rejects.toBeInstanceOf(CoreFilesConflictError);

    expect(sent).toHaveLength(1);
  });

  it("does not retry a read either, though reads are concurrent and could be retried harmlessly", async () => {
    // Deliberate: the rule is that this package does not retry, full stop.
    // A surface that retried reads "because they are safe" is one where the
    // next contributor cannot tell which calls have hidden attempts behind
    // them, and where a 404 for a path that never existed costs three round
    // trips before it is reported.
    const sent: string[] = [];
    const missing: CoreFilesFetch = (req) => {
      sent.push(req.url);
      return Promise.resolve(
        new Response(JSON.stringify({ code: "not-found", error: "no such path" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    rig = await startFilesRig();
    coreRig = startCoreRig({ announceFiles: true });
    client = new CoreClient({
      url: `ws://${rig.host}:${rig.port}`,
      createSocket: coreRig.dialer().createSocket,
      filesFetch: missing,
    });
    await client.connect();

    await expect(
      client.project(rig.projectId).files.download({ path: "gone.txt" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(sent).toHaveLength(1);
  });
});

describe("a file write onto a non-empty directory", () => {
  it("is the other conflict, and is told apart by its code", async () => {
    rig = await startFilesRig({ seed: { "src/a.txt": "a" } });
    const connected = await connectedClient(rig);
    client = connected.client;
    coreRig = connected.coreRig;

    const error = (await drain(
      client.project(rig.projectId).files.upload({ path: "src", body: chunk("oops") }),
    ).catch((err: unknown) => err)) as CoreFilesConflictError;

    expect(error).toBeInstanceOf(CoreFilesConflictError);
    expect(error.status).toBe(409);
    expect(error.code).toBe("directory-in-the-way");
    // Retrying this one would never succeed — it will still be a directory —
    // which is the second half of why 409 is an error here and not a signal to
    // wait and try again.
    expect(fs.readFileSync(path.join(rig.root, "src", "a.txt"), "utf8")).toBe("a");
  });
});

function chunk(content: string): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield new TextEncoder().encode(content);
  })();
}
