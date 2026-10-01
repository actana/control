import type { Session } from "~/db/schema";

/** What the board remembers about the session that was last active in a scope. */
export type LastActiveSession = {
  projectId: string;
  sessionId: string;
  /** Whether that row was archived while it held the active slot. */
  archived: boolean;
};

type RememberDeps = {
  /** The project's active session list — a Panel-owned project's archived rows live here too. */
  sessions: readonly Session[];
  /** The rows the Archived view is showing. For a Core these are absent from `sessions` (ADR 0019). */
  archivedSessions: readonly Session[];
  /** What was remembered before, so an established `archived` verdict is not forgotten. */
  previous: LastActiveSession | null;
};

/**
 * Remember the session holding a scope's active slot, and whether it is archived.
 *
 * The flag is worked out here, while the row is active and the list it came from
 * is loaded, rather than at deselect time: a Core's archived rows are fetched
 * only while the Archived view is open (ADR 0019), so a later read of
 * `archivedSessions` can no longer answer the question. Once an id is known to be
 * archived it stays archived for as long as it holds the slot — a refetch that
 * drops the row must not un-know it.
 */
export function rememberActiveSession(
  sessionId: string,
  projectId: string,
  deps: RememberDeps,
): LastActiveSession {
  const { sessions, archivedSessions, previous } = deps;
  const alreadyKnown =
    previous !== null &&
    previous.projectId === projectId &&
    previous.sessionId === sessionId &&
    previous.archived;
  const archived =
    alreadyKnown ||
    archivedSessions.some((t) => t.id === sessionId) ||
    (sessions.find((t) => t.id === sessionId)?.archived ?? false);
  return { projectId, sessionId, archived };
}

/**
 * Did the remembered session go away, or did the operator just deselect it?
 *
 * The board force-opens a replacement only for the first. The check is "is it
 * still on screen", and an archived row never is — it is not in the active list
 * by construction — so before the archived flag existed a deselect on one read
 * as a deletion and yanked the operator into an unrelated live session (issue
 * 397 review §5.1; on a Core that session is opened without a `coreId` and its
 * pane never spawns). An archived row leaving the slot is always a deselect.
 */
export function activeSessionWentAway(
  previous: LastActiveSession,
  projectId: string,
  visibleSessions: readonly Session[],
): boolean {
  if (previous.projectId !== projectId) return false;
  if (previous.archived) return false;
  return !visibleSessions.some((t) => t.id === previous.sessionId);
}
