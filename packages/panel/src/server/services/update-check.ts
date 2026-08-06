/**
 * The Panel's own "is there a newer Actana?" — asked server-side, once a day.
 *
 * The check itself is `@actana/shared/actana-update-check`, the same module
 * `actana status` drives, so the Panel does not carry a second GitHub-release
 * client with its own idea of the repository and the tag format. What is the
 * Panel's own is everything around it: the version reported is *this Panel's*
 * (a deployment can be running a newer Core than its Panel, or the reverse, and
 * each component answers for itself), and the cache lives in the data volume so
 * a restarted container does not re-ask.
 *
 * It answers and nothing else. Updating a Panel is `docker compose pull` on the
 * operator's host — never something this process does to itself (ADR 0010).
 */

import * as path from "node:path";
import {
  checkForUpdate,
  updateCheckEnabled,
  type UpdateCheck,
} from "@actana/shared/actana-update-check";
import { CURRENT_MC_VERSION } from "~/queries/mission-control-version";
import { resolvePanelDataDir } from "../panel-data-dir";

/** Under `/data` in the reference deployment — the one mounted volume. */
const CACHE_FILE = "update-check.json";

/**
 * Long enough for a slow DNS answer, short enough that the browser's banner
 * query is never what makes a page feel stuck.
 */
const REQUEST_TIMEOUT_MS = 3_000;

/** GitHub rejects API requests without one, and a named agent is traceable. */
const USER_AGENT = "actana-panel";

/**
 * One in-flight check at a time.
 *
 * The disk cache already caps this at one request a day, but several browser
 * tabs opening at once would otherwise race to be the one that writes it.
 */
let inflight: Promise<UpdateCheck> | null = null;

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return response.text();
}

/** What the Panel's banner reads. Never throws, never blocks for long. */
export function readPanelUpdateCheck(): Promise<UpdateCheck> {
  const current = CURRENT_MC_VERSION;
  if (!updateCheckEnabled(process.env)) {
    return Promise.resolve({ current, latest: null, updateAvailable: false });
  }
  if (inflight) return inflight;

  const running = checkForUpdate({
    current,
    fetcher: { fetchText },
    cachePath: path.join(resolvePanelDataDir(), CACHE_FILE),
    now: () => Date.now(),
    env: process.env,
    // Two deadlines on purpose, not one by accident: the abort signal above
    // actually cancels the socket, and this bounds the promise for anything
    // that ignores a signal. They fire at the same moment, so whichever wins
    // gives the same answer.
    timeoutMs: REQUEST_TIMEOUT_MS,
  }).finally(() => {
    if (inflight === running) inflight = null;
  });
  inflight = running;
  return running;
}

export function _resetPanelUpdateCheckForTests(): void {
  inflight = null;
}
