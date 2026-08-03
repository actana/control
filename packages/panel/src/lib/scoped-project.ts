import type { Project } from "~/db/schema";

/** A Project as carried by the terminal stores. Worktree scoping is gone
 * (spec 11); the alias survives so store call-sites keep a single name for
 * "the project a task's terminal runs in". */
export type ScopedProject = Project;

/** Frozen storage-key suffix. Per-scope UI state (grid layouts, active-task
 * keys) was persisted under `${projectId}:main` when worktree scoping existed —
 * keep the literal so that state survives the removal. */
const SCOPE_KEY_SUFFIX = "main";

/** Stable key identifying a project's terminal bucket. */
export function projectScopeKey(projectId: string): string {
  return `${projectId}:${SCOPE_KEY_SUFFIX}`;
}

export function scopeKeyForProject(project: ScopedProject): string {
  return projectScopeKey(project.id);
}
