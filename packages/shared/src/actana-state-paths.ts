// Where the two files the update check leaves behind live.
//
// Split out of `actana-layout.ts` because the daemon writes both: the CLI's
// `status` and the daemon's once-a-day notice share one cache of what the
// release channel last answered, and the daemon alone keeps the record of what
// it has already said. Both are a path join on the data dir and neither is a
// decision either half should make twice (#288 D2).

import * as path from "node:path";

/**
 * Where the update check remembers what the release channel last answered.
 *
 * Under the data dir rather than the install tree: `actana update` replaces
 * `versions/<v>` wholesale, and a cache that vanished on every update would
 * ask GitHub again on the first `status` after one — exactly when an operator
 * is most likely to run it in a loop.
 *
 * Takes the data dir rather than the whole layout because container mode
 * resolves it from `AC_USER_DATA_DIR` (the image bakes it) instead of from the
 * install root.
 */
export function updateCheckCachePath(dataDir: string): string {
  return path.join(dataDir, "update-check.json");
}

/**
 * Where the daemon remembers which release it last announced in its log.
 *
 * Beside the cache above, and separate from it: that file is the release
 * channel's answer, shared with the CLI; this one is the daemon's own record of
 * what it has already said, so a Core its host restarts hourly does not repeat
 * the same line hourly.
 */
export function updateNoticeStatePath(dataDir: string): string {
  return path.join(dataDir, "update-notice.json");
}
