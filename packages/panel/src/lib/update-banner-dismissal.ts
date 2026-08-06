// "I've seen that one" — remembered per release, in this browser.
//
// localStorage rather than the settings row on purpose: dismissing the banner
// is one operator on one device saying they have read the notice, not a
// deployment-wide decision that the next release should also be hidden. It is
// keyed by the version that was dismissed, so it expires by itself — dismissing
// 0.2.0 keeps quiet until 0.3.0 exists, and never longer.

import { readJson, writeJson } from "~/lib/local-storage-json";

const KEY = "actana.update-banner.dismissed";

/** The release this browser last dismissed the banner for, if any. */
export function readDismissedUpdate(): string | null {
  const value = readJson<unknown>(KEY, null);
  return typeof value === "string" && value !== "" ? value : null;
}

/** Remember that this release's banner has been read. */
export function dismissUpdate(version: string): void {
  writeJson(KEY, version);
}
