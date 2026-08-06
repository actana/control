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

import * as fs from "node:fs";
import * as path from "node:path";
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
  /**
   * Where this daemon remembers what it last said, and when.
   *
   * Its own file rather than a field in {@link cachePath}: that one holds what
   * the release channel answered and belongs to the check, which the CLI drives
   * too. This one is bookkeeping for a log line, and only the daemon writes it.
   */
  noticePath: string;
  env: NodeJS.ProcessEnv;
  now: () => number;
  /** Where the line goes. The Core's logger on a real daemon. */
  log: (message: string) => void;
  /** The command the operator runs, which differs on metal and in the image. */
  remedy: string;
};

/** What this daemon last said, so a restart does not say it again. */
type NoticeState = { noticedAt: number; latest: string };

/**
 * Ask once, and log only if there is something new to say.
 *
 * Silence covers every uninteresting case — opted out, channel unreachable,
 * already current — because a daemon that logged "no update" every day would
 * train its operator to skip the line that one day matters. It also covers the
 * same release twice in a day: a Core under `restart: unless-stopped` boots as
 * often as its host decides, and "once a day at most" has to survive that. A
 * *different* release always speaks, however recently the last one did.
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

  const now = deps.now();
  if (alreadySaid(deps.noticePath, result.latest, now)) return;
  deps.log(
    `Actana ${result.latest} is available — this Core is on ${result.current}. ` +
      `To update: ${deps.remedy}`,
  );
  rememberSaid(deps.noticePath, { noticedAt: now, latest: result.latest });
}

/** Whether this exact release was announced less than a day ago. */
function alreadySaid(noticePath: string, latest: string, now: number): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(noticePath, "utf8"));
  } catch {
    // Never announced, or the file is unreadable. Both mean "say it" — the
    // failure mode of this bookkeeping is one repeated line, never a missed one.
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const state = parsed as Record<string, unknown>;
  if (state.latest !== latest || typeof state.noticedAt !== "number") return false;
  const age = now - state.noticedAt;
  return age >= 0 && age < UPDATE_CHECK_TTL_MS;
}

function rememberSaid(noticePath: string, state: NoticeState): void {
  try {
    fs.mkdirSync(path.dirname(noticePath), { recursive: true });
    fs.writeFileSync(noticePath, `${JSON.stringify(state)}\n`, "utf8");
  } catch {
    // A read-only state dir costs a repeated line a day and nothing else.
  }
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
