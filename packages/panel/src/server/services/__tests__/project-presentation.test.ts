import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-presentation-test-"));
process.env.AC_USER_DATA_DIR = tmpRoot;

const {
  deleteProjectPresentation,
  getProjectPresentation,
  listProjectPresentation,
  pruneProjectPresentation,
  upsertProjectPresentation,
} = await import("../project-presentation");
const { projectImagesDir } = await import("../project-image-files");
const { createGroup } = await import("../groups");
const { getDb } = await import("~/db/client");
const { projectPresentation, projects, tasks, groups } = await import("~/db/schema");

// Panel-local filing for projects whose row lives on a Core (issue 98). The
// point of the table is that it is keyed to a project the Panel has no row for,
// so nothing here creates one.

function touchImage(projectId: string, ext = "png"): string {
  const dir = projectImagesDir();
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${projectId}.${ext}`;
  fs.writeFileSync(path.join(dir, filename), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return filename;
}

describe("project-presentation service", () => {
  // group_id carries a real foreign key, so a group has to exist to file into
  // — the same ON DELETE SET NULL the Panel's own project rows get.
  let groupId: string;

  beforeEach(() => {
    const db = getDb();
    db.delete(tasks).run();
    db.delete(projectPresentation).run();
    db.delete(projects).run();
    db.delete(groups).run();
    groupId = createGroup({ name: "Work" }).id;
  });

  it("creates the row on the first field an operator sets", () => {
    const row = upsertProjectPresentation("p1", "core-a", { groupId });

    expect(row).toMatchObject({ projectId: "p1", coreId: "core-a", groupId });
    expect(getProjectPresentation("p1")).toMatchObject({ groupId });
  });

  it("leaves fields the patch omits alone", () => {
    upsertProjectPresentation("p1", "core-a", { groupId, launchUrl: "http://x" });
    const row = upsertProjectPresentation("p1", "core-a", { imagePath: "p1.png" });

    expect(row).toMatchObject({ groupId, launchUrl: "http://x", imagePath: "p1.png" });
  });

  it("treats an explicit null as a clear, not as an omission", () => {
    upsertProjectPresentation("p1", "core-a", { groupId });
    const row = upsertProjectPresentation("p1", "core-a", { groupId: null });

    expect(row.groupId).toBeNull();
    expect(getProjectPresentation("p1")?.groupId).toBeNull();
  });

  it("re-keys a project that moved Cores rather than stranding its filing", () => {
    upsertProjectPresentation("p1", "core-a", { groupId });
    const row = upsertProjectPresentation("p1", "core-b", { groupId });

    expect(row.coreId).toBe("core-b");
  });

  it("deleting the filing also takes the card image off this disk", () => {
    const filename = touchImage("p1");
    upsertProjectPresentation("p1", "core-a", { imagePath: filename });

    expect(deleteProjectPresentation("p1")).toBe(true);
    expect(getProjectPresentation("p1")).toBeNull();
    expect(fs.existsSync(path.join(projectImagesDir(), filename))).toBe(false);
  });

  it("deleting a project with no filing is not an error", () => {
    expect(deleteProjectPresentation("never-filed")).toBe(false);
  });

  // A project deleted on its Core — including by another Panel, or at the
  // Core's own keyboard — leaves a row nothing else would ever collect.
  it("prunes filing for projects the Core no longer lists", () => {
    upsertProjectPresentation("p1", "core-a", { groupId });
    upsertProjectPresentation("p2", "core-a", { groupId });

    expect(pruneProjectPresentation("core-a", ["p1"])).toBe(1);
    expect(listProjectPresentation().map((r) => r.projectId)).toEqual(["p1"]);
  });

  it("prunes only within the Core that answered", () => {
    upsertProjectPresentation("p1", "core-a", { groupId });
    upsertProjectPresentation("p2", "core-b", { groupId });

    expect(pruneProjectPresentation("core-a", [])).toBe(1);
    expect(listProjectPresentation().map((r) => r.projectId)).toEqual(["p2"]);
  });

  it("sweeps the image file of a pruned orphan too", () => {
    const filename = touchImage("p1");
    upsertProjectPresentation("p1", "core-a", { imagePath: filename });

    pruneProjectPresentation("core-a", []);

    expect(fs.existsSync(path.join(projectImagesDir(), filename))).toBe(false);
  });
});
