// Pure fleet-merge helper for the Panel's Fleet view (issue 07, CONTEXT.md
// "Fleet view").
//
// The Fleet view fans out `sessionRowsList` calls to every connected Core in parallel
// and merges results keyed by `coreId/sessionId` for a unified dashboard. Offline
// Cores show "unreachable + last-seen timestamp" with no session rows — the Panel
// caches nothing beyond the Core registry, so a downed Core is honestly blank,
// not stale. With a single registered Core the Fleet view degenerates to
// per-Core navigation.
//
// This module is pure (no I/O, no IPC) so it is fully unit-testable and can be
// shared across the renderer and main process. It compiles under both the Vite
// tsconfigs (no `~/` imports), mirroring `core-link-frames.ts`.

import type { CoreLinkSessionRow } from "@actana/shared/sdk-link-frames";

/**
 * One Core's contribution to a fan-out. The caller (the Panel's fleet manager)
 * produces one of these per registered Core after attempting its `sessionRowsList`
 * query: `{ ok: true, sessions, lastSeenAt }` on success, or `{ ok: false,
 * lastSeenAt }` when the Core was unreachable (the query timed out, the
 * core-link was down, or auth failed). `lastSeenAt` is the highest timestamp
 * the Panel ever reached this Core at (null if never seen) — used for the
 * "last-seen" hint on offline rows.
 */
export type CoreFanOutResult =
  | {
      coreId: string;
      coreLabel: string;
      ok: true;
      sessions: CoreLinkSessionRow[];
      lastSeenAt: number;
    }
  | {
      coreId: string;
      coreLabel: string;
      ok: false;
      lastSeenAt: number | null;
    };

/**
 * A session row in the merged Fleet view. A {@link CoreLinkSessionRow}
 * annotated with its source Core's id + label so the dashboard can group or
 * badge rows by Core. The composite key `coreId/sessionId` uniquely identifies a
 * row across the fleet.
 */
export type FleetSessionRow = CoreLinkSessionRow & {
  coreId: string;
  coreLabel: string;
};

/**
 * A Core that could not be reached for this fan-out. Carries no session rows —
 * the Panel caches nothing session-shaped, so a downed Core is honestly blank
 * rather than stale. `lastSeenAt` is null when the Panel has never reached it.
 */
export type OfflineCore = {
  coreId: string;
  coreLabel: string;
  lastSeenAt: number | null;
};

/**
 * The merged Fleet view model returned by {@link mergeFleetSessions}.
 */
export type FleetMergeResult = {
  rows: FleetSessionRow[];
  offlineCores: OfflineCore[];
  /**
   * True when exactly one Core was fanned out to (online or offline). The
   * Fleet view degenerates to per-Core navigation in this case — the caller
   * may render the single-Core layout instead of the merged dashboard.
   */
  singleCore: boolean;
};

/**
 * Merge per-Core `sessionRowsList` fan-out results into a single Fleet view model.
 *
 * - Online Cores contribute their sessions as {@link FleetSessionRow}s, keyed by
 *   `coreId/sessionId`. Archived sessions are defensively dropped (the Core
 *   should already omit them, but a stale Core never pollutes the active
 *   dashboard).
 * - Offline Cores contribute an {@link OfflineCore} entry with no rows.
 * - Rows are sorted by `updatedAt` descending (most recent first).
 * - Offline Cores are sorted by label for stable display.
 *
 * Pure and synchronous; safe to call from the renderer.
 */
