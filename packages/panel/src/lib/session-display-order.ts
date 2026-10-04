import {
  STATUS_DISPLAY_ORDER,
  SESSION_STATUSES,
  type SessionStatus,
} from "@actana/shared/domain";

type DisplaySession = {
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
};

type PinnableDisplaySession = DisplaySession & {
  pinned: boolean;
};

function byMostRecentActivity<T extends DisplaySession>(a: T, b: T): number {
  return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt;
}

function statusDisplayRank(status: SessionStatus): number {
  return STATUS_DISPLAY_ORDER.indexOf(status);
}

function byPinnedListOrder<T extends DisplaySession>(a: T, b: T): number {
  const rankDelta = statusDisplayRank(a.status) - statusDisplayRank(b.status);
  if (rankDelta !== 0) return rankDelta;
  if (a.status === "finished" || b.status === "finished") {
    return byMostRecentActivity(a, b);
  }
  return 0;
}

export function groupSessionsByStatusForDisplay<T extends DisplaySession>(
  sessions: readonly T[],
): Record<SessionStatus, T[]> {
  const grouped = SESSION_STATUSES.reduce(
    (acc, status) => {
      acc[status] = [];
      return acc;
    },
    {} as Record<SessionStatus, T[]>,
  );

  for (const session of sessions) grouped[session.status].push(session);

  grouped.finished.sort(byMostRecentActivity);

  return grouped;
}

/**
 * Archived-tab list view: collapse every live status into the Finished/
 * "Archived" bucket. Archived sessions keep their last runtime status in the
 * DB (interrupted, running, …), but the archived tab is parked history — it
 * must never re-surface Interrupted / Running / Ready / etc. columns.
 */
export function groupArchivedSessionsForDisplay<T extends DisplaySession>(
  sessions: readonly T[],
): Record<SessionStatus, T[]> {
  const grouped = SESSION_STATUSES.reduce(
    (acc, status) => {
      acc[status] = [];
      return acc;
    },
    {} as Record<SessionStatus, T[]>,
  );
  grouped.finished = [...sessions].sort(byMostRecentActivity);
  return grouped;
}

/**
 * Active-tab list view: peel pinned sessions into their own top section, then
 * group the remaining (unpinned) sessions by status as usual.
 */
export function groupActiveListSessionsForDisplay<T extends PinnableDisplaySession>(
  sessions: readonly T[],
): { pinned: T[]; byStatus: Record<SessionStatus, T[]> } {
  const pinned: T[] = [];
  const unpinned: T[] = [];
  for (const session of sessions) {
    if (session.pinned) pinned.push(session);
    else unpinned.push(session);
  }
  pinned.sort(byPinnedListOrder);
  return {
    pinned,
    byStatus: groupSessionsByStatusForDisplay(unpinned),
  };
}
