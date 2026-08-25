// Landing an extracted tarball in the versioned install layout.
//
// `actana setup` and `actana update` both do the same three things with a tree
// they have just unpacked — check it is really a Core build, copy it into
// `versions/<v>`, and repoint `current` at it — so those three live here rather
// than once in each.
//
// The swap is a symlink rename, which is atomic: `current` names the old tree
// or the new one and never anything in between, so a crash mid-update leaves a
// Core that still starts. Copying into a staging path and renaming into place
// is the same idea one level down — a half-copied tree never becomes
// `versions/<v>`.

import * as fs from "node:fs";
import * as path from "node:path";

/** Files that must exist for a directory to be an extracted Core tarball. */
export const REQUIRED_TREE_FILES = [
  path.join("app", "core-entry.cjs"),
  path.join("bin", "actana"),
  path.join("node", "bin", "node"),
];

/** The required file a tree is missing, or null when it is a complete build. */
export function missingTreeFile(root: string): string | null {
  return REQUIRED_TREE_FILES.find((rel) => !fs.existsSync(path.join(root, rel))) ?? null;
}

/** `fs.lstatSync` that answers null instead of throwing for a missing path. */
export function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

/** The physical path of a file or directory, or null when it does not exist. */
export function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/** Point `linkPath` at `target`, replacing whatever was there. */
export function pointSymlink(linkPath: string, target: string): void {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  // A previous install (or an operator) may have left a real directory here;
  // rename(2) will not replace one with a symlink.
  const existing = lstatOrNull(linkPath);
  if (existing && !existing.isSymbolicLink()) {
    fs.rmSync(linkPath, { recursive: true, force: true });
  }
  const staging = `${linkPath}.tmp-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.symlinkSync(target, staging);
  fs.renameSync(staging, linkPath);
}

/**
 * Copy the extracted tree into its versioned home, replacing any existing one.
 *
 * **Either the old tree or the new one, at every instant, on every path.** The
 * copy lands in `<installDir>.incoming` and a failure there takes that
 * directory with it. The swap then moves the existing tree aside to
 * `<installDir>.previous` rather than deleting it, so the rename that puts the
 * new tree in place has something to be undone with: if it throws, the old
 * tree goes straight back. `rmSync(installDir)` followed by a rename would
 * have destroyed a working install to make room for one that then failed to
 * arrive — rare, but it is the one failure with no recovery, and it is the
 * failure the two callers' docstrings promise cannot happen.
 *
 * That promise matters more since #316: `install.sh` places before anything is
 * activated, and a failed placement has to leave the machine as it was found.
 *
 * Both scratch paths are cleared on entry as well as on exit, so a process
 * killed mid-swap leaves nothing for the next run to trip over or adopt.
 */
export function installTree(source: string, installDir: string): void {
  const staging = `${installDir}.incoming`;
  const previous = `${installDir}.previous`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(previous, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(installDir), { recursive: true });
  try {
    // verbatimSymlinks so a symlink inside the tarball is copied as-is rather
    // than resolved against this machine's paths.
    fs.cpSync(source, staging, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }

  // Aside, not away: `rename` cannot replace a non-empty directory, so the old
  // tree has to leave `installDir` before the new one can arrive — but it does
  // not have to stop existing until the new one has.
  const displaced = lstatOrNull(installDir) !== null;
  if (displaced) fs.renameSync(installDir, previous);
  try {
    fs.renameSync(staging, installDir);
  } catch (err) {
    if (displaced) fs.renameSync(previous, installDir);
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  // Replace wholesale rather than merging: a half-written tree from a crashed
  // install must not survive inside the new one.
  fs.rmSync(previous, { recursive: true, force: true });
}
