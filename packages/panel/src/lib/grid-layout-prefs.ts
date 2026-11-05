import { useSyncExternalStore } from "react";
import type { Harness } from "@actana/shared/domain";

// Per-scope "sessions per row" lock for the session grid. Stored beside the
// grid's layout blobs (same per-scope keying) so each Core
// scope keeps its own row width. `null` means auto — the grid keeps its
// historical behavior (near-square seeding, rows grow as sessions land in
// them). A number caps how many cells a *new* session may join a row with:
// the grid fills the current row up to the cap, then flows into the next row
// with space, then opens a fresh row. Manual drag-reordering is deliberately
// not policed by the cap — the lock governs placement, not the user's hands.
const GRID_COLUMNS_PREFIX = "mc.gridColumns";

/** Row widths offered by the layout dropdown (and accepted from storage). */
export const GRID_COLUMN_OPTIONS = [1, 2, 3, 4, 5, 6] as const;
export const MAX_GRID_COLUMNS = 6;

/** Fired (on window) after a scope's column limit changes, so the grid and the
 *  header dropdown — which don't share React state — both re-read storage. */
export const GRID_PREFS_EVENT = "mc:grid-prefs-changed";
export type GridPrefsEventDetail = { scopeKey: string };

/** One-shot "sort the grid by agent" command from the header dropdown to the
 *  mounted SessionGrid (same window-event bridge as GRID_EXPAND_TOGGLE_EVENT). */
export const GRID_SORT_EVENT = "mc:grid-sort";
export type GridSortEventDetail = { scopeKey: string; firstHarness: Harness };

function columnsStorageKey(scopeKey: string): string {
  return `${GRID_COLUMNS_PREFIX}:${scopeKey}`;
}

/** Valid stored limit (1..MAX_GRID_COLUMNS), or null for auto/malformed. */
function sanitizeLimit(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_GRID_COLUMNS
    ? value
    : null;
}

export function loadGridColumnLimit(scopeKey: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(columnsStorageKey(scopeKey));
    if (!raw) return null;
    return sanitizeLimit(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveGridColumnLimit(scopeKey: string, limit: number | null): void {
  if (typeof window === "undefined") return;
  const next = sanitizeLimit(limit);
  try {
    if (next === null) {
      window.localStorage.removeItem(columnsStorageKey(scopeKey));
    } else {
      window.localStorage.setItem(columnsStorageKey(scopeKey), JSON.stringify(next));
    }
  } catch {
    /* quota or disabled */
  }
  window.dispatchEvent(
    new CustomEvent<GridPrefsEventDetail>(GRID_PREFS_EVENT, { detail: { scopeKey } }),
  );
}

export function requestGridSort(scopeKey: string, firstHarness: Harness): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<GridSortEventDetail>(GRID_SORT_EVENT, {
      detail: { scopeKey, firstHarness },
    }),
  );
}

/** Fired (on window) after the grid's hidden-Session set is saved, so the
 *  header's Sessions picker re-reads it. Separate from GRID_PREFS_EVENT, which
 *  makes the grid reflow to the column lock. */
export const GRID_HIDDEN_EVENT = "mc:grid-hidden-changed";

/** One-shot "show / hide this Session's tile" command from the header's
 *  Sessions picker to the mounted SessionGrid (same window-event bridge as
 *  GRID_SORT_EVENT). Hiding keeps the Session open; it only leaves the grid. */
export const GRID_SHOW_SESSION_EVENT = "mc:grid-show-session";
export type GridShowSessionEventDetail = {
  scopeKey: string;
  sessionId: string;
  show: boolean;
};

// Sessions the operator picked by hand, per scope. They outrank the default
// ranking when the grid is over its cap. Held in memory only: a reload goes
// back to the default pick.
const pickedByScope = new Map<string, Set<string>>();

export function pickedGridSessionIds(scopeKey: string): ReadonlySet<string> {
  return pickedByScope.get(scopeKey) ?? new Set();
}

export function clearPickedGridSessions(scopeKey: string): void {
  pickedByScope.delete(scopeKey);
}

export function requestGridShowSession(scopeKey: string, sessionId: string, show: boolean): void {
  const picked = new Set(pickedByScope.get(scopeKey));
  if (show) picked.add(sessionId);
  else picked.delete(sessionId);
  pickedByScope.set(scopeKey, picked);
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<GridShowSessionEventDetail>(GRID_SHOW_SESSION_EVENT, {
      detail: { scopeKey, sessionId, show },
    }),
  );
}

