import type { CoreLinkTaskSnapshot } from "@actana/sdk/core-link-frames";
import {
  coreTaskCountsByProject,
  emptyTaskCounts,
  type ProjectTaskCounts,
} from "~/shared/projects";

/**
 * What the rail should show for one Core's pinned projects (issue 377).
 *
 * `tasks` is that Core's own `tasksList` answer — the same frame, and so the
 * same rows, the grid renders from. `null` means the Core could not be asked
 * this pass: it is offline, or the read failed. That is the case worth being
 * careful about. Zeroing there would light no dot, and no dot is not a neutral
 * rendering — on a rail it reads as "nothing running on this project", which is
 * a claim the Panel cannot make about a Core it just failed to reach. So an
 * unreachable Core's pins keep exactly the counts they last had, and the tile
 * stops moving instead of lying.
 *
 * A project with no rows in a Core that *did* answer is a real zero: that is
 * how the last running Session going away clears the dot.
 *
 * `lastKnown` is keyed by project id and holds the previous answer for this
 * Core. A project the Panel has never had counts for falls back to zeros —
 * there is nothing else to show, and it is honest about a rail that has not
 * heard from this Core yet.
 */
export function corePinTaskCounts(
  projectIds: readonly string[],
  tasks: readonly CoreLinkTaskSnapshot[] | null,
  lastKnown: ReadonlyMap<string, ProjectTaskCounts>,
): Map<string, ProjectTaskCounts> {
  const derived = tasks === null ? null : coreTaskCountsByProject(tasks);
  const counts = new Map<string, ProjectTaskCounts>();
  for (const projectId of projectIds) {
    counts.set(
      projectId,
      derived === null
        ? (lastKnown.get(projectId) ?? emptyTaskCounts())
        : (derived.get(projectId) ?? emptyTaskCounts()),
    );
  }
  return counts;
}
