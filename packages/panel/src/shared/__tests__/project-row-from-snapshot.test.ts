import { describe, it, expect } from "vitest";
import type { CoreLinkProjectSnapshot } from "@actana/shared/core-link-frames";
import type { ProjectPresentation } from "~/db/schema";
import { projectPresentationById, projectRowFromSnapshot } from "../projects";

// The one mapper every remote-project surface renders through — the project
// page, the rail's pinned strip, Fleet. Core facts come off the snapshot; the
// Panel's own filing for that project is joined on from its presentation row
// (issue 98), and everything the Panel decorates from its own database takes a
// safe default rather than inventing Core state.

function snapshot(over: Partial<CoreLinkProjectSnapshot> = {}): CoreLinkProjectSnapshot {
  return {
    projectId: "p1",
    name: "Control",
    path: "/srv/control",
    icon: "CT",
    iconColor: "#7ce58a",
    pinned: true,
    rememberHarnessSettings: true,
    savedHarness: "claude-code",
    savedSkipPermissions: false,
    savedBareSession: false,
    defaultGridView: true,
    updatedAt: 4200,
    ...over,
  };
}

function presentation(over: Partial<ProjectPresentation> = {}): ProjectPresentation {
  return {
    projectId: "p1",
    coreId: "core-a",
    imagePath: "p1.png",
    groupId: "g1",
    launchUrl: "http://localhost:3000",
    updatedAt: 99,
    ...over,
  };
}

describe("projectRowFromSnapshot", () => {
  it("carries the Core's own facts through unchanged", () => {
    expect(projectRowFromSnapshot(snapshot())).toMatchObject({
      id: "p1",
      name: "Control",
      path: "/srv/control",
      icon: "CT",
      iconColor: "#7ce58a",
      pinned: true,
      rememberHarnessSettings: true,
      savedHarness: "claude-code",
      defaultGridView: true,
    });
  });

  it("joins the Panel's filing on when there is a presentation row", () => {
    expect(projectRowFromSnapshot(snapshot(), presentation())).toMatchObject({
      groupId: "g1",
      imagePath: "p1.png",
      launchUrl: "http://localhost:3000",
    });
  });

  // Never filed is the common case, and it must read as unfiled rather than
  // crashing a rail that clusters by group.
  it("reads as unfiled when the operator never filed the project", () => {
    expect(projectRowFromSnapshot(snapshot())).toMatchObject({
      groupId: null,
      imagePath: null,
      launchUrl: null,
    });
  });

  it("zeroes the counts a Core snapshot has no answer for", () => {
    const row = projectRowFromSnapshot(snapshot());
    expect(row.taskCounts.total).toBe(0);
    expect(row.taskCounts.running).toBe(0);
    expect(row.preview).toBeNull();
    expect(row.repoKey).toBeNull();
  });

  it("indexes presentation rows by project id", () => {
    const index = projectPresentationById([presentation(), presentation({ projectId: "p2" })]);
    expect(index.get("p2")?.projectId).toBe("p2");
    expect(index.get("p3")).toBeUndefined();
  });
});
