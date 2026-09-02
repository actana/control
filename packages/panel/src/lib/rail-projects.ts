import type { Group } from "~/db/schema";
import { getPinnedProjects, type PinnedOrderable } from "~/lib/pinned-project-order";
import {
  ACTIVE_GROUP_ALL,
  ACTIVE_GROUP_UNGROUPED,
  type ActiveProjectGroup,
} from "~/shared/ui-preferences";

export type RailProject = PinnedOrderable & {
  /** The Core that owns this row; absent/null means the Panel's own rows. */
  coreId?: string | null;
  groupId: string | null;
  name: string;
};

/** One visual cluster in the left rail — a run of tiles under one group. */
export type RailCluster<T extends RailProject> = {
  key: string;
  label: string;
  color: string | null;
  projects: T[];
};

/**
 * Project digits need a group prefix only while browsing All with at least one
 * real group. With no groups, the synthetic Ungrouped cluster is presentation
 * noise and the rail behaves as one flat directly-addressable project list.
 */
export function usesDirectRailProjectShortcuts(
  groups: readonly Group[],
  activeGroup: ActiveProjectGroup,
): boolean {
  return activeGroup !== ACTIVE_GROUP_ALL || groups.length === 0;
}

/**
 * Cluster an already-ordered pinned list by group (group order first, then
 * ungrouped) without disturbing the relative pinned order inside a cluster.
 * Real groups stay in the result even when they have no pinned projects so the
 * rail keeps a stable group list and each header remains a project drop target.
 * Ungrouped is synthetic, so it only renders when it has projects.
 */
export function clusterPinnedByGroup<T extends RailProject>(
  orderedPinned: readonly T[],
  groups: readonly Group[],
): RailCluster<T>[] {
  const clusters: RailCluster<T>[] = [];
  for (const group of groups) {
    const members = orderedPinned.filter((p) => p.groupId === group.id);
    clusters.push({ key: group.id, label: group.name, color: group.color, projects: members });
  }
  const groupIds = new Set(groups.map((g) => g.id));
  const ungrouped = orderedPinned.filter((p) => p.groupId == null || !groupIds.has(p.groupId));
  if (ungrouped.length > 0) {
    clusters.push({ key: "ungrouped", label: "Ungrouped", color: null, projects: ungrouped });
  }
  return clusters;
}

/**
 * The rail as a single group's workspace: every project in the active group,
 * pinned first (in pinned order), the rest alphabetical.
 */
export function getGroupRailCluster<T extends RailProject>(
  projects: readonly T[],
  groups: readonly Group[],
  activeGroup: ActiveProjectGroup,
): RailCluster<T> {
  const inGroup =
    activeGroup === ACTIVE_GROUP_UNGROUPED
      ? projects.filter((p) => p.groupId == null)
      : projects.filter((p) => p.groupId === activeGroup);
  const pinned = getPinnedProjects(inGroup);
  const rest = inGroup
    .filter((p) => !p.pinned)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const group = groups.find((g) => g.id === activeGroup);
  return {
    key: activeGroup,
    label: activeGroup === ACTIVE_GROUP_UNGROUPED ? "Ungrouped" : (group?.name ?? "Group"),
    color: group?.color ?? null,
    projects: [...pinned, ...rest],
  };
}

export function getRailClusters<T extends RailProject>(
  projects: readonly T[],
  groups: readonly Group[],
  activeGroup: ActiveProjectGroup,
): RailCluster<T>[] {
  if (activeGroup === ACTIVE_GROUP_ALL) {
    return clusterPinnedByGroup(getPinnedProjects(projects), groups);
  }
  const cluster = getGroupRailCluster(projects, groups, activeGroup);
  return cluster.projects.length > 0 ? [cluster] : [];
}

/**
 * The rail's project list: the Panel's own rows plus every Core's pins, tagged
 * with the Core that owns them (see `useRemotePinnedProjects`). Concatenation
 * order matches ProjectBar's so a pinned-order tie breaks the same way in both;
 * `getPinnedProjects` orders the result from there.
 */
export function mergeRailProjects<T extends RailProject>(
  panelProjects: readonly T[] | undefined,
  remotePinned: readonly T[],
): T[] {
  return [...(panelProjects ?? []), ...remotePinned];
}

/**
 * The project a rail chord addresses, given the clusters the rail renders.
 *
 * Badges number projects from 1 *within their cluster*, so a chord is a group
 * digit (absent when the rail is one flat directly-addressable list) plus a
 * project digit — and this resolves both against the very clusters the badges
 * were drawn from. Hotkeys and badges disagreeing is the whole of #379.
 */
export function resolveRailChordTarget<T extends RailProject>(
  clusters: readonly RailCluster<T>[],
  groupDigit: number | null,
  projectDigit: number,
): T | undefined {
  const cluster = groupDigit == null ? clusters[0] : clusters[groupDigit - 1];
  return cluster?.projects[projectDigit - 1];
}

/** All a rail navigation needs: which project, and which Core owns it. */
export type RailTarget = { id: string; coreId?: string | null };

/**
 * The search params a rail navigation carries. A Core-owned pin must keep its
 * `?coreId=`, or the project page addresses the Panel's own DB instead of the
 * Core that owns the row — a 404, or the wrong project (#379).
 */
export function railNavigateSearch(target: RailTarget): { coreId: string } | undefined {
  return target.coreId ? { coreId: target.coreId } : undefined;
}
