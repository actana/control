// Pure SQL helpers that read the Core's projects + tasks tables and map
// them to core-link snapshots for the per-Core navigation + Fleet view (issue
// 07, ADR 0001).
//
// The Core is the single source of truth for projects and tasks; the Panel
// holds none. The `projectsList` / `tasksList` core-link frames delegate to a
// `CoreQueryPort` whose real implementation (packages/core/src/core-query-store.ts)
// opens the shared SQLite read-only and calls these helpers.
//
// This file is self-contained (no `~/` imports) so it compiles under both the
// Vite (browser/server) and the Core's CommonJS tsconfigs. It operates on a
// minimal `CoreQuerySqlite` interface so tests can pass an in-memory
// better-sqlite3 handle without the full db/client bootstrap — mirroring
// `event-log.ts`.

import type { CoreLinkProjectSnapshot, CoreLinkTaskSnapshot } from "./core-link-frames";

/**
 * Minimal slice of `better-sqlite3.Database` that the query helpers need.
 * Structural so a real `Database` and a test fake both satisfy it.
 */
export interface CoreQuerySqlite {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
  };
}

type ProjectRow = {
  id: string;
  name: string;
  path: string;
  icon: string;
  icon_color: string;
  pinned: number;
  updated_at: number;
};

type TaskRow = {
  id: string;
  project_id: string;
  title: string;
  agent: string;
  status: string;
  pinned: number;
  archived: number;
  icon: string | null;
  updated_at: number;
};

/**
 * Read every project on this Core as a flattened snapshot. Returns an empty
 * array when the table is absent (a Core whose DB hasn't bootstrapped yet)
 * or when there are no rows. `path` is a VM path — only the Core can
 * validate it (CONTEXT.md "Project").
 */
export function queryProjects(sqlite: CoreQuerySqlite): CoreLinkProjectSnapshot[] {
  let rows: ProjectRow[];
  try {
    rows = sqlite
      .prepare(
        `SELECT id, name, path, icon, icon_color, pinned, updated_at
         FROM projects
         ORDER BY pinned DESC, updated_at DESC`,
      )
      .all() as ProjectRow[];
  } catch {
    // Table missing (DB not bootstrapped) — the Fleet view shows no projects
    // for this Core rather than crashing.
    return [];
  }
  return rows.map(rowToSnapshot);
}

function rowToSnapshot(row: ProjectRow): CoreLinkProjectSnapshot {
  return {
    projectId: row.id,
    name: row.name,
    path: row.path,
    icon: row.icon,
    iconColor: row.icon_color,
    pinned: row.pinned === 1,
    updatedAt: row.updated_at,
  };
}

/**
 * Read every active (non-archived) task on this Core, optionally filtered
 * to one project. Archived tasks are omitted — the Fleet view is for active
 * work, and the Panel caches nothing, so archived rows never cross the
 * core-link. Ordered by `updated_at` descending (most recent first) so a
 * single-Project view shows live work at the top. Returns an empty array when
 * the table is absent or no rows match.
 */
export function queryTasks(
  sqlite: CoreQuerySqlite,
  projectId?: string,
): CoreLinkTaskSnapshot[] {
  let rows: TaskRow[];
  try {
    if (projectId === undefined) {
      rows = sqlite
        .prepare(
          `SELECT id, project_id, title, agent, status, pinned, archived, icon, updated_at
           FROM tasks
           WHERE archived = 0
           ORDER BY updated_at DESC`,
        )
        .all() as TaskRow[];
    } else {
      rows = sqlite
        .prepare(
          `SELECT id, project_id, title, agent, status, pinned, archived, icon, updated_at
           FROM tasks
           WHERE archived = 0 AND project_id = ?
           ORDER BY updated_at DESC`,
        )
        .all(projectId) as TaskRow[];
    }
  } catch {
    return [];
  }
  return rows.map(taskRowToSnapshot);
}

function taskRowToSnapshot(row: TaskRow): CoreLinkTaskSnapshot {
  return {
    taskId: row.id,
    projectId: row.project_id,
    title: row.title,
    agent: row.agent,
    status: row.status,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    icon: row.icon,
    updatedAt: row.updated_at,
  };
}
