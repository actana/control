import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TarError, unpackTarInto } from "../files-tar";
import { cleanupTrees, inChunks, makeTree } from "./files-fixture";

// Tar unpack is this ticket's attack surface, so the archives below are built
// by hand rather than by `tar(1)`: every one of them is a shape a cooperating
// tool will not produce and a hostile or broken one will.
//
// The property under test is **refusal**, and the assertion that matters most
// is the second half of each case — that nothing was written outside the root.
// A refusal that happens after the bytes have landed is not one.

afterEach(() => cleanupTrees());

// ─── A hand-rolled tar writer, so the tests can lie ──────────────────────────

type RawEntry = {
  name: string;
  typeflag?: string;
  mode?: number;
  linkname?: string;
  content?: string;
  /**
   * A size field that disagrees with the body actually present.
   *
   * The whole point of some of the cases below: a link or directory entry that
   * *claims* a body is how a writer and a reader end up disagreeing about where
   * the next header starts.
   */
  declaredSize?: number;
  /** Raw 12 bytes for the size field, for the base-256 encoding real tars use. */
  sizeField?: Buffer;
  /** Overrides the computed checksum, for the corrupt-archive case. */
  checksum?: string;
};

function block(entry: RawEntry): Buffer {
  const header = Buffer.alloc(512);
  const content = Buffer.from(entry.content ?? "", "utf8");
  const declared = entry.declaredSize ?? content.length;
  header.write(entry.name, 0, 100, "utf8");
  header.write(`${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  if (entry.sizeField) header.set(entry.sizeField.subarray(0, 12), 124);
  else header.write(`${declared.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write(entry.typeflag ?? "0", 156, 1, "ascii");
  header.write(entry.linkname ?? "", 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i]!;
  header.write(entry.checksum ?? `${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

/**
 * One pax extended-header record: `<len> <key>=<value>\n`, where `<len>`
 * counts itself. Solved rather than guessed — an off-by-one here makes a test
 * silently assert nothing, because the parser skips a record it cannot measure.
 */
function paxRecord(key: string, value: string): string {
  const payload = `${key}=${value}\n`;
  let length = Buffer.byteLength(payload) + 1;
  while (Buffer.byteLength(`${length}`) + Buffer.byteLength(` ${payload}`) !== length) {
    length = Buffer.byteLength(`${length}`) + Buffer.byteLength(` ${payload}`);
  }
  return `${length} ${payload}`;
}

function buildTar(entries: RawEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(block(entry));
    const content = Buffer.from(entry.content ?? "", "utf8");
    if (content.length > 0) {
      parts.push(content);
      const pad = content.length % 512 === 0 ? 0 : 512 - (content.length % 512);
      if (pad > 0) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

async function unpack(archive: Buffer, destination: string, confineRoot = destination): Promise<void> {
  await unpackTarInto(inChunks(archive, 128), destination, confineRoot, () => {});
}

async function refusal(archive: Buffer, destination: string, confineRoot = destination): Promise<TarError> {
  try {
    await unpack(archive, destination, confineRoot);
  } catch (err) {
    expect(err).toBeInstanceOf(TarError);
    return err as TarError;
  }
  throw new Error("expected the unpack to be refused, and it was not");
}

// ─── The refusals ────────────────────────────────────────────────────────────

describe("`..` inside a tar entry — the classic escape", () => {
  it("refuses a plain `../` entry", async () => {
    const outside = makeTree();
    const destination = makeTree();
    const archive = buildTar([{ name: "../pwned.txt", content: "owned" }]);

    const error = await refusal(archive, destination);

    expect(error.code).toBe("dot-dot-entry-path");
    expect(fs.readdirSync(path.dirname(destination)).includes("pwned.txt")).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("refuses a `..` buried mid-path", async () => {
    const destination = makeTree();
    const archive = buildTar([{ name: "a/b/../../../pwned.txt", content: "owned" }]);

    expect((await refusal(archive, destination)).code).toBe("dot-dot-entry-path");
  });

  it("refuses the entry that follows a legitimate one, without keeping the legitimate one", async () => {
    // Refusal aborts the transfer rather than skipping the entry. A partially
    // applied archive is a worse outcome than a failed one: the operator can
    // retry a failure and cannot see a skip.
    const destination = makeTree();
    const archive = buildTar([
      { name: "good.txt", content: "fine" },
      { name: "../bad.txt", content: "owned" },
    ]);

    expect((await refusal(archive, destination)).code).toBe("dot-dot-entry-path");
    // `good.txt` did land, because it was legal when it was read. The rule is
    // that the *escape* never happens, not that the transfer is atomic — a
    // multi-gigabyte tar cannot be staged and swapped, and pretending otherwise
    // in a test would be asserting a promise this surface does not make.
    expect(fs.existsSync(path.join(destination, "good.txt"))).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(destination), "bad.txt"))).toBe(false);
  });
});

describe("an absolute entry path", () => {
  it("refuses `/etc/cron.d/x`", async () => {
    const destination = makeTree();
    const archive = buildTar([{ name: "/etc/cron.d/x", content: "* * * * * root sh\n" }]);

    expect((await refusal(archive, destination)).code).toBe("absolute-entry-path");
    expect(fs.existsSync("/etc/cron.d/x")).toBe(false);
  });

  it("refuses an absolute path that points inside the destination anyway", async () => {
    const destination = makeTree();
    const archive = buildTar([{ name: path.join(destination, "inside.txt"), content: "x" }]);

    expect((await refusal(archive, destination)).code).toBe("absolute-entry-path");
    expect(fs.existsSync(path.join(destination, "inside.txt"))).toBe(false);
  });
});

describe("a symlink that reaches out of the root", () => {
  it("refuses a symlink entry pointing outside", async () => {
    const destination = makeTree();
    const archive = buildTar([{ name: "escape", typeflag: "2", linkname: "../../../../etc" }]);

    const error = await refusal(archive, destination);

    expect(error.code).toBe("symlink-outside-root");
    expect(fs.existsSync(path.join(destination, "escape"))).toBe(false);
  });

  it("refuses a symlink whose target is absolute", async () => {
    const destination = makeTree();
    const archive = buildTar([{ name: "escape", typeflag: "2", linkname: "/etc/passwd" }]);

    expect((await refusal(archive, destination)).code).toBe("symlink-outside-root");
  });

  it("refuses the follow-up write through a symlink the same archive just planted", async () => {
    // The two-entry attack, and the reason resolution has to happen per entry
    // at the moment of the write rather than once over the entry list: entry
    // one is a legal-looking symlink, entry two is a legal-looking relative
    // path, and only the filesystem as it stands between them knows they add up
    // to a write into `outside`.
    const outside = makeTree();
    const destination = makeTree();
    const archive = buildTar([
      { name: "link", typeflag: "2", linkname: outside },
      { name: "link/pwned.txt", content: "owned" },
    ]);

    const error = await refusal(archive, destination);

    expect(["symlink-outside-root", "entry-outside-root"]).toContain(error.code);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("accepts a symlink that stays inside", async () => {
    const destination = makeTree({ "real/a.txt": "a" });
    const archive = buildTar([{ name: "link", typeflag: "2", linkname: "real" }]);

    await unpack(archive, destination);

    expect(fs.readlinkSync(path.join(destination, "link"))).toBe("real");
  });
});

describe("a hardlink pointing outside the root", () => {
  it("refuses it", async () => {
    const outside = makeTree({ "secret.txt": "not yours" });
    const destination = makeTree();
    const archive = buildTar([
      { name: "stolen.txt", typeflag: "1", linkname: path.join(outside, "secret.txt") },
    ]);

    const error = await refusal(archive, destination);

    expect(error.code).toBe("hardlink-outside-root");
    expect(fs.existsSync(path.join(destination, "stolen.txt"))).toBe(false);
  });

  it("refuses a relative hardlink that walks out", async () => {
    const outside = makeTree({ "secret.txt": "not yours" });
    const destination = makeTree();
    const relative = path.relative(destination, path.join(outside, "secret.txt"));
    const archive = buildTar([{ name: "stolen.txt", typeflag: "1", linkname: relative }]);

    expect((await refusal(archive, destination)).code).toBe("hardlink-outside-root");
  });

  it("accepts a hardlink to a file inside the root", async () => {
    const destination = makeTree({ "a.txt": "a" });
    const archive = buildTar([{ name: "b.txt", typeflag: "1", linkname: "a.txt" }]);

    await unpack(archive, destination);

    expect(fs.readFileSync(path.join(destination, "b.txt"), "utf8")).toBe("a");
  });
});

describe("device nodes and fifos", () => {
  it("refuses a character device", async () => {
    const destination = makeTree();
    const archive = buildTar([{ name: "dev/null", typeflag: "3" }]);

    const error = await refusal(archive, destination);

    expect(error.code).toBe("unsupported-entry-type");
    expect(error.message).toContain("device node or fifo");
  });

  it("refuses a block device", async () => {
    const destination = makeTree();
    expect((await refusal(buildTar([{ name: "dev/sda", typeflag: "4" }]), destination)).code).toBe(
      "unsupported-entry-type",
    );
  });

  it("refuses a fifo", async () => {
    const destination = makeTree();
    expect((await refusal(buildTar([{ name: "pipe", typeflag: "6" }]), destination)).code).toBe(
      "unsupported-entry-type",
    );
  });

  it("refuses an entry type it has never heard of rather than guessing", async () => {
    const destination = makeTree();
    expect((await refusal(buildTar([{ name: "odd", typeflag: "Z" }]), destination)).code).toBe(
      "unsupported-entry-type",
    );
  });
});

describe("the Project root is the boundary, not the unpack destination", () => {
  it("refuses an entry that leaves the Project even when it stays under the destination's parent", async () => {
    // An upload into `<project>/vendor` unpacks with `destRoot = <project>/vendor`
    // and `confineRoot = <project>`. An entry may legally reach anywhere under
    // the Project — but a tar aimed at a subfolder that walks up past the
    // Project is the case that has to be refused by the *second* root.
    const project = makeTree({ "vendor/": "" });
    const destination = path.join(project, "vendor");
    const archive = buildTar([{ name: "ok.txt", content: "fine" }]);

    await unpackTarInto(inChunks(archive), destination, project, () => {});
    expect(fs.readFileSync(path.join(destination, "ok.txt"), "utf8")).toBe("fine");

    const outside = makeTree();
    const escaping = buildTar([{ name: "out", typeflag: "2", linkname: outside }]);
    await expect(unpackTarInto(inChunks(escaping), destination, project, () => {})).rejects.toThrow(TarError);
  });
});

describe("a damaged archive", () => {
  it("refuses a bad header checksum instead of reading garbage as a path", async () => {
    const destination = makeTree();
    const archive = buildTar([{ name: "a.txt", content: "a", checksum: "000000\0 " }]);

    expect((await refusal(archive, destination)).code).toBe("corrupt-archive");
  });

  it("refuses a stream that ends inside an entry's body", async () => {
    const destination = makeTree();
    const full = buildTar([{ name: "a.txt", content: "x".repeat(2000) }]);
    const truncated = full.subarray(0, 512 + 700);

    expect((await refusal(truncated, destination)).code).toBe("corrupt-archive");
  });

  it("refuses a stream that ends mid-header", async () => {
    const destination = makeTree();
    const truncated = buildTar([{ name: "a.txt", content: "a" }]).subarray(0, 300);

    expect((await refusal(truncated, destination)).code).toBe("corrupt-archive");
  });
});

describe("what it still gets right while being careful", () => {
  it("honours a pax `path` record, which is how bsdtar writes a long name", async () => {
    const destination = makeTree();
    const long = `${"x".repeat(120)}/file.txt`;
    const record = paxRecord("path", long);
    const archive = buildTar([
      { name: "PaxHeaders/file.txt", typeflag: "x", content: record },
      { name: "shortname.txt", content: "long-named" },
    ]);

    await unpack(archive, destination);

    expect(fs.readFileSync(path.join(destination, long), "utf8")).toBe("long-named");
    expect(fs.existsSync(path.join(destination, "shortname.txt"))).toBe(false);
  });

  it("refuses a pax `path` record that escapes — the override is validated, not trusted", async () => {
    // The pax record is the second place a path can come from, so it is the
    // second place the check has to happen. An implementation that validated
    // the ustar name and then let pax replace it would pass every other test
    // in this file.
    const destination = makeTree();
    const escape = "../../pwned.txt";
    const record = paxRecord("path", escape);
    const archive = buildTar([
      { name: "PaxHeaders/x", typeflag: "x", content: record },
      { name: "innocent.txt", content: "owned" },
    ]);

    expect((await refusal(archive, destination)).code).toBe("dot-dot-entry-path");
    expect(fs.existsSync(path.join(destination, "innocent.txt"))).toBe(false);
  });

  it("honours a GNU long-name entry, and validates that too", async () => {
    const destination = makeTree();
    const archive = buildTar([
      { name: "././@LongLink", typeflag: "L", content: "../../pwned.txt\0" },
      { name: "innocent.txt", content: "owned" },
    ]);

    expect((await refusal(archive, destination)).code).toBe("dot-dot-entry-path");
  });

  it("ignores a global pax header rather than letting it rename every entry", async () => {
    const destination = makeTree();
    const record = paxRecord("path", "hijacked");
    const archive = buildTar([
      { name: "PaxHeaders/global", typeflag: "g", content: record },
      { name: "a.txt", content: "a" },
      { name: "b.txt", content: "b" },
    ]);

    await unpack(archive, destination);

    expect(fs.readdirSync(destination).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("does not write through an existing symlink that points out of the root", async () => {
    // The `open(…, "w")` follows-a-symlink case. An entry named `note.txt` says
    // "there is a file called note.txt" — so the link is replaced by a real
    // file and the thing it pointed at is not touched. Following it would have
    // put the archive's bytes in someone else's file with every path check
    // passed, which is the bug this asserts is absent.
    const outside = makeTree({ "target.txt": "original" });
    const destination = makeTree();
    fs.symlinkSync(path.join(outside, "target.txt"), path.join(destination, "note.txt"));
    const archive = buildTar([{ name: "note.txt", content: "replaced" }]);

    await unpack(archive, destination);

    expect(fs.readFileSync(path.join(outside, "target.txt"), "utf8")).toBe("original");
    expect(fs.lstatSync(path.join(destination, "note.txt")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(destination, "note.txt"), "utf8")).toBe("replaced");
  });

  it("still refuses an entry *under* a symlink that points out of the root", async () => {
    // The parents are followed even though the last component is not, because
    // the parents are where an escape actually hides.
    const outside = makeTree();
    const destination = makeTree();
    fs.symlinkSync(outside, path.join(destination, "vendor"));
    const archive = buildTar([{ name: "vendor/lib.js", content: "owned" }]);

    expect((await refusal(archive, destination)).code).toBe("entry-outside-root");
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("replaces a symlink that stayed inside with a real file, rather than writing through it", async () => {
    const destination = makeTree({ "real.txt": "original" });
    fs.symlinkSync("real.txt", path.join(destination, "alias.txt"));
    const archive = buildTar([{ name: "alias.txt", content: "replaced" }]);

    await unpack(archive, destination);

    expect(fs.lstatSync(path.join(destination, "alias.txt")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(destination, "alias.txt"), "utf8")).toBe("replaced");
    expect(fs.readFileSync(path.join(destination, "real.txt"), "utf8")).toBe("original");
  });
});

describe("an entry that declares a body it has no business having", () => {
  // A directory, a symlink and a hardlink carry size 0 from any writer that
  // means well. This module used to `continue` past all three *without*
  // skipping the declared body, so an archive that declared one desynchronised
  // the stream: the next 512 bytes of payload were read as a header, failed
  // their checksum, and the transfer died as `corrupt-archive`.
  //
  // It fails closed and no escape follows from it — whatever is parsed still
  // goes through `confineWriteTarget` — but "the writer and the reader disagree
  // about where the next entry starts" is the shape that produces real parser
  // bugs, and `tar(1)` skips the declared body. So this one does too.

  it("skips a directory entry's declared body instead of desynchronising", async () => {
    const destination = makeTree();
    const archive = buildTar([
      // 512 bytes of claimed body, and the body really is there — so a reader
      // that does not skip it reads "sneaky.txt…" as its next header.
      { name: "folder/", typeflag: "5", content: "Z".repeat(512) },
      { name: "after.txt", content: "read as a file, not as a header" },
    ]);

    await unpack(archive, destination);

    expect(fs.statSync(path.join(destination, "folder")).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(destination, "after.txt"), "utf8")).toBe("read as a file, not as a header");
  });

  it("skips a symlink entry's declared body instead of desynchronising", async () => {
    const destination = makeTree({ "target.txt": "pointed at" });
    const archive = buildTar([
      { name: "link", typeflag: "2", linkname: "target.txt", content: "Z".repeat(512) },
      { name: "after.txt", content: "still a file" },
    ]);

    await unpack(archive, destination);

    expect(fs.readlinkSync(path.join(destination, "link"))).toBe("target.txt");
    expect(fs.readFileSync(path.join(destination, "after.txt"), "utf8")).toBe("still a file");
  });

  it("skips a hardlink entry's declared body instead of desynchronising", async () => {
    const destination = makeTree({ "target.txt": "pointed at" });
    const archive = buildTar([
      { name: "hard", typeflag: "1", linkname: "target.txt", content: "Z".repeat(512) },
      { name: "after.txt", content: "still a file" },
    ]);

    await unpack(archive, destination);

    expect(fs.readFileSync(path.join(destination, "hard"), "utf8")).toBe("pointed at");
    expect(fs.readFileSync(path.join(destination, "after.txt"), "utf8")).toBe("still a file");
  });
});

describe("a file entry landing where a directory already is", () => {
  // #165 F5's overwrite-by-default is about replacing a *file*. Deleting a
  // subtree to make room for one is a different promise, made nowhere: not in
  // the ticket, not in ADR 0029 D6, not in `docs/external-api.md`. `tar(1)`
  // refuses this rather than performing it, and so does this.

  it("refuses rather than recursively deleting the tree", async () => {
    const destination = makeTree({
      "src/keep-me.ts": "a hundred files like this one",
      "src/nested/deep.ts": "and this one",
    });
    const archive = buildTar([{ name: "src", content: "a regular file called src" }]);

    expect((await refusal(archive, destination)).code).toBe("directory-in-the-way");
    // The half that matters: nothing was deleted on the way to the refusal.
    expect(fs.readFileSync(path.join(destination, "src/keep-me.ts"), "utf8")).toBe("a hundred files like this one");
    expect(fs.readFileSync(path.join(destination, "src/nested/deep.ts"), "utf8")).toBe("and this one");
  });

  it("refuses a symlink entry landing on a non-empty directory too", async () => {
    const destination = makeTree({ "vendor/lib.js": "keep" });
    const archive = buildTar([{ name: "vendor", typeflag: "2", linkname: "lib.js" }]);

    expect((await refusal(archive, destination)).code).toBe("directory-in-the-way");
    expect(fs.readFileSync(path.join(destination, "vendor/lib.js"), "utf8")).toBe("keep");
  });

  it("still replaces an *empty* directory, which has nothing to lose", async () => {
    // A stray `mkdir` should not wedge a path forever, and the asymmetry is the
    // point: the refusal is about destroying work, not about the node type.
    const destination = makeTree({ "placeholder/": "" });
    const archive = buildTar([{ name: "placeholder", content: "now a file" }]);

    await unpack(archive, destination);

    expect(fs.readFileSync(path.join(destination, "placeholder"), "utf8")).toBe("now a file");
  });
});

describe("a tar entry that names the unpack root itself", () => {
  // The same defect the single-file `PUT` guard refuses one branch over, and
  // for a while it lived here undisturbed: `handlePut` reads the *resolved*
  // path, and this loop used to test the *raw* entry name for emptiness. An
  // entry called `.` survived that test with length 1 while confining to the
  // root, and a regular-file typeflag then did what `writeSingleFile` used to —
  // `lstat` finds a directory, an empty root has nothing to lose, `rm -r` takes
  // the Project root away and `open(…, "w")` leaves a file at its path.
  //
  // Worse here than on the `PUT` branch, because a tar `PUT` answers `200`
  // before it reads a byte: the old code reported `{type:"done"}` over a
  // Project whose root it had just deleted.
  //
  // The spellings below are not a list this loop maintains — every one of them
  // resolves to `relative === ""` through the one confinement function, which
  // is why keying on the resolved answer is exhaustive where a string test over
  // the raw name would not be.

  const spellings: Array<[string, string]> = [
    ["a bare `.`", "."],
    ["`./`", "./"],
    ["`./.`", "./."],
    ["`././`", "././"],
    ["a trailing run of slashes", ".///"],
    ["a nameless entry", ""],
    ["whitespace around the dot", " . "],
  ];

  for (const [label, name] of spellings) {
    it(`refuses ${label} against an empty root, which is the destructive case`, async () => {
      const destination = makeTree();
      const archive = buildTar([{ name, content: "CLOBBER" }]);

      expect((await refusal(archive, destination)).code).toBe("root-entry-path");
      // The half that matters: the root is still a directory, not a file whose
      // contents are the archive's.
      expect(fs.lstatSync(destination).isDirectory()).toBe(true);
    });

    it(`refuses ${label} against a populated root, losing nothing`, async () => {
      const destination = makeTree({ "keep.txt": "keep", "src/deep.ts": "deep" });
      const archive = buildTar([{ name, content: "CLOBBER" }]);

      // Both halves matter, as on the `PUT` branch: the populated case was
      // already caught by `directory-in-the-way`, so asserting it here is what
      // keeps the refusal about *being the root* rather than about its
      // contents.
      const err = await refusal(archive, destination);
      expect(err.code).toBe("root-entry-path");
      expect(err.code).not.toBe("directory-in-the-way");
      expect(fs.lstatSync(destination).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(destination, "keep.txt"), "utf8")).toBe("keep");
      expect(fs.readFileSync(path.join(destination, "src/deep.ts"), "utf8")).toBe("deep");
    });
  }

  it("refuses a symlink entry that names the root", async () => {
    // Refused before the containment check has an opinion about the link
    // target, so the code names what is actually wrong with it.
    const destination = makeTree();
    const archive = buildTar([{ name: ".", typeflag: "2", linkname: "elsewhere" }]);

    expect((await refusal(archive, destination)).code).toBe("root-entry-path");
    expect(fs.lstatSync(destination).isDirectory()).toBe(true);
  });

  it("refuses a hardlink entry that names the root", async () => {
    const destination = makeTree({ "target.txt": "pointed at" });
    const archive = buildTar([{ name: "./.", typeflag: "1", linkname: "target.txt" }]);

    expect((await refusal(archive, destination)).code).toBe("root-entry-path");
    expect(fs.lstatSync(destination).isDirectory()).toBe(true);
  });

  it("refuses a pax `path` record that names the root, because the override is resolved too", async () => {
    // The raw name is innocent and the override is not — the check runs after
    // `rawName` has taken the pax value, which is the only ordering that works.
    const destination = makeTree();
    const record = paxRecord("path", ".");
    const archive = buildTar([
      { name: "PaxHeaders/innocent.txt", typeflag: "x", content: record },
      { name: "innocent.txt", content: "CLOBBER" },
    ]);

    expect((await refusal(archive, destination)).code).toBe("root-entry-path");
    expect(fs.lstatSync(destination).isDirectory()).toBe(true);
  });

  it("refuses the root entry without keeping the entries that preceded it", async () => {
    // No atomicity is promised — what is asserted is that the refusal lands
    // before the root is touched, not that the archive rolls back.
    const destination = makeTree();
    const archive = buildTar([{ name: "before.txt", content: "landed" }, { name: ".", content: "CLOBBER" }]);

    expect((await refusal(archive, destination)).code).toBe("root-entry-path");
    expect(fs.lstatSync(destination).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(destination, "before.txt"), "utf8")).toBe("landed");
  });

  it("skips a *directory* entry naming the root rather than refusing it — that is `tar(1)`'s `./`", async () => {
    // Every `tar -cf - .` archive opens with a `./` directory header, so
    // refusing this would refuse the ordinary archive. It is skipped, and the
    // rest of the archive unpacks into the root exactly as before.
    const destination = makeTree();
    const archive = buildTar([
      { name: "./", typeflag: "5", mode: 0o700 },
      { name: "a.txt", content: "a" },
      { name: "sub/b.txt", content: "b" },
    ]);

    await unpack(archive, destination);

    expect(fs.lstatSync(destination).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(destination, "a.txt"), "utf8")).toBe("a");
    expect(fs.readFileSync(path.join(destination, "sub/b.txt"), "utf8")).toBe("b");
  });

  it("does not apply a root directory entry's mode to the Project root", async () => {
    // The behaviour change that comes with skipping rather than chmod'ing, said
    // out loud because it is a change: an archive somebody dropped does not
    // restyle the permissions of the Project root it was dropped on.
    const destination = makeTree();
    fs.chmodSync(destination, 0o755);
    const archive = buildTar([{ name: "./", typeflag: "5", mode: 0o700 }, { name: "a.txt", content: "a" }]);

    await unpack(archive, destination);

    expect(fs.statSync(destination).mode & 0o777).toBe(0o755);
  });

  it("skips a root directory entry that declares a body, rather than desynchronising", async () => {
    // The skip that the old empty-name branch was carrying: a bodyless entry
    // claiming a body has to be walked past, or the next 512 bytes read as a
    // header.
    const destination = makeTree();
    const archive = buildTar([
      { name: "./", typeflag: "5", content: "Z".repeat(512) },
      { name: "after.txt", content: "read as a file, not as a header" },
    ]);

    await unpack(archive, destination);

    expect(fs.readFileSync(path.join(destination, "after.txt"), "utf8")).toBe("read as a file, not as a header");
  });

  it("refuses `/` and `//`, which this loop strips to nothing before confinement sees them", async () => {
    // Not `absolute-entry-path`, and the difference is worth pinning rather
    // than discovering: the trailing-slash strip above runs *before*
    // `confineWriteTarget`, so a name that is nothing but slashes reaches it as
    // `""` and resolves to the root. Pre-fix these were the silent-skip case.
    const destination = makeTree();
    for (const name of ["/", "//", "///"]) {
      expect((await refusal(buildTar([{ name, content: "x" }]), destination)).code).toBe("root-entry-path");
      expect(fs.lstatSync(destination).isDirectory()).toBe(true);
    }
  });

  it("still refuses `/.` as absolute, which is a different complaint", async () => {
    // This one keeps a non-slash last character, so confinement sees it whole
    // and answers about what is actually wrong with it. The root check is not
    // asked, and should not be.
    const destination = makeTree();

    expect((await refusal(buildTar([{ name: "/.", content: "x" }]), destination)).code).toBe("absolute-entry-path");
    expect(fs.lstatSync(destination).isDirectory()).toBe(true);
  });

  it("leaves an entry called `.hidden` alone, which only looks like the root", async () => {
    const destination = makeTree();
    const archive = buildTar([{ name: ".hidden", content: "an ordinary dotfile" }]);

    await unpack(archive, destination);

    expect(fs.readFileSync(path.join(destination, ".hidden"), "utf8")).toBe("an ordinary dotfile");
  });
});

