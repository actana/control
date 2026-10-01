// The Shared folder of a Core: `~/shared`, always present (ADR 0041 D5, #561).
//
// Without S3 it is a plain local folder and the Core works fully alone (D6), so
// nothing here knows about a backend. This file is only the folder: where it is
// and how to make sure it exists. It is in `@actana/shared` because the install
// (`actana setup`, in the CLI package) and the daemon's boot (in the Core
// package) both make it, and neither package imports the other.
//
// Pure of the process: the home is an argument, never `os.homedir()`, because in
// the container the daemon's own home is not `core`'s (D24).

import * as fs from "node:fs";
import * as path from "node:path";

/** The folder's name in the workspace home. */
export const SHARED_FOLDER_NAME = "shared";

/** `<home>/shared`. */
export function sharedFolderPath(home: string): string {
  return path.join(home, SHARED_FOLDER_NAME);
}

/** The folder is there but is not one we can use as the Shared folder. */
export class SharedFolderUnusableError extends Error {
  constructor(
    readonly folder: string,
    reason: string,
  ) {
    super(`the Shared folder ${folder} ${reason}`);
    this.name = "SharedFolderUnusableError";
  }
}

/**
 * Make sure `<home>/shared` exists as a real directory, and return its path.
 * Idempotent, and it never changes what is already there: an existing folder
 * keeps its mode, owner and contents.
 *
 * It refuses, rather than replacing, a path that is a link or a file. A link
 * would send every Session's reports somewhere the Core does not own, and
 * deleting somebody's file to make room is not this function's call.
 *
 * Runs as whoever calls it. The folder belongs to the user the Sessions run as,
 * so in the container the caller is a process that is already `core`; this never
 * asks for a privilege.
 */
export function ensureSharedFolder(home: string): string {
  const folder = sharedFolderPath(home);
  let stat = fs.lstatSync(folder, { throwIfNoEntry: false });
  if (!stat) {
    // `recursive` is the answer to two racing makers (setup and a booting
    // daemon): the loser finds it made and succeeds.
    fs.mkdirSync(folder, { recursive: true, mode: 0o755 });
    stat = fs.lstatSync(folder);
  }
  if (stat.isSymbolicLink()) throw new SharedFolderUnusableError(folder, "is a symbolic link");
  if (!stat.isDirectory()) throw new SharedFolderUnusableError(folder, "exists and is not a directory");
  return folder;
}
