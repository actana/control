import type { Task } from "~/db/schema";

/** What the board remembers about the session that was last active in a scope. */
export type LastActiveSession = {
  projectId: string;
  taskId: string;
  /** Whether that row was archived while it held the active slot. */
  archived: boolean;
};

type RememberDeps = {
  /** The project's active task list — a Panel-owned project's archived rows live here too. */
  tasks: readonly Task[];
  /** The rows the Archived view is showing. For a Core these are absent from `tasks` (ADR 0019). */
  archivedTasks: readonly Task[];
  /** What was remembered before, so an established `archived` verdict is not forgotten. */
  previous: LastActiveSession | null;
};

/**
 * Remember the session holding a scope's active slot, and whether it is archived.
 *
 * The flag is worked out here, while the row is active and the list it came from
 * is loaded, rather than at deselect time: a Core's archived rows are fetched
 * only while the Archived view is open (ADR 0019), so a later read of
 * `archivedTasks` can no longer answer the question. Once an id is known to be
 * archived it stays archived for as long as it holds the slot — a refetch that
 * drops the row must not un-know it.
 */
export function rememberActiveSession(
  taskId: string,
  projectId: string,
  deps: RememberDeps,
): LastActiveSession {
  const { tasks, archivedTasks, previous } = deps;
  const alreadyKnown =
    previous !== null &&
    previous.projectId === projectId &&
    previous.taskId === taskId &&
    previous.archived;
  const archived =
    alreadyKnown ||
    archivedTasks.some((t) => t.id === taskId) ||
    (tasks.find((t) => t.id === taskId)?.archived ?? false);
  return { projectId, taskId, archived };
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
  visibleTasks: readonly Task[],
): boolean {
  if (previous.projectId !== projectId) return false;
  if (previous.archived) return false;
  return !visibleTasks.some((t) => t.id === previous.taskId);
}
