import type { CoreLinkProjectSnapshot } from "@actana/sdk/core-link-frames";
import { isActiveStatus, isTaskStatus, TASK_STATUSES, type Harness } from "@actana/shared/domain";
import type { Project, ProjectPresentation, TaskStatus } from "~/db/schema";

export type ProjectWithCounts = Project & {
  taskCounts: Record<TaskStatus, number> & { total: number; activeNonDone: number };
  preview?: string | null;
  githubUrl?: string | null;
  /**
   * Normalized `host/owner/repo` git-remote key (any host, not just GitHub), or
   * null for local-only repos. See ~/shared/repo-key.
   */
  repoKey?: string | null;
  /**
   * The Core that owns this row. Absent means the Panel's own local
   * server; anything else tags a project fetched from a remote Core's
   * `fleet.listProjects(coreId)`. Consumers use it to route clicks with the
   * `?coreId=` search param so the shell hits the right transport.
   */
  coreId?: string | null;
};

/**
 * The remembered session settings a Core's project snapshot carries (issue 22),
 * in the Panel row's shape. Three separate snapshot -> row mappers need exactly
 * this slice — `queries/index.ts`, `lib/use-fleet.ts` and `lib/terminal-store.tsx`
 * — so it lives here rather than being retyped in each: a sixth field is then
 * one edit, not three, and the three can't drift apart.
 *
 * `savedHarness` is a plain string on the wire (a Core may name a Harness this
 * Panel does not render); the cast lands it in the row's own union and consumers
 * already fall back when the id is unknown.
 */
export function projectSettingsFromSnapshot(
  snapshot: CoreLinkProjectSnapshot,
): Pick<
  Project,
  | "rememberHarnessSettings"
  | "savedHarness"
  | "savedSkipPermissions"
  | "savedBareSession"
  | "defaultGridView"
> {
  return {
    rememberHarnessSettings: snapshot.rememberHarnessSettings,
    savedHarness: (snapshot.savedHarness as Harness | null) ?? null,
    savedSkipPermissions: snapshot.savedSkipPermissions,
    savedBareSession: snapshot.savedBareSession,
    defaultGridView: snapshot.defaultGridView,
  };
}

/** The count block every {@link ProjectWithCounts} carries. */
export type ProjectTaskCounts = ProjectWithCounts["taskCounts"];

/**
 * A count block with every status at zero — "this project has no active work",
 * as opposed to "nobody has counted yet". The Panel's own rows are counted
 * server-side; this is what a row built from a Core snapshot starts as, and
 * what a project the fleet fan-out returned no rows for settles at.
 */
export function emptyTaskCounts(): ProjectTaskCounts {
  return {
    ...(Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>),
    total: 0,
    activeNonDone: 0,
  };
}

/** How a fleet row is addressed per project: project ids are only Core-unique. */
export function fleetProjectKey(coreId: string, projectId: string): string {
  return `${coreId}/${projectId}`;
}

/**
 * Per-project counts derived from the Fleet fan-out's own rows, keyed by
 * {@link fleetProjectKey}.
 *
 * The pin rail draws an activity dot from `taskCounts`, and a Core-owned pin
 * has no Panel database row to count — so the counts have to come from the
 * same `tasksList` answer the Fleet row came from. Deriving them here rather
 * than from a second read is what makes a dot and its row agree by
 * construction: one snapshot in, both readings out (#389 acceptance 2).
 *
 * The arithmetic mirrors the server's own `decorate()` — archived rows are
 * already dropped by `mergeFleetTasks`, `total` is the rows counted, and
 * `activeNonDone` is the active-but-unfinished subset — so a Core-owned
 * project and a Panel-owned one light the same dot for the same work.
 */
export function taskCountsByFleetProject(
  rows: readonly { coreId: string; projectId: string; status: string }[],
): Map<string, ProjectTaskCounts> {
  const byProject = new Map<string, ProjectTaskCounts>();
  for (const row of rows) {
    const key = fleetProjectKey(row.coreId, row.projectId);
    let counts = byProject.get(key);
    if (!counts) {
      counts = emptyTaskCounts();
      byProject.set(key, counts);
    }
    counts.total++;
    // A Core may name a status this Panel does not model; it still counts
    // toward `total` but has no bucket of its own to land in.
    if (!isTaskStatus(row.status)) continue;
    counts[row.status]++;
    if (isActiveStatus(row.status) && row.status !== "finished") counts.activeNonDone++;
  }
  return byProject;
}

/**
 * A Core's project snapshot as the row every project surface renders.
 *
 * The core-link carries Core facts only — name, path, icon, pin, remembered
 * session settings. The Panel's own presentation for that project (its group,
 * card image and launch URL) has no frame to travel in and is kept Panel-side
 * (issue 98); pass the row for this project and it is joined on here. Without
 * it those three read as empty, which is exactly right for a project the
 * operator has never filed.
 *
 * The rest — task counts, preview, git remote — the Panel decorates from its
 * own database and a Core snapshot has no answer for, so they take safe
 * defaults rather than inventing Core state. One mapper for every caller: the
 * project page, the rail's pinned strip and Fleet must agree on what a remote
 * project looks like.
 */
export function projectRowFromSnapshot(
  snapshot: CoreLinkProjectSnapshot,
  presentation?: ProjectPresentation | null,
): ProjectWithCounts {
  return {
    id: snapshot.projectId,
    name: snapshot.name,
    path: snapshot.path,
    icon: snapshot.icon,
    iconColor: snapshot.iconColor,
    imagePath: presentation?.imagePath ?? null,
    groupId: presentation?.groupId ?? null,
    pinned: snapshot.pinned,
    pinnedOrder: null,
    launchUrl: presentation?.launchUrl ?? null,
    // Remembered session settings are Core facts on the project row (issue 22),
    // so they come off the snapshot rather than defaulting to empty.
    ...projectSettingsFromSnapshot(snapshot),
    createdAt: snapshot.updatedAt,
    updatedAt: snapshot.updatedAt,
    taskCounts: emptyTaskCounts(),
    preview: null,
    githubUrl: null,
    repoKey: null,
  };
}

/** Presentation rows as a lookup by project id, for the mapper above. */
export function projectPresentationById(
  rows: readonly ProjectPresentation[],
): Map<string, ProjectPresentation> {
  return new Map(rows.map((row) => [row.projectId, row]));
}

export type ProjectPathStatus =
  | { ok: true; path: string }
  | {
      ok: false;
      path: string;
      reason: "missing" | "not-directory" | "unreadable";
      message: string;
    };

export type ProjectActivityState =
  | "offline"
  | "agent-running"
  | "needs-input"
  | "interrupted";

export function getProjectActivity(
  project: ProjectWithCounts,
): ProjectActivityState {
  if (project.taskCounts.interrupted > 0) return "interrupted";
  if (project.taskCounts["needs-input"] > 0) return "needs-input";
  if (project.taskCounts.running > 0) return "agent-running";
  return "offline";
}

export function isProjectActive(activity: ProjectActivityState): boolean {
  return activity !== "offline";
}
