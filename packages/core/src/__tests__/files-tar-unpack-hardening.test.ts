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
  /** Overrides the computed checksum, for the corrupt-archive case. */
  checksum?: string;
};

function block(entry: RawEntry): Buffer {
  const header = Buffer.alloc(512);
  const content = Buffer.from(entry.content ?? "", "utf8");
  header.write(entry.name, 0, 100, "utf8");
  header.write(`${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
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
