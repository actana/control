// A folder crosses as one streamed tar (ADR 0029), and this is the **local**
// half of that: packing this machine's disk on the way up, unpacking onto it on
// the way down.
//
// The Core owns the other half (`packages/core/src/files-tar.ts`) and the two
// never share code — this package cannot import `@actana/core` at all (#129 D8,
// and `no-local-escape.test.ts` enforces it), and it should not:
// the two halves guard different disks and their rules are not the same. What
// they do share is a format, and it is a thirty-year-old one with an unusually
// precise definition, so "compatible" here means ustar with pax extensions and
// is checked against the Core's own codec by `local-tar.test.ts`.
//
// ## Why a codec rather than a dependency
//
// The same trade the Core made, arriving at the same answer for a different
// reason. This package publishes with **one** runtime dependency it actually
// chose (`@actana/sdk`), and `no-local-escape.test.ts` pins the whole list —
// the CLI being one package deep is a property #129 D8 asks for out loud. A tar
// library would be the third name on that list, resolved in every stranger's
// global install, to do about four hundred lines of arithmetic on 512-byte
// blocks that has not changed since 1988.
//
// ## What the executable bit has to do with any of this
//
// #168's "a folder copies both ways and keeps its executable bits" is the whole
// reason a folder is a tar rather than N file writes. A mode is a property of
// an entry in an archive; it is not a property of an HTTP request, and a
// transfer that sent bytes and re-created files locally would have to invent a
// side channel for it — or, as almost every such transfer does, silently give
// every file 0o644 and leave the operator to discover it when their `./deploy`
// will not run. `mode & 0o777` rides in the header both ways, and is applied on
// the way out with an explicit `chmod`, because `open(…, mode)` is masked by
// the process umask and a `0o755` would land as `0o755 & ~umask`.
//
// ## Confinement, and whose disk it is about
//
// `unpackTarInto` refuses an entry whose path is absolute, contains a `..`
// segment, or resolves outside the destination directory. That is **not** the
// client-side path validation #168 rules out: those rules are about the Core's
// disk and the Core owns them (F3, F11). This one is about *this* disk, and the
// bytes being unpacked came off a network. A tar is a list of filenames written
// by somebody else, and "write it wherever it says" is how an archive
// overwrites `~/.ssh/authorized_keys`.

import fs from "node:fs";
import path from "node:path";

const BLOCK = 512;
const ZERO_BLOCK = new Uint8Array(BLOCK);

/** The ustar type flags this codec writes and reads. */
const TYPE_FILE = "0";
const TYPE_FILE_OLD = "\0";
const TYPE_SYMLINK = "2";
const TYPE_DIRECTORY = "5";
const TYPE_PAX_NEXT = "x";
const TYPE_PAX_GLOBAL = "g";
const TYPE_GNU_LONGNAME = "L";
const TYPE_GNU_LONGLINK = "K";

/** The largest size an 11-digit octal ustar field holds: 8 GiB, less a byte. */
const MAX_USTAR_SIZE = 0o77777777777;

export type LocalTarErrorCode = "corrupt-archive" | "unsafe-entry-path" | "read-failed" | "write-failed";

/** Anything this module refuses or cannot finish, with a code a caller can branch on. */
export class LocalTarError extends Error {
  readonly code: LocalTarErrorCode;

  constructor(code: LocalTarErrorCode, message: string) {
    super(message);
    this.name = "LocalTarError";
    this.code = code;
  }
}

/** One entry, in the same five-field shape the Core's manifest uses (#129 F10). */
export type LocalTarEntry = {
  /** Relative to the tree's root, always `/`-separated — a tar path, not a local one. */
  path: string;
  kind: "file" | "directory" | "symlink";
  size: number;
  /** Permission bits only. Ownership is deliberately not carried; see {@link packLocalTree}. */
  mode: number;
  /** Epoch milliseconds, though a tar header holds seconds and the round trip truncates. */
  mtime: number;
};

/** How a written entry landed. `overwritten` is what F5 requires be named. */
export type LocalWriteOutcome = "written" | "overwritten";

