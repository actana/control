import type { ProjectPresentation } from "~/db/schema";
import { getSqlite } from "~/db/client";
import { deleteAllProjectImagesFor } from "./project-image-files";
import {
  findProjectPresentationOrphans,
  deleteProjectPresentationRow,
  findAllProjectPresentation,
  findProjectPresentationById,
  insertProjectPresentation,
  updateProjectPresentationRow,
} from "../repositories/project-presentation.repo";

/**
 * Panel-local presentation for Core-owned projects (issue 98).
 *
 * The Panel has no project row for a Core-owned Project — it lives on its Core
 * and reaches the Panel as a core-link snapshot. But group membership, the card
 * image, the launch URL and where the pin sits on this Panel's rail (#382) are
 * the Panel operator's filing, not Core facts: they mean nothing on the Core
 * and no frame carries them. The rail slot has a reason of its own — the rail
 * interleaves several Cores' pins with the Panel's, so no single Core is in a
 * position to hold a number in that sequence. This service is where all four
 * live, keyed to the Core's project id, so `PATCH /api/projects/:id` no longer
 * 404s on the only fields it could still legitimately be asked for.
 *
 * Every write is an upsert: the first time an operator files a Core-owned
 * project into a group, there is nothing to update.
 */

/** The fields a presentation row carries. `undefined` leaves one untouched. */
export type ProjectPresentationPatch = {
  groupId?: string | null;
  imagePath?: string | null;
  launchUrl?: string | null;
  pinnedOrder?: number | null;
};

/** One Core-owned pin's slot on the rail — what {@link reorderCorePins} writes. */
export type CorePinSlot = {
  projectId: string;
  coreId: string;
  pinnedOrder: number;
};

export function listProjectPresentation(): ProjectPresentation[] {
  return findAllProjectPresentation();
}

export function getProjectPresentation(projectId: string): ProjectPresentation | null {
  return findProjectPresentationById(projectId);
}

/**
 * Write `patch` onto the presentation row for `projectId`, creating the row if
 * this is the first field the operator has ever set on it. `coreId` is recorded
 * on create and refreshed on update — a project that moved Cores keeps its
 * filing rather than stranding a row nobody will ever sweep.
 */
export function upsertProjectPresentation(
  projectId: string,
  coreId: string,
  patch: ProjectPresentationPatch,
): ProjectPresentation {
  const existing = findProjectPresentationById(projectId);
  const now = Date.now();
  const fields = definedFields(patch);
  if (!existing) {
    const row: ProjectPresentation = {
      projectId,
      coreId,
      imagePath: null,
      groupId: null,
      launchUrl: null,
      pinnedOrder: null,
      ...fields,
      updatedAt: now,
    };
    insertProjectPresentation(row);
    return row;
  }
  const next: ProjectPresentation = { ...existing, ...fields, coreId, updatedAt: now };
  updateProjectPresentationRow(projectId, { ...fields, coreId, updatedAt: now });
  return next;
}

/**
 * Write the rail slot of every Core-owned pin on the rail, in one transaction
 * (issue 382).
 *
 * The rail is a single sequence of slots holding this Panel's own pins and
 * every Core's, so a reorder moves rows on both sides of that line at once.
 * The Panel's own rows take their slot on their `projects` row through
 * `reorderPinnedProjects`; a Core-owned row has no `projects` row here, so its
 * slot lands on its presentation row instead — the same integer, from the same
 * numbering space, which is what lets the merged list sort back into the
 * operator's order after a reload.
 *
 * All of it or none of it, within this half: a write that landed some of these
 * slots would be the silently-wrong order this issue is about, not a smaller
 * version of it. It does not make the reorder as a whole atomic — the Panel's
 * own rows are written by `reorderPinnedProjects` in a separate transaction
 * over a separate request, and there is no transaction spanning the two.
 */
export function reorderCorePins(slots: readonly CorePinSlot[]): ProjectPresentation[] {
  const write = getSqlite().transaction(() =>
    slots.map((slot) =>
      upsertProjectPresentation(slot.projectId, slot.coreId, { pinnedOrder: slot.pinnedOrder }),
    ),
  );
  return write.immediate();
}

/**
 * Forget a Core-owned project's filing, card image file included — the Core's
 * own delete cascades its rows and knows nothing about the bytes the Panel put
 * on this disk. Returns whether a row was there.
 */
export function deleteProjectPresentation(projectId: string): boolean {
  const removed = deleteProjectPresentationRow(projectId) > 0;
  if (removed) deleteAllProjectImagesFor(projectId);
  return removed;
}

/**
 * Drop the filing for every project on `coreId` that the Core no longer lists.
 * A project deleted on the Core — including by another Panel, or by a hand at
 * the Core's own keyboard — leaves a row here that nothing else would ever
 * collect. Returns how many rows went.
 */
export function pruneProjectPresentation(
  coreId: string,
  liveProjectIds: readonly string[],
): number {
  const orphans = findProjectPresentationOrphans(coreId, liveProjectIds);
  for (const orphan of orphans) deleteProjectPresentation(orphan.projectId);
  return orphans.length;
}

function definedFields(patch: ProjectPresentationPatch): ProjectPresentationPatch {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as ProjectPresentationPatch;
}
