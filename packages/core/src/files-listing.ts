// Walking a Project's tree, one entry at a time (#166, F7 and the manifest half
// of F10).
//
// **Nothing here builds a tree.** The walk is an async generator that yields an
// entry the moment it has one and forgets it immediately; the caller streams
// each as an NDJSON line. That is the whole of "listing a large tree does not
// buffer it in memory on either side": the only state this walk holds is the
// chain of directories it is currently inside, which is bounded by the depth of
// the tree and not by its size.
//
// It reads the disk and nothing else, because there is nothing else to read —
// ADR 0027 D1: a Project's files are the directory, there is no index, and a
// `readdir` is right at the moment it returns. Which is also why an entry that
// vanishes between the `opendir` and the `lstat` is skipped rather than raised:
// a Project is a folder a harness is actively writing to, and a listing that
// fails because a build deleted a temp file underneath it would fail most of
// the time on exactly the Projects worth looking at.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * One entry of a listing — the five fields #129 F10 fixes, and a `kind`.
 *
 * Deliberately the same five names, in the same units, as `TarEntryReport` in
 * `files-tar.ts`: `mtime` in epoch milliseconds, `mode` masked to `0o777`, a
 * POSIX-shaped path relative to the **Project root** rather than to whatever
 * subtree was asked for. A client that reads a listing and a client that reads
 * an upload's progress stream are reading the same manifest shape, which is
 * the shape F10's future diff endpoint compares.
 */
export type FileListingEntry = {
  /** Project-relative, `/`-separated. Never absolute, never `..`. */
  path: string;
  kind: "file" | "directory" | "symlink";
  /** Bytes of content. 0 for a directory; the target's length for a symlink. */
  size: number;
  /** Modification time, epoch milliseconds. */
  mtime: number;
  /** Permission bits, `mode & 0o777`. This is where the executable bit rides. */
  mode: number;
  /**
   * The digest, **or null because it was not computed** — see
   * {@link FileListingOptions.sha256}. Null is not "this file has no digest";
   * for a directory it means there are no bytes to digest, and for anything
   * else it means nobody asked. A caller that needs to tell those apart knows
   * which of the two it requested.
   */
  sha256: string | null;
};

/** Why one path of the tree is not in the listing, while the rest of it is. */
export type FileListingSkipCode =
  /** `opendir` refused — permissions, most often. Its parent is still listed. */
  | "unreadable-directory"
  /** A digest was asked for and the file's bytes could not be read. */
  | "unreadable-file"
  /** A directory that contains one of its own ancestors. See {@link listTree}. */
  | "directory-cycle";

/**
 * One line of a listing.
 *
 * A discriminated union rather than two generators, because the order of the
 * two matters to a reader: a skip belongs where it happened in the walk, next
 * to the entries around it, and a caller that collected them separately would
 * have to reconstruct that. It is also the exact shape that goes on the wire —
 * the route `JSON.stringify`s these lines, it does not translate them.
 */
export type FileListingLine =
  | ({ type: "entry" } & FileListingEntry)
  | { type: "skipped"; path: string; code: FileListingSkipCode; message: string };

export type FileListingOptions = {
  /**
   * How many levels below the listed path to walk. `1` is the immediate
   * children; the default is the whole subtree, which is what "arbitrary depth"
   * (#166) asks for and what an unbounded stream can afford to promise.
   */
  depth?: number;
  /**
   * Compute `sha256` for every file and symlink (#166's trap, ADR 0027 D6).
   *
   * **Off by default, and that is the decision, not an oversight.** A listing's
   * metadata comes out of the `lstat` the walk makes anyway; a digest costs a
   * full read of every byte in the tree, which is a second pass over a
   * `node_modules` that nothing in phase 3 consumes. ADR 0027 D4's argument for
   * carrying the digest — that it is free *while the bytes are in hand* — is
   * exactly the argument that does not hold here, because a listing never has
   * the bytes in hand.
   *
   * So the field is **available on request rather than free**, which is what
   * F10 asks for: a future diff endpoint asks for digests and pays for them,
   * and a Panel drawing a folder does not pay for what it will not draw.
   */
  sha256?: boolean;
};

/**
 * Walk `absolute`, yielding a line per entry, deepest-last within a directory.
 *
 * `base` is where `absolute` sits relative to the Project root, and every path
 * yielded is prefixed with it — so a listing of `src` reports `src/index.ts`,
 * which is the string an operator hands back to `GET`. The caller has already
 * confined both (`files-confinement.ts`); this function does no path checking
 * of its own and must never be handed an unconfined path.
 *
 * **Symlinks are reported and never followed.** A link is an entry of its own —
 * `kind: "symlink"`, `size` the length of its target, the target itself the
 * thing a digest covers — and the walk does not descend through it. Two
 * reasons, and the second is the load-bearing one: following links makes a
 * self-referential link an infinite listing, and a link pointing out of the
 * Project would put paths from outside the root into a stream whose every path
 * is supposed to be Project-relative. Confinement is checked on the way in;
 * not descending through links is what keeps it true for the whole walk.
 *
 * A directory can still contain one of its own ancestors without a symlink —
 * a bind mount is the way it happens in practice — so the ancestor chain is
 * carried down as `dev:ino` pairs and a repeat is reported as a
 * `directory-cycle` skip rather than walked. The chain, not a set of everything
 * seen: a cycle must revisit an ancestor, so the check is O(depth) and the walk
 * keeps its promise about memory.
 *
 * Throws only for the listed path itself — a missing or unreadable `absolute`,
 * which the caller turns into a status code because no byte of the response has
 * gone out yet. Everything that fails deeper in the tree is a `skipped` line.
 */
