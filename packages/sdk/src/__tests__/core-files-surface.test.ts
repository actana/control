// `project.files.list / upload / download` against a real Core file surface
// (#167, F12).
//
// Every assertion here goes over a real loopback socket to the Core's own route
// handler, writing to a real directory — see `files-rig.ts` for why a fake
// would prove nothing this ticket cares about.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { packDirectory } from "@actana/core/files-tar";
import {
  CoreFilesRequestError,
  CoreFilesUnavailableError,
} from "../core-files-http";
import type { CoreFileProgress } from "../core-files";
import type { CoreClient } from "../core-client";
import {
  cleanupRoots,
  collect,
  connectedClient,
  startFilesRig,
  writeTree,
  type FilesRig,
} from "./files-rig";

let rig: FilesRig | null = null;
let client: CoreClient | null = null;
let closeRig: (() => void) | null = null;

afterEach(async () => {
  client?.close();
  client = null;
  closeRig?.();
  closeRig = null;
  await rig?.close();
  rig = null;
});

afterAll(() => cleanupRoots());

async function open(opts: Parameters<typeof startFilesRig>[0] = {}): Promise<CoreClient> {
  rig = await startFilesRig(opts);
  const connected = await connectedClient(rig);
  client = connected.client;
  closeRig = () => connected.coreRig.close();
  return connected.client;
}

