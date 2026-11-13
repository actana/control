import { coreLinkManager } from "./core-link-manager";
import { DEFAULT_MAX_LIVE_SESSIONS, type CoreCapacity } from "~/shared/cores";

/**
 * A Core's live harness PTYs against its limit (#962), for the Panel and `list_cores`.
 *
 * The core-link has no "how many PTYs" frame, so the count is read the way `get_sessions` reads: the Core's own
 * Session list, counting the rows that have a PTY and a harness (a shell has none). The limit is not on the link
 * either: it is the one the Core last refused a start at (`noteCoreCap`), else the Core's default. A reading is kept
 * for {@link CAPACITY_TTL_MS} so a polled Core list asks each Core at most once in that time.
 */

export const CAPACITY_TTL_MS = 5_000;
const PAGE = 100;
/** Pages read per count: the list puts running and waiting Sessions first, so a Core with more Sessions than this still counts its live ones. */
export const CAPACITY_MAX_PAGES = 5;

type Row = { ptyId: string | null; agent?: string };
type Page = { type?: string; sessions?: Row[]; nextCursor?: string | null };
type Link = { request(frame: never): Promise<unknown> };
export type CapacityLinkFor = (coreId: string) => Link | null;

const caps = new Map<string, number>();
const cache = new Map<string, { at: number; live: number | null }>();

/** The Core refused a start at this limit. */
export function noteCoreCap(coreId: string, max: number): void {
  caps.set(coreId, max);
  cache.delete(coreId);
}

export function resetCoreCapacityForTests(): void {
  caps.clear();
  cache.clear();
}

async function countLive(link: Link): Promise<number | null> {
  let live = 0;
  let cursor: string | null | undefined;
  for (let page = 0; page < CAPACITY_MAX_PAGES; page++) {
    const frame = { type: "sessionsList", limit: PAGE, archived: false, ...(cursor ? { cursor } : {}) };
    const answer = (await link.request(frame as never)) as Page;
    if (answer.type !== "sessionsListResult") return null;
    for (const s of answer.sessions ?? []) if (s.ptyId !== null && s.agent) live++;
    cursor = answer.nextCursor;
    if (!cursor) break;
  }
  return live;
}

export async function readCoreCapacity(
  coreId: string,
  linkFor: CapacityLinkFor = (id) => coreLinkManager().client(id) as unknown as Link | null,
  now: () => number = Date.now,
): Promise<CoreCapacity> {
  const maxSessions = caps.get(coreId) ?? DEFAULT_MAX_LIVE_SESSIONS;
  const hit = cache.get(coreId);
  if (hit && now() - hit.at < CAPACITY_TTL_MS) return { liveSessions: hit.live, maxSessions };
  let live: number | null = null;
  try {
    const link = linkFor(coreId);
    live = link ? await countLive(link) : null;
  } catch {
    live = null;
  }
  cache.set(coreId, { at: now(), live });
  return { liveSessions: live, maxSessions };
}
