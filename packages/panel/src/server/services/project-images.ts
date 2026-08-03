import * as fs from "node:fs";
import * as path from "node:path";
import { resolveUserDataDir } from "~/db/client";
import { findProjectById } from "../repositories/projects.repo";
import { updateProject } from "./projects";
import type { Project } from "~/db/schema";

import {
  PROJECT_IMAGE_EXTENSIONS,
  projectImageContentType,
  type ProjectImageExtension,
} from "~/shared/project-image-limits";

export {
  MAX_PROJECT_IMAGE_BYTES as MAX_IMAGE_BYTES,
  PROJECT_IMAGE_EXTENSIONS as ALLOWED_IMAGE_EXTENSIONS,
} from "~/shared/project-image-limits";

export function projectImagesDir(): string {
  return path.join(resolveUserDataDir(), "project-images");
}

export function projectImageAbsolutePath(filename: string): string {
  // Reject anything that tries to escape the directory.
  const safe = path.basename(filename);
  return path.join(projectImagesDir(), safe);
}

export function setProjectImage(projectId: string, filename: string): Project | null {
  return updateProject(projectId, { imagePath: filename });
}

export function clearProjectImage(projectId: string): Project | null {
  const existing = findProjectById(projectId);
  if (!existing) return null;
  if (existing.imagePath) deleteProjectImageFile(existing.imagePath);
  return updateProject(projectId, { imagePath: null });
}

export function deleteProjectImageFile(filename: string): void {
  try {
    const abs = projectImageAbsolutePath(filename);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch {
    /* swallow — best-effort cleanup */
  }
}

export function deleteAllProjectImagesFor(projectId: string): void {
  try {
    const dir = projectImagesDir();
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const base = name.split(".")[0];
      if (base === projectId) fs.unlinkSync(path.join(dir, name));
    }
  } catch {
    /* swallow */
  }
}

/**
 * A stored card image, ready to serve: its bytes and the type to send them as.
 * Null when the project has no image, or its file went missing under us.
 */
export function readProjectImage(
  project: Project,
): { bytes: Buffer; contentType: string } | null {
  if (!project.imagePath) return null;
  const abs = projectImageAbsolutePath(project.imagePath);
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
): Project | null {
  const dir = projectImagesDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const stale of PROJECT_IMAGE_EXTENSIONS) {
    if (stale === extension) continue;
    const stalePath = projectImageAbsolutePath(`${projectId}.${stale}`);
    if (fs.existsSync(stalePath)) fs.unlinkSync(stalePath);
  }
  const filename = `${projectId}.${extension}`;
  fs.writeFileSync(projectImageAbsolutePath(filename), bytes);
  return setProjectImage(projectId, filename);
}
