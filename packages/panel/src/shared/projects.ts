import type {
  CoreLinkProjectSnapshot,
  CoreLinkTaskSnapshot,
} from "@actana/sdk/core-link-frames";
import { TASK_STATUSES, isActiveStatus, isTaskStatus, type Harness } from "@actana/shared/domain";
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

/** The task-count block every project row carries. */
export type ProjectTaskCounts = ProjectWithCounts["taskCounts"];

/** Every status at zero — a project with no tasks the caller knows of. */
export function emptyTaskCounts(): ProjectTaskCounts {
  return {
    ...(Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>),
    total: 0,
    activeNonDone: 0,
  };
}

/**
 * One project's task counts, derived from the Core's own task snapshots.
 *
 * The Core stays the single authority for task status (ADR 0005): this counts
 * the very rows `tasksList` answers with — the same frame, and so the same
 * facts, the grid renders from — rather than keeping a second opinion about
 * what is running. Archived rows travel in their own list (ADR 0019) and are
 * filtered here too, so the block matches the Panel server's own aggregation
 * for its own projects (`server/services/projects.ts`): count by status over
 * the non-archived rows, `total` across all of them, and `activeNonDone` for
 * the active statuses that are not `finished`.
 *
 * A status string a Core names but this Panel does not know still counts
 * toward `total` — the row exists — but lands in no status bucket, which is
 * the same degradation the server makes for an unrecognised status.
 */
export function taskCountsFromCoreTasks(
  tasks: readonly CoreLinkTaskSnapshot[],
): ProjectTaskCounts {
  const counts = emptyTaskCounts();
  for (const task of tasks) {
    if (task.archived) continue;
    counts.total += 1;
    if (!isTaskStatus(task.status)) continue;
    counts[task.status] += 1;
    if (isActiveStatus(task.status) && task.status !== "finished") counts.activeNonDone += 1;
  }
  return counts;
}

/**
 * A Core's tasks bucketed into per-project count blocks, keyed by project id.
 *
 * One `tasksList(coreId)` answers for every project on that Core, so a surface
 * showing many of a Core's projects at once — the rail's pinned strip, the
 * project switcher — reads this once instead of asking per project. Projects
 * with no tasks are absent from the map; callers fall back to
 * {@link emptyTaskCounts}, which is what "this project has nothing running"
 * looks like.
 */
export function coreTaskCountsByProject(
  tasks: readonly CoreLinkTaskSnapshot[],
): Map<string, ProjectTaskCounts> {
  const byProject = new Map<string, CoreLinkTaskSnapshot[]>();
  for (const task of tasks) {
    const bucket = byProject.get(task.projectId);
    if (bucket) bucket.push(task);
    else byProject.set(task.projectId, [task]);
  }
  return new Map(
    [...byProject].map(([projectId, rows]) => [projectId, taskCountsFromCoreTasks(rows)]),
  );
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
 * Preview and git remote the Panel decorates from its own database and a Core
 * snapshot has no answer for, so they take safe defaults rather than inventing
 * Core state. One mapper for every caller: the project page, the rail's pinned
 * strip and Fleet must agree on what a remote project looks like.
 *
 * Task counts are the same kind of fact, and the project frame carries none of
 * them — but a Core-owned row that always reported zero is why activity dots
 * never moved for a Core's projects (issue 377). A caller that has already
 * read the Core's tasks passes the block from {@link coreTaskCountsByProject};
 * one that has not still gets zeros, so nothing here invents a status the
 * Core did not report.
 */
export function projectRowFromSnapshot(
  snapshot: CoreLinkProjectSnapshot,
  presentation?: ProjectPresentation | null,
  taskCounts?: ProjectTaskCounts | null,
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
    taskCounts: taskCounts ?? emptyTaskCounts(),
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