export type UnpackedEntry = LocalTarEntry & { result: LocalWriteOutcome };

// ─── Header codec ────────────────────────────────────────────────────────────

type TarHeader = {
  name: string;
  mode: number;
  size: number;
  /** Epoch milliseconds. Converted to the header's seconds on the way out. */
  mtime: number;
  typeflag: string;
  linkname: string;
};

function readString(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return Buffer.from(end === -1 ? slice : slice.subarray(0, end)).toString("utf8");
}

/**
 * A ustar numeric field: octal, or base-256 for anything that does not fit.
 *
 * The high bit of the first byte marks base-256 — a big-endian integer in the
 * remaining bytes — and it is how GNU tar writes a size the 12-byte octal field
 * cannot hold. Parsing one as octal yields `NaN`, and treating that as zero
 * lands the file empty and then desynchronises every entry after it into a
 * checksum failure, which is a bug report about "a corrupt archive" that is
 * really a bug about one number.
 */
function readOctal(block: Uint8Array, offset: number, length: number): number {
  const first = block[offset] ?? 0;
  if ((first & 0x80) !== 0) {
    if (first === 0xff) {
      throw new LocalTarError("corrupt-archive", "a tar numeric field is negative, which no field here can be");
    }
    let value = first & 0x7f;
    for (let i = offset + 1; i < offset + length; i += 1) value = value * 256 + (block[i] ?? 0);
    return value;
  }
  const raw = readString(block, offset, length).trim();
  if (raw.length === 0) return 0;
  const value = Number.parseInt(raw, 8);
  return Number.isFinite(value) ? value : 0;
}

function writeString(block: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) {
    // Every overflow has already been routed through a pax record by
    // `entryHeaderBlocks`, so reaching here is a bug in this file rather than
    // an archive somebody is not allowed to write.
    throw new LocalTarError("corrupt-archive", `tar field overflow writing ${JSON.stringify(value)}`);
  }
  block.set(bytes, offset);
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  const text = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, "0");
  writeString(block, offset, length, `${text}\0`);
}

/**
 * The header checksum, computed both ways.
 *
 * Historic tars summed the header bytes as signed and modern ones as unsigned,
 * so an archive with a high byte anywhere in a filename matches one and not the
 * other. Every reader in the world accepts either; rejecting on one would
 * refuse legitimate output from `tar(1)`.
 */
function headerChecksums(block: Uint8Array): { unsigned: number; signed: number } {
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    // The checksum field itself is counted as eight spaces, by definition.
    const byte = i >= 148 && i < 156 ? 0x20 : block[i]!;
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return { unsigned, signed };
}

function parseHeader(block: Uint8Array): TarHeader {
  const stored = readOctal(block, 148, 8);
  const { unsigned, signed } = headerChecksums(block);
  if (stored !== unsigned && stored !== signed) {
    throw new LocalTarError(
      "corrupt-archive",
      "a tar header checksum does not match — the archive is damaged, or is not a tar",
    );
  }
  const prefix = readString(block, 345, 155);
  const name = readString(block, 0, 100);
  return {
    name: prefix.length > 0 ? `${prefix}/${name}` : name,
    mode: readOctal(block, 100, 8) & 0o7777,
    size: readOctal(block, 124, 12),
    // ustar mtime is epoch *seconds*; everything this module hands out is
    // milliseconds, because that is what `fs.Stats` and JSON consumers use.
    mtime: readOctal(block, 136, 12) * 1000,
    typeflag: String.fromCharCode(block[156]!),
    linkname: readString(block, 157, 100),
  };
}