/** Announced when the session.gridLayout quick picker opens, so the header's
 *  layout dropdown closes instead of stacking a second popup over it (the
 *  reverse needs no event — opening the dropdown is an outside pointerdown,
 *  which already dismisses the picker). */
export const GRID_QUICK_PICKER_EVENT = "mc:grid-quick-picker-open";

export function announceGridQuickPickerOpen(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(GRID_QUICK_PICKER_EVENT));
}

// How many Sessions the grid draws at once. Every tile is a terminal (an xterm
// surface plus, for a live Session, a PTY on the Core), so an uncapped grid
// over a few hundred Sessions exhausts the VM (#895). Compact screens (under
// 768px) keep no grid at all; the tablet value only matters to a window that
// is narrowed below the desktop breakpoint.
export const MAX_GRID_TILES = { desktop: 8, tablet: 4 } as const;
const TABLET_MIN_WIDTH = 768;
const DESKTOP_MIN_WIDTH = 1024;

/** The tile cap for a viewport `width` in px (defaults to the window's). */
export function gridTileCap(
  width: number = typeof window === "undefined" ? DESKTOP_MIN_WIDTH : window.innerWidth,
): number {
  return width >= DESKTOP_MIN_WIDTH || width < TABLET_MIN_WIDTH
    ? MAX_GRID_TILES.desktop
    : MAX_GRID_TILES.tablet;
}

function subscribeToResize(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

/** {@link gridTileCap} for the current window, re-read on resize. */
export function useGridTileCap(): number {
  return useSyncExternalStore(
    subscribeToResize,
    () => gridTileCap(),
    () => MAX_GRID_TILES.desktop,
  );
}

/** A Session with no work in flight: opening its tile must never start its
 *  harness by itself. Only a user gesture (Resume) brings one back. */
export function isSettledSessionStatus(status: string): boolean {
  return status !== "ready" && status !== "running" && status !== "needs-input";
}

type GridRankable = { status: string; pinned: boolean; updatedAt: number; archived?: boolean };

function gridRank(row: GridRankable): number {
  if (row.status === "running" || row.status === "needs-input") return 0;
  return row.pinned ? 1 : 2;
}

function compareForGrid(a: GridRankable, b: GridRankable): number {
  return gridRank(a) - gridRank(b) || b.updatedAt - a.updatedAt;
}

/**
 * The Sessions the grid opens by default, at most `cap`: running or needing
 * input first, then pinned, then most recently updated. Archived and settled
 * (finished, terminated, ...) Sessions are never picked.
 */
export function pickDefaultGridSessions<T>(
  items: readonly T[],
  cap: number,
  rowOf: (item: T) => GridRankable = (item) => item as unknown as GridRankable,
): T[] {
  return items
    .filter((item) => {
      const row = rowOf(item);
      return !row.archived && !isSettledSessionStatus(row.status);
    })
    .sort((a, b) => compareForGrid(rowOf(a), rowOf(b)))
    .slice(0, cap);
}

/**
 * Trim already-open tiles to `cap`: when over it, keep the best-ranked ones
 * (same order as {@link pickDefaultGridSessions}, but settled Sessions rank
 * last rather than out) and leave them in their original order so the layout
 * does not reshuffle. Sessions the operator picked by hand (`isPreferred`)
 * are kept ahead of the ranking.
 */
export function capGridTiles<T>(
  items: readonly T[],
  cap: number,
  rowOf: (item: T) => GridRankable = (item) => item as unknown as GridRankable,
  isPreferred: (item: T) => boolean = () => false,
): T[] {
  if (items.length <= cap) return [...items];
  const keep = new Set(
    [...items]
      .sort((a, b) => {
        const ra = rowOf(a);
        const rb = rowOf(b);
        return (
          Number(isPreferred(b)) - Number(isPreferred(a)) ||
          Number(isSettledSessionStatus(ra.status)) - Number(isSettledSessionStatus(rb.status)) ||
          compareForGrid(ra, rb)
        );
      })
      .slice(0, cap),
  );
  return items.filter((item) => keep.has(item));
}
