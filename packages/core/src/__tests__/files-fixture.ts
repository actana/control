// Throwaway Project roots for the file-transfer suites (#165).
//
// Real directories on a real disk, not a mocked `fs`. Every property these
// tests are about — a symlink resolving out of a tree, an executable bit
// surviving a tar, `statfs` having an answer — is a property of the operating
// system, and a fake filesystem would let all four pass while the Core did the
// wrong thing on a machine.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const roots: string[] = [];

/**
 * A fresh directory, seeded from a description of a tree.
 *
 * A value is a file's contents; a value of `{ mode }` sets the bits as well.
 * `dir/` keys make empty directories, and any parent directory named by a path
 * is created on the way.
 *
 * The returned path is **realpath'd**, because `os.tmpdir()` is a symlink on
 * macOS and half of what this ticket does is compare resolved paths.
 */
export function makeTree(entries: Record<string, string | { content?: string; mode?: number }> = {}): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "actana-files-")));
  roots.push(root);
  writeTree(root, entries);
  return root;
}

/** Seed an existing directory. Same shape as {@link makeTree}. */
export function writeTree(
  root: string,
  entries: Record<string, string | { content?: string; mode?: number }>,
): void {
  for (const [relative, value] of Object.entries(entries)) {
    const target = path.join(root, relative);
    if (relative.endsWith("/")) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const spec = typeof value === "string" ? { content: value } : value;
    fs.writeFileSync(target, spec.content ?? "");
    if (spec.mode !== undefined) fs.chmodSync(target, spec.mode);
  }
}

/** Read a tree back as `{ relativePath: { content, mode } }`, sorted by path. */
export function readTree(root: string): Record<string, { content: string; mode: number }> {
  const out: Record<string, { content: string; mode: number }> = {};
  const walk = (absolute: string, relative: string): void => {
    for (const name of fs.readdirSync(absolute).sort()) {
      const child = path.join(absolute, name);
      const childRelative = relative.length > 0 ? `${relative}/${name}` : name;
      const stats = fs.lstatSync(child);
      if (stats.isDirectory()) {
        walk(child, childRelative);
        continue;
      }
      if (stats.isSymbolicLink()) {
        out[childRelative] = { content: `→ ${fs.readlinkSync(child)}`, mode: stats.mode & 0o777 };
        continue;
      }
      out[childRelative] = { content: fs.readFileSync(child, "utf8"), mode: stats.mode & 0o777 };
    }
  };
  walk(root, "");
  return out;
}

/** Remove every tree handed out so far. Call from `afterEach`. */
export function cleanupTrees(): void {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}

/** Drain an async byte stream into one buffer. */
export async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Feed a buffer back as an async iterable, in chunks, the way a socket would. */
export async function* inChunks(buffer: Buffer, size = 1024): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < buffer.length; offset += size) {
    yield buffer.subarray(offset, Math.min(offset + size, buffer.length));
  }
}