function buildHeaderBlock(header: TarHeader): Uint8Array {
  const block = new Uint8Array(BLOCK);
  writeString(block, 0, 100, header.name);
  writeOctal(block, 100, 8, header.mode & 0o7777);
  // uid and gid are deliberately zero and no uname/gname is written: a transfer
  // crosses machines that do not share a passwd file, so a preserved numeric
  // owner restores a *stranger's* uid at the far end. The bit that has to
  // survive is the executable one, and that rides `mode`.
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, header.size);
  writeOctal(block, 136, 12, Math.floor(header.mtime / 1000));
  writeString(block, 148, 8, "        ");
  block[156] = header.typeflag.charCodeAt(0);
  writeString(block, 157, 100, header.linkname);
  writeString(block, 257, 6, "ustar\0");
  writeString(block, 263, 2, "00");
  const { unsigned } = headerChecksums(block);
  writeString(block, 148, 8, `${unsigned.toString(8).padStart(6, "0")}\0 `);
  return block;
}

function padding(size: number): number {
  const remainder = size % BLOCK;
  return remainder === 0 ? 0 : BLOCK - remainder;
}

// ─── Packing ─────────────────────────────────────────────────────────────────

/** A pax extended header — how a name, a link target or a size overflows ustar. */
function* paxRecordBlocks(name: string, records: Record<string, string>): Generator<Uint8Array> {
  let body = "";
  for (const [key, value] of Object.entries(records)) {
    const payload = `${key}=${value}\n`;
    // The length prefix counts itself, so it is solved for rather than measured.
    let length = Buffer.byteLength(payload) + 1;
    while (Buffer.byteLength(`${length}`) + Buffer.byteLength(` ${payload}`) !== length) {
      length = Buffer.byteLength(`${length}`) + Buffer.byteLength(` ${payload}`);
    }
    body += `${length} ${payload}`;
  }
  const bytes = Buffer.from(body, "utf8");
  yield buildHeaderBlock({
    // Cosmetic — readers key off the type flag — but `tar tv` prints it, so it
    // says which entry it belongs to.
    name: `PaxHeaders/${path.basename(name).slice(0, 80)}`,
    mode: 0o644,
    size: bytes.length,
    mtime: 0,
    typeflag: TYPE_PAX_NEXT,
    linkname: "",
  });
  yield bytes;
  if (padding(bytes.length) > 0) yield ZERO_BLOCK.subarray(0, padding(bytes.length));
}

/** One entry's header blocks: a pax header first, when anything overflows ustar. */
function* entryHeaderBlocks(header: TarHeader): Generator<Uint8Array> {
  const nameTooLong = Buffer.byteLength(header.name) > 100;
  const linkTooLong = Buffer.byteLength(header.linkname) > 100;
  const sizeTooBig = header.size > MAX_USTAR_SIZE;
  if (nameTooLong || linkTooLong || sizeTooBig) {
    const records: Record<string, string> = {};
    if (nameTooLong) records.path = header.name;
    if (linkTooLong) records.linkpath = header.linkname;
    if (sizeTooBig) records.size = String(header.size);
    yield* paxRecordBlocks(header.name, records);
  }
  yield buildHeaderBlock({
    ...header,
    // Zero rather than the real size: the octal field cannot hold it, and the
    // pax record above is what a reader takes. A reader that ignores pax sees
    // an empty entry rather than a wrong one, which is the safe way to be wrong.
    size: sizeTooBig ? 0 : header.size,
    name: nameTooLong ? Buffer.from(header.name, "utf8").subarray(0, 100).toString("utf8") : header.name,
    linkname: linkTooLong ? "" : header.linkname,
  });
}

/**
 * Walk a local directory and stream it as one tar, **lazily**.
 *
 * A generator rather than a buffer, for the reason the SDK's whole file surface
 * is generators: this is handed to `fetch` as a request body, and a `pull` that
 * reads one chunk per socket-write is what keeps a ten-gigabyte upload at a
 * constant few hundred kilobytes of memory. Materialising the archive first
 * would defeat every bit of streaming underneath it.
 *
 * Entries are the root's **contents**, at paths relative to it and sorted per
 * directory — so `cp ./dist api:build` makes `build` a copy of `dist` rather
 * than putting a `dist` inside it, and so the same tree produces the same bytes
 * twice, which is what makes a transfer diffable and a test assertable.
 *
 * Anything that is not a file, directory or symlink — a socket, a fifo, a
 * device node — is skipped rather than refused. The operator asked to copy the
 * folder they have; a `.sock` left behind by a running daemon should not fail
 * their upload, and it could not be meaningfully recreated on another machine.
 */
