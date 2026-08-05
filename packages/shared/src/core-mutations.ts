// Pure SQL helpers that mutate the Core's projects + tasks tables and read
// the derived sessions view for the write path (issue 04, ADR 0004).
//
// The Core process is the sole VM-side writer of the shared SQLite (ADR
// 0004); on remote Cores no sibling stateful server exists, so
// `PtyCoreLinkServer` dispatches `projectsMutate` / `tasksMutate` /
// `sessionsList` frames to a `CoreMutationPort` whose real implementation
// (packages/core/src/core-mutation-store.ts) opens `missioncontrol.db` read-write
// and calls these helpers.
//
// This file is self-contained (no `~/` imports) so it compiles under both the
// Vite (browser/server) and the Core's CommonJS tsconfigs. It operates on a
// minimal `CoreMutationSqlite` interface so tests can pass an in-memory
// better-sqlite3 handle without the full db/client bootstrap — mirroring
// `core-query.ts`.

import { newClientId } from "./client-id";
import type {
  CoreLinkProjectMutation,
  CoreLinkProjectSnapshot,
  CoreLinkSessionSnapshot,
  CoreLinkTaskMutation,
  CoreLinkTaskSnapshot,
} from "./core-link-frames";

/**
 * Minimal slice of `better-sqlite3.Database` that the mutation helpers need.
 * Structural so a real `Database` and a test fake both satisfy it. `prepare`
 * returns a statement with both `run` (for writes) and `all`/`get` (for
 * read-back after write).
 */
