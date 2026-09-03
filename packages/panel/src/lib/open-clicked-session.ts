import type { Task } from "~/db/schema";
import type { ScopedProject } from "~/lib/scoped-project";

/** The slice of the terminal store a session card click needs. */
type SessionOpener = {
  openSession: (
    project: ScopedProject,
    task: Task,
    opts?: { ptyId?: string | null; coreId?: string | null },
  ) => void;
  focusGridSession: (taskId: string, opts?: { flash?: boolean }) => void;
};

type OpenClickedSessionDeps = {
  /** The project's active task list — a Panel-owned project's archived rows live here too. */
  tasks: readonly Task[];
  /** The rows the Archived view is showing. For a Core these are absent from `tasks` (ADR 0019). */
  archivedTasks: readonly Task[];
  project: ScopedProject | null;
  coreId: string | null;
  terminals: SessionOpener;
};

/**
 * Open (or reattach) the session behind a card click, from either list.
 *
 * Where the clicked row can be found differs by owner (ADR 0019). A Panel-owned
 * project's task list already carries its archived rows, so one lookup covers
 * both views. A Core keeps its archived rows in their own list, so a click on an
 * archived card resolved against `tasks` alone finds nothing and the card — and
 * its Reply button, which routes here too — does nothing at all (issue 397).
 * Falling back to the archived rows resolves those the same way active ones are
 * resolved. Active rows still resolve out of `tasks` first, so their behaviour
 * is untouched.
 *
 * Returns whether a session was opened.
 */
export function openClickedSession(taskId: string, deps: OpenClickedSessionDeps): boolean {
  const { tasks, archivedTasks, project, coreId, terminals } = deps;
  const task = tasks.find((t) => t.id === taskId) ?? archivedTasks.find((t) => t.id === taskId);
  if (!task || !project) return false;
  terminals.openSession(project, task, { coreId });
  // Move the caret into the session's terminal so the user can type right
  // away. Switching to an already-built (cached) surface reattaches without
  // focusing, so without this the card click selects the session but leaves
  // the terminal blurred until a second manual click. TerminalPanel consumes
  // this request and re-asserts focus across the pane remount.
  terminals.focusGridSession(taskId);
  return true;
}
