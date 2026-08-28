// `actana uninstall` — leaving a machine as cleanly as arriving on it.
//
// The line this command draws is between what `actana setup` *installed* and
// what the Core *accumulated*. The install — the service, the launcher, the
// versioned trees — always goes. The accumulation — the SQLite in the data dir,
// and the pairing material that identifies this Core to a Panel — stays unless
// `--purge-data` says otherwise, because deleting it is the one part of an
// uninstall that cannot be undone by reinstalling.
//
// Credentials go with the data rather than with the install on purpose: a
// reinstall over kept material re-pairs with the Panel that is already paired,
// which is what an operator moving a Core between versions wants. An operator
// who is done with the machine passes `--purge-data` and nothing of the Core
// is left.
//
// Every step is best effort and idempotent. Uninstall runs on machines where a
// previous uninstall was interrupted, where the operator deleted half of it by
// hand, or where setup never finished — and on all of them it must leave less
// behind than it found, not an error.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ActanaLayout } from "./actana-layout.ts";
import type { ActanaServiceManager } from "./actana-service.ts";
import { lstatOrNull, realpathOrNull } from "./actana-tree.ts";

export type UninstallOptions = {
  layout: ActanaLayout;
  /** This machine's init system — the unit / plist goes through it. */
  service: ActanaServiceManager;
  /** Also remove the data dir and this Core's pairing credentials. */
  purgeData: boolean;
  /** Progress for the operator. */
  out: (line: string) => void;
};

export type UninstallResult = {
  /** Paths that no longer exist. */
  removed: string[];
  /** Paths deliberately left in place, for the operator to be told about. */
  kept: string[];
};

/** Remove a path if it exists, recording it. Missing is not a failure. */
function remove(target: string, removed: string[]): void {
  if (lstatOrNull(target) === null) return;
  fs.rmSync(target, { recursive: true, force: true });
  removed.push(target);
}

/** Remove a directory only when nothing is left in it. */
function removeIfEmpty(dir: string, removed: string[]): void {
  try {
    if (fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      removed.push(dir);
    }
  } catch {
    /* not there, or not ours to remove */
  }
}

/**
 * Whether `binLink` is the launcher this install put there.
 *
 * An operator may have their own `actana` on the PATH — a build from source, a
 * second install — and uninstall deleting it would be this command reaching
 * outside what it created. The test is where the symlink points, not its name.
 */
function isOurLauncher(layout: ActanaLayout): boolean {
  const stat = lstatOrNull(layout.binLink);
  if (!stat) return false;
  if (!stat.isSymbolicLink()) return false;
  const linkTarget = path.resolve(path.dirname(layout.binLink), fs.readlinkSync(layout.binLink));
  const root = realpathOrNull(layout.root) ?? layout.root;
  return (
    linkTarget === path.join(layout.currentLink, "bin", "actana") ||
    linkTarget.startsWith(`${root}${path.sep}`) ||
    linkTarget.startsWith(`${layout.root}${path.sep}`)
  );
}

/** Stop the daemon, remove the install, and report what survived. */
export function runActanaUninstall(opts: UninstallOptions): UninstallResult {
  const { layout } = opts;
  const removed: string[] = [];
  const kept: string[] = [];

  // The service first: removing the tree under a running daemon would leave it
  // executing files that no longer exist. It runs even when there is no service
  // file — a daemon can be loaded with its unit already deleted, and booting it
  // out is the point of the call.
  const hadService = fs.existsSync(opts.service.filePath);
  opts.service.uninstall();
  if (hadService) removed.push(opts.service.filePath);

  // And the pre-rename one, which `uninstall()` above does not touch: it only
  // knows the current label (#348). Left behind on a machine being uninstalled
  // it is worse than a leftover file — `KeepAlive` re-execs `current/bin/actana`
  // out of a tree this function is about to delete, until launchd throttles a
  // job that can never start again.
  const legacy = opts.service.removeLegacyUnit();
  if (legacy) {
    removed.push(legacy);
    opts.out(`Removed ${legacy}, left by an install from before the rename.`);
  }

  if (isOurLauncher(layout)) {
    remove(layout.binLink, removed);
  } else if (lstatOrNull(layout.binLink)) {
    opts.out(`Left ${layout.binLink} alone — it is not the launcher this install created.`);
    kept.push(layout.binLink);
  }

  remove(layout.currentLink, removed);
  remove(layout.versionsDir, removed);

  if (opts.purgeData) {
    remove(layout.dataDir, removed);
    remove(layout.configDir, removed);
  } else {
    if (fs.existsSync(layout.dataDir)) kept.push(layout.dataDir);
    if (fs.existsSync(layout.configDir)) kept.push(layout.configDir);
  }

  // The default data dir lives inside the install root, so the root can only go
  // once whatever is being kept there is accounted for.
  removeIfEmpty(layout.root, removed);

  if (removed.length > 0) {
    opts.out(`Removed the ${opts.service.name} service and the Core install.`);
  }
  if (kept.length > 0) {
    opts.out("");
    opts.out("Kept:");
    for (const target of kept) opts.out(`  ${target}`);
    opts.out("");
    opts.out(
      "Your sessions and this Core's pairing credentials are still here, so reinstalling " +
        "picks up where you left off. Run `actana uninstall --purge-data` to remove them too.",
    );
  }

  return { removed, kept };
}