export interface CoreMutationSqlite {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/**
 * A liveness probe: given a `taskId`, return the live `ptyId` if one is
 * currently running for that task, else `null`. `sessionsList` uses this to
 * enrich task rows with their optional live PTY so a reconnecting Panel knows
 * which sessions it can reattach to. Passed in from the caller so this module
 * stays SQL-only (no dependency on `PtyCore`).
 */
export type LivePtyProbe = (taskId: string) => string | null;

// ─── Project mutations ────────────────────────────────────────────────────────

/**
 * Validate a candidate project path — a VM path (CONTEXT.md "Project"). The
 * default probe uses node:fs; tests can pass a fake. Throws `ValidationError`
 * (a plain `Error` with a `code` set to "invalid-path") on failure so the
 * server can translate to an actionable `error` frame message.
 *
 * Rules:
 *  - non-empty after trim
 *  - absolute (rooted). Rooted-ness is checked with a cross-platform sniff
 *    (`/` prefix OR `X:` drive-letter prefix) since this file compiles for
 *    both node and the browser; the Core caller passes the real
 *    `path.isAbsolute` probe for the OS-native rule.
 *  - the path must exist and be a directory (not a regular file)
 */
export type ProjectPathProbe = {
  isAbsolute(p: string): boolean;
  statSync(p: string): { isDirectory(): boolean } | null;
};

/**
 * Validate a candidate project path. Rules: non-empty, absolute (per the
 * caller's OS-specific `isAbsolute`), exists, is a directory. Throws a plain
 * `Error` with an actionable message on failure — the server translates the
 * message into an `error` frame; there is no error code to switch on because
 * the message is what the operator reads.
 */
export function validateProjectPath(rawPath: string, probe: ProjectPathProbe): string {
  const trimmed = (rawPath ?? "").trim();
  if (!trimmed) {
    throw new Error("project path is required");
  }
  if (!probe.isAbsolute(trimmed)) {
    throw new Error(`project path must be absolute on the Core's machine (got: ${trimmed})`);
  }
  let stat: { isDirectory(): boolean } | null;
  try {
    stat = probe.statSync(trimmed);
  } catch {
    stat = null;
  }
  if (!stat) {
    throw new Error(`project path does not exist on the Core: ${trimmed}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`project path is a file, not a directory: ${trimmed}`);
  }
  return trimmed;
}

type ProjectInsert = Extract<CoreLinkProjectMutation, { op: "create" }>;

const DEFAULT_PROJECT_ICON = "PR";
const DEFAULT_PROJECT_ICON_COLOR = "#7ce58a";

/**
 * Insert a new project row and return its snapshot. `now()` is threaded in so
 * tests can produce deterministic timestamps. `validatedPath` is the output of
 * {@link validateProjectPath} — the SQL helper doesn't re-check because the
 * caller (the mutation store) owns the OS-specific probe.
 */
export function createProject(
  sqlite: CoreMutationSqlite,
  input: ProjectInsert,
  validatedPath: string,
  now: number,
): CoreLinkProjectSnapshot {
  const id = input.projectId?.trim() || newClientId("p");
  const trimmedName = (input.name ?? "").trim();
  if (!trimmedName) {
    throw new Error("project name is required");
  }
  const icon = input.icon?.trim() || DEFAULT_PROJECT_ICON;
  const iconColor = input.iconColor?.trim() || DEFAULT_PROJECT_ICON_COLOR;
  const pinned = input.pinned === true ? 1 : 0;
  const settings = normalizeProjectSettings(input);
  sqlite
    .prepare(
      `INSERT INTO projects (
         id, name, path, icon, icon_color, pinned,
         remember_agent_settings, saved_agent, saved_skip_permissions,
         saved_bare_session, default_grid_view,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      trimmedName,
      validatedPath,
      icon,
      iconColor,
      pinned,
      settings.rememberHarnessSettings ? 1 : 0,
      settings.savedHarness,
      settings.savedSkipPermissions ? 1 : 0,
      settings.savedBareSession ? 1 : 0,
      settings.defaultGridView ? 1 : 0,
      now,
      now,
    );
  return {
    projectId: id,
    name: trimmedName,
    path: validatedPath,
    icon,
    iconColor,
    pinned: pinned === 1,
    ...settings,
    updatedAt: now,
  };
}

/**
 * The remembered session settings (issue 22) a project row carries, resolved
 * against the column defaults. Shared by `create` (which needs a value for
 * every column it inserts) and the snapshot it echoes back, so the returned
 * snapshot cannot drift from the row that was just written.
 */
type ProjectSettings = Pick<
  CoreLinkProjectSnapshot,
  | "rememberHarnessSettings"
  | "savedHarness"
  | "savedSkipPermissions"
  | "savedBareSession"
  | "defaultGridView"
>;

function normalizeProjectSettings(input: {
  rememberHarnessSettings?: boolean;
  savedHarness?: string | null;
  savedSkipPermissions?: boolean;
  savedBareSession?: boolean;
  defaultGridView?: boolean;
}): ProjectSettings {
  return {
    rememberHarnessSettings: input.rememberHarnessSettings === true,
    savedHarness: normalizeSavedHarness(input.savedHarness),
    savedSkipPermissions: input.savedSkipPermissions === true,
    savedBareSession: input.savedBareSession === true,
    defaultGridView: input.defaultGridView === true,
  };
}

/** `undefined`/`null`/blank all mean "no remembered Harness" — one `NULL` column value. */
function normalizeSavedHarness(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

type ProjectSettingsPatch = Extract<CoreLinkProjectMutation, { op: "settings" }>;

/**
 * Patch a project's remembered session settings. Fields omitted from `input`
 * are left untouched (partial patch, mirroring `updateTask`); `savedHarness:
 * null` clears the remembered Harness. Returns the updated snapshot, or `null`
 * when the row is missing — the Panel rolls its optimistic patch back on both
 * a `null` and a thrown error.
 */
export function updateProjectSettings(
  sqlite: CoreMutationSqlite,
  input: ProjectSettingsPatch,
  now: number,
): CoreLinkProjectSnapshot | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.rememberHarnessSettings !== undefined) {
    sets.push("remember_agent_settings = ?");
    params.push(input.rememberHarnessSettings ? 1 : 0);
  }
  if (input.savedHarness !== undefined) {
    sets.push("saved_agent = ?");
    params.push(normalizeSavedHarness(input.savedHarness));
  }
  if (input.savedSkipPermissions !== undefined) {
    sets.push("saved_skip_permissions = ?");
    params.push(input.savedSkipPermissions ? 1 : 0);
  }
  if (input.savedBareSession !== undefined) {
    sets.push("saved_bare_session = ?");
    params.push(input.savedBareSession ? 1 : 0);
  }
  if (input.defaultGridView !== undefined) {
    sets.push("default_grid_view = ?");
    params.push(input.defaultGridView ? 1 : 0);
  }
  if (sets.length === 0) {
    // An empty patch is not an error — the dialog can fire one when nothing
    // changed. Read the row back rather than bumping `updated_at` for nothing.
    return readProjectSnapshot(sqlite, input.projectId);
  }
  sets.push("updated_at = ?");
  params.push(now);
  params.push(input.projectId);
  const result = sqlite
    .prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`)
    .run(...params);
  if (result.changes === 0) return null;
  return readProjectSnapshot(sqlite, input.projectId);
}

/**
 * Set a project's `pinned` flag. Returns the updated snapshot, or `null`
 * when the row is missing. Pin state is a Core fact — two Panels
 * connected to the same Core see the same value (issue 10).
 */
export function pinProject(
  sqlite: CoreMutationSqlite,
  projectId: string,
  pinned: boolean,
  now: number,
): CoreLinkProjectSnapshot | null {
  const result = sqlite
    .prepare(`UPDATE projects SET pinned = ?, updated_at = ? WHERE id = ?`)
    .run(pinned ? 1 : 0, now, projectId);
  if (result.changes === 0) return null;
  return readProjectSnapshot(sqlite, projectId);
}

/** Rename an existing project. Returns the updated snapshot, or `null` when the row is missing. */
export function renameProject(
  sqlite: CoreMutationSqlite,
  projectId: string,
  name: string,
  now: number,
): CoreLinkProjectSnapshot | null {
  const trimmedName = (name ?? "").trim();
  if (!trimmedName) {
    throw new Error("project name is required");
  }
  const result = sqlite
    .prepare(`UPDATE projects SET name = ?, updated_at = ? WHERE id = ?`)
    .run(trimmedName, now, projectId);
  if (result.changes === 0) return null;
  return readProjectSnapshot(sqlite, projectId);
}

/**
 * Delete a project row and return the snapshot of what was removed. SQLite's
 * ON DELETE CASCADE removes tasks, terminal_logs, prompts, token_usage,
 * etc. tied to this project — matching the Panel server's
 * `deleteProject` semantics (which is a hard delete today). Returns `null`
 * when nothing matched. Returning the pre-delete snapshot (rather than
 * fabricating an empty one, or a boolean) lets the Panel echo the row it just
 * lost — the `projectsMutateResult.project` field is the same shape for all
 * three ops so the caller doesn't branch on `op`. "Archive" is used at the
 * protocol layer to leave room for a future soft-archive column without
 * changing the frame shape.
 */
export function archiveProject(
  sqlite: CoreMutationSqlite,
  projectId: string,
): CoreLinkProjectSnapshot | null {
  const before = readProjectSnapshot(sqlite, projectId);
  if (!before) return null;
  sqlite.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);
  return before;
}

function readProjectSnapshot(
  sqlite: CoreMutationSqlite,
  projectId: string,
): CoreLinkProjectSnapshot | null {
  const row = sqlite
    .prepare(
      `SELECT id, name, path, icon, icon_color, pinned,
              remember_agent_settings, saved_agent, saved_skip_permissions,
              saved_bare_session, default_grid_view, updated_at
       FROM projects WHERE id = ?`,
    )
    .get(projectId) as
    | {
        id: string;
        name: string;
        path: string;
        icon: string;
        icon_color: string;
        pinned: number;
        remember_agent_settings: number;
        saved_agent: string | null;
        saved_skip_permissions: number;
        saved_bare_session: number;
        default_grid_view: number;
        updated_at: number;
      }
    | undefined;
  if (!row) return null;
  return {
    projectId: row.id,
    name: row.name,
    path: row.path,
    icon: row.icon,
    iconColor: row.icon_color,
    pinned: row.pinned === 1,
    rememberHarnessSettings: row.remember_agent_settings === 1,
    savedHarness: row.saved_agent,
    savedSkipPermissions: row.saved_skip_permissions === 1,
    savedBareSession: row.saved_bare_session === 1,
    defaultGridView: row.default_grid_view === 1,
    updatedAt: row.updated_at,
  };
}

// ─── Task mutations ─────────────────────────────────────────────────────────

type TaskInsert = Extract<CoreLinkTaskMutation, { op: "create" }>;
type TaskUpdate = Extract<CoreLinkTaskMutation, { op: "update" }>;

const DEFAULT_TASK_STATUS = "ready";
const DEFAULT_TASK_BRANCH = "main";

/**
 * Insert a new task row and return its snapshot. `projectId`, `title`, and
 * `agent` are required (validated here). `taskId` is caller-supplied when the
 * Panel wants optimistic-UI parity, else generated on the Core.
 */
export function createTask(
  sqlite: CoreMutationSqlite,
  input: TaskInsert,
  now: number,
): CoreLinkTaskSnapshot {
  const projectId = input.projectId?.trim();
  const title = input.title?.trim();
  const agent = input.agent?.trim();
  if (!projectId) throw new Error("task projectId is required");
  if (!title) throw new Error("task title is required");
  if (!agent) throw new Error("task agent is required");
  const id = input.taskId?.trim() || newClientId("t");
  const status = input.status?.trim() || DEFAULT_TASK_STATUS;
  const icon = normalizeIconInput(input.icon);
  sqlite
    .prepare(
      `INSERT INTO tasks (
         id, project_id, title, agent, status, icon, branch, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, projectId, title, agent, status, icon, DEFAULT_TASK_BRANCH, now, now);
  return {
    taskId: id,
    projectId,
    title,
    agent,
    status,
    pinned: false,
    archived: false,
    icon,
    updatedAt: now,
  };
}

/**
 * Normalize a caller-supplied icon value into what the SQL column stores.
 * `undefined` → `null` (create); trimmed empty string → `null`; else the trimmed
 * string. The Core does not validate against `SESSION_ICON_OPTIONS` — the
 * Panel-side `isSessionIcon` guard falls back to `DEFAULT_SESSION_ICON` when a
 * row carries an unknown id, so a Core on a newer version can hand a Panel
 * on an older version an icon it doesn't render without breaking the cell.
 */
function normalizeIconInput(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Patch an existing task row. Fields omitted from `input` are left untouched
 * (partial update). Returns the updated snapshot, or `null` when the row is
 * missing.
 */
export function updateTask(
  sqlite: CoreMutationSqlite,
  input: TaskUpdate,
  now: number,
): CoreLinkTaskSnapshot | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.status !== undefined) {
    sets.push("status = ?");
    params.push(input.status);
  }
  if (input.title !== undefined) {
    const trimmed = input.title.trim();
    if (!trimmed) throw new Error("task title cannot be empty");
    sets.push("title = ?");
    params.push(trimmed);
    // Mirror the local server controller (tasks.controller.ts): any title
    // present on an update is a manual rename, so pin the flag that stops
    // the auto title-generator from clobbering it.
    sets.push("title_manually_set = 1");
  }
  if (input.pinned !== undefined) {
    sets.push("pinned = ?");
    params.push(input.pinned ? 1 : 0);
  }
  if (input.archived !== undefined) {
    sets.push("archived = ?");
    params.push(input.archived ? 1 : 0);
  }
  if (input.icon !== undefined) {
    sets.push("icon = ?");
    params.push(normalizeIconInput(input.icon));
  }
  if (sets.length === 0) {
    // No-op patch: still bump updated_at so the Panel's live snapshot moves.
    // Return the existing row unchanged.
    return readTaskSnapshot(sqlite, input.taskId);
  }
  sets.push("updated_at = ?");
  params.push(now);
  params.push(input.taskId);
  const result = sqlite
    .prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`)
    .run(...params);
  if (result.changes === 0) return null;
  return readTaskSnapshot(sqlite, input.taskId);
}

/**
 * Delete a task row and return the snapshot of what was removed. SQLite's
 * ON DELETE CASCADE takes the rows hanging off it (terminal_logs, prompts,
 * token_usage, …) — the same hard delete the Panel server's `deleteTask`
 * performs for a Panel-owned row. Returns `null` when nothing matched, the way
 * {@link updateTask} reports a missing row, so the server answers
 * `tasksMutateResult` with a null task rather than an `error` frame.
 *
 * The pre-delete snapshot is what comes back (mirroring {@link archiveProject})
 * so `tasksMutateResult.task` carries the same shape for every op and the
 * caller doesn't branch on `op` to read the answer.
 *
 * No pending-question clear rides along, unlike the Panel server's delete.
 * A pending question is an in-memory map on the *Panel* server, filled by the
 * hooks route, which resolves the task against the Panel's own database — so a
 * Core-owned task never gets an entry to clear. Nothing on the Core tracks one.
 * The Panel-side state that does follow a Core-owned session (its stored
 * session-finish notifications) is pruned off the `task:deleted` event this
 * delete appends.
 */
export function deleteTask(
  sqlite: CoreMutationSqlite,
  taskId: string,
): CoreLinkTaskSnapshot | null {
  const before = readTaskSnapshot(sqlite, taskId);
  if (!before) return null;
  sqlite.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskId);
  return before;
}

function readTaskSnapshot(
  sqlite: CoreMutationSqlite,
  taskId: string,
): CoreLinkTaskSnapshot | null {
  const row = sqlite
    .prepare(
      `SELECT id, project_id, title, agent, status, pinned, archived, icon, updated_at
       FROM tasks WHERE id = ?`,
    )
    .get(taskId) as
    | {
        id: string;
        project_id: string;
        title: string;
        agent: string;
        status: string;
        pinned: number;
        archived: number;
        icon: string | null;
        updated_at: number;
      }
    | undefined;
  if (!row) return null;
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

// ─── Sessions view ──────────────────────────────────────────────────────────

/**
 * Read every active (non-archived) task as a session snapshot, optionally
 * filtered to one project. `probe` enriches each row with its live `ptyId`
 * (if the Core's PTY core currently has one for that task), so a
 * reconnecting Panel knows which sessions it can reattach to. Rows are
 * ordered `updated_at` DESC — same as `queryTasks`.
 */
export function querySessions(
  sqlite: CoreMutationSqlite,
  probe: LivePtyProbe,
  projectId?: string,
): CoreLinkSessionSnapshot[] {
  let rows: { id: string; status: string; updated_at: number }[];
  try {
    if (projectId === undefined) {
      rows = sqlite
        .prepare(
          `SELECT id, status, updated_at FROM tasks
           WHERE archived = 0 ORDER BY updated_at DESC`,
        )
        .all() as typeof rows;
    } else {
      rows = sqlite
        .prepare(
          `SELECT id, status, updated_at FROM tasks
           WHERE archived = 0 AND project_id = ? ORDER BY updated_at DESC`,
        )
        .all(projectId) as typeof rows;
    }
  } catch {
    return [];
  }
  return rows.map((row) => ({
    taskId: row.id,
    ptyId: probe(row.id),
    status: row.status,
    updatedAt: row.updated_at,
  }));
}