export async function* packLocalTree(
  root: string,
  onEntry?: (entry: LocalTarEntry) => void,
): AsyncGenerator<Uint8Array> {
  async function* walk(absolute: string, relative: string): AsyncGenerator<Uint8Array> {
    const names = (await fs.promises.readdir(absolute)).sort();
    for (const name of names) {
      const childAbsolute = path.join(absolute, name);
      const childRelative = relative.length > 0 ? `${relative}/${name}` : name;
      const stats = await fs.promises.lstat(childAbsolute);

      if (stats.isSymbolicLink()) {
        const target = await fs.promises.readlink(childAbsolute);
        yield* entryHeaderBlocks({
          name: childRelative,
          mode: 0o777,
          size: 0,
          mtime: stats.mtimeMs,
          typeflag: TYPE_SYMLINK,
          linkname: toTarPath(target),
        });
        onEntry?.({
          path: childRelative,
          kind: "symlink",
          size: Buffer.byteLength(target),
          mode: stats.mode & 0o777,
          mtime: Math.floor(stats.mtimeMs),
        });
        continue;
      }

      if (stats.isDirectory()) {
        yield* entryHeaderBlocks({
          name: `${childRelative}/`,
          mode: stats.mode & 0o777,
          size: 0,
          mtime: stats.mtimeMs,
          typeflag: TYPE_DIRECTORY,
          linkname: "",
        });
        onEntry?.({
          path: childRelative,
          kind: "directory",
          size: 0,
          mode: stats.mode & 0o777,
          mtime: Math.floor(stats.mtimeMs),
        });
        yield* walk(childAbsolute, childRelative);
        continue;
      }

      if (!stats.isFile()) continue;

      yield* entryHeaderBlocks({
        name: childRelative,
        mode: stats.mode & 0o777,
        size: stats.size,
        mtime: stats.mtimeMs,
        typeflag: TYPE_FILE,
        linkname: "",
      });
      let written = 0;
      const handle = await fs.promises.open(childAbsolute, "r");
      try {
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          const bytes = chunk as Uint8Array;
          // The header has already promised `stats.size`. A file being appended
          // to underneath the walk would otherwise desynchronise every entry
          // after it, so the stream is clamped to what was declared.
          const room = stats.size - written;
          if (room <= 0) break;
          const slice = bytes.length > room ? bytes.subarray(0, room) : bytes;
          written += slice.length;
          yield slice;
        }
      } finally {
        await handle.close();
      }
      // And a file that shrank leaves the promise unmet, so it is made good
      // with zeros. Either way the archive stays well-formed.
      if (written < stats.size) yield new Uint8Array(stats.size - written);
      if (padding(stats.size) > 0) yield ZERO_BLOCK.subarray(0, padding(stats.size));
      onEntry?.({
        path: childRelative,
        kind: "file",
        size: stats.size,
        mode: stats.mode & 0o777,
        mtime: Math.floor(stats.mtimeMs),
      });
    }
  }

  yield* walk(path.resolve(root), "");
  // Two zero blocks close a tar.
  yield ZERO_BLOCK;
  yield ZERO_BLOCK;
}

/** A local path as a tar path: `\` is a separator here and never inside an archive. */
function toTarPath(local: string): string {
  return local.split(path.sep).join("/");
}

// ─── Unpacking ───────────────────────────────────────────────────────────────