export function mergeFleetSessions(results: CoreFanOutResult[]): FleetMergeResult {
  // Keyed by `coreId/sessionId` — the composite identity the Fleet view merges
  // on (CONTEXT.md "Fleet view"). Each Core owns disjoint sessionIds, so in
  // practice this is a union; the Map makes the merge explicit and drops any
  // duplicate that slips through (a re-delivery after reconnect) rather than
  // rendering it twice.
  const rowsByKey = new Map<string, FleetSessionRow>();
  const offlineCores: OfflineCore[] = [];

  for (const result of results) {
    if (result.ok) {
      for (const session of result.sessions) {
        // The Fleet view is for active work; archived sessions stay on the
        // Core. Defensively drop any that slip through.
        if (session.archived) continue;
        const key = `${result.coreId}/${session.sessionId}`;
        if (rowsByKey.has(key)) continue;
        rowsByKey.set(key, {
          ...session,
          coreId: result.coreId,
          coreLabel: result.coreLabel,
        });
      }
    } else {
      offlineCores.push({
        coreId: result.coreId,
        coreLabel: result.coreLabel,
        lastSeenAt: result.lastSeenAt,
      });
    }
  }

  const rows = [...rowsByKey.values()];
  rows.sort(byUpdatedAtDesc);
  offlineCores.sort(byLabelAsc);

  return {
    rows,
    offlineCores,
    singleCore: results.length === 1,
  };
}

function byUpdatedAtDesc(a: { updatedAt: number }, b: { updatedAt: number }): number {
  return b.updatedAt - a.updatedAt;
}

function byLabelAsc(a: { coreLabel: string }, b: { coreLabel: string }): number {
  return a.coreLabel.localeCompare(b.coreLabel, undefined, { sensitivity: "base" });
}

// ─── Fan-out ─────────────────────────────────────────────────────────────────

/**
 * One Core to fan a `sessionRowsList` query out to. `lastSeenAt` is the highest
 * timestamp the Panel ever reached this Core at (null if never) — carried
 * through to the {@link CoreFanOutResult} so an offline Core shows an honest
 * "last-seen" hint instead of stale rows.
 */
export type CoreFanOutTarget = {
  coreId: string;
  coreLabel: string;
  lastSeenAt: number | null;
};

/** Default per-Core query timeout. A Core that doesn't answer in time is
 *  treated as offline — the Fleet view never blocks on one slow Core. */
export const DEFAULT_FANOUT_TIMEOUT_MS = 5_000;

/**
 * Fan a `sessionRowsList` query out to every target Core in parallel and collect the
 * results as {@link CoreFanOutResult}s. A Core whose query rejects or times
 * out (after {@link timeoutMs}) becomes an offline result with no session rows —
 * the Panel caches nothing, so a downed Core is honestly blank.
 *
 * The `query` function is injected so this helper is process-agnostic: a
 * browser passes one that asks over the panel link, the service passes one that
 * calls each Core's client directly. Either way the fan-out + timeout +
 * offline-fallback logic is identical and tested here, once.
 *
 * Results preserve the input target order so the caller's Core ordering is
 * stable in the merged view.
 */
export async function fanOutSessions(
  targets: CoreFanOutTarget[],
  query: (coreId: string) => Promise<CoreLinkSessionRow[]>,
  timeoutMs: number = DEFAULT_FANOUT_TIMEOUT_MS,
): Promise<CoreFanOutResult[]> {
  const settled = await Promise.all(
    targets.map(async (target): Promise<CoreFanOutResult> => {
      try {
        const sessions = await withTimeout(query(target.coreId), timeoutMs);
        return {
          coreId: target.coreId,
          coreLabel: target.coreLabel,
          ok: true,
          sessions,
          lastSeenAt: target.lastSeenAt ?? Date.now(),
        };
      } catch {
        return {
          coreId: target.coreId,
          coreLabel: target.coreLabel,
          ok: false,
          lastSeenAt: target.lastSeenAt,
        };
      }
    }),
  );
  return settled;
}

/**
 * Race a promise against a timeout. Resolves with the promise's value, or
 * rejects with a timeout error if it doesn't settle in time. The timeout
 * never leaks: the underlying promise is abandoned (not cancelled — JS
 * promises can't be), so a late resolution is simply ignored.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`fan-out query timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
