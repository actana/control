import { readJson, writeJson } from "~/lib/local-storage-json";

// When the operator last had a Core's Files tab open (#565): the "new" badges are the files written after it. It is a
// per-browser convenience (the same rule as the Core remember settings), so another browser starts from its own visit.

const KEY = (coreId: string) => `mc:files-last-visit:${coreId}`;

/** The last visit in ms, or `now` for a first visit: nothing is new to someone who has never looked. */
export function readLastVisit(coreId: string, now = Date.now()): number {
  const stored = readJson<number | null>(KEY(coreId), null);
  return typeof stored === "number" && Number.isFinite(stored) && stored > 0 ? stored : now;
}

export function writeLastVisit(coreId: string, at = Date.now()): void {
  writeJson(KEY(coreId), at);
}
