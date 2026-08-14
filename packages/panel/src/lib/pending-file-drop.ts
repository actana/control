// A file drop that has to survive a navigation (#169).
//
// Dropping files on a Project's tile in the rail is the gesture that needs this:
// the tile has nowhere to show a progress list, so the drop opens that Project
// and the upload starts there. Between those two moments a route change happens,
// and React state does not cross one.
//
// The `File` handles do. A `DataTransfer` is only valid inside its own event, so
// the files are read out of it at drop time (`filesFromDrop`) and the handles are
// parked here — still unread, still streaming off the operator's disk when
// `fetch` finally asks for them. Nothing is copied.
//
// The same module-level-handoff shape as `pending-initial-input.ts` and
// `project-onboard-intent.ts`, and for the same reason: a one-shot value the
// sender cannot deliver directly, taken exactly once by whoever it was for.
import type { DroppedFile } from "~/lib/core-files";

type PendingDrop = { projectId: string; coreId: string; files: DroppedFile[] };

let pending: PendingDrop | null = null;

/**
 * Park a drop for the Project about to be opened.
 *
 * One at a time, and the newest wins: a second drop before the first was taken
 * means the operator changed their mind mid-navigation, and the stale one has no
 * screen left to land on.
 */
export function stashProjectFileDrop(drop: PendingDrop): void {
  pending = drop;
}

/**
 * Take the drop parked for this Project, if there is one. **Consumes it** — a
 * drop taken twice would upload the same files twice, and the Core would
 * faithfully report the second pass as an overwrite of the first.
 */
export function takeProjectFileDrop(projectId: string): PendingDrop | null {
  if (!pending || pending.projectId !== projectId) return null;
  const taken = pending;
  pending = null;
  return taken;
}

/** @internal — suites that must not inherit a previous test's parked drop. */
export function clearProjectFileDropForTests(): void {
  pending = null;
}
