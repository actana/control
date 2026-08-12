// The blob registry — one blob per named Core on disk (#129 D9).
//
//   $XDG_CONFIG_HOME/actana/cores/<name>.txt   the blob, mode 0600
//   $XDG_CONFIG_HOME/actana/current.txt        the `current` pointer, a name
//
// with `$XDG_CONFIG_HOME` defaulting to `~/.config`. That is the same directory
// `actana setup` writes a Core's own `registration-blob.txt` and `material.json`
// into, and deliberately so: one command name (#129 D8) reading one config
// directory is the arrangement an operator can hold in their head. The `cores/`
// subdirectory is what keeps the client half's files from colliding with the
// machine half's.
//
// **The pointer is a sibling of `cores/`, not a file inside it.** A Core named
// `current` is a perfectly reasonable thing to name a Core, and a registry that
// stored the pointer at `cores/current.txt` would quietly make that name mean
// two things.
//
// Everything here is filesystem-shaped and nothing here is client-shaped: no
// dialling, no SDK, no frames. The registry answers "which Cores does this
// machine know about, and where is the credential for one of them" and stops.

import * as fs from "node:fs";
import * as path from "node:path";
import { decodeRegistrationBlobText, summarizeBlob, type BlobSummary } from "./registration-blob-file.ts";
import type { CoreRegistrationBlob } from "@actana/sdk/core-registration-blob.ts";

/** Mode for a file holding a credential: owner read/write, nobody else. */
export const BLOB_FILE_MODE = 0o600;

/** Mode for the directory holding them: owner only, so a listing is private too. */
export const REGISTRY_DIR_MODE = 0o700;

/** The three paths the registry is made of, resolved once. */
export type RegistryPaths = {
  /** `<config>/actana` — shared with the Core's machine-side files. */
  root: string;
  /** `<config>/actana/cores` — one `<name>.txt` per Core this machine knows. */
  coresDir: string;
  /** `<config>/actana/current.txt` — holds a name, not a blob. */
  currentPointer: string;
};

/**
 * Where the registry lives, honouring `XDG_CONFIG_HOME`.
 *
 * A relative `XDG_CONFIG_HOME` is ignored rather than resolved against the
 * working directory: the specification says the variable holds an absolute
 * path, and a registry whose location depends on where the operator happened to
 * be standing when they ran `actana core add` is a registry that loses Cores.
 */
export function registryPaths(env: NodeJS.ProcessEnv, home: string): RegistryPaths {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const configHome = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".config");
  const root = path.join(configHome, "actana");
  return {
    root,
    coresDir: path.join(root, "cores"),
    currentPointer: path.join(root, "current.txt"),
  };
}

/** Longest accepted Core name. Long enough to be descriptive, short enough to tabulate. */
const MAX_NAME_LENGTH = 64;

/**
 * Why this name cannot be used, or null when it can.
 *
 * The pattern is narrow because a name becomes a path segment. Nothing that
 * could traverse (`..`, a separator), hide (a leading dot), or arrive from a
 * shell's expansion of something else gets through — this is the one place a
 * caller-supplied string is concatenated onto a directory, so it is checked
 * here rather than at each of the five verbs that pass one in.
 */
export function coreNameError(name: string): string | null {
  if (!name) return "a Core name is required";
  if (name.length > MAX_NAME_LENGTH) {
    return `a Core name is at most ${MAX_NAME_LENGTH} characters`;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    return "a Core name starts with a letter or digit and holds only letters, digits, dot, dash and underscore";
  }
  return null;
}

/** The path a named Core's blob is stored at. The name must already be valid. */
export function coreBlobPath(paths: RegistryPaths, name: string): string {
  return path.join(paths.coresDir, `${name}.txt`);
}

/**
 * Write a Core's blob, at mode 0600, creating the registry if it is not there.
 *
 * The mode is set twice on purpose. `writeFileSync`'s `mode` applies only when
 * the file is *created*, so re-adding a Core over a file that some earlier tool
 * left world-readable would silently keep the loose mode; the explicit
 * `chmodSync` is what makes 0600 a post-condition of this function rather than
 * a property of the happy path. Both are cheap and only one of them is enough
 * on any given call — which is the point.
 */
export function writeCoreBlob(paths: RegistryPaths, name: string, text: string): void {
  fs.mkdirSync(paths.coresDir, { recursive: true, mode: REGISTRY_DIR_MODE });
  const file = coreBlobPath(paths, name);
  fs.writeFileSync(file, `${text.trim()}\n`, { mode: BLOB_FILE_MODE });
  fs.chmodSync(file, BLOB_FILE_MODE);
}