/** Exactly-sized reads out of a chunked byte source. */
class ByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private buffered: Buffer[] = [];
  private available = 0;
  private exhausted = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async fill(want: number): Promise<void> {
    while (this.available < want && !this.exhausted) {
      const next = await this.iterator.next();
      if (next.done) {
        this.exhausted = true;
        return;
      }
      const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      if (chunk.length === 0) continue;
      this.buffered.push(chunk);
      this.available += chunk.length;
    }
  }

  private take(count: number): Buffer {
    const out = Buffer.allocUnsafe(count);
    let filled = 0;
    while (filled < count) {
      const head = this.buffered[0]!;
      const usable = Math.min(head.length, count - filled);
      head.copy(out, filled, 0, usable);
      filled += usable;
      if (usable === head.length) this.buffered.shift();
      else this.buffered[0] = head.subarray(usable);
    }
    this.available -= count;
    return out;
  }

  /** Exactly `count` bytes, or null at a clean end of stream. Throws on a partial tail. */
  async exact(count: number): Promise<Buffer | null> {
    await this.fill(count);
    if (this.available === 0) return null;
    if (this.available < count) {
      throw new LocalTarError(
        "corrupt-archive",
        `the tar stream ended mid-record (${this.available} of ${count} bytes) — the transfer was cut short`,
      );
    }
    return this.take(count);
  }

  /** Up to `max` bytes of whatever has already arrived. */
  async some(max: number): Promise<Buffer | null> {
    await this.fill(1);
    if (this.available === 0) return null;
    return this.take(Math.min(max, this.available));
  }

  async skip(count: number): Promise<void> {
    let left = count;
    while (left > 0) {
      const chunk = await this.some(left);
      if (!chunk) return;
      left -= chunk.length;
    }
  }
}

function parsePaxRecords(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(body.subarray(offset, space).toString("ascii"), 10);
    if (!Number.isFinite(length) || length <= 0 || offset + length > body.length) break;
    const record = body.subarray(space + 1, offset + length).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1).replace(/\n$/, "");
    offset += length;
  }
  return out;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < block.length; i += 1) if (block[i] !== 0) return false;
  return true;
}

/**
 * Where one entry lands, or a refusal.
 *
 * **The string checks are the cheap half and they are not the half that
 * matters.** `..` and a leading `/` are caught first because they are free to
 * catch, but an archive does not need either to escape: two entries do it, and
 * neither one looks wrong on its own.
 *
 *     out -> /somewhere/else      a symlink. Legal — a copy that dropped links
 *                                 would not be a copy.
 *     out/pwned.txt               inside the destination, lexically. Written
 *                                 through the link, to /somewhere/else.
 *
 * `path.resolve` does not resolve symlinks, so it says "inside" for the second
 * entry and the bytes land outside. What closes it is resolving the entry's
 * **parent directory as it exists at the moment of the write** — links written
 * by earlier entries of this same archive included — and re-checking *that*
 * against the destination's own real path. The parent is created first so there
 * is something to resolve, which is work the write needed doing anyway.
 *
 * See the module header for whose disk this protects, and why it is not the
 * client-side path validation #168 rules out.
 */
async function confineEntryTarget(
  realRoot: string,
  entryPath: string,
): Promise<{ absolute: string; result: LocalWriteOutcome }> {
  const cleaned = entryPath.replace(/\/+$/, "");
  if (cleaned.length === 0) return { absolute: realRoot, result: "written" };
  if (cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned)) {
    throw new LocalTarError(
      "unsafe-entry-path",
      `the Core sent an entry with an absolute path (${entryPath}), which will not be written to this machine`,
    );
  }
  if (cleaned.split("/").includes("..")) {
    throw new LocalTarError(
      "unsafe-entry-path",
      `the Core sent an entry with a ".." segment (${entryPath}), which will not be written to this machine`,
    );
  }

  const segments = cleaned.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  const leaf = segments.pop();
  if (leaf === undefined) return { absolute: realRoot, result: "written" };

  const parent = path.resolve(realRoot, ...segments);
  await fs.promises.mkdir(parent, { recursive: true });
  const realParent = await fs.promises.realpath(parent);
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)) {
    throw new LocalTarError(
      "unsafe-entry-path",
      `the Core sent an entry that resolves outside ${realRoot} (${entryPath}) — ` +
        "a symlink in the archive points out of the folder being written. Nothing was written for it",
    );
  }

  const absolute = path.join(realParent, leaf);
  // And the leaf itself: an existing symlink here would be written *through*
  // for a file, and stepped into by `mkdir` for a directory. It is replaced
  // rather than followed — the archive says what belongs at this name.
  //
  // What was already there is read *before* anything is removed, because that
  // is the answer F5 needs: a path this replaced is an overwrite whether it
  // held a file, a folder or a link, and clearing it first would leave nothing
  // to report.
  const existing = await fs.promises.lstat(absolute).catch(() => null);
  if (existing?.isSymbolicLink()) await fs.promises.rm(absolute, { force: true });
  return { absolute, result: existing ? "overwritten" : "written" };
}