export async function* listTree(
  absolute: string,
  base: string,
  options: FileListingOptions = {},
): AsyncGenerator<FileListingLine> {
  const depth = options.depth ?? Number.POSITIVE_INFINITY;
  const digests = options.sha256 === true;

  // `lstat`, not `stat`, and it makes no difference for the path that was
  // asked for: `confineToProjectRoot` already resolved it through every
  // symlink, so what is here is the real thing it named.
  const stats = await fs.promises.lstat(absolute);
  if (!stats.isDirectory()) {
    const line = await describeLeaf(absolute, base, stats, digests);
    if (line) yield line;
    return;
  }

  yield* walk(absolute, base, 1, [identity(stats)], depth, digests);
}

async function* walk(
  absolute: string,
  base: string,
  level: number,
  ancestors: string[],
  depth: number,
  digests: boolean,
): AsyncGenerator<FileListingLine> {
  let dir: fs.Dir;
  try {
    // `opendir` rather than `readdir`: it reads the directory in batches as it
    // is iterated, so a folder with a hundred thousand entries in it costs a
    // buffer of a few dozen names rather than a hundred thousand strings. It is
    // also why a listing arrives in the filesystem's order and not sorted —
    // sorting a directory means holding all of it, which is the one thing this
    // walk promises not to do. A caller that displays an order sorts what it
    // has chosen to display, which it is holding anyway.
    dir = await fs.promises.opendir(absolute);
  } catch (err) {
    yield {
      type: "skipped",
      path: base,
      code: "unreadable-directory",
      message: `could not read this directory: ${reason(err)}`,
    };
    return;
  }

  // The `for await` closes the handle when it ends — including when this
  // generator is abandoned part-way, because the consumer's `return()` reaches
  // it as a `break`. That is the case that matters: an operator who closes a
  // listing of a huge tree half-way must not leave a directory handle open on
  // every level of the path they were inside.
  for await (const child of dir) {
    const childAbsolute = path.join(absolute, child.name);
    const childPath = base.length > 0 ? `${base}/${child.name}` : child.name;

    let stats: fs.Stats;
    try {
      stats = await fs.promises.lstat(childAbsolute);
    } catch {
      // Gone between the `opendir` and here. The ordinary case on a live
      // Project (ADR 0027 D1), not a failure: the answer is what was there
      // when it was asked, and this was not there.
      continue;
    }

    if (stats.isDirectory()) {
      yield {
        type: "entry",
        path: childPath,
        kind: "directory",
        size: 0,
        mtime: Math.floor(stats.mtimeMs),
        mode: stats.mode & 0o777,
        sha256: null,
      };
      if (level >= depth) continue;
      const id = identity(stats);
      if (ancestors.includes(id)) {
        yield {
          type: "skipped",
          path: childPath,
          code: "directory-cycle",
          message: "this directory contains one of its own ancestors — a mount loop, most likely — so it is not walked",
        };
        continue;
      }
      yield* walk(childAbsolute, childPath, level + 1, [...ancestors, id], depth, digests);
      continue;
    }

    const line = await describeLeaf(childAbsolute, childPath, stats, digests);
    if (line) yield line;
  }
}

/**
 * A file, a symlink, or something that is neither.
 *
 * Returns null for a socket, a fifo or a device node — skipped silently and not
 * reported as a skip, exactly as `packDirectory` skips them. They are not
 * missing from the listing by accident and there is nothing an operator can do
 * about a `.sock` a running daemon left behind; a `skipped` line per socket
 * would be noise in every listing of a Project with a dev server in it.
 */
async function describeLeaf(
  absolute: string,
  relative: string,
  stats: fs.Stats,
  digests: boolean,
): Promise<FileListingLine | null> {
  if (stats.isSymbolicLink()) {
    let target: string;
    try {
      target = await fs.promises.readlink(absolute);
    } catch {
      return null;
    }
    return {
      type: "entry",
      path: relative,
      kind: "symlink",
      // The target string is the symlink's content, so it is what `size`
      // measures and what a digest covers — the same answer `packDirectory`
      // gives, so the two manifests agree about a link.
      size: Buffer.byteLength(target),
      mtime: Math.floor(stats.mtimeMs),
      mode: stats.mode & 0o777,
      sha256: digests ? createHash("sha256").update(target).digest("hex") : null,
    };
  }

  if (!stats.isFile()) return null;

  let sha256: string | null = null;
  if (digests) {
    try {
      sha256 = await digestFile(absolute);
    } catch (err) {
      // A `skipped` line rather than an entry carrying `sha256: null`. The
      // caller asked for digests, so a null in the field it asked for would be
      // indistinguishable from "not computed" — which is precisely the
      // ambiguity the entry shape cannot carry, and precisely what a diff
      // endpoint would silently read as "unchanged".
      return {
        type: "skipped",
        path: relative,
        code: "unreadable-file",
        message: `could not read this file to digest it: ${reason(err)}`,
      };
    }
  }

  return {
    type: "entry",
    path: relative,
    kind: "file",
    size: stats.size,
    mtime: Math.floor(stats.mtimeMs),
    mode: stats.mode & 0o777,
    sha256,
  };
}

/**
 * Hash a file's bytes without holding them.
 *
 * A stream and not a `readFile`, because the file being digested may be the
 * multi-gigabyte one, and a listing that buffers a single file has broken the
 * same promise as a listing that buffers the tree.
 */
async function digestFile(absolute: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await fs.promises.open(absolute, "r");
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk as Uint8Array);
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

/** A directory's identity on this machine, for the ancestor-chain check. */
function identity(stats: fs.Stats): string {
  return `${stats.dev}:${stats.ino}`;
}

function reason(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ?? err.message;
  }
  return String(err);
}
