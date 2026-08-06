// The daemon's half of the update check — one log line a day, at most.
//
// The operator surfaces (`actana status`, the Panel's banner) only speak when
// someone is looking. A Core that nobody has run `status` against in six
// months would never learn it is behind, so the daemon asks too — and the
// answer goes to the only place a daemon can put one, which is its log
// (`actana logs`, `docker compose logs`). Not a notification, not a frame the
// Panel raises, not a restart: a line.
//
// The cadence is the checker's own — one network hit per day, cached on disk
// and shared with the CLI — so a Core that reboots hourly still asks GitHub
// once. Nothing here runs an update; the line names the command its operator
// runs (ADR 0016 D16 decides which one).

import {
  checkForUpdate,
  updateCheckEnabled,
  UPDATE_CHECK_TTL_MS,
  type LatestReleaseFetcher,
} from "@actana/shared/actana-update-check";

export type UpdateNoticeDeps = {
  /** This daemon's own version, from `core-manifest.json`. */
  current: string;
  fetcher: LatestReleaseFetcher;
  /** The shared cache file — the CLI reads and writes the same one. */
  cachePath: string;
  env: NodeJS.ProcessEnv;
  now: () => number;
  /** Where the line goes. The Core's logger on a real daemon. */
  log: (message: string) => void;
  /** The command the operator runs, which differs on metal and in the image. */
  remedy: string;
};

/**
 * Ask once, and log only if there is something to say.
 *
 * Silence covers every uninteresting case — opted out, channel unreachable,
 * already current — because a daemon that logged "no update" every day would
 * train its operator to skip the line that one day matters.
 */
export async function runUpdateNotice(deps: UpdateNoticeDeps): Promise<void> {
  if (!updateCheckEnabled(deps.env)) return;
  const result = await checkForUpdate({
    current: deps.current,
    fetcher: deps.fetcher,
    cachePath: deps.cachePath,
    now: deps.now,
    env: deps.env,
    // The check's own failures are not this daemon's news either — they are
    // the ordinary state of a repository with no releases published yet.
    debug: () => {},
  });
  if (!result.updateAvailable || result.latest === null) return;
  deps.log(
    `Actana ${result.latest} is available — this Core is on ${result.current}. ` +
      `To update: ${deps.remedy}`,
  );
}

/**
 * Start the daily notice. Returns the handle that stops it on shutdown.
 *
 * The first check runs immediately rather than a day in: an operator who just
 * started a Core they had parked for a month should be told on the first page
 * of its log, not tomorrow. Failures never propagate — this is a log line, and
 * a log line must not be able to take the daemon down.
 */
export function startUpdateNotice(deps: UpdateNoticeDeps): { stop: () => void } {
  const tick = () => {
    void runUpdateNotice(deps).catch(() => {});
  };
  tick();
  const timer = setInterval(tick, UPDATE_CHECK_TTL_MS);
  // A once-a-day timer must never be the reason the process refuses to exit.
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
