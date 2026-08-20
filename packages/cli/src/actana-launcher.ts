// Who owns `~/.local/bin/actana` (#288 D10).
//
// `actana setup` used to link its launcher into `binDir` unconditionally. That
// was safe while the tarball's `actana` was the only program with that name.
// It is not safe now: `deploy/core.Dockerfile` sets
// `NPM_CONFIG_PREFIX=/home/core/.local`, so an `npm i -g @actana/cli` inside a
// container Core puts its shim at `/home/core/.local/bin/actana` — **the same
// path `resolveActanaLayout` calls `binLink`**. Two installers, one path.
//
// **Whoever installed the CLI owns it.** If something that is not setup's own
// symlink already answers to `actana`, setup does not write one and says so.
// No clobber, no silent win, no ordering trick — the operator gets told which
// program is on their `PATH` and where the other one is, and decides.
//
// That is not a fix for the collision so much as a refusal to have an opinion
// about it. Since #288 the two programs are the same program, so which one
// wins no longer changes what any verb does; what would still be rude is
// deleting a file npm is tracking, and that is what this prevents.
//
// Ownership is decided by where the link points, not by what it is called: a
// symlink whose target is inside this layout's install root is one setup
// wrote, and anything else — a real file, a shim into `lib/node_modules`, a
// hand-rolled wrapper — belongs to somebody else.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ActanaLayout } from "./actana-layout.ts";
import { pointSymlink, realpathOrNull } from "./actana-tree.ts";

/** What {@link claimLauncher} did, and what to tell the operator about it. */
export type LauncherClaim = {
  /**
   * - `linked` — the symlink is setup's and now points at `current/bin/actana`.
   * - `foreign` — something else answers to `actana`; nothing was written.
   */
  outcome: "linked" | "foreign";
  /** The launcher path this layout wanted: `<binDir>/actana`. */
  binLink: string;
  /** The other `actana`, when there is one. Absolute. */
  foreignPath: string | null;
  /** What setup prints. Null when there is nothing to say. */
  note: string | null;
};

/**
 * The first `actana` on `PATH` that is not the launcher this layout owns.
 *
 * Deliberately not `which`: the CLI does not shell out to answer a question
 * about its own environment, and a subprocess would be a worse answer anyway
 * — `which` reads the *shell's* `PATH`, and this reads the one the process was
 * actually given.
 */
function foreignActanaOnPath(
  layout: ActanaLayout,
  env: NodeJS.ProcessEnv,
  exists: (file: string) => boolean,
): string | null {
  const raw = env.PATH ?? env.Path;
  if (!raw) return null;
  const own = path.resolve(layout.binLink);
  for (const entry of raw.split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(entry, "actana");
    if (candidate === own) continue;
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** Whether `binLink` is a symlink this layout's own install root is behind. */
function ownedByThisLayout(layout: ActanaLayout): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(layout.binLink);
  } catch {
    // Nothing there at all: free to claim.
    return true;
  }
  if (!stat.isSymbolicLink()) return false;
  const target = realpathOrNull(layout.binLink);
  if (target === null) {
    // A dangling symlink into our own root is an install that was removed by
    // hand; one pointing anywhere else is not ours to repair. `readlink` is
    // what answers that, because `realpath` cannot resolve a broken link.
    const raw = path.resolve(path.dirname(layout.binLink), fs.readlinkSync(layout.binLink));
    return raw.startsWith(path.resolve(layout.root) + path.sep);
  }
  return target.startsWith(path.resolve(layout.root) + path.sep);
}

/**
 * Point `<binDir>/actana` at this install — unless somebody else owns it.
 *
 * `exists` is injectable so a test can lay out a container's `PATH` without
 * creating files across it; the default is the real filesystem, and the
 * collision that matters (`binDir` *is* the npm prefix's `bin`) is tested
 * against real files.
 */
export function claimLauncher(
  layout: ActanaLayout,
  env: NodeJS.ProcessEnv,
  exists: (file: string) => boolean = fs.existsSync,
): LauncherClaim {
  if (!ownedByThisLayout(layout)) {
    return {
      outcome: "foreign",
      binLink: layout.binLink,
      foreignPath: layout.binLink,
      note:
        `${layout.binLink} is not this install's launcher, so it was left alone. ` +
        "Whoever installed that `actana` owns it — since 0.4.0 there is one " +
        "`actana` program, so it can run this Core's verbs too. This install's " +
        `own launcher is ${path.join(layout.currentLink, "bin", "actana")}.`,
    };
  }

  const foreign = foreignActanaOnPath(layout, env, exists);
  if (foreign) {
    return {
      outcome: "foreign",
      binLink: layout.binLink,
      foreignPath: foreign,
      note:
        `${foreign} is already on PATH as \`actana\`, so no launcher was linked into ` +
        `${layout.binDir}. Since 0.4.0 there is one \`actana\` program, so that one can ` +
        `run this Core's verbs too. This install's own launcher is ` +
        `${path.join(layout.currentLink, "bin", "actana")}.`,
    };
  }

  pointSymlink(layout.binLink, path.join(layout.currentLink, "bin", "actana"));
  return { outcome: "linked", binLink: layout.binLink, foreignPath: null, note: null };
}
