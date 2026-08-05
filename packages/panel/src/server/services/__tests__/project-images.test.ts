import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-img-test-"));
process.env.AC_USER_DATA_DIR = tmpRoot;

const { createProject, deleteProject, getProject } = await import("../projects");
const {
  setProjectImage,
  clearProjectImage,
  findProjectImageOwner,
  writeProjectImage,
  projectImagesDir,
  projectImageAbsolutePath,
  deleteAllProjectImagesFor,
} = await import("../project-images");
const { getProjectPresentation } = await import("../project-presentation");
const { getDb } = await import("~/db/client");
const { projectPresentation, projects, tasks, groups } = await import("~/db/schema");

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function workdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-img-proj-"));
}

function touchImage(projectId: string, ext = "png"): string {
  const dir = projectImagesDir();
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${projectId}.${ext}`;
  fs.writeFileSync(path.join(dir, filename), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return filename;
}

describe("project-images service", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(tasks).run();
    db.delete(projectPresentation).run();
    db.delete(projects).run();
    db.delete(groups).run();
  });

  it("setProjectImage persists imagePath on the project row", () => {
    const c = createProject({ name: "img1", path: workdir() });
    const filename = touchImage(c.id);
    const updated = setProjectImage(c.id, filename);
    expect(updated?.imagePath).toBe(filename);
    expect(getProject(c.id)?.imagePath).toBe(filename);
  });

  it("clearProjectImage nulls the column and removes the file", () => {
    const c = createProject({ name: "img2", path: workdir() });
    const filename = touchImage(c.id);
    setProjectImage(c.id, filename);
    expect(fs.existsSync(path.join(projectImagesDir(), filename))).toBe(true);

    const cleared = clearProjectImage(c.id);
    expect(cleared?.imagePath).toBeNull();
    expect(fs.existsSync(path.join(projectImagesDir(), filename))).toBe(false);
  });

  it("deleteAllProjectImagesFor sweeps every extension for a project", () => {
    const c = createProject({ name: "img3", path: workdir() });
    touchImage(c.id, "png");
    touchImage(c.id, "jpg");
    deleteAllProjectImagesFor(c.id);
    const remaining = fs
      .readdirSync(projectImagesDir())
      .filter((n) => n.startsWith(`${c.id}.`));
    expect(remaining).toEqual([]);
  });

  it("deleteProject removes the row even when imagePath is set", () => {
    const c = createProject({ name: "img4", path: workdir() });
    const filename = touchImage(c.id);
    setProjectImage(c.id, filename);
    expect(deleteProject(c.id)).toBe(true);
    expect(getProject(c.id)).toBeNull();
  });

  it("deleteProject synchronously cleans up image files", () => {
    const c = createProject({ name: "img5", path: workdir() });
    touchImage(c.id, "png");
    touchImage(c.id, "jpg");
    deleteProject(c.id);
    const remaining = fs
      .readdirSync(projectImagesDir())
      .filter((n) => n.startsWith(`${c.id}.`));
    expect(remaining).toEqual([]);
  });

  // A Core-owned project has no row in the Panel's database (issue 98), so the
  // image record lives on its presentation row instead. Everything about the
  // files on disk is the same.
  it("records a Core-owned project's image on its presentation row", () => {
    const owner = writeProjectImage("core-project", "png", PNG_BYTES, "core-a");

    expect(owner?.imagePath).toBe("core-project.png");
    expect(getProjectPresentation("core-project")).toMatchObject({
      coreId: "core-a",
      imagePath: "core-project.png",
    });
    expect(findProjectImageOwner("core-project")?.imagePath).toBe("core-project.png");
  });

  it("refuses an image for a project neither owner knows, before writing it", () => {
    // No Panel row, no coreId to key a presentation row by: writing the file
    // and reporting success would leave bytes nothing ever points at. The
    // refusal has to come first, or the file outlives it as an orphan.
    expect(writeProjectImage("nobodys-project", "png", PNG_BYTES)).toBeNull();
    expect(fs.existsSync(path.join(projectImagesDir(), "nobodys-project.png"))).toBe(false);
  });

  // The stale-extension sweep runs on the way to writing, so a refusal that
  // happened after it would take the project's existing image down with it.
  it("leaves an existing image intact when a later write is refused", () => {
    const filename = touchImage("nobodys-project", "png");

    expect(writeProjectImage("nobodys-project", "jpg", PNG_BYTES)).toBeNull();
    expect(fs.existsSync(path.join(projectImagesDir(), filename))).toBe(true);
  });

  it("finds the Core it already knows when a later call omits the coreId", () => {
    writeProjectImage("core-project", "png", PNG_BYTES, "core-a");

    const cleared = clearProjectImage("core-project");

    expect(cleared?.imagePath).toBeNull();
    expect(getProjectPresentation("core-project")?.imagePath).toBeNull();
    expect(fs.existsSync(path.join(projectImagesDir(), "core-project.png"))).toBe(false);
  });

  it("projectImageAbsolutePath rejects path-traversal attempts", () => {
    const dir = projectImagesDir();
    const sneaky = projectImageAbsolutePath("../../etc/passwd");
    expect(sneaky.startsWith(dir)).toBe(true);
    expect(sneaky).not.toContain("..");
    const a = projectImageAbsolutePath("/absolute/path.png");
    expect(a.startsWith(dir)).toBe(true);
  });
});
