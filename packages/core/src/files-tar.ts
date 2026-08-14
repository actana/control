// A folder crosses as one streamed tar (#165 F4), packed and unpacked here.
//
// Why tar at all, and why not one request per file, is ADR 0029. Why the codec
// is written out longhand instead of pulled from npm is the same record: the
// unpack side is this ticket's attack surface, every rule it enforces is a
// rule about *this* Core's disk, and a dependency in the Core bundle whose
// default posture is "extract faithfully" would have to be fought on every
// entry anyway. Roughly three hundred lines of ustar, read end to end by a
// reviewer, is the cheaper artifact.
//
// **Unpack validates after resolution, never before.** A `..` inside a tar
// entry is the classic escape and the string check for it below is the cheap
// half; the half that matters is that every entry's destination is resolved
// through the symlinks that exist *at the moment it is written* — including
// symlinks written by an earlier entry of the same tar — and re-checked
// against the Project root. See `confineWriteTarget`.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { confineWriteTarget, resolveDeepestExisting, withinRoot } from "./files-confinement";

const BLOCK = 512;
const ZERO_BLOCK = new Uint8Array(BLOCK);

/** ustar type flags. The three this Core refuses are named, not lumped. */
const TYPE_FILE = "0";
const TYPE_FILE_ALT = "\0";
const TYPE_HARDLINK = "1";
const TYPE_SYMLINK = "2";
const TYPE_CHAR_DEVICE = "3";
const TYPE_BLOCK_DEVICE = "4";
const TYPE_DIRECTORY = "5";
const TYPE_FIFO = "6";
const TYPE_CONTIGUOUS = "7";
const TYPE_PAX_NEXT = "x";
const TYPE_PAX_GLOBAL = "g";
const TYPE_GNU_LONGNAME = "L";
const TYPE_GNU_LONGLINK = "K";

/** Why an entry was refused. Each one is a sentence an operator can act on. */
export type TarRefusalCode =
  | "corrupt-archive"
  | "absolute-entry-path"
  | "dot-dot-entry-path"
  | "root-entry-path"
  | "entry-outside-root"
  | "unsupported-entry-type"
  | "hardlink-outside-root"
  | "symlink-outside-root"
  | "directory-in-the-way";

export class TarError extends Error {
  readonly code: TarRefusalCode;
  constructor(code: TarRefusalCode, message: string) {
    super(message);
    this.name = "TarError";
    this.code = code;
  }
}

/**
 * One entry, as reported to the caller's progress stream.
 *
 * The five fields #129 F10 requires — `path`, `size`, `mtime`, `mode`,
 * `sha256` — are here from this first commit, and that is deliberate. They are
 * free while the bytes are already in hand and cost a second pass over every
 * byte to add later; a diff endpoint is the obvious thing that falls out of
 * them, and it should not have to ask for a re-read of a `node_modules`.
 *
 * `sha256` is null exactly for a directory, which has no bytes. A symlink
 * hashes its target string, which is what a diff would compare.
 */
export type TarEntryReport = {
  /** POSIX-shaped, relative to the transfer root. Never absolute, never `..`. */
  path: string;
  kind: "file" | "directory" | "symlink";
  /** Bytes of content. 0 for a directory; the target's length for a symlink. */
  size: number;
  /** Modification time, epoch milliseconds. */
  mtime: number;
  /** Permission bits, `mode & 0o777`. This is where the executable bit rides. */
  mode: number;
  sha256: string | null;
};

// ─── Header codec ────────────────────────────────────────────────────────────