/** The stored text for a named Core, or null when this machine has no such Core. */
export function readCoreBlobText(paths: RegistryPaths, name: string): string | null {
  try {
    return fs.readFileSync(coreBlobPath(paths, name), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Whether a named Core is in the registry. */
export function coreExists(paths: RegistryPaths, name: string): boolean {
  return fs.existsSync(coreBlobPath(paths, name));
}

/**
 * Every Core this machine knows, by name, sorted.
 *
 * Sorted rather than in readdir order so that `actana core ls` prints the same
 * table twice in a row, and so a `--json` consumer diffing two runs sees a
 * change only when something changed.
 */
export function listCoreNames(paths: RegistryPaths): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(paths.coresDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
    .map((entry) => entry.name.slice(0, -".txt".length))
    .filter((name) => coreNameError(name) === null)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Remove a named Core's blob. False when there was nothing there to remove. */
export function removeCoreBlob(paths: RegistryPaths, name: string): boolean {
  try {
    fs.unlinkSync(coreBlobPath(paths, name));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * The `current` pointer's name, or null when nothing is selected.
 *
 * A pointer at a Core that has since been removed reads as null rather than as
 * the dangling name: every caller of this is about to go looking for that
 * Core's blob, and "nothing is selected" is the honest answer to give them one
 * step earlier than the file-not-found they would otherwise get.
 */
export function readCurrentCore(paths: RegistryPaths): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(paths.currentPointer, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const name = raw.trim();
  if (!name || coreNameError(name) !== null) return null;
  return coreExists(paths, name) ? name : null;
}

/** Point `current` at a named Core. */
export function writeCurrentCore(paths: RegistryPaths, name: string): void {
  fs.mkdirSync(paths.root, { recursive: true, mode: REGISTRY_DIR_MODE });
  fs.writeFileSync(paths.currentPointer, `${name}\n`, { mode: BLOB_FILE_MODE });
}

/** Drop the `current` pointer. Removing the Core it names calls this. */
export function clearCurrentCore(paths: RegistryPaths): void {
  try {
    fs.unlinkSync(paths.currentPointer);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** One row of `actana core ls`: what is known about a Core without dialling it. */
export type RegisteredCore = {
  name: string;
  /** True for the Core the `current` pointer names. */
  current: boolean;
  /** The endpoint and label off the stored blob, or null when it will not decode. */
  summary: BlobSummary | null;
  /**
   * Why the stored blob will not decode, when it will not. A registry entry
   * that is corrupt is a thing an operator has to be told about — silently
   * omitting the row would leave `core ls` disagreeing with `ls ~/.config`.
   */
  error: string | null;
  /**
   * True when the stored file is readable by somebody other than its owner.
   *
   * Reported rather than repaired: this package wrote it 0600, so a loose mode
   * means something else touched the file — a restore from a backup, a `cp -r`
   * of a home directory, a synced dotfiles repository — and the operator wants
   * to know which of those happened, not have the evidence quietly chmodded
   * away underneath them.
   */
  insecureMode: boolean;
};

/** Read one registry entry, without dialling anything. */
export function readRegisteredCore(paths: RegistryPaths, name: string, current: string | null): RegisteredCore {
  const text = readCoreBlobText(paths, name);
  const row: RegisteredCore = {
    name,
    current: current === name,
    summary: null,
    error: null,
    insecureMode: false,
  };
  try {
    const mode = fs.statSync(coreBlobPath(paths, name)).mode & 0o777;
    row.insecureMode = (mode & 0o077) !== 0;
  } catch {
    // A file that vanished between the listing and the stat is not a mode
    // problem, and the decode below reports it as the missing entry it is.
  }
  if (text === null) {
    row.error = "no blob stored for this Core";
    return row;
  }
  const decoded = decodeRegistrationBlobText(text);
  if (!decoded.ok) {
    row.error = decoded.error;
    return row;
  }
  row.summary = summarizeBlob(decoded.blob);
  return row;
}

/** Every registry entry, in `listCoreNames` order. */
export function readRegistry(paths: RegistryPaths): RegisteredCore[] {
  const current = readCurrentCore(paths);
  return listCoreNames(paths).map((name) => readRegisteredCore(paths, name, current));
}

/**
 * The blob for a named Core, decoded — or the one line saying why not.
 *
 * The returned object is what the SDK takes (#129 D9): a blob *object*, with
 * no path, no encoding and no notion of a registry anywhere on it.
 */
export function loadCoreBlob(
  paths: RegistryPaths,
  name: string,
): { ok: true; blob: CoreRegistrationBlob } | { ok: false; error: string } {
  const text = readCoreBlobText(paths, name);
  if (text === null) {
    return { ok: false, error: `no Core named ${name} — \`actana core ls\` lists what this machine knows` };
  }
  const decoded = decodeRegistrationBlobText(text);
  if (!decoded.ok) {
    return { ok: false, error: `the stored blob for ${name} is unusable: ${decoded.error}` };
  }
  return { ok: true, blob: decoded.blob };
}
