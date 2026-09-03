import { eq, and, max, notInArray } from "drizzle-orm";
import { getDb } from "~/db/client";
import { projectPresentation } from "~/db/schema";
import type { ProjectPresentation } from "~/db/schema";

export function findAllProjectPresentation(): ProjectPresentation[] {
  return getDb().select().from(projectPresentation).all();
}

export function findProjectPresentationById(projectId: string): ProjectPresentation | null {
  return (
    getDb()
      .select()
      .from(projectPresentation)
      .where(eq(projectPresentation.projectId, projectId))
      .get() ?? null
  );
}

export function insertProjectPresentation(row: ProjectPresentation): void {
  getDb().insert(projectPresentation).values(row).run();
}

export function updateProjectPresentationRow(
  projectId: string,
  patch: Partial<ProjectPresentation>,
): void {
  getDb()
    .update(projectPresentation)
    .set(patch)
    .where(eq(projectPresentation.projectId, projectId))
    .run();
}

/**
 * The highest rail slot any Core-owned pin holds, or null when none does.
 * `projects.pinned_order` and this column index the same rail (#382), so the
 * Panel cannot decide where the end of that rail is by looking at its own rows
 * alone.
 *
 * It maxes over every row, stranded slots included — a presentation row whose
 * project is no longer pinned on its Core keeps the slot it held, and this
 * table cannot tell that from a live one. So the end of the rail drifts upward
 * over time. That only ever pushes a newly pinned project further past the last
 * tile, never in among them, which is why it is left here rather than guessed
 * at: the answer needs a view of both halves of the rail at once, and that is
 * the reconciliation pass filed as #478 item 1.
 */
export function findMaxProjectPresentationPinnedOrder(): number | null {
  const row = getDb()
    .select({ value: max(projectPresentation.pinnedOrder) })
    .from(projectPresentation)
    .get();
  return row?.value ?? null;
}

export function deleteProjectPresentationRow(projectId: string): number {
  return getDb()
    .delete(projectPresentation)
    .where(eq(projectPresentation.projectId, projectId))
    .run().changes;
}

/**
 * Every presentation row for `coreId` whose project is not in `liveProjectIds`
 * — the orphan set for projects deleted on the Core, including deletes this
 * Panel never witnessed. Scoped to one Core because that is the scope of the
 * list that proves a project is gone.
 */
export function findProjectPresentationOrphans(
  coreId: string,
  liveProjectIds: readonly string[],
): ProjectPresentation[] {
  const scoped = eq(projectPresentation.coreId, coreId);
  const where =
    liveProjectIds.length === 0
      ? scoped
      : and(scoped, notInArray(projectPresentation.projectId, [...liveProjectIds]));
  return getDb().select().from(projectPresentation).where(where).all();
}
