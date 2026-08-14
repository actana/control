// The walk behind the listing route (#166 F7, the manifest half of F10).
//
// Against a real filesystem, like every other suite in this ticket's family:
// what a symlink is, what a directory handle costs, whether an unreadable
// folder is an error or a fact are all properties of the operating system, and
// a mocked `fs` would let each of them pass while a Core did the wrong thing on
// a machine.
//
// The route's own concerns — status codes, NDJSON framing, confinement — are
// `core-files-listing-routes.test.ts` and `files-listing-confinement.test.ts`.
// This file is about the walk itself.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listTree, type FileListingLine } from "../files-listing";
import { cleanupTrees, makeTree } from "./files-fixture";

afterEach(() => {
  cleanupTrees();
});

async function lines(root: string, base = "", options = {}): Promise<FileListingLine[]> {
  const out: FileListingLine[] = [];
  for await (const line of listTree(path.join(root, base), base, options)) out.push(line);
  return out;
}

/** Just the entry paths, sorted — the walk's order is the filesystem's. */
async function paths(root: string, base = "", options = {}): Promise<string[]> {
  return (await lines(root, base, options))
    .filter((line) => line.type === "entry")
    .map((line) => line.path)
    .sort();
}

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("what a listing contains", () => {
  it("lists a tree to arbitrary depth by default", async () => {
    const root = makeTree({
      "a.txt": "a",
      "src/index.ts": "x",
      "src/deep/deeper/deepest/leaf.txt": "l",
    });

    expect(await paths(root)).toEqual([
      "a.txt",
      "src",
      "src/deep",
      "src/deep/deeper",
      "src/deep/deeper/deepest",
      "src/deep/deeper/deepest/leaf.txt",
      "src/index.ts",
    ]);
  });

  it("carries the five fields #129 F10 fixes, in the units the tar manifest uses", async () => {
    const root = makeTree({ "run.sh": { content: "#!/bin/sh\n", mode: 0o755 } });
    const stats = fs.statSync(path.join(root, "run.sh"));

    const [entry] = await lines(root);

    expect(entry).toEqual({
      type: "entry",
      path: "run.sh",
      kind: "file",
      size: 10,
      mtime: Math.floor(stats.mtimeMs),
      mode: 0o755,
      sha256: null,
    });
  });

  it("reports a directory with no size and no digest, because it has no bytes", async () => {
    const root = makeTree({ "empty/": "" });

    const [entry] = await lines(root, "", { sha256: true });

    expect(entry).toMatchObject({ type: "entry", path: "empty", kind: "directory", size: 0, sha256: null });
  });

  it("lists a single file when the listed path is one, rather than refusing it", async () => {
    // The cheapest `stat` this surface can offer, and it falls out of the walk
    // rather than being a fourth route.
    const root = makeTree({ "notes/todo.md": "hello" });

    expect(await lines(root, "notes/todo.md")).toEqual([
      expect.objectContaining({ type: "entry", path: "notes/todo.md", kind: "file", size: 5 }),
    ]);
  });

  it("prefixes every path with the subtree that was listed, so it reads back to GET", async () => {
    const root = makeTree({ "src/lib/util.ts": "u" });

    expect(await paths(root, "src")).toEqual(["src/lib", "src/lib/util.ts"]);
  });

  it("skips sockets, fifos and device nodes silently, exactly as the tar packer does", async () => {
    const root = makeTree({ "a.txt": "a" });
    // A fifo is the one of the three a test can make without privileges, and
    // `mkfifo(1)` is the only way to make one from Node.
    execFileSync("mkfifo", [path.join(root, "pipe")]);

    // Not a `skipped` line either: a `.sock` left by a dev server is not
    // something an operator can act on, and one line per socket would be noise
    // in every listing of a Project with one running.
    expect(await lines(root)).toEqual([expect.objectContaining({ path: "a.txt" })]);
  });
});

