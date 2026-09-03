import { describe, expect, it } from "vitest";
import type { Group } from "~/db/schema";
import {
  clusterPinnedByGroup,
  getRailClusters,
  mergeRailProjects,
  railNavigateSearch,
  resolveRailChordTarget,
  usesDirectRailProjectShortcuts,
  type RailProject,
} from "~/lib/rail-projects";
import { ACTIVE_GROUP_ALL, ACTIVE_GROUP_UNGROUPED } from "~/shared/ui-preferences";

function group(id: string, name: string): Group {
  return {
    id,
    name,
    color: "#888888",
    sortOrder: null,
    createdAt: 1_000,
  };
}

function project(
  id: string,
  groupId: string | null,
  pinnedOrder: number,
): RailProject {
  return {
    id,
    name: id,
    groupId,
    pinned: true,
    pinnedOrder,
    createdAt: 1_000 + pinnedOrder,
  };
}

describe("clusterPinnedByGroup", () => {
  it("keeps empty groups in group order so their rail headers remain drop targets", () => {
    const clusters = clusterPinnedByGroup(
      [project("alpha-project", "alpha", 0), project("loose-project", null, 1)],
      [group("alpha", "Alpha"), group("empty", "Empty"), group("omega", "Omega")],
    );

    expect(clusters.map(({ key, projects }) => [key, projects.map((entry) => entry.id)])).toEqual([
      ["alpha", ["alpha-project"]],
      ["empty", []],
      ["omega", []],
      ["ungrouped", ["loose-project"]],
    ]);
  });

  it("does not add an empty synthetic Ungrouped cluster", () => {
    const clusters = clusterPinnedByGroup([], [group("empty", "Empty")]);

    expect(clusters.map((cluster) => cluster.key)).toEqual(["empty"]);
  });
});

describe("usesDirectRailProjectShortcuts", () => {
  it("uses direct project digits when no real groups exist", () => {
    expect(usesDirectRailProjectShortcuts([], ACTIVE_GROUP_ALL)).toBe(true);
  });

  it("uses group→project chords in All mode when groups exist", () => {
    expect(usesDirectRailProjectShortcuts([group("dev", "Dev")], ACTIVE_GROUP_ALL)).toBe(false);
  });

  it("uses direct project digits inside a selected group workspace", () => {
    expect(usesDirectRailProjectShortcuts([group("dev", "Dev")], "dev")).toBe(true);
    expect(
      usesDirectRailProjectShortcuts([group("dev", "Dev")], ACTIVE_GROUP_UNGROUPED),
    ).toBe(true);
  });
});

// #379: the rail badges number the MERGED pin list — the Panel's own rows plus
// every Core's pins — so a chord read off `useProjects` alone addressed a
// different list than the one the operator is looking at.
describe("rail chords address the merged pin list (#379)", () => {
  function corePin(
    id: string,
    coreId: string,
    groupId: string | null,
    pinnedOrder: number,
  ): RailProject {
    return { ...project(id, groupId, pinnedOrder), coreId };
  }

  const panelPins = [project("panel-a", null, 0), project("panel-b", null, 2)];
  const remotePins = [corePin("core-a", "core-1", null, 1), corePin("core-b", "core-2", null, 3)];

  it("resolves visible badge N to the Nth merged pin, Core pins included", () => {
    const merged = mergeRailProjects(panelPins, remotePins);
    const clusters = getRailClusters(merged, [], ACTIVE_GROUP_ALL);

    // One flat cluster, badges 1..4 in pinned order — panel, Core, panel, Core.
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.projects.map((p) => p.id)).toEqual([
      "panel-a",
      "core-a",
      "panel-b",
      "core-b",
    ]);
    for (const [badge, id] of [
      [1, "panel-a"],
      [2, "core-a"],
      [3, "panel-b"],
      [4, "core-b"],
    ] as const) {
      expect(resolveRailChordTarget(clusters, null, badge)?.id).toBe(id);
    }
  });

  it("would have opened the wrong pin from the Panel's own rows alone", () => {
    // The bug, pinned down: badge 2 is a Core pin, but the unmerged list makes
    // it `panel-b`. Merging is what makes the chord agree with the badge.
    const unmerged = getRailClusters(panelPins, [], ACTIVE_GROUP_ALL);
    expect(resolveRailChordTarget(unmerged, null, 2)?.id).toBe("panel-b");
  });

  it("carries ?coreId= for a Core pin and omits it for a Panel row", () => {
    const clusters = getRailClusters(mergeRailProjects(panelPins, remotePins), [], ACTIVE_GROUP_ALL);

    expect(railNavigateSearch(resolveRailChordTarget(clusters, null, 2)!)).toEqual({
      coreId: "core-1",
    });
    expect(railNavigateSearch(resolveRailChordTarget(clusters, null, 4)!)).toEqual({
      coreId: "core-2",
    });
    expect(railNavigateSearch(resolveRailChordTarget(clusters, null, 1)!)).toBeUndefined();
  });

  it("resolves a group→project chord against the same clusters the rail draws", () => {
    const groups = [group("alpha", "Alpha"), group("omega", "Omega")];
    const merged = mergeRailProjects(
      [project("panel-alpha", "alpha", 0)],
      [corePin("core-omega", "core-9", "omega", 1), corePin("core-alpha", "core-9", "alpha", 2)],
    );
    const clusters = getRailClusters(merged, groups, ACTIVE_GROUP_ALL);

    // Group 1 badge 2 is the Core's Alpha pin; group 2 badge 1 its Omega pin.
    expect(resolveRailChordTarget(clusters, 1, 2)?.id).toBe("core-alpha");
    expect(resolveRailChordTarget(clusters, 2, 1)?.id).toBe("core-omega");
    expect(railNavigateSearch(resolveRailChordTarget(clusters, 1, 2)!)).toEqual({
      coreId: "core-9",
    });
    // A Cmd release mid-chord jumps to the group's first project — same list.
    expect(resolveRailChordTarget(clusters, 1, 1)?.id).toBe("panel-alpha");
    expect(resolveRailChordTarget(clusters, 3, 1)).toBeUndefined();
  });
});
