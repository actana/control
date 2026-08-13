import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { packDirectory, unpackTarInto, type TarEntryReport, type TarWriteOutcome } from "../files-tar";
import { cleanupTrees, collect, inChunks, makeTree, readTree } from "./files-fixture";

// A folder crosses as one streamed tar (#165 F4) and comes back the same
// folder — including its executable bits, which is the acceptance criterion the
// mode field exists for.

afterEach(() => cleanupTrees());

type Report = TarEntryReport & { result: TarWriteOutcome };

async function roundTrip(source: string, destination: string): Promise<Report[]> {
  const archive = await collect(packDirectory(source));
  const reports: Report[] = [];
  await unpackTarInto(inChunks(archive), destination, destination, (entry) => {
    reports.push(entry);
  });
  return reports;
}

describe("a folder round-trips", () => {
  it("comes back with the same files, contents and layout", async () => {
    const source = makeTree({
      "README.md": "# hello",
      "src/index.ts": "export const x = 1;\n",
      "src/nested/deep/file.txt": "deep",
      "empty/": "",
    });
    const destination = makeTree();

    await roundTrip(source, destination);

    expect(readTree(destination)).toEqual(readTree(source));
    expect(fs.statSync(path.join(destination, "empty")).isDirectory()).toBe(true);
  });

  it("keeps the executable bit — on a file and on the folder holding it", async () => {
    const source = makeTree({
      "bin/run.sh": { content: "#!/bin/sh\necho hi\n", mode: 0o755 },
      "bin/notes.txt": { content: "not executable", mode: 0o644 },
    });
    fs.chmodSync(path.join(source, "bin"), 0o750);
    const destination = makeTree();

    await roundTrip(source, destination);

    expect(fs.statSync(path.join(destination, "bin/run.sh")).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(destination, "bin/notes.txt")).mode & 0o777).toBe(0o644);
    expect(fs.statSync(path.join(destination, "bin")).mode & 0o777).toBe(0o750);
  });

  it("keeps the executable bit when it overwrites an existing non-executable file", async () => {
    // `open(…, mode)` applies the mode only on create, so this is the case that
    // silently keeps the old bits if the chmod after the write is dropped.
    const source = makeTree({ "run.sh": { content: "#!/bin/sh\n", mode: 0o755 } });
    const destination = makeTree({ "run.sh": { content: "stale", mode: 0o600 } });

    await roundTrip(source, destination);

    expect(fs.statSync(path.join(destination, "run.sh")).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(path.join(destination, "run.sh"), "utf8")).toBe("#!/bin/sh\n");
  });

  it("carries a symlink across as a symlink", async () => {
    const source = makeTree({ "real/a.txt": "a" });
    fs.symlinkSync("real/a.txt", path.join(source, "link.txt"));
    const destination = makeTree();

    await roundTrip(source, destination);

    const link = path.join(destination, "link.txt");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe("real/a.txt");
    expect(fs.readFileSync(link, "utf8")).toBe("a");
  });

  it("round-trips an empty folder as an empty folder rather than nothing", async () => {
    const source = makeTree({ "a/b/c/": "" });
    const destination = makeTree();

    await roundTrip(source, destination);

    expect(fs.statSync(path.join(destination, "a/b/c")).isDirectory()).toBe(true);
  });

  it("round-trips a file whose path is longer than ustar's 100-byte name field", async () => {
    const long = `${"deep".repeat(20)}/${"nested".repeat(15)}/finally.txt`;
    const source = makeTree({ [long]: "made it" });
    const destination = makeTree();

    await roundTrip(source, destination);

    expect(fs.readFileSync(path.join(destination, long), "utf8")).toBe("made it");
  });

  it("round-trips a file with a non-ASCII name", async () => {
    const source = makeTree({ "docs/naïve—café 😀.md": "unicode" });
    const destination = makeTree();

    await roundTrip(source, destination);

    expect(fs.readFileSync(path.join(destination, "docs/naïve—café 😀.md"), "utf8")).toBe("unicode");
  });

  it("round-trips a file larger than one read chunk, byte for byte", async () => {
    const big = Buffer.alloc(300_000).fill("abcdefgh");
    const source = makeTree();
    fs.writeFileSync(path.join(source, "big.bin"), big);
    const destination = makeTree();

    await roundTrip(source, destination);

    expect(fs.readFileSync(path.join(destination, "big.bin")).equals(big)).toBe(true);
  });

  it("produces the same bytes for the same tree twice, so a transfer is diffable", async () => {
    const source = makeTree({ "b.txt": "b", "a.txt": "a", "c/d.txt": "d" });
    const first = await collect(packDirectory(source));
    const second = await collect(packDirectory(source));
    expect(first.equals(second)).toBe(true);
  });

  it("skips a socket or fifo on the way out rather than failing the operator's upload", async () => {
    const source = makeTree({ "a.txt": "a" });
    try {
      execFileSync("mkfifo", [path.join(source, "pipe")], { stdio: "ignore" });
    } catch {
      return; // no mkfifo on this machine — the property is asserted on unpack too
    }
    const destination = makeTree();

    await roundTrip(source, destination);

    expect(fs.existsSync(path.join(destination, "a.txt"))).toBe(true);
    expect(fs.existsSync(path.join(destination, "pipe"))).toBe(false);
  });
});

