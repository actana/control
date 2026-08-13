// The local tar codec: a folder survives the round trip, and its executable
// bits survive with it (#168).
//
// Three layers, because "it round-trips through itself" is the weakest possible
// evidence for a wire format:
//
//   1. **Round trip** — pack a tree, unpack it, compare. Catches the ordinary
//      bugs and is where the mode assertions live.
//   2. **The bytes are ustar** — the magic, the version, the field offsets and
//      the checksum, read out of the buffer by hand. The Core reads these
//      offsets, so a codec that only agrees with itself would pass layer 1 and
//      fail in production.
//   3. **GNU tar can read what this writes, and this can read what GNU tar
//      writes.** An outside implementation is the only thing that makes layers
//      1 and 2 mean what they claim. Skipped, loudly, on a machine with no
//      `tar` — a test that silently passes when it did not run is worse than no
//      test.

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { LocalTarError, packLocalTree, unpackTarInto, type UnpackedEntry } from "../local-tar.ts";

const temporary: string[] = [];

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-tar-"));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  while (temporary.length > 0) fs.rmSync(temporary.pop()!, { recursive: true, force: true });
});

/** Whether this machine has a tar to check against. */
const HAS_TAR = (() => {
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

async function pack(root: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of packLocalTree(root)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function unpack(archive: Buffer, dest: string): Promise<UnpackedEntry[]> {
  const seen: UnpackedEntry[] = [];
  await unpackTarInto(oneChunk(archive), dest, (entry) => {
    seen.push(entry);
  });
  return seen;
}

/** The archive as a stream, in awkward little pieces. */
async function* oneChunk(archive: Buffer, size = 100): AsyncGenerator<Uint8Array> {
  // Deliberately not a multiple of 512: every chunk boundary lands mid-header
  // or mid-body, which is the case a reader that assumed block-aligned reads
  // would get wrong, and it is what a real socket delivers.
  for (let offset = 0; offset < archive.length; offset += size) {
    yield archive.subarray(offset, Math.min(offset + size, archive.length));
  }
}

/** A tree with the three node types, a nested folder, and one executable. */
function buildTree(root: string): void {
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  fs.writeFileSync(path.join(root, "readme.md"), "hello\n");
  fs.writeFileSync(path.join(root, "bin", "deploy"), "#!/bin/sh\necho hi\n");
  fs.chmodSync(path.join(root, "bin", "deploy"), 0o755);
  fs.writeFileSync(path.join(root, "src", "deep", "index.ts"), "export const a = 1;\n");
  fs.chmodSync(path.join(root, "src", "deep", "index.ts"), 0o644);
  fs.symlinkSync("../readme.md", path.join(root, "src", "link.md"));
}

describe("a folder round-trips, and keeps its executable bits (#168)", () => {
  it("restores every file, its contents and its mode", async () => {
    const source = scratch();
    buildTree(source);
    const dest = scratch();

    await unpack(await pack(source), dest);

    expect(fs.readFileSync(path.join(dest, "readme.md"), "utf8")).toBe("hello\n");
    expect(fs.readFileSync(path.join(dest, "src", "deep", "index.ts"), "utf8")).toBe(
      "export const a = 1;\n",
    );
    // The whole reason a folder is an archive rather than N writes. An 0o755
    // that came back 0o644 is a `./deploy` that will not run, and it is the
    // failure this line exists to catch.
    expect(fs.statSync(path.join(dest, "bin", "deploy")).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(dest, "src", "deep", "index.ts")).mode & 0o777).toBe(0o644);
  });

  it("survives a umask that would have masked the mode away", async () => {
    // `open(…, mode)` is masked by the umask, so a codec that set the mode at
    // creation would drop the group and other bits under an 0o077 umask and
    // pass the test above on a developer's 0o022 machine. The explicit `chmod`
    // is what makes this pass, and this is the test that would notice.
    const source = scratch();
    fs.writeFileSync(path.join(source, "run"), "#!/bin/sh\n");
    fs.chmodSync(path.join(source, "run"), 0o755);
    const archive = await pack(source);

    const previous = process.umask(0o077);
    try {
      const dest = scratch();
      await unpack(archive, dest);
      expect(fs.statSync(path.join(dest, "run")).mode & 0o777).toBe(0o755);
    } finally {
      process.umask(previous);
    }
  });

  it("restores a symlink as a symlink, pointing where it did", async () => {
    const source = scratch();
    buildTree(source);
    const dest = scratch();

    await unpack(await pack(source), dest);

    const link = path.join(dest, "src", "link.md");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe("../readme.md");
  });

  it("copies the folder's contents to the destination, not the folder into it", async () => {
    // `cp ./dist api:build` makes `build` a copy of `dist`. The alternative —
    // `build/dist` — makes the round trip asymmetric, so copying down what you
    // copied up would nest one level deeper every time.
    const source = scratch();
    buildTree(source);
    const dest = scratch();

    const entries = await unpack(await pack(source), dest);

    expect(entries.map((entry) => entry.path).sort()).toEqual([
      "bin",
      "bin/deploy",
      "readme.md",
      "src",
      "src/deep",
      "src/deep/index.ts",
      "src/link.md",
    ]);
    expect(fs.existsSync(path.join(dest, path.basename(source)))).toBe(false);
  });

  it("reports an empty folder as an archive with nothing in it", async () => {
    const dest = scratch();
    const entries = await unpack(await pack(scratch()), dest);
    expect(entries).toEqual([]);
  });

  it("skips a node it could not recreate anywhere, rather than failing the copy", async () => {
    // A socket left behind by a running daemon is not a reason to refuse
    // somebody's whole folder — and it could not be meaningfully recreated on
    // another machine even if it were packed.
    const source = scratch();
    fs.writeFileSync(path.join(source, "keep.txt"), "kept\n");
    const socketPath = path.join(source, "daemon.sock");
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
      const entries = await unpack(await pack(source), scratch());
      expect(entries.map((entry) => entry.path)).toEqual(["keep.txt"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("every overwrite is named (F5)", () => {
  it("says `written` the first time and `overwritten` the second", async () => {
    const source = scratch();
    fs.writeFileSync(path.join(source, "a.txt"), "one\n");
    const archive = await pack(source);
    const dest = scratch();

    const first = await unpack(archive, dest);
    expect(first.map((entry) => entry.result)).toEqual(["written"]);

    const second = await unpack(archive, dest);
    // Named, with its path — a count would be the thing F5 exists to prevent
    // somebody being able to publish.
    expect(second).toEqual([expect.objectContaining({ path: "a.txt", result: "overwritten" })]);
  });

  it("counts a file landing on a directory as an overwrite, and removes the directory", async () => {
    const source = scratch();
    fs.writeFileSync(path.join(source, "thing"), "now a file\n");
    const dest = scratch();
    fs.mkdirSync(path.join(dest, "thing"), { recursive: true });
    fs.writeFileSync(path.join(dest, "thing", "inside.txt"), "gone\n");

    const entries = await unpack(await pack(source), dest);

    expect(entries[0]).toMatchObject({ path: "thing", result: "overwritten" });
    expect(fs.readFileSync(path.join(dest, "thing"), "utf8")).toBe("now a file\n");
  });
});

describe("an archive off the network cannot write outside where it was aimed", () => {
  // Not the confinement #168 rules out — that is the Core's rule about the
  // Core's disk. This is about *this* disk, and the bytes came off a socket.
  it("refuses an entry with a `..` segment", async () => {
    const archive = await pack(scratch());
    const forged = forgeEntry("../escape.txt", "gotcha\n");
    const dest = scratch();

    await expect(unpack(Buffer.concat([forged, archive]), dest)).rejects.toThrow(LocalTarError);
    expect(fs.existsSync(path.join(path.dirname(dest), "escape.txt"))).toBe(false);
  });

  it("refuses an absolute entry path", async () => {
    const dest = scratch();
    await expect(unpack(forgeEntry("/tmp/actana-escape.txt", "gotcha\n"), dest)).rejects.toThrow(
      /absolute path/,
    );
  });

  it("refuses a Windows-style absolute entry path too", async () => {
    const dest = scratch();
    await expect(unpack(forgeEntry("C:\\escape.txt", "gotcha\n"), dest)).rejects.toThrow(LocalTarError);
  });

  it("does not follow a symlink an earlier entry wrote", async () => {
    // The classic two-entry attack: a link out of the tree, then a file
    // "inside" it. The link itself is legal — a copy that dropped links would
    // not be a copy — so what has to hold is that the *file* is resolved and
    // refused rather than written through it.
    const outside = scratch();
    const dest = scratch();
    const archive = Buffer.concat([
      forgeSymlink("out", outside),
      forgeEntry("out/pwned.txt", "gotcha\n"),
    ]);

    await expect(unpack(archive, dest)).rejects.toThrow(LocalTarError);
    expect(fs.existsSync(path.join(outside, "pwned.txt"))).toBe(false);
  });
});

describe("the bytes are ustar, at the offsets the Core reads", () => {
  it("writes the magic, the version and a matching checksum", async () => {
    const source = scratch();
    fs.writeFileSync(path.join(source, "a.txt"), "x");
    const archive = await pack(source);

    expect(archive.subarray(257, 263).toString("ascii")).toBe("ustar\0");
    expect(archive.subarray(263, 265).toString("ascii")).toBe("00");

    let unsigned = 0;
    for (let i = 0; i < 512; i += 1) unsigned += i >= 148 && i < 156 ? 0x20 : archive[i]!;
    expect(Number.parseInt(archive.subarray(148, 154).toString("ascii"), 8)).toBe(unsigned);
  });

  it("puts the mode where a reader looks for it, in octal", async () => {
    const source = scratch();
    fs.writeFileSync(path.join(source, "run"), "#!/bin/sh\n");
    fs.chmodSync(path.join(source, "run"), 0o755);
    const archive = await pack(source);

    expect(archive.subarray(0, 3).toString("ascii")).toBe("run");
    expect(archive.subarray(100, 107).toString("ascii")).toBe("0000755");
    expect(String.fromCharCode(archive[156]!)).toBe("0");
  });

  it("flattens ownership to zero, because two machines share no passwd file", async () => {
    const source = scratch();
    fs.writeFileSync(path.join(source, "a.txt"), "x");
    const archive = await pack(source);
    expect(archive.subarray(108, 115).toString("ascii")).toBe("0000000");
    expect(archive.subarray(116, 123).toString("ascii")).toBe("0000000");
  });

  it("closes the archive with two zero blocks", async () => {
    const archive = await pack(scratch());
    expect(archive.length).toBe(1024);
    expect(archive.every((byte) => byte === 0)).toBe(true);
  });

  it("reaches for a pax header when a name will not fit in ustar's 100 bytes", async () => {
    const source = scratch();
    const deep = path.join(source, "a".repeat(60), "b".repeat(60));
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, "c.txt"), "deep\n");

    const archive = await pack(source);
    expect(archive.includes(Buffer.from("PaxHeaders/"))).toBe(true);

    // And it reads its own: the long path comes back whole, not truncated to
    // the 100 bytes the ustar field could hold.
    const dest = scratch();
    const entries = await unpack(archive, dest);
    expect(entries.map((entry) => entry.path)).toContain(`a`.repeat(60) + "/" + "b".repeat(60) + "/c.txt");
    expect(fs.readFileSync(path.join(deep.replace(source, dest), "c.txt"), "utf8")).toBe("deep\n");
  });

  it("refuses a header whose checksum does not match, rather than writing garbage", async () => {
    const source = scratch();
    fs.writeFileSync(path.join(source, "a.txt"), "x");
    const archive = await pack(source);
    archive[0] = "z".charCodeAt(0);
    await expect(unpack(archive, scratch())).rejects.toThrow(/checksum/);
  });

  it("says so when the stream stops in the middle of a file", async () => {
    const source = scratch();
    fs.writeFileSync(path.join(source, "a.txt"), "x".repeat(2000));
    const archive = await pack(source);
    await expect(unpack(archive.subarray(0, 900), scratch())).rejects.toThrow(/ended/);
  });
});

describe("GNU tar agrees, in both directions", () => {
  it.skipIf(!HAS_TAR)("reads an archive this codec wrote, modes intact", async () => {
    const source = scratch();
    buildTree(source);
    const archive = await pack(source);
    const archivePath = path.join(scratch(), "out.tar");
    fs.writeFileSync(archivePath, archive);

    const dest = scratch();
    execFileSync("tar", ["-xf", archivePath, "-C", dest]);

    expect(fs.readFileSync(path.join(dest, "readme.md"), "utf8")).toBe("hello\n");
    expect(fs.statSync(path.join(dest, "bin", "deploy")).mode & 0o777).toBe(0o755);
    expect(fs.readlinkSync(path.join(dest, "src", "link.md"))).toBe("../readme.md");
  });

  it.skipIf(!HAS_TAR)("reads an archive GNU tar wrote, modes intact", async () => {
    const source = scratch();
    buildTree(source);
    const archivePath = path.join(scratch(), "gnu.tar");
    // `.` as the member, so the archive holds the folder's *contents* under
    // relative names — the same shape this codec writes.
    execFileSync("tar", ["-cf", archivePath, "-C", source, "."]);

    const dest = scratch();
    await unpack(fs.readFileSync(archivePath), dest);

    expect(fs.readFileSync(path.join(dest, "readme.md"), "utf8")).toBe("hello\n");
    expect(fs.statSync(path.join(dest, "bin", "deploy")).mode & 0o777).toBe(0o755);
    expect(fs.readlinkSync(path.join(dest, "src", "link.md"))).toBe("../readme.md");
  });

  it.skipIf(!HAS_TAR)("reads GNU tar's long-name encoding, whichever one it used", async () => {
    const source = scratch();
    const deep = path.join(source, "a".repeat(60), "b".repeat(60));
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, "c.txt"), "deep\n");
    const archivePath = path.join(scratch(), "gnu-long.tar");
    execFileSync("tar", ["-cf", archivePath, "-C", source, "."]);

    const dest = scratch();
    await unpack(fs.readFileSync(archivePath), dest);
    expect(fs.readFileSync(path.join(deep.replace(source, dest), "c.txt"), "utf8")).toBe("deep\n");
  });
});

// ─── Forging entries a well-behaved packer would never emit ──────────────────

function forgeEntry(name: string, contents: string): Buffer {
  const body = Buffer.from(contents, "utf8");
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([forgeHeader(name, body.length, "0", ""), padded]);
}

function forgeSymlink(name: string, target: string): Buffer {
  return forgeHeader(name, 0, "2", target);
}

/** A valid ustar header for a name this codec would have refused to produce. */
function forgeHeader(name: string, size: number, typeflag: string, linkname: string): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  block.write("0000644\0", 100, 8, "ascii");
  block.write("0000000\0", 108, 8, "ascii");
  block.write("0000000\0", 116, 8, "ascii");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  block.write(`${(0).toString(8).padStart(11, "0")}\0`, 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii");
  block.write(typeflag, 156, 1, "ascii");
  block.write(linkname, 157, 100, "utf8");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  let unsigned = 0;
  for (let i = 0; i < 512; i += 1) unsigned += i >= 148 && i < 156 ? 0x20 : block[i]!;
  block.write(`${unsigned.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}