describe("depth", () => {
  const tree = { "top.txt": "t", "one/mid.txt": "m", "one/two/leaf.txt": "l", "one/two/three/deep.txt": "d" };

  it("bounds the walk to the immediate children at depth 1", async () => {
    const root = makeTree(tree);

    expect(await paths(root, "", { depth: 1 })).toEqual(["one", "top.txt"]);
  });

  it("takes one more level at depth 2", async () => {
    const root = makeTree(tree);

    expect(await paths(root, "", { depth: 2 })).toEqual(["one", "one/mid.txt", "one/two", "top.txt"]);
  });

  it("still reports the directory it stopped at, so a client knows there is more to ask for", async () => {
    const root = makeTree(tree);

    // `one/two` is present at depth 2 and its contents are not — which is what
    // lets a Panel draw a closed folder rather than an empty one.
    const listed = await paths(root, "", { depth: 2 });
    expect(listed).toContain("one/two");
    expect(listed).not.toContain("one/two/leaf.txt");
  });
});

describe("sha256 — available on request, not free (ADR 0027 D6)", () => {
  it("is null for every entry when it was not asked for", async () => {
    const root = makeTree({ "a.txt": "a", "src/b.txt": "b" });

    for (const line of await lines(root)) {
      if (line.type === "entry") expect(line.sha256).toBeNull();
    }
  });

  it("digests a file's bytes when it was", async () => {
    const root = makeTree({ "a.txt": "hello" });

    const [entry] = await lines(root, "", { sha256: true });

    expect(entry).toMatchObject({
      sha256: createHash("sha256").update("hello").digest("hex"),
    });
  });

  it("digests a symlink's target string, which is the answer the tar manifest gives for one", async () => {
    const root = makeTree({ "a.txt": "hello" });
    fs.symlinkSync("a.txt", path.join(root, "link"));

    const link = (await lines(root, "", { sha256: true })).find(
      (line) => line.type === "entry" && line.kind === "symlink",
    );

    expect(link).toMatchObject({
      size: "a.txt".length,
      sha256: createHash("sha256").update("a.txt").digest("hex"),
    });
  });

  it("reads a file in chunks rather than materialising it, so a large one costs no memory", async () => {
    // 24 MB is well past any buffer this code could plausibly hold, and the
    // digest below is only correct if every byte reached the hash.
    const root = makeTree();
    const block = Buffer.alloc(1024 * 1024, 0x61);
    const handle = fs.openSync(path.join(root, "big.bin"), "w");
    for (let i = 0; i < 24; i += 1) fs.writeSync(handle, block);
    fs.closeSync(handle);

    const [entry] = await lines(root, "", { sha256: true });

    const expected = createHash("sha256");
    for (let i = 0; i < 24; i += 1) expected.update(block);
    expect(entry).toMatchObject({ size: 24 * 1024 * 1024, sha256: expected.digest("hex") });
  });

  it.skipIf(isRoot)("reports an unreadable file as skipped rather than as an entry with a null digest", async () => {
    // The ambiguity this avoids is the point: a client that asked for digests
    // and got a null cannot tell "could not read it" from "nobody computed it",
    // and a diff endpoint reads the second as unchanged.
    const root = makeTree({ "secret.txt": { content: "s", mode: 0o000 } });

    const [line] = await lines(root, "", { sha256: true });

    expect(line).toEqual({
      type: "skipped",
      path: "secret.txt",
      code: "unreadable-file",
      message: expect.stringContaining("EACCES"),
    });
  });

  it.skipIf(isRoot)("lists that same file normally when no digest was asked for, because lstat still answers", async () => {
    const root = makeTree({ "secret.txt": { content: "s", mode: 0o000 } });

    expect(await lines(root)).toEqual([
      expect.objectContaining({ type: "entry", path: "secret.txt", kind: "file", mode: 0o000 }),
    ]);
  });
});

