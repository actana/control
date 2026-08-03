// Shared schema-bootstrap primitives — the CREATE-IF-NOT-EXISTS DDL that owns
// the shape of `missioncontrol.db`, plus the idempotent helpers that keep older
// databases and schema-divergent branches converging on that shape.
//
// Two callers rely on this module:
//   • src/db/client.ts — the stateful server's `getDb()` bootstrap on the
//     loopback host, running under Vite (ESM).
//   • packages/harness/src/harness-db-bootstrap.ts — the Harness process on a remote VM
//     where no sibling server exists
//     (CommonJS).
//
// The two entry points share this DDL so the schema on a harness-only VM
// matches the schema on a loopback host byte-for-byte. Migration replay and
// drizzle bookkeeping stay in client.ts; this file is purely the shape.
//
// Kept self-contained (relative imports only, no `~/*` alias, no drizzle, no
// native binding resolution, no Vite globs) so the Harness's tsc build can
// compile it against its own tsconfig.

import type Database from "better-sqlite3";
import * as fs from "node:fs";
import { DEFAULT_BRANCH, DEFAULT_TASK_STATUS } from "./domain";

// missioncontrol.db holds the API bearer token
// in cleartext. Created with default perms it is world-readable (~0644), so any
// other local user / backup / sync process can lift those secrets straight off
// disk. Tighten the directory to owner-only and the DB (plus its WAL/SHM
// sidecars) to 0600. Best-effort: on filesystems/platforms without POSIX modes
// (e.g. Windows) chmod is a harmless no-op.
export function restrictDbFilePermissions(dbPath: string): void {
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (fs.existsSync(p)) fs.chmodSync(p, 0o600);
    } catch {
      /* best effort */
    }
  }
}

export function tableExists(sqlite: Database.Database, name: string): boolean {
  const row = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return !!row;
}

/**
 * Idempotently add a column to an existing table. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so we check pragma table_info first — this makes
 * the bootstrap safe even against a DB that already has the column (e.g. a
 * schema-divergent build that defined its own `sandbox_id`), instead of throwing
 * "duplicate column name". `table`/`column` are internal constants, not input.
 */
export function ensureColumn(
  sqlite: Database.Database,
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function indexColumns(sqlite: Database.Database, indexName: string): string[] {
  return (
    sqlite.prepare(`PRAGMA index_info(${quoteIdent(indexName)})`).all() as {
      name: string;
    }[]
  ).map((c) => c.name);
}

const STALE_PROJECT_UNIQUE_COLUMNS = new Set(["path", "sandbox_id"]);

function uniqueProjectIndexesToRepair(sqlite: Database.Database): { name: string }[] {
  return (
    sqlite.prepare("PRAGMA index_list(projects)").all() as {
      name: string;
      unique: number;
    }[]
  ).filter((idx) => {
    const columns = indexColumns(sqlite, idx.name);
    return idx.unique === 1 && columns.length === 1 && STALE_PROJECT_UNIQUE_COLUMNS.has(columns[0]);
  });
}

type TableColumn = {
  name: string;
};

function splitSqlList(input: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(input.slice(start, i));
      start = i + 1;
    }
  }
  out.push(input.slice(start));
  return out;
}

function staleProjectUniqueColumnPattern(): string {
  return [...STALE_PROJECT_UNIQUE_COLUMNS]
    .map((column) => `(?:"${column}"|\`${column}\`|\\[${column}\\]|${column})`)
    .join("|");
}

function isStaleUniqueColumnDef(definition: string): boolean {
  return new RegExp(`^(?:${staleProjectUniqueColumnPattern()})(?:\\s|$)`, "i").test(definition.trimStart());
}

function isStaleUniqueConstraint(definition: string): boolean {
  const withoutName = definition
    .trimStart()
    .replace(/^CONSTRAINT\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)\s+/i, "");
  return new RegExp(`^UNIQUE\\s*\\(\\s*(?:${staleProjectUniqueColumnPattern()})\\s*\\)`, "i").test(withoutName);
}