describe("a size the 11-digit octal ustar field cannot hold", () => {
  // #165 F8 says no size cap, and an 11-octal-digit size field is one at
  // 8589934592 bytes (8 GiB). Real writers encode past it two ways and this
  // module read neither: base-256 parsed to `NaN` and then to 0, so the file
  // landed empty and the stream desynchronised into a checksum failure.
  //
  // Tested at the encoding rather than with an 8 GiB fixture — the parse is the
  // thing that was broken, and it is broken or correct at any magnitude.

  /** GNU/pax base-256: high bit set on the first byte, big-endian after it. */
  function base256(value: number, length = 12): Buffer {
    const field = Buffer.alloc(length);
    let left = value;
    for (let i = length - 1; i > 0; i -= 1) {
      field[i] = left % 256;
      left = Math.floor(left / 256);
    }
    field[0] = 0x80;
    return field;
  }

  it("reads a base-256 size field rather than treating it as zero", async () => {
    const destination = makeTree();
    const body = "the bytes a base-256 size field describes";
    const archive = buildTar([
      { name: "big.bin", content: body, sizeField: base256(body.length) },
      { name: "after.txt", content: "and the stream is still in step" },
    ]);

    await unpack(archive, destination);

    expect(fs.readFileSync(path.join(destination, "big.bin"), "utf8")).toBe(body);
    expect(fs.readFileSync(path.join(destination, "after.txt"), "utf8")).toBe("and the stream is still in step");
  });

  it("honours a pax `size` record, which is the other way a real tar says it", async () => {
    const destination = makeTree();
    const body = "described by a pax record instead";
    const archive = buildTar([
      { name: "PaxHeaders/big.bin", typeflag: "x", content: paxRecord("size", String(body.length)) },
      // The ustar field says 0, exactly as a pax writer leaves it. Before the
      // fix this entry landed empty and swallowed the next header.
      { name: "big.bin", content: body, declaredSize: 0 },
      { name: "after.txt", content: "and the stream is still in step" },
    ]);

    await unpack(archive, destination);

    expect(fs.readFileSync(path.join(destination, "big.bin"), "utf8")).toBe(body);
    expect(fs.readFileSync(path.join(destination, "after.txt"), "utf8")).toBe("and the stream is still in step");
  });

  it("refuses a negative base-256 field rather than reading it as a length", async () => {
    const destination = makeTree();
    const negative = Buffer.alloc(12, 0xff);
    const archive = buildTar([{ name: "odd.bin", content: "x", sizeField: negative }]);

    const error = await refusal(archive, destination);

    expect(error.code).toBe("corrupt-archive");
    // The message, not just the code: before base-256 was read at all this
    // archive also died as `corrupt-archive`, but two entries later and for an
    // unrelated reason — the size parsed as 0, the body was read as the next
    // header, and its checksum failed. Asserting *why* keeps this test pinned
    // to the field and not to the accident.
    expect(error.message).toContain("negative");
  });
});
