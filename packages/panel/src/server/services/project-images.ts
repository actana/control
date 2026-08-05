import * as fs from "node:fs";
import * as path from "node:path";
import { findProjectById } from "../repositories/projects.repo";
import { updateProject } from "./projects";
import {
  getProjectPresentation,
  upsertProjectPresentation,
} from "./project-presentation";
import {
  deleteProjectImageFile,
  projectImageAbsolutePath,
  projectImagesDir,
} from "./project-image-files";

import {
  PROJECT_IMAGE_EXTENSIONS,
  projectImageContentType,
  type ProjectImageExtension,
} from "~/shared/project-image-limits";

export {
  MAX_PROJECT_IMAGE_BYTES as MAX_IMAGE_BYTES,
  PROJECT_IMAGE_EXTENSIONS as ALLOWED_IMAGE_EXTENSIONS,
} from "~/shared/project-image-limits";
export {
  deleteAllProjectImagesFor,
  deleteProjectImageFile,
  projectImageAbsolutePath,
  projectImagesDir,
} from "./project-image-files";

/**
 * Where a project's card image is recorded and what it currently points at.
 *
 * A card image is Panel-local presentation whichever kind of project it belongs
 * to, but the column it lives in differs: the Panel's own project row for a
 * Panel-owned project, and the presentation row (issue 98) for a Core-owned
 * one, whose project row lives on its Core and carries no image. Every read and
 * write below goes through this shape, so the file handling — naming, stale
 * extension sweeps, traversal guards — is written once and neither owner is a
 * special case.
 */
export type ProjectImageOwner = { projectId: string; imagePath: string | null };

/** The current image record for a project, or null when neither owner has one. */
export function findProjectImageOwner(projectId: string): ProjectImageOwner | null {
  const project = findProjectById(projectId);
  if (project) return { projectId, imagePath: project.imagePath };
  const presentation = getProjectPresentation(projectId);
  if (presentation) return { projectId, imagePath: presentation.imagePath };
  return null;
}

/**
 * Point a project at a stored image file (or at nothing, with `null`).
 *
 * `coreId` names the Core for a Core-owned project, and is what lets the very
 * first image an operator uploads create the presentation row. Without it there
 * is no row to update and nothing to key a new one by, so the write is refused
 * — the caller turns that into a 404 rather than reporting a save that did not
 * happen.
 */
export function setProjectImage(
  projectId: string,
  filename: string | null,
  coreId?: string | null,
): ProjectImageOwner | null {
  if (findProjectById(projectId)) {
    const project = updateProject(projectId, { imagePath: filename });
    return project ? { projectId, imagePath: project.imagePath } : null;
  }
  const owningCore = coreId ?? getProjectPresentation(projectId)?.coreId ?? null;
  if (!owningCore) return null;
  const row = upsertProjectPresentation(projectId, owningCore, { imagePath: filename });
  return { projectId, imagePath: row.imagePath };
}

export function clearProjectImage(
  projectId: string,
  coreId?: string | null,
): ProjectImageOwner | null {
  const existing = findProjectImageOwner(projectId);
  if (!existing) return null;
  if (existing.imagePath) deleteProjectImageFile(existing.imagePath);
  return setProjectImage(projectId, null, coreId);
}

/**
 * A stored card image, ready to serve: its bytes and the type to send them as.
 * Null when the project has no image, or its file went missing under us.
 */
export function readProjectImage(
  owner: ProjectImageOwner,
): { bytes: Buffer; contentType: string } | null {
  if (!owner.imagePath) return null;
  const abs = projectImageAbsolutePath(owner.imagePath);
  try {
    const bytes = fs.readFileSync(abs);
    const extension = path.extname(abs).replace(".", "");
    return { bytes, contentType: projectImageContentType(extension) };
  } catch {
    // Gone or unreadable — the row outlived its file. A missing image is a
    // 404, not a 500.
    return null;
  }
}

/**
 * Write a project's card image and point the row at it.
 *
 * One file per project, named by id, so replacing an image overwrites in place
 * and a project can never accumulate orphans. A format change leaves a file
 * under the old extension, so those are swept first.
 *
 * Throws if the directory or the file cannot be written — the caller turns that
 * into an error response rather than a silent success.
 */
export function writeProjectImage(
  projectId: string,
  extension: ProjectImageExtension,
  bytes: Uint8Array,
  coreId?: string | null,
): ProjectImageOwner | null {
  const dir = projectImagesDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const stale of PROJECT_IMAGE_EXTENSIONS) {
    if (stale === extension) continue;
    const stalePath = projectImageAbsolutePath(`${projectId}.${stale}`);
    if (fs.existsSync(stalePath)) fs.unlinkSync(stalePath);
  }
  const filename = `${projectId}.${extension}`;
  fs.writeFileSync(projectImageAbsolutePath(filename), bytes);
  return setProjectImage(projectId, filename, coreId);
}