function projectTableSqlWithoutStaleUniques(sqlite: Database.Database): string {
  const row = sqlite
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'projects'")
    .get() as { sql: string } | undefined;
  if (!row?.sql) throw new Error("Cannot repair projects schema: missing CREATE TABLE SQL");

  const open = row.sql.indexOf("(");
  const close = row.sql.lastIndexOf(")");
  if (open < 0 || close < open) throw new Error("Cannot repair projects schema: invalid CREATE TABLE SQL");

  const body = row.sql.slice(open + 1, close);
  const suffix = row.sql.slice(close + 1);
  const definitions = splitSqlList(body)
    .map((definition) =>
      isStaleUniqueColumnDef(definition)
        ? definition.replace(
            /\bUNIQUE\b(?:\s+ON\s+CONFLICT\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE))?/i,
            "",
          )
        : definition,
    )
    .filter((definition) => !isStaleUniqueConstraint(definition));

  return `CREATE TABLE projects_without_stale_uniques (${definitions.join(",")})${suffix}`;
}

function rebuildProjectsWithoutStaleUniques(
  sqlite: Database.Database,
  uniqueIndexNames: Set<string>,
): void {
  const existingColumns = sqlite.prepare("PRAGMA table_info(projects)").all() as TableColumn[];
  const copyColumns = existingColumns.map((column) => quoteIdent(column.name)).join(", ");
  const createReplacementTable = projectTableSqlWithoutStaleUniques(sqlite);
  const schemaEntries = (
    sqlite
      .prepare(
        "SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = 'projects' AND sql IS NOT NULL AND type IN ('index', 'trigger')",
      )
      .all() as { type: string; name: string; sql: string }[]
  ).filter((entry) => !uniqueIndexNames.has(entry.name));
  const replaySchemaSql = schemaEntries.map((entry) => entry.sql).join(";\n");

  const foreignKeys = sqlite.pragma("foreign_keys", { simple: true }) as number;
  let inTransaction = false;
  sqlite.pragma("foreign_keys = OFF");
  try {
    sqlite.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    sqlite.exec(`
      DROP TABLE IF EXISTS projects_without_stale_uniques;
      ${createReplacementTable};
      INSERT INTO projects_without_stale_uniques (${copyColumns})
        SELECT ${copyColumns} FROM projects;
      DROP TABLE projects;
      ALTER TABLE projects_without_stale_uniques RENAME TO projects;
      ${replaySchemaSql ? `${replaySchemaSql};` : ""}
    `);
    const violations = sqlite.prepare("PRAGMA foreign_key_check").all();
    if (violations.length) {
      throw new Error("Project schema repair failed foreign key validation");
    }
    sqlite.exec("COMMIT");
    inTransaction = false;
  } catch (error) {
    if (inTransaction) sqlite.exec("ROLLBACK");
    throw error;
  } finally {
    sqlite.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}

export function repairProjectIndexes(sqlite: Database.Database): void {
  const uniqueIndexes = uniqueProjectIndexesToRepair(sqlite);
  const uniqueIndexNames = new Set(uniqueIndexes.map((idx) => idx.name));
  if (uniqueIndexes.some((idx) => idx.name.startsWith("sqlite_autoindex_"))) {
    rebuildProjectsWithoutStaleUniques(sqlite, uniqueIndexNames);
  } else {
    for (const idx of uniqueIndexes) {
      sqlite.exec(`DROP INDEX IF EXISTS ${quoteIdent(idx.name)}`);
    }
  }

  sqlite.exec(`CREATE INDEX IF NOT EXISTS projects_group_idx ON projects(group_id);`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS projects_pinned_idx ON projects(pinned);`);
}

/**
 * PTYs are owned by the Harness process and are not restored across app
 * restarts, so on every launch any task the app left mid-session has a dead PTY
 * now: one that was actively `running`, or one blocked waiting on the user
 * (`needs-input`). Left as-is, a `needs-input` row never transitions on its own
 * — its agent is gone — so it would linger forever and keep the project's
 * "needs input" dot lit across restarts. Reset both to `disconnected`
 * (click-to-resume) so the stale state is cleared.
 *
 * `ready` is deliberately left alone: it means "created but never launched", so
 * there is no dead session to reconcile.
 */
export function reconcileStaleSessionsOnBoot(sqlite: Database.Database): void {
  sqlite
    .prepare(
      "UPDATE tasks SET status = 'disconnected', updated_at = ? WHERE status IN ('running', 'needs-input')"
    )
    .run(Date.now());
}

/**
 * Inline schema bootstrap so we don't ship migration files to the user.
 * Drizzle Kit migrations remain useful in dev for tracking diffs, but for the
 * embedded SQLite we always idempotently CREATE IF NOT EXISTS on first open.
 */
export function ensureSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      sort_order INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      icon TEXT NOT NULL,
      icon_color TEXT NOT NULL,
      image_path TEXT,
      group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      pinned_order INTEGER,
      launch_url TEXT,
      remember_agent_settings INTEGER NOT NULL DEFAULT 0,
      saved_agent TEXT,
      saved_skip_permissions INTEGER NOT NULL DEFAULT 0,
      saved_bare_session INTEGER NOT NULL DEFAULT 0,
      default_grid_view INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projects_group_idx ON projects(group_id);
    CREATE INDEX IF NOT EXISTS projects_pinned_idx ON projects(pinned);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      title_manually_set INTEGER NOT NULL DEFAULT 0,
      icon TEXT,
      agent TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '${DEFAULT_TASK_STATUS}',
      branch TEXT NOT NULL DEFAULT '${DEFAULT_BRANCH}',
      preview TEXT NOT NULL DEFAULT '',
      lines INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      claude_session_id TEXT,
      claude_skip_permissions INTEGER NOT NULL DEFAULT 0,
      claude_bare_session INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);
    CREATE INDEX IF NOT EXISTS tasks_archived_idx ON tasks(archived);
    CREATE INDEX IF NOT EXISTS tasks_pinned_idx ON tasks(pinned);
    -- listProjects() aggregates non-archived task counts with
    -- WHERE archived = 0 GROUP BY project_id, status. This partial covering
    -- index lets SQLite satisfy that GROUP BY by scanning the index in
    -- (project_id, status) order, avoiding a temp B-tree that spilled the 2MB
    -- page cache to disk at extreme scale (~2.6s -> ~25ms at 750k tasks). It's
    -- scoped to archived = 0 to stay small and match the query's predicate.
    CREATE INDEX IF NOT EXISTS tasks_active_project_status_idx ON tasks(project_id, status) WHERE archived = 0;

    CREATE TABLE IF NOT EXISTS terminal_logs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      chunk TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS terminal_logs_task_idx ON terminal_logs(task_id);

    CREATE TABLE IF NOT EXISTS user_terminals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      cwd TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS user_terminals_project_idx ON user_terminals(project_id);

    -- Project-less "home" terminals (dashboard). Separate table so user_terminals
    -- never needs a destructive rebuild to relax its NOT NULL project_id FK.
    CREATE TABLE IF NOT EXISTS home_terminals (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      emailVerified INTEGER NOT NULL DEFAULT 0,
      image TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS token_usage (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      claude_session_id TEXT NOT NULL,
      message_uuid TEXT NOT NULL UNIQUE,
      model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS token_usage_task_idx ON token_usage(task_id);
    CREATE INDEX IF NOT EXISTS token_usage_project_idx ON token_usage(project_id);
    CREATE INDEX IF NOT EXISTS token_usage_ts_idx ON token_usage(ts);
    -- Covering indexes so a raw-table aggregate (backfill, or any fallback read)
    -- can sum straight from the index without touching the heap. The rollup
    -- below is the primary read path; these keep the raw path from cliffing.
    CREATE INDEX IF NOT EXISTS token_usage_project_cover_idx
      ON token_usage(project_id, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens);
    CREATE INDEX IF NOT EXISTS token_usage_ts_cover_idx
      ON token_usage(ts, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens);
    CREATE INDEX IF NOT EXISTS token_usage_task_ts_cover_idx
      ON token_usage(task_id, ts, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens);

    -- Pre-aggregated token usage per (project, task, local day). Every summary
    -- read (totals, per-project, per-session, per-day) sums this instead of
    -- scanning all of token_usage, turning multi-second aggregates at ~1M rows
    -- into sub-millisecond ones. Kept in lockstep with token_usage by the ingest
    -- transaction (only newly-inserted rows are folded in) and by ON DELETE
    -- CASCADE, which drops rollup rows when a task/project is removed just as it
    -- drops the raw rows — so the rollup always equals the raw aggregate.
    CREATE TABLE IF NOT EXISTS token_usage_rollup (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      last_ts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, task_id, day)
    );
    CREATE INDEX IF NOT EXISTS token_usage_rollup_project_idx ON token_usage_rollup(project_id);
    CREATE INDEX IF NOT EXISTS token_usage_rollup_task_idx ON token_usage_rollup(task_id);
    CREATE INDEX IF NOT EXISTS token_usage_rollup_day_idx ON token_usage_rollup(day);

    CREATE TABLE IF NOT EXISTS token_usage_session_offsets (
      claude_session_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    -- Monotonic per-Harness event log. See src/shared/event-log.ts for the
    -- read/append helpers; the table is created here (idempotently) so both the
    -- server process and the Harness (PTY manager) process share the same shape.
    CREATE TABLE IF NOT EXISTS event_log (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      pty_id TEXT,
      task_id TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS event_log_kind_idx ON event_log(kind);
    CREATE INDEX IF NOT EXISTS event_log_task_idx ON event_log(task_id);
    CREATE INDEX IF NOT EXISTS event_log_pty_idx ON event_log(pty_id);
  `);

  // Repair legacy unique indexes on projects (a schema-divergent build once
  // shipped single-column uniques on path / sandbox_id).
  repairProjectIndexes(sqlite);

  // Manual group ordering. Legacy rows keep NULL until the user reorders (they
  // sort last by created_at meanwhile) — see groups.repo findAllGroups.
  ensureColumn(sqlite, "groups", "sort_order", "INTEGER");

  // Columns added after their table first shipped; tolerate pre-existing
  // tables created without them.
  ensureColumn(sqlite, "tasks", "title_manually_set", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(sqlite, "tasks", "pinned", "INTEGER NOT NULL DEFAULT 0");
  sqlite.exec("CREATE INDEX IF NOT EXISTS tasks_pinned_idx ON tasks(pinned);");
  // findTasksByProjectId filters project_id and orders by created_at DESC.
  // Without a composite covering that shape SQLite picks a single-column index
  // and sorts separately; this lets it satisfy the filter + order in one scan.
  sqlite.exec("CREATE INDEX IF NOT EXISTS tasks_project_created_idx ON tasks(project_id, created_at);");

  // Legacy builds briefly modeled "shell" as a task agent even though shell
  // terminals are not persisted tasks. Normalize stale rows before the narrowed
  // TaskAgent union reaches UI code that indexes AGENT_REGISTRY.
  sqlite.exec(`
    UPDATE tasks SET agent = 'claude-code' WHERE agent = 'shell';
    UPDATE projects SET saved_agent = NULL WHERE saved_agent = 'shell';
  `);

  // One-time upgrade-path fill of the token-usage rollup from existing raw rows.
  // Fresh DBs have no token_usage yet (no-op); the ingest transaction keeps it
  // current from here on.
  backfillTokenUsageRollup(sqlite);

  // Actana Control removed the Mission Pet subsystem (docs/specs/02-remove-pet.md).
  // Every boot idempotently drops the six pet_* rows from app_settings so a
  // DB carried over from a pre-cutover Mission Control install doesn't keep
  // dead pet state around. Stays in the tree for one release, then removed.
  dropLegacyPetSettings(sqlite);

  // Actana Control removed voice / Whisper (docs/specs/01-remove-whisper.md).
  // Every boot idempotently drops the voice_command_aliases row from
  // app_settings and any project_memories rows tagged source='voice', so a
  // DB carried over from a pre-cutover install doesn't keep dead voice state
  // around. Stays in the tree for one release, then removed.
  dropLegacyVoiceSettings(sqlite);

  // Actana Control removed the Scratch Pad, Custom Scripts / Launch Commands,
  // and Prompt Search surfaces (docs/specs/07-remove-convenience.md). Every
  // boot idempotently drops the prompts + scratch_pads tables plus the
  // projects.launch_commands, projects.custom_scripts, and
  // user_terminals.start_command columns so a DB carried over from a
  // pre-cutover Mission Control install doesn't keep the dead schema around.
  // Stays in the tree for one release, then removed.
  dropLegacyConvenienceSurfaces(sqlite);

  // Actana Control removed Recall / project memory / code graph
  // (docs/specs/04-remove-recall-and-memory.md). Every boot idempotently drops
  // the project_memory table (+ its FTS5 shadow tables/triggers), the three
  // graph_* tables and their indexes, and the ten recall_* rows (plus the
  // stray code_graph_state legacy blob) from app_settings, so a DB carried
  // over from a pre-cutover install doesn't keep dead recall state around.
  // Stays in the tree for one release, then removed.
  dropLegacyRecallMemoryGraph(sqlite);

  // Actana Control removed bundled agent skills and the diagram HTTP API
  // (docs/specs/05-remove-bundled-skills.md, ADR 0006). Every boot
  // idempotently drops the task_diagrams table (+ its indexes and the
  // 0012-rename dance leftover), and any diagram_* / ship_skill_* /
  // diagram_skill_* rows from app_settings, so a DB carried over from a
  // pre-cutover install doesn't keep the dead diagram state around.
  // Stays in the tree for one release, then removed.
  dropLegacyBundledSkillsSchema(sqlite);

  // Actana Control removed the IDE-adjacent file editor / finder / HTML
  // preview / markdown annotator surface (docs/specs/06-remove-ide-adjacent.md).
  // Every boot idempotently drops the two annotation_* rows from app_settings
  // and scrubs file.finder / file.save entries from every keybindings:* blob,
  // so a DB carried over from a pre-cutover install doesn't keep dead
  // annotation settings or orphan hotkey overrides around. Stays in the tree
  // for one release, then removed.
  dropLegacyIdeAdjacentSettings(sqlite);

  // Actana Control removed the managed sandbox / remote VM subsystem
  // (docs/specs/10-remove-sandbox.md, ADR 0009). Every boot idempotently drops
  // the sandboxes table, the sandbox_id / scope_id columns and their indexes,
  // and the sandbox.* / multiSandbox.* app_settings rows, so a DB carried over
  // from a pre-cutover install doesn't keep the dead sandbox schema around.
  // Stays in the tree for one release, then removed.
  dropLegacySandboxSchema(sqlite);

  // Actana Control removed worktree management and git integration
  // (docs/specs/11-remove-worktree-and-git.md). Every boot idempotently drops
  // the worktrees table, the tasks/user_terminals worktree_id columns and
  // their indexes, the projects branch / worktree_setup_command columns, and
  // the worktree / git-diff app_settings rows. Sessions previously bound to a
  // non-default worktree collapse to the project's single implicit path (rows
  // are kept). Stays in the tree for one release, then removed.
  dropLegacyWorktreeSchema(sqlite);

  // Actana Control adopted the Studio look as the sole Panel look
  // (docs/specs/12-adopt-studio-look.md). Every boot idempotently drops the
  // fourteen theming rows from app_settings — every theming setting other
  // than dark/light (which lives in localStorage as mc:theme) collapsed to a
  // fixed default. Stays in the tree for one release, then removed.
  dropLegacyThemeSettings(sqlite);
}

export function dropLegacyThemeSettings(sqlite: Database.Database): void {
  sqlite.exec(`
    DELETE FROM app_settings WHERE key IN (
      'accent_color',
      'theme_style',
      'minimal_theme',
      'surface_tint',
      'background_image',
      'show_background_grid',
      'interface_font_family',
      'interface_font_scale',
      'terminal_font_family',
      'terminal_font_weight',
      'terminal_font_weight_bold',
      'terminal_line_height',
      'terminal_letter_spacing',
      'launch_overlay_enabled'
    );
  `);
}

export function dropLegacyWorktreeSchema(sqlite: Database.Database): void {
  // Indexes first — SQLite refuses to DROP COLUMN while an index covers it.
  sqlite.exec(`
    DROP INDEX IF EXISTS tasks_project_worktree_idx;
    DROP INDEX IF EXISTS tasks_worktree_idx;
    DROP INDEX IF EXISTS user_terminals_project_worktree_idx;
    DROP INDEX IF EXISTS user_terminals_worktree_idx;
  `);
  // No `DROP COLUMN IF EXISTS` in SQLite — guard on pragma_table_info so this
  // is a clean no-op on fresh DBs and on every boot after the first. Rows are
  // NOT deleted: a worktree-bound session collapses to the project path.
  if (columnExists(sqlite, "tasks", "worktree_id")) {
    sqlite.exec(`ALTER TABLE tasks DROP COLUMN worktree_id;`);
  }
  if (columnExists(sqlite, "user_terminals", "worktree_id")) {
    sqlite.exec(`ALTER TABLE user_terminals DROP COLUMN worktree_id;`);
  }
  if (columnExists(sqlite, "projects", "branch")) {
    sqlite.exec(`ALTER TABLE projects DROP COLUMN branch;`);
  }
  if (columnExists(sqlite, "projects", "worktree_setup_command")) {
    sqlite.exec(`ALTER TABLE projects DROP COLUMN worktree_setup_command;`);
  }
  sqlite.exec(`
    DROP INDEX IF EXISTS worktrees_project_idx;
    DROP INDEX IF EXISTS worktrees_project_name_unique;
  `);
  sqlite.exec(`DROP TABLE IF EXISTS worktrees;`);
  sqlite.exec(`
    DELETE FROM app_settings WHERE key IN (
      'selected_worktree_by_project',
      'git_diff_changed_files_view',
      'git_diff_changed_files_width',
      'worktrees_enabled'
    );
  `);
}

export function dropLegacySandboxSchema(sqlite: Database.Database): void {
  // Indexes first — SQLite refuses to DROP COLUMN while an index covers it.
  sqlite.exec(`
    DROP INDEX IF EXISTS projects_sandbox_idx;
    DROP INDEX IF EXISTS tasks_project_worktree_scope_idx;
    DROP INDEX IF EXISTS tasks_scope_idx;
    DROP INDEX IF EXISTS tasks_project_scope_created_idx;
    DROP INDEX IF EXISTS user_terminals_project_worktree_scope_idx;
    DROP INDEX IF EXISTS user_terminals_scope_idx;
    DROP INDEX IF EXISTS home_terminals_scope_idx;
  `);
  // Forward-only cutover: sandbox-scoped rows go with their sandbox (no data
  // migration path — ADR 0009). Delete BEFORE the columns drop; project rows
  // cascade their tasks/worktrees/terminals via the FKs client.ts enables.
  // No `DROP COLUMN IF EXISTS` in SQLite — guard on pragma_table_info so this
  // is a clean no-op on fresh DBs and on every boot after the first.
  if (columnExists(sqlite, "projects", "sandbox_id")) {
    sqlite.exec(`DELETE FROM projects WHERE sandbox_id IS NOT NULL;`);
    sqlite.exec(`ALTER TABLE projects DROP COLUMN sandbox_id;`);
  }
  if (columnExists(sqlite, "tasks", "scope_id")) {
    sqlite.exec(`DELETE FROM tasks WHERE scope_id != 'local';`);
    sqlite.exec(`ALTER TABLE tasks DROP COLUMN scope_id;`);
  }
  if (columnExists(sqlite, "user_terminals", "scope_id")) {
    sqlite.exec(`DELETE FROM user_terminals WHERE scope_id != 'local';`);
    sqlite.exec(`ALTER TABLE user_terminals DROP COLUMN scope_id;`);
  }
  if (columnExists(sqlite, "home_terminals", "scope_id")) {
    sqlite.exec(`DELETE FROM home_terminals WHERE scope_id != 'local';`);
    sqlite.exec(`ALTER TABLE home_terminals DROP COLUMN scope_id;`);
  }
  sqlite.exec(`DROP TABLE IF EXISTS sandboxes;`);
  sqlite.exec(
    `DELETE FROM app_settings WHERE key LIKE 'sandbox.%' OR key LIKE 'multiSandbox.%';`,
  );
}

function dropLegacyPetSettings(sqlite: Database.Database): void {
  sqlite.exec(`DELETE FROM app_settings WHERE key LIKE 'pet\\_%' ESCAPE '\\';`);
}

function dropLegacyBundledSkillsSchema(sqlite: Database.Database): void {
  sqlite.exec(`DROP INDEX IF EXISTS task_diagrams_project_idx;`);
  sqlite.exec(`DROP INDEX IF EXISTS task_diagrams_task_idx;`);
  sqlite.exec(`DROP TABLE IF EXISTS task_diagrams;`);
  // Legacy from the 0012 rename dance — defensive.
  sqlite.exec(`DROP TABLE IF EXISTS task_diagrams_new;`);
  sqlite.exec(`DELETE FROM app_settings WHERE key LIKE 'diagram\\_%' ESCAPE '\\';`);
  sqlite.exec(`DELETE FROM app_settings WHERE key LIKE 'ship\\_skill\\_%' ESCAPE '\\';`);
  sqlite.exec(`DELETE FROM app_settings WHERE key LIKE 'diagram\\_skill\\_%' ESCAPE '\\';`);
}

function dropLegacyConvenienceSurfaces(sqlite: Database.Database): void {
  // Drop the prompt-history palette's storage and its supporting indexes.
  sqlite.exec(`DROP INDEX IF EXISTS prompts_task_idx;`);
  sqlite.exec(`DROP INDEX IF EXISTS prompts_project_idx;`);
  sqlite.exec(`DROP INDEX IF EXISTS prompts_ts_idx;`);
  sqlite.exec(`DROP TABLE IF EXISTS prompts;`);

  // Drop the scratch-pad table and its indexes.
  sqlite.exec(`DROP INDEX IF EXISTS scratch_pads_project_idx;`);
  sqlite.exec(`DROP INDEX IF EXISTS scratch_pads_project_updated_idx;`);
  sqlite.exec(`DROP TABLE IF EXISTS scratch_pads;`);

  // Drop the launch-commands / custom-scripts / start_command columns. SQLite
  // has no `DROP COLUMN IF EXISTS`, so guard on pragma_table_info first — this
  // makes the cleanup a clean no-op on a fresh DB that never had the column.
  if (columnExists(sqlite, "projects", "launch_commands")) {
    sqlite.exec(`ALTER TABLE projects DROP COLUMN launch_commands;`);
  }
  if (columnExists(sqlite, "projects", "custom_scripts")) {
    sqlite.exec(`ALTER TABLE projects DROP COLUMN custom_scripts;`);
  }
  if (columnExists(sqlite, "user_terminals", "start_command")) {
    sqlite.exec(`ALTER TABLE user_terminals DROP COLUMN start_command;`);
  }
}

function columnExists(
  sqlite: Database.Database,
  table: string,
  column: string,
): boolean {
  const row = sqlite
    .prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`)
    .get(table, column);
  return !!row;
}

function dropLegacyIdeAdjacentSettings(sqlite: Database.Database): void {
  sqlite.exec(
    `DELETE FROM app_settings WHERE key IN ('annotation_agent', 'annotation_model');`,
  );
  // Rewrite each keybinding-scope blob to drop the retired file.finder /
  // file.save keys. json_remove is a no-op when the path is absent, so this is
  // safe on a fresh DB too.
  sqlite.exec(
    `UPDATE app_settings SET value = json_remove(value, '$."file.finder"', '$."file.save"') WHERE key LIKE 'keybindings:%';`,
  );
}

function dropLegacyVoiceSettings(sqlite: Database.Database): void {
  sqlite.exec(`DELETE FROM app_settings WHERE key = 'voice_command_aliases';`);
  // The legacy project_memories table may or may not exist depending on which
  // schema the DB last saw; guard on sqlite_master so this stays a clean no-op.
  const hasMemories = sqlite
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_memories'`)
    .get();
  if (hasMemories) {
    sqlite.exec(`DELETE FROM project_memories WHERE source = 'voice';`);
  }
}

/**
 * Populate token_usage_rollup from token_usage once, when the rollup is empty
 * but raw usage rows already exist (i.e. a DB created before the rollup shipped).
 * Idempotent: a no-op on fresh DBs and on every subsequent boot. Transactional so
 * a crash mid-fill leaves the rollup empty and simply retries next boot. Uses the
 * same local-day expression the ingest upsert and read queries use, so the
 * aggregate matches the raw table exactly.
 */
export function backfillTokenUsageRollup(sqlite: Database.Database): void {
  const rollupCount = (
    sqlite.prepare("SELECT count(*) AS n FROM token_usage_rollup").get() as { n: number }
  ).n;
  if (rollupCount > 0) return;
  const rawCount = (
    sqlite.prepare("SELECT count(*) AS n FROM token_usage").get() as { n: number }
  ).n;
  if (rawCount === 0) return;
  sqlite
    .transaction(() => {
      sqlite.exec(`
        INSERT INTO token_usage_rollup (
          project_id, task_id, day,
          input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, last_ts
        )
        SELECT
          project_id,
          task_id,
          strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') AS day,
          SUM(input_tokens),
          SUM(output_tokens),
          SUM(cache_creation_tokens),
          SUM(cache_read_tokens),
          MAX(ts)
        FROM token_usage
        GROUP BY project_id, task_id, day;
      `);
    })();
}

/**
 * One-shot idempotent boot-time cleanup that removes every schema artifact
 * left behind by the removed Recall / project-memory / code-graph pillars
 * (spec 04). Safe on a fresh DB — every DROP is guarded by IF EXISTS and the
 * DELETE's WHERE predicate matches nothing there. Required on upgraded DBs so
 * a future rename doesn't collide with phantom rows.
 */
export function dropLegacyRecallMemoryGraph(sqlite: Database.Database): void {
  sqlite.exec(`
    -- FTS triggers first (safer before dropping their content table).
    DROP TRIGGER IF EXISTS project_memory_fts_ai;
    DROP TRIGGER IF EXISTS project_memory_fts_ad;
    DROP TRIGGER IF EXISTS project_memory_fts_au;
    DROP TABLE   IF EXISTS project_memory_fts;

    DROP INDEX IF EXISTS project_memory_project_idx;
    DROP INDEX IF EXISTS project_memory_project_scope_idx;
    DROP INDEX IF EXISTS project_memory_type_idx;
    DROP INDEX IF EXISTS project_memory_status_idx;
    DROP INDEX IF EXISTS project_memory_pinned_idx;
    DROP TABLE IF EXISTS project_memory;

    DROP INDEX IF EXISTS graph_edges_dangling_idx;
    DROP INDEX IF EXISTS graph_edges_project_idx;
    DROP INDEX IF EXISTS graph_edges_src_idx;
    DROP INDEX IF EXISTS graph_edges_dst_idx;
    DROP INDEX IF EXISTS graph_edges_project_kind_idx;
    DROP TABLE IF EXISTS graph_edges;

    DROP INDEX IF EXISTS graph_nodes_project_idx;
    DROP INDEX IF EXISTS graph_nodes_project_kind_idx;
    DROP INDEX IF EXISTS graph_nodes_project_name_idx;
    DROP INDEX IF EXISTS graph_nodes_project_file_idx;
    DROP INDEX IF EXISTS graph_nodes_project_degree_idx;
    DROP TABLE IF EXISTS graph_nodes;

    DROP TABLE IF EXISTS graph_files;

    DELETE FROM app_settings WHERE key IN (
      'recall_enabled',
      'recall_auto_capture_enabled',
      'recall_engine_enabled',
      'recall_engine_harness',
      'recall_engine_model',
      'recall_agent_write_enabled',
      'recall_inject_brief_enabled',
      'recall_code_graph_enabled',
      'recall_proactive_recall_enabled',
      'recall_learned_toast_enabled',
      'code_graph_state'
    );
  `);
}
