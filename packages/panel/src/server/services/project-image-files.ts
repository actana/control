import * as fs from "node:fs";
import * as path from "node:path";
import { resolveUserDataDir } from "~/db/client";

/**
 * The project-image files on disk, and nothing else.
 *
 * Split out from `project-images.ts` because two owners now record which file a
 * project's card image is (the Panel's project row, and a Core-owned project's
 * presentation row), and both of those services need to sweep files when a
 * project goes. Keeping the fs half free of any DB dependency lets either import
 * it without importing the other.
 */

export function projectImagesDir(): string {
  return path.join(resolveUserDataDir(), "project-images");
}

export function projectImageAbsolutePath(filename: string): string {
  // Reject anything that tries to escape the directory.
  const safe = path.basename(filename);
  return path.join(projectImagesDir(), safe);
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
