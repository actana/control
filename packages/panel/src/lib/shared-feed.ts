import { useEffect, useRef, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getPanelBridge, type PanelBridge } from "~/lib/panel-bridge";
import { queryKeys } from "~/queries";
import type { CoreFileChange } from "~/shared/shared-files";

// The Files tab's view of the Core's `shared:changed` feed (#561, ADR 0041 D5). The tab already watches the Core through
// the panel link, which hands it every event live and replays what it missed; this turns those events into the three
// things the tab wants: which files are new since the operator's last visit, what the Core last said about each path (the
// sync state), and a refresh of the folder on screen without polling. It adds no request of its own.

export const SHARED_CHANGED_KIND = "shared:changed";

/** Events within this window of each other cause one refetch. A Session writing a tree is a burst, not a stream. */
export const REFRESH_DEBOUNCE_MS = 400;

/**
 * When to look at S3 again after a burst of events. The event is the Core's local write; the Core uploads it on its next
 * sync pass, up to `SYNC_INTERVAL_MS` (15 s, core/src/shared-sync.ts) later, and the first look at 400 ms is usually
 * before the object exists. A second pass can be needed when the first was already running, so there are two follow-ups,
 * a little past one and two intervals. A delete the Core made reaches S3 the same way.
 */
export const REFRESH_FOLLOW_UP_MS = [17_000, 34_000] as const;

/**
 * The refreshes one burst of events asks for: one after the debounce, then the follow-ups. A new event restarts the
 * sequence, so a Session writing for a minute is looked at once it has stopped, not on every file.
 */
export function createRefreshSchedule(refresh: () => void) {
  let timers: ReturnType<typeof setTimeout>[] = [];
  const stop = () => {
    for (const t of timers) clearTimeout(t);
    timers = [];
  };
  return {
    /** An event arrived: (re)start the sequence. */
    note() {
      stop();
      timers = [REFRESH_DEBOUNCE_MS, ...REFRESH_FOLLOW_UP_MS].map((ms) => setTimeout(refresh, ms));
    },
    stop,
  };
}

/** The most paths the state remembers; the oldest go first. The panel link's own replay is bounded the same way. */
const MAX_PATHS = 10_000;

export type SharedFeedState = {
  /** The Core's last event for each path. */
  changes: ReadonlyMap<string, CoreFileChange>;
  /** Paths a live or replayed event wrote after `since`, and that nothing has deleted since. */
  newPaths: ReadonlySet<string>;
};

/** One event's payload, checked: `{ path, size, mtime, deleted }` as the Core writes it, or null. */
export function parseSharedChanged(payload: string): ({ path: string } & CoreFileChange) | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.path !== "string" || v.path === "" || typeof v.deleted !== "boolean") return null;
  const size = typeof v.size === "number" && Number.isFinite(v.size) && v.size >= 0 ? v.size : 0;
  const mtime = typeof v.mtime === "number" && Number.isFinite(v.mtime) && v.mtime >= 0 ? v.mtime : 0;
  return { path: v.path, size, mtime, deleted: v.deleted };
}

/** The pure fold of one event into the state. A path the Core deleted is not new; a path written after `since` is. */
export function applyChange(state: SharedFeedState, change: { path: string } & CoreFileChange, since: number): SharedFeedState {
  const changes = new Map(state.changes);
  changes.delete(change.path);
  changes.set(change.path, { size: change.size, mtime: change.mtime, deleted: change.deleted });
  while (changes.size > MAX_PATHS) changes.delete(changes.keys().next().value as string);
  const newPaths = new Set(state.newPaths);
  if (change.deleted) newPaths.delete(change.path);
  else if (change.mtime > since) newPaths.add(change.path);
  return { ...state, changes, newPaths };
}

export const EMPTY_FEED: SharedFeedState = { changes: new Map(), newPaths: new Set() };

type Bridge = Pick<PanelBridge, "watchCore" | "onEvent" | "onConnectionChange">;

/**
 * The feed for one Core, as a small store so a tab's several readers share one fold. `connect` watches the Core and
 * returns the function that stops. `onChange` is told each time something that is on screen may have changed.
 */
export function createSharedFeed(coreId: string, since: number, bridge: Bridge, onChange: () => void) {
  let state: SharedFeedState = EMPTY_FEED;
  const listeners = new Set<() => void>();
  const set = (next: SharedFeedState) => {
    state = next;
    for (const l of listeners) l();
  };
  return {
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect(): () => void {
      const release = bridge.watchCore(coreId);
      const off = bridge.onEvent(({ coreId: owner, event }) => {
        if (owner !== coreId || event.kind !== SHARED_CHANGED_KIND) return;
        const change = parseSharedChanged(event.payload);
        if (!change) return;
        set(applyChange(state, change, since));
        onChange();
      });
      const offConnection = bridge.onConnectionChange((connected) => {
        // A gap the replay may not cover: look again when the link is back.
        if (connected) onChange();
      });
      return () => {
        off();
        offConnection();
        release();
      };
    },
  };
}

/**
 * Subscribe a Files tab to the Core's feed. Returns the state; a change refreshes the shared-files queries once the burst
 * is over. With no panel bridge (a bare render, or a server render) the state stays empty.
 */
export function useSharedFeed(coreId: string, since: number): SharedFeedState {
  const queryClient = useQueryClient();
  const storeRef = useRef<ReturnType<typeof createSharedFeed> | null>(null);
  const scheduleRef = useRef<ReturnType<typeof createRefreshSchedule> | null>(null);

  if (storeRef.current === null || (storeRef.current as { coreId?: string }).coreId !== coreId) {
    const bridge = getPanelBridge();
    storeRef.current = Object.assign(
      createSharedFeed(
        coreId,
        since,
        bridge ?? NO_BRIDGE,
        () => scheduleRef.current?.note(),
      ),
      { coreId },
    );
  }
  const store = storeRef.current;
  useEffect(() => {
    const schedule = createRefreshSchedule(() => void queryClient.invalidateQueries({ queryKey: queryKeys.sharedFiles(coreId) }));
    scheduleRef.current = schedule;
    const stop = store.connect();
    return () => {
      stop();
      schedule.stop();
      scheduleRef.current = null;
    };
  }, [store, queryClient, coreId]);
  return useSyncExternalStore(store.subscribe, store.get, () => EMPTY_FEED);
}

const NO_BRIDGE: Bridge = {
  watchCore: () => () => undefined,
  onEvent: () => () => undefined,
  onConnectionChange: () => () => undefined,
};