describe("symlinks are reported and never followed", () => {
  it("lists a link to a directory as one entry and does not walk through it", async () => {
    const root = makeTree({ "real/inside.txt": "i" });
    fs.symlinkSync("real", path.join(root, "alias"));

    const listed = await paths(root);

    expect(listed).toEqual(["alias", "real", "real/inside.txt"]);
    // The file exists at `alias/inside.txt` too, as far as the OS is concerned.
    // It is not in the listing, because walking through the link would report
    // the same bytes twice under two names — and, when the link leaves the
    // Project, would report bytes that are not the Project's at all.
    expect(listed).not.toContain("alias/inside.txt");
  });

  it("does not hang on a link that points at itself", async () => {
    const root = makeTree({ "a.txt": "a" });
    fs.symlinkSync(path.join(root, "loop"), path.join(root, "loop"));

    expect(await paths(root)).toEqual(["a.txt", "loop"]);
  });

  it("does not hang on a link to the directory holding it", async () => {
    const root = makeTree({ "nested/a.txt": "a" });
    fs.symlinkSync(path.join(root, "nested"), path.join(root, "nested", "self"));

    expect(await paths(root)).toEqual(["nested", "nested/a.txt", "nested/self"]);
  });
});

describe("what fails deeper in the tree is a fact about that path, not the end of the listing", () => {
  it.skipIf(isRoot)("reports an unreadable directory as skipped and keeps walking its siblings", async () => {
    const root = makeTree({ "locked/hidden.txt": "h", "open/visible.txt": "v", "top.txt": "t" });
    fs.chmodSync(path.join(root, "locked"), 0o000);
    try {
      const listed = await lines(root);

      expect(listed).toContainEqual({
        type: "skipped",
        path: "locked",
        code: "unreadable-directory",
        message: expect.stringContaining("EACCES"),
      });
      // The directory itself is still an entry — `lstat` from the parent
      // answered — and the rest of the tree is still listed.
      expect(listed.filter((l) => l.type === "entry").map((l) => l.path).sort()).toEqual([
        "locked",
        "open",
        "open/visible.txt",
        "top.txt",
      ]);
    } finally {
      fs.chmodSync(path.join(root, "locked"), 0o755);
    }
  });

  it("throws for the listed path itself, so the caller can still answer with a status code", async () => {
    const root = makeTree();

    await expect(lines(root, "nope")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("the walk holds the tree nowhere", () => {
  // The claim #166 makes — "listing a large tree does not buffer it in memory
  // on either side" — has two halves. The route's half (nothing is assembled
  // before it is sent) is in the route suite. This is the walk's half: what it
  // holds while it is running, and what it lets go of when it is abandoned.

  it("yields the first entry without having walked the rest", async () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < 2000; i += 1) entries[`dir-${i}/file.txt`] = "x";
    const root = makeTree(entries);

    const walk = listTree(root, "");
    const first = await walk.next();
    await walk.return(undefined);

    expect(first.done).toBe(false);
    // 4000 entries exist. One was produced, which is only possible if the walk
    // is a stream rather than a list handed back at the end.
    expect(first.value).toMatchObject({ type: "entry" });
  });

  // Directory handles are the resource a lazy walk can leak: it is suspended
  // inside a `for await` over an open `fs.Dir` on every level of the path it
  // has reached. `/proc/self/fd` is the honest way to look, and it works
  // because the walk runs in this process.
  it.skipIf(process.platform !== "linux")("closes every directory handle when it is abandoned part-way", async () => {
    const root = makeTree({ "one/two/three/four/leaf.txt": "l", "one/two/three/four/other.txt": "o" });

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
        .filter((target) => target === root || target.startsWith(`${root}/`));

    expect(openUnderRoot()).toEqual([]);

    const walk = listTree(root, "");
    // Deep enough that the walk is suspended several directories down, each
    // with its own open handle.
    let sawSomethingOpen = false;
    for (let i = 0; i < 5; i += 1) {
      await walk.next();
      if (openUnderRoot().length > 0) sawSomethingOpen = true;
    }

    // The positive control. Without it a `/proc` shape change would make the
    // assertion below vacuously green — the same failure mode as a leak test
    // that passes against unfixed code.
    expect(sawSomethingOpen).toBe(true);

    await walk.return(undefined);

    expect(openUnderRoot()).toEqual([]);
  });
});
