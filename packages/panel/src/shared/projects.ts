import type { CoreLinkProjectSnapshot } from "@actana/shared/core-link-frames";
import type { Harness } from "@actana/shared/domain";
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
