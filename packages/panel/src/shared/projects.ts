import type { Project, TaskStatus } from "~/db/schema";

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