type TarHeader = {
  name: string;
  mode: number;
  size: number;
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
 * A ustar numeric field: octal, or GNU/pax base-256 for anything that does not
 * fit.
 *
 * The 12-byte size field holds 11 octal digits — 8589934591 bytes, one byte
 * under 8 GiB. Every real tar writer encodes a larger size some other way, and
 * the two ways in the wild are a pax `size` record (handled by the caller) and
 * **base-256**: the high bit of the first byte set, the rest of the field a
 * big-endian integer. Parsing that as octal yields `NaN`, and returning 0 for
 * it — which is what this did — lands the file empty and then desynchronises
 * the stream into a checksum failure two entries later. So it is read properly.
 *
 * Above 2^53 the result stops being exact, but that is 8 PiB in a single tar
 * entry and `Number` is what every field on this surface is.
 */
function readOctal(block: Uint8Array, offset: number, length: number): number {
  const first = block[offset] ?? 0;
  if ((first & 0x80) !== 0) {
    // A leading 0xff is base-256's negative sign. No field this module reads is
    // ever legitimately negative, so it is corruption rather than a value.
    if (first === 0xff) {
      throw new TarError("corrupt-archive", "tar numeric field is negative, which no field on this surface can be");
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

/** The largest size an 11-digit octal ustar field can hold: 8 GiB minus a byte. */
const MAX_USTAR_SIZE = 0o77777777777;

function writeString(block: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) {
    // Callers must have routed this through a pax header already. Reaching here
    // is a bug in this file, not bad input.
    throw new TarError("corrupt-archive", `tar field overflow writing ${JSON.stringify(value)}`);
  }
  block.set(bytes, offset);
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  // ustar writes N-1 octal digits then a NUL. A value that does not fit — a
  // file of 8 GiB or more in a 12-byte size field — is written as a pax `size`
  // record by `packEntryHeader`, which then passes 0 here for the ustar field
  // the record overrides. So reaching the overflow in `writeString` below is a
  // bug in this file rather than a file the operator is not allowed to send.
  const text = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, "0");
  writeString(block, offset, length, `${text}\0`);
}

/**
 * The ustar header checksum, both ways.
 *
 * Historic tars signed the header bytes and modern ones do not, so an archive
 * with a high byte anywhere in a name matches one sum and not the other.
 * Accepting either is what every reader does; rejecting on one of them would
 * refuse legitimate archives from `tar(1)`.
 */
function headerChecksums(block: Uint8Array): { unsigned: number; signed: number } {
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    // The checksum field itself counts as eight spaces.
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
    throw new TarError("corrupt-archive", "tar header checksum does not match — the archive is damaged or is not a tar");
  }
  const prefix = readString(block, 345, 155);
  const name = readString(block, 0, 100);
  return {
    name: prefix.length > 0 ? `${prefix}/${name}` : name,
    mode: readOctal(block, 100, 8) & 0o7777,
    size: readOctal(block, 124, 12),
    // ustar mtime is epoch *seconds*; every field this module hands out is
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
  writeOctal(block, 108, 8, 0); // uid — deliberately 0, see `packEntryHeader`
  writeOctal(block, 116, 8, 0); // gid
  writeOctal(block, 124, 12, header.size);
  writeOctal(block, 136, 12, Math.floor(header.mtime / 1000));
  block.set(Buffer.from("        ", "ascii"), 148); // checksum placeholder
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

/** A pax extended header, for a name or link target longer than ustar's 100. */
function* paxRecordBlocks(name: string, records: Record<string, string>): Generator<Uint8Array> {
  let body = "";
  for (const [key, value] of Object.entries(records)) {
    const payload = `${key}=${value}\n`;
    // The length prefix counts itself, so it is solved rather than measured.
    let length = Buffer.byteLength(payload) + 1;
    while (Buffer.byteLength(`${length}`) + Buffer.byteLength(` ${payload}`) !== length) {
      length = Buffer.byteLength(`${length}`) + Buffer.byteLength(` ${payload}`);
    }
    body += `${length} ${payload}`;
  }
  const bytes = Buffer.from(body, "utf8");
  yield buildHeaderBlock({
    // A pax header's own name is cosmetic — readers key off the type flag —
    // but `tar tv` prints it, so it says which entry it belongs to.
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

/**
 * One entry's header blocks — a pax header first when anything overflows ustar.
 *
 * Exported for the codec's own tests: the three overflow cases (a long name, a
 * long link target, a size of 8 GiB or more) are the ones a round-trip test
 * cannot reach without a fixture that costs 8 GiB of disk to build, and they
 * are exactly the ones worth pinning.
 */
export function* packEntryHeader(header: TarHeader): Generator<Uint8Array> {
  const nameTooLong = Buffer.byteLength(header.name) > 100;
  const linkTooLong = Buffer.byteLength(header.linkname) > 100;
  // #165 F8 says no size cap, and an 11-digit octal field is one at 8 GiB. A
  // pax `size` record carries the real value in decimal and every reader that
  // understands pax — including this module's — takes it over the ustar field.
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
    // 0, not the real size: the ustar field cannot hold it, and the pax record
    // above is what a reader uses. A reader that ignores pax sees an empty
    // entry rather than a wrong one, which is the safe way to be wrong.
    size: sizeTooBig ? 0 : header.size,
    // The ustar fields still have to hold *something* legal. Truncation is safe
    // because the pax record above overrides them for any reader that
    // understands pax, and this Core's reader does.
    name: nameTooLong ? Buffer.from(header.name, "utf8").subarray(0, 100).toString("utf8") : header.name,
    linkname: linkTooLong ? "" : header.linkname,
  });
}

/**
 * Walk a directory and stream it as one tar.
 *
 * Ownership is flattened to uid/gid 0 and no uname/gname is written. A transfer
 * crosses machines that do not share a passwd file, so preserving numeric
 * ownership would restore a stranger's uid at the far end; the bit that has to
 * survive is the executable one, and that rides `mode`.
 *
 * Entries are emitted in sorted order per directory, so the same tree produces
 * the same bytes twice — which is what makes a transfer diffable and a test
 * assertable.
 *
 * Anything that is not a file, directory or symlink — a socket, a fifo, a
 * device node — is skipped rather than refused. Packing is the read side and
 * the operator asked for the folder they have; a `.sock` left by a running
 * daemon should not fail their upload, and it cannot be meaningfully recreated
 * on another machine anyway.
 */
export async function* packDirectory(
  root: string,
  onEntry?: (entry: TarEntryReport) => void,
): AsyncGenerator<Uint8Array> {
  const realRoot = await fs.promises.realpath(root);

  async function* walk(absolute: string, relative: string): AsyncGenerator<Uint8Array> {
    const names = (await fs.promises.readdir(absolute)).sort();
    for (const name of names) {
      const childAbsolute = path.join(absolute, name);
      const childRelative = relative.length > 0 ? `${relative}/${name}` : name;
      const stats = await fs.promises.lstat(childAbsolute);

      if (stats.isSymbolicLink()) {
        const target = await fs.promises.readlink(childAbsolute);
        yield* packEntryHeader({
          name: childRelative,
          mode: 0o777,
          size: 0,
          mtime: stats.mtimeMs,
          typeflag: TYPE_SYMLINK,
          linkname: target,
        });
        onEntry?.({
          path: childRelative,
          kind: "symlink",
          size: Buffer.byteLength(target),
          mtime: Math.floor(stats.mtimeMs),
          mode: stats.mode & 0o777,
          sha256: createHash("sha256").update(target).digest("hex"),
        });
        continue;
      }

      if (stats.isDirectory()) {
        yield* packEntryHeader({
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
          mtime: Math.floor(stats.mtimeMs),
          mode: stats.mode & 0o777,
          sha256: null,
        });
        yield* walk(childAbsolute, childRelative);
        continue;
      }

      if (!stats.isFile()) continue;

      yield* packEntryHeader({
        name: childRelative,
        mode: stats.mode & 0o777,
        size: stats.size,
        mtime: stats.mtimeMs,
        typeflag: TYPE_FILE,
        linkname: "",
      });
      const hash = createHash("sha256");
      let written = 0;
      const handle = await fs.promises.open(childAbsolute, "r");
      try {
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          const bytes = chunk as Uint8Array;
          // The header already promised `stats.size`. A file being appended to
          // underneath us would otherwise desynchronise every following entry,
          // so the stream is clamped to what was declared.
          const room = stats.size - written;
          if (room <= 0) break;
          const slice = bytes.length > room ? bytes.subarray(0, room) : bytes;
          hash.update(slice);
          written += slice.length;
          yield slice;
        }
      } finally {
        await handle.close();
      }
      // And a file that shrank leaves the promise unmet, so it is made up with
      // zeros. Either way the archive stays well-formed.
      if (written < stats.size) yield new Uint8Array(stats.size - written);
      if (padding(stats.size) > 0) yield ZERO_BLOCK.subarray(0, padding(stats.size));
      onEntry?.({
        path: childRelative,
        kind: "file",
        size: stats.size,
        mtime: Math.floor(stats.mtimeMs),
        mode: stats.mode & 0o777,
        sha256: hash.digest("hex"),
      });
    }
  }

  yield* walk(realRoot, "");
  // Two zero blocks close a tar.
  yield ZERO_BLOCK;
  yield ZERO_BLOCK;
}

// ─── Unpacking ───────────────────────────────────────────────────────────────

/** Pulls exactly-sized reads out of a chunked byte source. */
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
      throw new TarError("corrupt-archive", `tar stream ended mid-record (${this.available} of ${count} bytes)`);
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

export type TarUnpackResult = {
  entries: number;
  bytes: number;
};

/**
 * The result of writing one entry — the half of the report that is about what
 * happened rather than about the bytes. Overwrite is the default (#165 F5) and
 * every overwrite is named, which is what this discriminant is for.
 */
export type TarWriteOutcome = "written" | "overwritten";

/**
 * Unpack a tar into `destRoot`, one entry at a time, refusing anything that
 * would land outside `confineRoot`.
 *
 * `destRoot` is where the archive is written; `confineRoot` is the Project root
 * every entry must stay under. They differ when an upload targets a subfolder —
 * the archive unpacks into `<project>/vendor` and is still confined to
 * `<project>`, so a tar that walks up out of `vendor` is refused even though
 * `vendor` is not the boundary.
 *
 * `onEntry` is awaited before the next entry is read. That is what keeps the
 * NDJSON progress stream honest: a line has been handed to the response before
 * the next file starts, rather than a batch of them arriving after the fact.
 */
export async function unpackTarInto(
  source: AsyncIterable<Uint8Array>,
  destRoot: string,
  confineRoot: string,
  onEntry: (report: TarEntryReport & { result: TarWriteOutcome }) => void | Promise<void>,
): Promise<TarUnpackResult> {
  const reader = new ByteReader(source);
  const realConfineRoot = await fs.promises.realpath(confineRoot);
  let entries = 0;
  let bytes = 0;
  let zeroBlocks = 0;
  // Overrides that apply to the *next* real entry, from a pax or GNU long-name
  // header. Cleared as soon as they are consumed.
  let pendingName: string | null = null;
  let pendingLink: string | null = null;
  // A pax `size` record is how a writer states a size the 11-digit octal ustar
  // field cannot hold (8 GiB and up). It overrides the header field for the
  // next real entry, exactly as `path` and `linkpath` do.
  let pendingSize: number | null = null;

  for (;;) {
    const block = await reader.exact(BLOCK);
    if (!block) break;
    if (isZeroBlock(block)) {
      zeroBlocks += 1;
      // Two in a row is the end-of-archive marker. Some writers pad further;
      // stopping here means trailing padding is simply not read.
      if (zeroBlocks >= 2) break;
      continue;
    }
    zeroBlocks = 0;

    const header = parseHeader(block);
    // A pax record only ever describes the *next* real entry, and a pax or GNU
    // metadata block is not one — so the override is applied here and consumed
    // where the name and link overrides are, below.
    const isMetadataEntry =
      header.typeflag === TYPE_PAX_NEXT ||
      header.typeflag === TYPE_PAX_GLOBAL ||
      header.typeflag === TYPE_GNU_LONGNAME ||
      header.typeflag === TYPE_GNU_LONGLINK;
    const bodySize = !isMetadataEntry && pendingSize !== null ? pendingSize : header.size;
    const bodyPadding = padding(bodySize);

    // ── Metadata-only entries: read, remember, move on ──
    if (header.typeflag === TYPE_PAX_NEXT || header.typeflag === TYPE_PAX_GLOBAL) {
      const body = (await reader.exact(bodySize)) ?? Buffer.alloc(0);
      await reader.skip(bodyPadding);
      // Global records are parsed and dropped: nothing this Core does with a
      // tar depends on them, and honouring a global `path` would rename every
      // following entry, which is not a thing an operator ever means.
      if (header.typeflag === TYPE_PAX_NEXT) {
        const records = parsePaxRecords(body);
        if (typeof records.path === "string") pendingName = records.path;
        if (typeof records.linkpath === "string") pendingLink = records.linkpath;
        if (typeof records.size === "string") {
          const declared = Number(records.size);
          if (Number.isFinite(declared) && declared >= 0) pendingSize = declared;
        }
      }
      continue;
    }
    if (header.typeflag === TYPE_GNU_LONGNAME || header.typeflag === TYPE_GNU_LONGLINK) {
      const body = (await reader.exact(bodySize)) ?? Buffer.alloc(0);
      await reader.skip(bodyPadding);
      const value = body.toString("utf8").replace(/\0+$/, "");
      if (header.typeflag === TYPE_GNU_LONGNAME) pendingName = value;
      else pendingLink = value;
      continue;
    }

    const rawName = pendingName ?? header.name;
    const rawLink = pendingLink ?? header.linkname;
    pendingName = null;
    pendingLink = null;
    pendingSize = null;

    // ── The refusals the ticket names, in the order they are cheapest ──
    //
    // A device node, a fifo or a socket is refused outright rather than
    // skipped. Skipping is right on the *pack* side, where the operator asked
    // for a folder that happens to contain one; here the archive is asking this
    // Core to create one, which is never something a file transfer means and is
    // the shape of the request worth being loud about.
    if (
      header.typeflag === TYPE_CHAR_DEVICE ||
      header.typeflag === TYPE_BLOCK_DEVICE ||
      header.typeflag === TYPE_FIFO
    ) {
      throw new TarError(
        "unsupported-entry-type",
        `tar entry ${JSON.stringify(rawName)} is a device node or fifo (type ${header.typeflag}), which a file transfer does not create`,
      );
    }
    if (
      header.typeflag !== TYPE_FILE &&
      header.typeflag !== TYPE_FILE_ALT &&
      header.typeflag !== TYPE_CONTIGUOUS &&
      header.typeflag !== TYPE_DIRECTORY &&
      header.typeflag !== TYPE_SYMLINK &&
      header.typeflag !== TYPE_HARDLINK
    ) {
      throw new TarError(
        "unsupported-entry-type",
        `tar entry ${JSON.stringify(rawName)} has unsupported type ${JSON.stringify(header.typeflag)}`,
      );
    }

    // The entry's path, resolved and *then* checked — including through any
    // symlink an earlier entry of this same archive just created.
    const entryRelative = rawName.replace(/\/+$/, "");
    // `confineWriteTarget`, not `confineToProjectRoot`: the entry's parents are
    // resolved — that is where an escape hides — and its last component is
    // left literal, so an entry called `notes.txt` creates `notes.txt` rather
    // than writing through a `notes.txt` symlink that is already there.
    const confined = confineWriteTarget(destRoot, entryRelative);
    if (!confined.ok) {
      throw new TarError(
        confined.reason === "absolute-path"
          ? "absolute-entry-path"
          : confined.reason === "dot-dot-segment"
            ? "dot-dot-entry-path"
            : "entry-outside-root",
        `tar entry ${JSON.stringify(rawName)}: ${confined.message}`,
      );
    }
    // `confineToProjectRoot` measured against `destRoot`; the Project root is
    // the boundary that actually matters, so it is asserted separately. When
    // the two are the same path this is a second reading of the same answer,
    // which is cheap, and when they differ it is the only check of the two that
    // is about the boundary the ticket names.
    if (!withinRoot(confined.absolute, realConfineRoot)) {
      throw new TarError(
        "entry-outside-root",
        `tar entry ${JSON.stringify(rawName)} resolves to ${confined.absolute}, outside the Project root`,
      );
    }
    // ── An entry that names the unpack root itself ──
    //
    // Read off `confined.relative` and not off `rawName`, for the same reason
    // the single-file guard at the top of `handlePut` reads the resolved answer:
    // confinement already collapses every spelling of the root into one — `.`,
    // `./`, `./.`, `././`, any trailing-slash or whitespace-padded variant, a
    // nameless entry, and the same set arriving through a pax `path` or GNU
    // long-name override, which are applied to `rawName` before this line. A
    // string test over the raw name would instead be a list of spellings
    // somebody has to keep complete, and the one that got missed is the bug.
    //
    // `/` and `//` land here too, and not on the absolute refusal above: the
    // trailing-slash strip runs *first*, so a name that is nothing but slashes
    // reaches confinement as `""`. `/.` keeps a non-slash last character and so
    // is still answered as `absolute-entry-path`, which is the more specific
    // and more useful complaint about it. Both are refused; only the code
    // differs, and the hardening suite pins each.
    //
    // A **directory** entry here is `tar(1)`'s leading `./`, which every
    // `tar -cf - .` archive opens with, so it is skipped rather than refused —
    // the root already exists as a directory and the archive's *contents*
    // unpack into it. Skipped rather than applied, note: the entry carries mode
    // bits, and an archive somebody dropped has no business restyling the
    // permissions of the Project root it was dropped on.
    //
    // Anything else is refused, and this is the same defect the single-file
    // `PUT` guard refuses one branch over. A regular file named `.` asks this
    // Core to replace the root with a node of another type, and the write below
    // would have done it: `lstat` finds a directory, an *empty* root passes
    // `refuseNonEmptyDirectory` with nothing to lose, `rm -r` then takes the
    // Project root away, and `open(…, "w")` puts a file at its path — no
    // listing, no transfers, no working directory for a harness, and a fix by
    // hand on the Core machine. It is worse here than on the `PUT` branch,
    // because the 200 is already spent and the stream would otherwise have
    // reported `done` over it.
    if (confined.relative.length === 0) {
      if (header.typeflag === TYPE_DIRECTORY) {
        // `skip` and not a bare `continue`, for the reason the "entries with no
        // body of their own" note below gives: a bodyless entry that declares a
        // body has to be walked past, or the stream desynchronises.
        await reader.skip(bodySize + bodyPadding);
        continue;
      }
      throw new TarError(
        "root-entry-path",
        `tar entry ${JSON.stringify(rawName)} names the unpack root itself, which no file transfer writes — ` +
          "an archive carries the root's contents, and only a directory entry may name the root",
      );
    }

    // ── Entries with no body of their own ──
    //
    // A directory, a symlink and a hardlink all carry size 0 from any writer
    // that means well, so the three `continue`s below used to walk straight on
    // to the next block. An archive that declares a non-zero size on one of
    // them then desynchronises the stream: the next 512 bytes read as a header,
    // fail their checksum, and the whole transfer dies as `corrupt-archive`.
    //
    // That fails closed and no escape follows from it — whatever is parsed
    // still goes through `confineWriteTarget` — but "two parsers disagree about
    // where the next entry starts" is the shape that produces real bugs later,
    // and `tar(1)` skips the declared body. So this one does too, and the
    // hardening suite has a case for it.
    const target = confined.absolute;
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const existing = await lstatOrNull(target);
    const result: TarWriteOutcome = existing ? "overwritten" : "written";
    const mode = (header.mode & 0o777) || (header.typeflag === TYPE_DIRECTORY ? 0o755 : 0o644);

    if (header.typeflag === TYPE_DIRECTORY) {
      if (existing && !existing.isDirectory()) await fs.promises.rm(target, { force: true });
      await fs.promises.mkdir(target, { recursive: true });
      await fs.promises.chmod(target, mode);
      entries += 1;
      await onEntry({ path: confined.relative, kind: "directory", size: 0, mtime: header.mtime, mode, sha256: null, result });
      await reader.skip(bodySize + bodyPadding);
      continue;
    }

    if (header.typeflag === TYPE_SYMLINK || header.typeflag === TYPE_HARDLINK) {
      // Where does the link point, once resolved? For a symlink the target is
      // interpreted relative to the link's own directory; for a hardlink it is
      // relative to the archive root. Both are checked the same way and for the
      // same reason: an accident that reaches out of the Project is refused
      // here rather than discovered later by whatever follows the link.
      const base = header.typeflag === TYPE_SYMLINK ? path.dirname(target) : destRoot;
      const resolved = path.isAbsolute(rawLink)
        ? resolveDeepestExisting(rawLink)
        : resolveDeepestExisting(path.join(base, rawLink));
      if (!withinRoot(resolved, realConfineRoot)) {
        throw new TarError(
          header.typeflag === TYPE_SYMLINK ? "symlink-outside-root" : "hardlink-outside-root",
          `tar entry ${JSON.stringify(rawName)} links to ${resolved}, which is outside the Project root ${realConfineRoot}`,
        );
      }
      if (existing) {
        await refuseNonEmptyDirectory(target, confined.relative, existing);
        await fs.promises.rm(target, { force: true, recursive: true });
      }
      if (header.typeflag === TYPE_SYMLINK) await fs.promises.symlink(rawLink, target);
      else await fs.promises.link(resolved, target);
      entries += 1;
      await onEntry({
        path: confined.relative,
        kind: header.typeflag === TYPE_SYMLINK ? "symlink" : "file",
        size: Buffer.byteLength(rawLink),
        mtime: header.mtime,
        mode,
        sha256: createHash("sha256").update(rawLink).digest("hex"),
        result,
      });
      await reader.skip(bodySize + bodyPadding);
      continue;
    }

    // ── A regular file ──
    //
    // An existing symlink is removed rather than written through. `open(…, "w")`
    // follows a symlink, so a tar that plants `link → /etc/cron.d/x` and then
    // writes `link` would land its bytes there with every string check passed.
    // The containment check above already refuses the *link*, so this is the
    // second of two independent reasons that write cannot happen.
    if (existing && !existing.isFile()) {
      await refuseNonEmptyDirectory(target, confined.relative, existing);
      await fs.promises.rm(target, { force: true, recursive: true });
    } else if (existing?.isSymbolicLink()) await fs.promises.rm(target, { force: true });

    const hash = createHash("sha256");
    const handle = await fs.promises.open(target, "w", mode);
    try {
      let left = bodySize;
      while (left > 0) {
        const chunk = await reader.some(left);
        if (!chunk) throw new TarError("corrupt-archive", `tar stream ended inside ${JSON.stringify(rawName)}`);
        hash.update(chunk);
        await handle.write(chunk);
        left -= chunk.length;
      }
    } finally {
      await handle.close();
    }
    await reader.skip(bodyPadding);
    // `open(…, mode)` only applies the mode when the file is created, so an
    // overwrite of an existing file would keep the old bits. The executable bit
    // surviving a round trip is an acceptance criterion, so it is set outright.
    await fs.promises.chmod(target, mode);
    if (header.mtime > 0) {
      const seconds = header.mtime / 1000;
      await fs.promises.utimes(target, seconds, seconds);
    }
    entries += 1;
    bytes += bodySize;
    await onEntry({
      path: confined.relative,
      kind: "file",
      size: bodySize,
      mtime: header.mtime,
      mode,
      sha256: hash.digest("hex"),
      result,
    });
  }

  return { entries, bytes };
}

/**
 * Refuse to delete a non-empty tree to make room for a file or a link.
 *
 * Overwrite-by-default (#165 F5) is about replacing a *file*. An archive whose
 * `src` entry is a regular file, landing on a `src/` that holds a hundred, is
 * asking for a recursive delete that nothing in the ticket, ADR 0029 D6 or
 * `docs/external-api.md` promises — and `tar(1)` refuses it rather than
 * performing it. An *empty* directory is still replaced: there is nothing to
 * lose, and a stray `mkdir` should not wedge a path forever.
 *
 * Refusing mid-archive leaves the entries before this one written, which is
 * true of every other refusal in this file and is why the progress stream
 * reports each entry as it lands.
 */
async function refuseNonEmptyDirectory(target: string, relative: string, existing: fs.Stats): Promise<void> {
  if (!existing.isDirectory()) return;
  const contents = await fs.promises.readdir(target).catch(() => [] as string[]);
  if (contents.length === 0) return;
  throw new TarError(
    "directory-in-the-way",
    `tar entry ${JSON.stringify(relative)} would replace a directory holding ${contents.length} ` +
      `entr${contents.length === 1 ? "y" : "ies"} with a file — this Core does not delete a tree to make room for one`,
  );
}

async function lstatOrNull(target: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(target);
  } catch {
    return null;
  }
}
