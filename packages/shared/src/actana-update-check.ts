// "Is there a newer Actana than the one I am running?" — asked once a day,
// answered from a file, and never acted on.
//
// This is an alert, not an updater. It returns three fields and prints
// nothing; the two surfaces that read it — `actana status` and the Panel's
// banner — name the command the *operator* runs. Nothing here downloads,
// installs, or offers a button that would (ADR 0010: the Panel is a service
// its operator deploys, not an app that rewrites itself).
//
// Three properties are load-bearing, in this order:
//
//   Fail silent. A network error, a 404 (which is the truth today — there are
//   no published releases yet), a rate limit, or a tag that does not parse all
//   land on the same answer: `updateAvailable: false`, one debug line, nothing
//   operator-visible. `actana status` is documented as a health check, so a
//   release channel having a bad day must never change its exit code or make
//   it slow.
//
//   One network hit per day. Every outcome — including the failures — is
//   cached for {@link UPDATE_CHECK_TTL_MS}, so an operator running `status` in
//   a loop cannot walk into GitHub's 60-requests-per-hour unauthenticated
//   limit. There is no retry, and no fan-out.
//
//   Nothing ambient. The clock, the fetcher and the cache path are all
//   arguments (the `actana` CLI's style — every side effect is a dependency),
//   so the paths that matter are testable without a network, a real day
//   passing, or a release existing.
//
// Version ordering is GitHub's, not ours: `releases/latest` already excludes
// prereleases, so a `0.2.0-rc.1` tag is never what this reads. The local
// comparison is only "is that tag newer than what I am running", which
// `@actana/shared/semver` already answers.

import * as fs from "node:fs";
import * as path from "node:path";
import { isNewerSemver } from "./semver";
import {
  latestReleaseUrl,
  parseLatestTag,
  releaseChannel,
  type ReleaseChannel,
} from "./actana-release-channel";

/** The opt-out. `0`, `false` or `off` disables the check on both surfaces. */
export const UPDATE_CHECK_ENV = "ACTANA_UPDATE_CHECK";

/** How long an answer — including "the channel had nothing" — stays good. */
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long the one request gets before the check gives up.
 *
 * Well under the ~3s `actana status` is allowed to take in total: a health
 * check that hangs on a release server is worse than one that never mentions
 * updates at all.
 */
export const UPDATE_CHECK_TIMEOUT_MS = 2_000;

/** What both surfaces render, and what the Panel's endpoint answers with. */
export type UpdateCheck = {
  /** The version of the component that asked — this Core, or this Panel. */
  current: string;
  /** The channel's newest published release, or null when it could not be read. */
  latest: string | null;
  /** Whether {@link latest} is newer than {@link current}. */
  updateAvailable: boolean;
};

/**
 * The one impure thing the check needs.
 *
 * Structurally a subset of the Core's `ReleaseFetcher`, so `actana status`
 * hands over the fetcher the CLI already carries rather than building a
 * second one.
 */
export type LatestReleaseFetcher = {
  /** GET a URL as text. Throws when the request fails or answers non-2xx. */
  fetchText(url: string): Promise<string>;
};

export type UpdateCheckOptions = {
  /** The asking component's own version. Never a combined "deployment version". */
  current: string;
  fetcher: LatestReleaseFetcher;
  /** JSON file holding the last answer and when it was read. */
  cachePath: string;
  /** Milliseconds since the epoch — injected so "a day has passed" is testable. */
  now: () => number;
  env: NodeJS.ProcessEnv;
  /** Defaults to the public channel; a fixture server passes its own. */
  channel?: ReleaseChannel;
  /** Where the silent failures go. Debug level — never the operator's stream. */
  debug?: (message: string) => void;
  timeoutMs?: number;
};

/** What the cache file holds between runs. */
type CacheEntry = {
  /** When the channel was last asked, successfully or not. */
  checkedAt: number;
  /** The tag it answered with, or null when it could not be read. */
  latest: string | null;
};

/** The answer whenever there is nothing to say, whatever the reason. */
const NO_UPDATE: Omit<UpdateCheck, "current"> = { latest: null, updateAvailable: false };

/**
 * Whether the operator has left the check on.
 *
 * Exported so a surface can skip the work entirely rather than call the check
 * and discard its answer; {@link checkForUpdate} honours it either way.
 */
export function updateCheckEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env[UPDATE_CHECK_ENV]?.trim().toLowerCase();
  if (value === undefined || value === "") return true;
  return value !== "0" && value !== "false" && value !== "off";
}

/**
 * Ask whether a newer release exists — from the cache when today's answer is
 * already on disk, over the network at most once a day, and never loudly.
 */
export async function checkForUpdate(opts: UpdateCheckOptions): Promise<UpdateCheck> {
  const { current, env, now, debug } = opts;
  const say = debug ?? (() => {});

  if (!updateCheckEnabled(env)) {
    say(`update check disabled by ${UPDATE_CHECK_ENV}`);
    return { current, ...NO_UPDATE };
  }

  const cached = readCache(opts.cachePath, now(), say);
  if (cached) return verdict(current, cached.latest);

  const channel = opts.channel ?? releaseChannel({});
  const url = latestReleaseUrl(channel);
  const latest = await readLatestTag(url, opts, say);
  writeCache(opts.cachePath, { checkedAt: now(), latest }, say);
  return verdict(current, latest);
}

/** Compare what the channel published against what is installed. */
function verdict(current: string, latest: string | null): UpdateCheck {
  return {
    current,
    latest,
    updateAvailable: latest !== null && isNewerSemver(latest, current),
  };
}

/**
 * The channel's newest tag, or null for every way that can fail.
 *
 * The timeout is a race rather than an abort signal because the fetcher port
 * takes a URL and nothing else — deliberately, so the Core's real fetcher and
 * a test's fixture are the same two-method shape. A request left running past
 * the race costs nothing: `actana status` exits, and the daemon's check runs
 * once a day.
 */
async function readLatestTag(
  url: string,
  opts: UpdateCheckOptions,
  say: (message: string) => void,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const body = await Promise.race([
      opts.fetcher.fetchText(url),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("timed out")),
          opts.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS,
        );
      }),
    ]);
    const latest = parseLatestTag(body);
    // A 200 whose body carries no `tag_name` is as unusable as a 404, and the
    // repository having no releases yet is the ordinary case until 0.1.0 ships.
    if (!latest) say(`no release tag in the answer from ${url}`);
    return latest;
  } catch (err) {
    say(`could not read ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Today's answer from disk, or null when there is none worth trusting. */
function readCache(
  cachePath: string,
  now: number,
  say: (message: string) => void,
): CacheEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } catch {
    // Absent on the first run, and unreadable if something else wrote it.
    // Both mean "ask the channel", which is the same recovery.
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const entry = parsed as Record<string, unknown>;
  const checkedAt = entry.checkedAt;
  const latest = entry.latest;
  if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt)) return null;
  if (latest !== null && typeof latest !== "string") return null;

  // A clock that jumped backwards (or a file copied from another machine)
  // would otherwise pin the answer for a day in the future.
  const age = now - checkedAt;
  if (age < 0 || age >= UPDATE_CHECK_TTL_MS) return null;
  say(`update check answered from ${cachePath}`);
  return { checkedAt, latest };
}

/** Record the answer so the rest of the day costs no request. */
function writeCache(
  cachePath: string,
  entry: CacheEntry,
  say: (message: string) => void,
): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (err) {
    // A read-only state dir costs a request per invocation and nothing else.
    say(`could not cache the update check: ${err instanceof Error ? err.message : String(err)}`);
  }
}
