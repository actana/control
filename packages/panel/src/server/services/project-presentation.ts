import type { ProjectPresentation } from "~/db/schema";
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
 * image and the launch URL are the Panel operator's filing, not Core facts:
 * they mean nothing on the Core and no frame carries them. This service is
 * where they live, keyed to the Core's project id, so `PATCH /api/projects/:id`
 * no longer 404s on the only fields it could still legitimately be asked for.
 *
 * Every write is an upsert: the first time an operator files a Core-owned
 * project into a group, there is nothing to update.
 */

/** The fields a presentation row carries. `undefined` leaves one untouched. */
export type ProjectPresentationPatch = {
  groupId?: string | null;
  imagePath?: string | null;
  launchUrl?: string | null;
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
