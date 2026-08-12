// Browsing the Core's own filesystem, for the Panel's folder picker.
//
// A Project's path is a VM path: only the Core can say whether it exists,
// what is under it, or whether a new folder can be made there (CONTEXT.md,
// "Project"). With the Panel in a browser there is no machine-local dialog to
// fall back on, so this module is the whole of the picker's back end — the
// `dirList` / `dirCreate` core-link frames delegate straight to it.
//
// Every failure is thrown with a message written for the operator, not for a
// log: it travels the core-link as an `error` frame and lands in the picker's
// error box verbatim.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CoreLinkDirEntry, CoreLinkDirListing } from "@actana/sdk/core-link-frames";

/**
 * How many folders one listing carries. A directory with thousands of children
 * would otherwise put all of them on the wire on every arrow-key drill; the
 * picker's type-to-filter is the way through a folder that big.
 */
const DEFAULT_LIST_LIMIT = 400;

/**
 * Shortcut chips, in the order the picker shows them. Only the ones that
 * actually exist on this machine are offered — a VM with no `Desktop` should
 * not advertise one.
 */
const STANDARD_ROOTS = ["Developer", "Documents", "Desktop", "Downloads"] as const;

export type DirectoryBrowseOptions = {
  /** The Core's home directory. Injectable so tests need no real $HOME. */
  home?: string;
  /** Max entries in one listing. Defaults to {@link DEFAULT_LIST_LIMIT}. */
  limit?: number;
};

/**
 * List the directories inside `requested`, or inside the Core's home when
 * it is null/blank — the Panel has never seen this machine and cannot compute
 * a sensible starting point itself.
 *
 * Throws `Folder not found` / `Not a folder` / `Can't read this folder`.
 */
export async function listDirectory(
  requested: string | null | undefined,
  opts: DirectoryBrowseOptions = {},
): Promise<CoreLinkDirListing> {
  const fsp = fs.promises;
  const home = opts.home ?? os.homedir();
  const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
  const raw = typeof requested === "string" && requested.trim() ? requested : home;

  let dir: string;
  try {
    dir = await fsp.realpath(path.resolve(raw));
  } catch {
    throw new Error("Folder not found");
  }
  if (!(await fsp.stat(dir)).isDirectory()) throw new Error("Not a folder");

  let dirents: fs.Dirent[];
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    throw new Error("Can't read this folder");
  }

  const visible = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const entries: CoreLinkDirEntry[] = await Promise.all(
    visible.slice(0, limit).map(async (d) => ({
      name: d.name,
      childCount: await countVisibleChildren(path.join(dir, d.name)),
    })),
  );

  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    home,
    roots: await resolveRoots(home),
    entries,
    truncated: visible.length > limit,
  };
}

/**
 * Make one folder (non-recursive) under `parent`. `name` is a single path
 * segment: separators, traversal, and hidden names are rejected here even
 * though the picker pre-filters them — the Panel is a browser now, and nothing
 * it sends is trusted.
 *
 * Returns the created folder's absolute path.
 */
export async function createDirectory(parentRaw: string, nameRaw: string): Promise<string> {
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  if (
    !name ||
    name === ".." ||
    // A dotfolder is filtered out of every listing, so one created here would
    // vanish the moment it was made.
    name.startsWith(".") ||
    name.includes("\0") ||
    // Path separators plus the characters Windows rejects. Spaces are fine.
    /[\\/:*?"<>|]/.test(name)
  ) {
    throw new Error("Invalid folder name");
  }
  if (typeof parentRaw !== "string" || !parentRaw.trim()) throw new Error("Invalid location");

  let parent: string;
  try {
    parent = await fs.promises.realpath(path.resolve(parentRaw));
  } catch {
    throw new Error("Location not found");
  }
  if (!(await fs.promises.stat(parent)).isDirectory()) {
    throw new Error("Location is not a folder");
  }

  const target = path.join(parent, name);
  try {
    await fs.promises.mkdir(target);
    return target;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") throw new Error("Something with that name already exists here");
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      throw new Error("No permission to create a folder here");
    }
    throw new Error("Could not create the folder");
  }
}

/** An unreadable child (permissions) simply reads as a leaf, not as an error. */
async function countVisibleChildren(dir: string): Promise<number> {
  try {
    const children = await fs.promises.readdir(dir, { withFileTypes: true });
    return children.filter((c) => c.isDirectory() && !c.name.startsWith(".")).length;
  } catch {
    return 0;
  }
}

async function resolveRoots(home: string): Promise<Array<{ label: string; path: string }>> {
  const standard = await Promise.all(
    STANDARD_ROOTS.map(async (label): Promise<{ label: string; path: string } | null> => {
      const p = path.join(home, label);
      try {
        return (await fs.promises.stat(p)).isDirectory() ? { label, path: p } : null;
      } catch {
        return null;
      }
    }),
  );
  return [
    { label: "Home", path: home },
    ...standard.filter((r): r is { label: string; path: string } => r !== null),
  ];
}