describe("the NDJSON entry fields (#129 F10)", () => {
  it("carries path, size, mtime, mode and sha256 for every file, from the first commit", async () => {
    const source = makeTree({ "src/a.txt": { content: "hello", mode: 0o644 } });
    const destination = makeTree();

    const reports = await roundTrip(source, destination);
    const file = reports.find((r) => r.path === "src/a.txt");

    expect(file).toBeDefined();
    expect(file).toMatchObject({
      path: "src/a.txt",
      kind: "file",
      size: 5,
      mode: 0o644,
      // sha256("hello")
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    });
    expect(typeof file!.mtime).toBe("number");
    expect(file!.mtime).toBeGreaterThan(0);
  });

  it("reports a directory with a null digest rather than a digest of nothing", async () => {
    const source = makeTree({ "d/x.txt": "x" });
    const destination = makeTree();

    const reports = await roundTrip(source, destination);
    const directory = reports.find((r) => r.path === "d");

    expect(directory).toMatchObject({ kind: "directory", size: 0, sha256: null });
  });

  it("digests a symlink's target, which is what a diff would compare", async () => {
    const source = makeTree({ "real.txt": "r" });
    fs.symlinkSync("real.txt", path.join(source, "link.txt"));
    const destination = makeTree();

    const reports = await roundTrip(source, destination);
    const link = reports.find((r) => r.path === "link.txt");

    expect(link).toMatchObject({
      kind: "symlink",
      size: "real.txt".length,
      // sha256("real.txt") — the target string, not the file it points at.
      sha256: "3be6b22f7a38c4f3bbb6c97c58b62781c85b3db8bf7ff5ac955877c464507ef9",
    });
  });

  it("names every overwrite `overwritten` and every new path `written` (#165 F5)", async () => {
    const source = makeTree({ "kept.txt": "new", "fresh.txt": "new" });
    const destination = makeTree({ "kept.txt": "old" });

    const reports = await roundTrip(source, destination);

    expect(reports.find((r) => r.path === "kept.txt")?.result).toBe("overwritten");
    expect(reports.find((r) => r.path === "fresh.txt")?.result).toBe("written");
  });

  it("overwrites by default — nothing has to ask for it", async () => {
    const source = makeTree({ "a.txt": "second" });
    const destination = makeTree({ "a.txt": "first" });

    await roundTrip(source, destination);

    expect(fs.readFileSync(path.join(destination, "a.txt"), "utf8")).toBe("second");
  });

  it("reports each entry before the next one is read, so progress is progress", async () => {
    const source = makeTree({ "a.txt": "a", "b.txt": "b", "c.txt": "c" });
    const destination = makeTree();
    const archive = await collect(packDirectory(source));

    const seenWhenCalled: string[][] = [];
    await unpackTarInto(inChunks(archive, 64), destination, destination, (entry) => {
      // At the moment `a.txt` is reported, `b.txt` has not been written yet.
      seenWhenCalled.push(fs.readdirSync(destination).sort());
      expect(entry.path).toBeTruthy();
    });

    expect(seenWhenCalled).toEqual([["a.txt"], ["a.txt", "b.txt"], ["a.txt", "b.txt", "c.txt"]]);
  });
});

describe("interoperability with `tar(1)`", () => {
  const hasSystemTar = (): boolean => {
    try {
      execFileSync("tar", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };

  it("unpacks an archive that GNU/bsd tar produced, long names and all", async () => {
    if (!hasSystemTar()) return;
    const long = `${"a".repeat(60)}/${"b".repeat(60)}/c.txt`;
    const source = makeTree({ "plain.txt": "plain", [long]: "long", "bin/x.sh": { content: "#!/bin/sh\n", mode: 0o755 } });
    const staging = makeTree();
    const archivePath = path.join(staging, "out.tar");
    execFileSync("tar", ["-cf", archivePath, "-C", source, "."]);

    const destination = makeTree();
    await unpackTarInto(inChunks(fs.readFileSync(archivePath)), destination, destination, () => {});

    expect(fs.readFileSync(path.join(destination, "plain.txt"), "utf8")).toBe("plain");
    expect(fs.readFileSync(path.join(destination, long), "utf8")).toBe("long");
    expect(fs.statSync(path.join(destination, "bin/x.sh")).mode & 0o777).toBe(0o755);
  });

  it("produces an archive `tar(1)` reads back correctly", async () => {
    if (!hasSystemTar()) return;
    const source = makeTree({ "a.txt": "a", "sub/b.sh": { content: "#!/bin/sh\n", mode: 0o755 } });
    const staging = makeTree();
    const archivePath = path.join(staging, "ours.tar");
    fs.writeFileSync(archivePath, await collect(packDirectory(source)));

    const destination = makeTree();
    execFileSync("tar", ["-xf", archivePath, "-C", destination]);

    expect(fs.readFileSync(path.join(destination, "a.txt"), "utf8")).toBe("a");
    expect(fs.statSync(path.join(destination, "sub/b.sh")).mode & 0o777).toBe(0o755);
  });
});