/** Drain an upload's progress into an array — most assertions are about the whole run. */
async function drain(progress: AsyncIterable<CoreFileProgress>): Promise<CoreFileProgress[]> {
  const lines: CoreFileProgress[] = [];
  for await (const line of progress) lines.push(line);
  return lines;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("upload", () => {
  it("takes a stream and reports each entry as NDJSON progress", async () => {
    const core = await open();
    const project = core.project(rig!.projectId);

    const lines = await drain(
      project.files.upload({
        path: "notes.txt",
        // An async iterable of chunks — which is what a Node `Readable` is, so
        // `fs.createReadStream(…)` is accepted by the same signature with no
        // conversion and no `node:stream` import in the shipped package.
        body: (async function* () {
          yield new TextEncoder().encode("hello ");
          yield new TextEncoder().encode("world");
        })(),
      }),
    );

    expect(lines).toEqual([
      {
        type: "entry",
        path: "notes.txt",
        kind: "file",
        size: 11,
        mtime: expect.any(Number),
        mode: 0o644,
        sha256: sha256("hello world"),
        result: "written",
      },
      { type: "done", entries: 1, bytes: 11 },
    ]);
    expect(fs.readFileSync(path.join(rig!.root, "notes.txt"), "utf8")).toBe("hello world");
  });

  it("names an overwrite as `overwritten` rather than leaving it to be inferred", async () => {
    const core = await open({ seed: { "notes.txt": "old" } });
    const project = core.project(rig!.projectId);

    const lines = await drain(
      project.files.upload({ path: "notes.txt", body: oneChunk("new") }),
    );

    // The done-when names this field by name: *every* overwrite is reported.
    // A caller diffing a tree before uploading it is the case that matters, and
    // "it existed" is not recoverable from anything else in the line.
    expect(lines[0]).toMatchObject({ type: "entry", result: "overwritten", path: "notes.txt" });
    expect(fs.readFileSync(path.join(rig!.root, "notes.txt"), "utf8")).toBe("new");
  });

  it("reports every entry of a folder upload, overwrites included", async () => {
    const core = await open({ seed: { "vendor/keep.txt": "existing", "vendor/dir/": "" } });
    const source = fs.mkdtempSync(path.join(rig!.root, "..", "src-"));
    writeTree(source, { "keep.txt": "replaced", "new.txt": "fresh", "deep/nested.txt": "down" });

    const project = core.project(rig!.projectId);
    const lines = await drain(
      // A folder crosses as one streamed tar (ADR 0029). The SDK does not build
      // it — packing lives on the side with the files — so the caller hands in
      // a tar stream and says so, which is exactly what this does.
      project.files.upload({ path: "vendor", kind: "tar", body: packDirectory(source) }),
    );
    fs.rmSync(source, { recursive: true, force: true });

    const entries = lines.filter((line) => line.type === "entry");
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    expect(byPath.get("vendor/keep.txt")).toMatchObject({ result: "overwritten" });
    expect(byPath.get("vendor/new.txt")).toMatchObject({ result: "written" });
    expect(byPath.get("vendor/deep/nested.txt")).toMatchObject({ result: "written" });
    // Project-relative, not relative to the folder unpacked into — the string
    // that goes straight back to `download`.
    for (const entry of entries) expect(entry.path.startsWith("vendor/")).toBe(true);
    expect(lines.at(-1)).toMatchObject({ type: "done" });
  });

  it("carries the executable bit and the mtime across", async () => {
    const core = await open();
    const project = core.project(rig!.projectId);
    const mtime = 1_700_000_000_000;

    const lines = await drain(
      project.files.upload({ path: "run.sh", body: oneChunk("#!/bin/sh\n"), mode: 0o755, mtime }),
    );

    expect(lines[0]).toMatchObject({ mode: 0o755, mtime });
    expect(fs.statSync(path.join(rig!.root, "run.sh")).mode & 0o777).toBe(0o755);
  });

  it("refuses a path that leaves the Project, and writes nothing", async () => {
    const core = await open();
    const project = core.project(rig!.projectId);

    await expect(
      drain(project.files.upload({ path: "../escape.txt", body: oneChunk("nope") })),
    ).rejects.toThrow(CoreFilesRequestError);
    expect(fs.existsSync(path.join(rig!.root, "..", "escape.txt"))).toBe(false);
  });

  it("sends nothing until the iterable is consumed", async () => {
    const core = await open();
    const project = core.project(rig!.projectId);

    const progress = project.files.upload({ path: "lazy.txt", body: oneChunk("x") });
    // Constructed, not started. This is the property that makes a progress
    // stream honest: nothing is buffered on the caller's behalf, so nothing has
    // happened yet either.
    expect(rig!.requests).toHaveLength(0);

    await drain(progress);
    expect(rig!.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  });
});

describe("download", () => {
  it("returns a stream and the metadata the Core already had", async () => {
    const core = await open({ seed: { "notes.txt": { content: "hello world", mode: 0o600 } } });
    const project = core.project(rig!.projectId);

    const file = await project.files.download({ path: "notes.txt" });

    expect(file.kind).toBe("file");
    expect(file.size).toBe(11);
    expect(file.mode).toBe(0o600);
    expect(file.mtime).toEqual(expect.any(Number));
    // A `ReadableStream`, and nothing on the result that hands over bytes
    // without one — see `core-files-streaming.test.ts` for the claim this
    // shape exists to keep.
    expect(typeof file.stream.getReader).toBe("function");
    expect((await collect(file.stream)).toString("utf8")).toBe("hello world");
  });

  it("hands a folder back as one streamed tar", async () => {
    const core = await open({ seed: { "src/a.txt": "a", "src/b.txt": "b" } });
    const project = core.project(rig!.projectId);

    const folder = await project.files.download({ path: "src" });

    expect(folder.kind).toBe("tar");
    const tar = await collect(folder.stream);
    // Not unpacked here — that is the Core's job and its own suite's. What
    // matters at this level is that a folder arrives as an archive rather than
    // as a refusal, and that the bytes are a tar.
    expect(tar.length).toBeGreaterThan(0);
    expect(tar.subarray(257, 262).toString("utf8")).toBe("ustar");
  });

  it("refuses a path that is not there, with the Core's own code", async () => {
    const core = await open();
    const project = core.project(rig!.projectId);

    await expect(project.files.download({ path: "missing.txt" })).rejects.toMatchObject({
      name: "CoreFilesRequestError",
      status: 404,
      code: "not-found",
    });
  });

  it("refuses an unknown Project by name", async () => {
    const core = await open();

    await expect(core.project("proj_nope").files.download({ path: "a" })).rejects.toMatchObject({
      status: 404,
      code: "project-not-found",
    });
  });
});

describe("list", () => {
  beforeEach(() => {
    // Every assertion in this block reads the #166 stand-in described in
    // `files-rig.ts`: the manifest shape PR 215 established, served in process.
    // The reader is what #167 owns; the route is #166's.
  });

  it("is an async iterable over the tree, in the manifest shape", async () => {
    const core = await open({
      listing: true,
      seed: { "a.txt": "aaa", "src/b.txt": "bb", "src/deep/c.txt": "c" },
    });
    const project = core.project(rig!.projectId);

    const entries = [];
    for await (const entry of project.files.list()) entries.push(entry);

    expect(entries.map((entry) => entry.path)).toEqual([
      "a.txt",
      "src",
      "src/b.txt",
      "src/deep",
      "src/deep/c.txt",
    ]);
    expect(entries[0]).toEqual({
      path: "a.txt",
      kind: "file",
      size: 3,
      mtime: expect.any(Number),
      mode: expect.any(Number),
      sha256: sha256("aaa"),
    });
  });

  it("lists a subtree to a depth", async () => {
    const core = await open({
      listing: true,
      seed: { "a.txt": "a", "src/b.txt": "b", "src/deep/c.txt": "c" },
    });
    const project = core.project(rig!.projectId);

    const entries = [];
    for await (const entry of project.files.list({ path: "src", depth: 1 })) entries.push(entry);

    expect(entries.map((entry) => entry.path)).toEqual(["src/b.txt", "src/deep"]);
  });

  it("sends nothing until the iterable is consumed", async () => {
    const core = await open({ listing: true, seed: { "a.txt": "a" } });
    const project = core.project(rig!.projectId);

    const listing = project.files.list();
    expect(rig!.requests).toHaveLength(0);

    await listing.next();
    expect(rig!.requests).toHaveLength(1);
    await listing.return(undefined);
  });
});

describe("the gate", () => {
  it("is checked on every call, so a handle taken while connected stops working when the link drops", async () => {
    const core = await open({ seed: { "a.txt": "a" } });
    const project = core.project(rig!.projectId);
    expect((await project.files.download({ path: "a.txt" })).size).toBe(1);

    core.close();

    // Not a stale `true` remembered from construction: the capability belongs
    // to the *current* connection, and there is not one.
    await expect(project.files.download({ path: "a.txt" })).rejects.toThrow(
      CoreFilesUnavailableError,
    );
  });
});

function oneChunk(content: string): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield new TextEncoder().encode(content);
  })();
}