export type UnpackResult = { entries: number; bytes: number };

/**
 * Unpack a tar into `destRoot`, one entry at a time.
 *
 * `onEntry` is awaited before the next entry is read, which is what keeps a
 * progress display honest: the line has been rendered before the next file
 * starts, rather than a batch of them arriving after the transfer finished.
 *
 * Modes are applied with an explicit `chmod` after the bytes land — see the
 * module header. Times are restored too, best-effort: a failure to set one is
 * swallowed, because a filesystem that will not take an mtime (some network
 * mounts, some Windows configurations) has not damaged the copy.
 */
export async function unpackTarInto(
  source: AsyncIterable<Uint8Array>,
  destRoot: string,
  onEntry: (entry: UnpackedEntry) => void | Promise<void>,
): Promise<UnpackResult> {
  const root = path.resolve(destRoot);
  await fs.promises.mkdir(root, { recursive: true });
  // Resolved once, and every entry is checked against *this* rather than
  // against the path that was typed: a destination reached through a symlink
  // (`/tmp` on macOS is one) would otherwise fail its own confinement check on
  // the first entry.
  const realRoot = await fs.promises.realpath(root);
  const reader = new ByteReader(source);
  let entries = 0;
  let bytes = 0;
  let zeroBlocks = 0;
  // Overrides that apply to the *next* real entry, from a pax or GNU long-name
  // header. Cleared the moment they are consumed.
  let pendingName: string | null = null;
  let pendingLink: string | null = null;
  let pendingSize: number | null = null;

  for (;;) {
    const block = await reader.exact(BLOCK);
    if (!block) break;
    if (isZeroBlock(block)) {
      zeroBlocks += 1;
      // Two in a row close a tar. Some writers pad further; stopping here means
      // trailing padding is simply not read.
      if (zeroBlocks >= 2) break;
      continue;
    }
    zeroBlocks = 0;

    const header = parseHeader(block);

    if (header.typeflag === TYPE_PAX_NEXT || header.typeflag === TYPE_PAX_GLOBAL) {
      const body = (await reader.exact(header.size + padding(header.size))) ?? Buffer.alloc(0);
      const records = parsePaxRecords(body.subarray(0, header.size));
      // A global header describes the archive, not the next entry, so its
      // records are read for well-formedness and then dropped.
      if (header.typeflag === TYPE_PAX_NEXT) {
        if (typeof records.path === "string") pendingName = records.path;
        if (typeof records.linkpath === "string") pendingLink = records.linkpath;
        if (typeof records.size === "string") {
          const size = Number.parseInt(records.size, 10);
          if (Number.isFinite(size)) pendingSize = size;
        }
      }
      continue;
    }

    if (header.typeflag === TYPE_GNU_LONGNAME || header.typeflag === TYPE_GNU_LONGLINK) {
      const body = (await reader.exact(header.size + padding(header.size))) ?? Buffer.alloc(0);
      const value = body.subarray(0, header.size).toString("utf8").replace(/\0+$/, "");
      if (header.typeflag === TYPE_GNU_LONGNAME) pendingName = value;
      else pendingLink = value;
      continue;
    }

    const name = pendingName ?? header.name;
    const linkname = pendingLink ?? header.linkname;
    const size = pendingSize ?? header.size;
    pendingName = null;
    pendingLink = null;
    pendingSize = null;

    if (header.typeflag === TYPE_DIRECTORY) {
      const { absolute, result } = await confineEntryTarget(realRoot, name);
      await fs.promises.mkdir(absolute, { recursive: true });
      await fs.promises.chmod(absolute, header.mode & 0o777).catch(() => {});
      entries += 1;
      await onEntry({
        path: tarPathOf(name),
        kind: "directory",
        size: 0,
        mode: header.mode & 0o777,
        mtime: header.mtime,
        result,
      });
      continue;
    }

    if (header.typeflag === TYPE_SYMLINK) {
      // The *target* is not resolved or checked. A symlink is a string on this
      // disk until something follows it, and a copy that silently rewrote or
      // dropped links would not be a copy — the Core's own packer preserves
      // them the same way. What is checked is where the link itself lands, and
      // an entry that later tries to write *through* this link is refused by
      // the same check when its own turn comes.
      const { absolute, result } = await confineEntryTarget(realRoot, name);
      if (result === "overwritten") await fs.promises.rm(absolute, { force: true, recursive: true });
      await fs.promises.symlink(linkname, absolute);
      entries += 1;
      await onEntry({
        path: tarPathOf(name),
        kind: "symlink",
        size: Buffer.byteLength(linkname),
        mode: header.mode & 0o777,
        mtime: header.mtime,
        result,
      });
      continue;
    }

    if (header.typeflag !== TYPE_FILE && header.typeflag !== TYPE_FILE_OLD) {
      // A character device, a fifo, a hard link, a type this codec has never
      // heard of. Skipped with its body, rather than refused: the alternative
      // is failing a whole folder copy over one entry that could not have been
      // recreated here anyway.
      await reader.skip(size + padding(size));
      continue;
    }

    const { absolute, result } = await confineEntryTarget(realRoot, name);
    // A directory sitting where a file must land is removed first: `open`
    // would fail with EISDIR. A symlink in the same position was already
    // removed by `confineEntryTarget`, which is what stops the bytes being
    // written through it to wherever it pointed.
    if (result === "overwritten") {
      const existing = await fs.promises.lstat(absolute).catch(() => null);
      if (existing && !existing.isFile()) await fs.promises.rm(absolute, { force: true, recursive: true });
    }

    const handle = await fs.promises.open(absolute, "w");
    try {
      let left = size;
      while (left > 0) {
        const chunk = await reader.some(left);
        if (!chunk) {
          throw new LocalTarError(
            "corrupt-archive",
            `the tar stream ended inside ${name} — ${left} of ${size} bytes never arrived`,
          );
        }
        await handle.write(chunk);
        left -= chunk.length;
        bytes += chunk.length;
      }
    } finally {
      await handle.close();
    }
    await reader.skip(padding(size));
    // After the bytes, and explicitly: `open(…, mode)` is masked by the umask,
    // so a 0o755 handed to it would land as 0o755 & ~umask and an executable
    // would arrive un-executable on most machines.
    await fs.promises.chmod(absolute, header.mode & 0o777).catch(() => {});
    if (header.mtime > 0) {
      const when = new Date(header.mtime);
      await fs.promises.utimes(absolute, when, when).catch(() => {});
    }
    entries += 1;
    await onEntry({
      path: tarPathOf(name),
      kind: "file",
      size,
      mode: header.mode & 0o777,
      mtime: header.mtime,
      result,
    });
  }

  return { entries, bytes };
}

/** An entry's name as it is reported: no trailing slash, whatever the header held. */
function tarPathOf(name: string): string {
  return name.replace(/\/+$/, "");
}

/**
 * A web `ReadableStream` as an async iterable of chunks.
 *
 * `ReadableStream` is async-iterable on Node, but the SDK hands back the
 * *global* declaration and the two are not always the same type to TypeScript —
 * see the cast comment in `core-files-http.ts` for the same two-copies problem
 * one layer down. Reading through `getReader()` is the spelling that is true of
 * every copy, and the `finally` is what tells the Core that an abandoned
 * download can stop: without it a cancelled transfer leaves the Core writing
 * into a socket nobody reads until it times out.
 */
export async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      if (next.value) yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
