// Where a durable Core client keeps its event cursor.
//
// The cursor is one number per Core — the highest `eventId` this client has seen
// (CONTEXT.md "Event cursor"). It is sent on every (re)connect as
// `subscribe { lastEventId }`, and the Core answers with the event-log tail past
// it. Persist it and a client that was killed and restarted recovers the
// timeline it missed; keep it in memory only and a client recovers everything
// missed while it was *running*, which is still every reconnect.
//
// **The store is injected and never imported** (issue 153's trap). In the Panel
// this interface is satisfied by the browser's `localStorage`, and a Node package
// that reached for that global — or for a wrapper around it — would either drag a
// DOM dependency into a process that has no DOM, or carry a `typeof
// localStorage !== "undefined"` sniff in a library whose every consumer knows
// perfectly well which runtime it is. So the SDK declares the two methods it
// needs, defaults to {@link InMemoryCoreLinkCursorStorage}, and lets a caller
// with somewhere durable to write hand that in: a browser passes `localStorage`,
// the CLI passes a file-backed store, a test passes a Map.
//
// The interface is `localStorage`-shaped on purpose — `getItem` / `setItem`, keys
// and string values — because that is what makes the Panel's own store pass
// without an adapter when it migrates (#156).

/** A `localStorage`-shaped store for the per-Core `lastEventId` cursor. */
export interface CoreLinkCursorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The default: a cursor that lives as long as the process does.
 *
 * Not a null object. Replay still works across every reconnect within one run —
 * which is the case the cursor exists for — and only a restart starts from
 * scratch. A store that dropped writes would make a reconnect re-replay the
 * whole log every time, so "in memory" is the honest floor rather than a stub.
 */
export class InMemoryCoreLinkCursorStorage implements CoreLinkCursorStorage {
  private readonly entries = new Map<string, string>();

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

/** The prefix every derived cursor key carries. */
export const CURSOR_STORAGE_KEY_PREFIX = "actana.coreLink.lastEventId";

/**
 * The storage key for one Core's cursor, derived from its core-link URL.
 *
 * Per Core, because the cursor is per Core: two Cores sharing a key would each
 * replay from the other's position, and the one that fell behind would silently
 * lose the events in between. The URL carries the host and port that identify a
 * Core, so the scheme is stripped and everything outside `[A-Za-z0-9_-]` is
 * replaced — the result is safe as a `localStorage` key, a file name, or a column
 * value.
 */
export function coreLinkCursorStorageKey(url: string): string {
  return `${CURSOR_STORAGE_KEY_PREFIX}.${deriveCoreKey(url)}`;
}

function deriveCoreKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}-${u.port}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  } catch {
    // Malformed URL — fall back to a sanitized full string, so distinct (if odd)
    // URLs still get key isolation from each other.
    return url.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-64);
  }
}
