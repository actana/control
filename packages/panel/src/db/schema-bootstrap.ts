// The Panel's SQLite schema bootstrap — the CREATE-IF-NOT-EXISTS DDL that owns
// the shape of the Panel's `missioncontrol.db`, plus the idempotent helpers that
// keep older databases converging on that shape.
//
// This was `@actana/shared/schema-bootstrap`, shared with the Core. The Core no
// longer has Projects (ADR 0041 D1), so it has its own, project-free schema in
// `@actana/shared/core-schema`; this file is the Panel's alone and moved here
// unchanged so the Panel's tables, including its Project family, stay as they
// were until #560 removed them (see dropLegacyProjects below); #567's move to
// Postgres deletes this file with SQLite.
//
// Kept self-contained (relative imports only, no `~/*` alias, no drizzle, no
// native binding resolution, no Vite globs).

import type Database from "better-sqlite3";
import * as fs from "node:fs";
import { DEFAULT_BRANCH, DEFAULT_SESSION_STATUS } from "@actana/shared/domain";

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

// The Panel's local session family. A Session belongs to a Core and nothing
// narrower (ADR 0041 D1), so none of these tables names a Project: they are
// declared once here and used both by ensureSchema (fresh DBs) and by
// dropLegacyProjects (which rebuilds the 0.4.x shape without `project_id`).
const SESSIONS_COLUMNS = `
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      title_manually_set INTEGER NOT NULL DEFAULT 0,
      icon TEXT,
      agent TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '${DEFAULT_SESSION_STATUS}',
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
    `;

const TOKEN_USAGE_COLUMNS = `
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      claude_session_id TEXT NOT NULL,
      message_uuid TEXT NOT NULL UNIQUE,
      model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      ts INTEGER NOT NULL
    `;

const TOKEN_USAGE_ROLLUP_COLUMNS = `
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      last_ts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, day)
    `;

const TOKEN_USAGE_OFFSETS_COLUMNS = `
      claude_session_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    `;

function createSessionIndexes(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions(status);
    CREATE INDEX IF NOT EXISTS sessions_archived_idx ON sessions(archived);
    CREATE INDEX IF NOT EXISTS sessions_pinned_idx ON sessions(pinned);

    CREATE INDEX IF NOT EXISTS token_usage_session_idx ON token_usage(session_id);
    CREATE INDEX IF NOT EXISTS token_usage_ts_idx ON token_usage(ts);
    -- Covering indexes so a raw-table aggregate (backfill, or any fallback read)
    -- can sum straight from the index without touching the heap. The rollup is
    -- the primary read path; these keep the raw path from cliffing.
    CREATE INDEX IF NOT EXISTS token_usage_ts_cover_idx
      ON token_usage(ts, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens);
    CREATE INDEX IF NOT EXISTS token_usage_session_ts_cover_idx
      ON token_usage(session_id, ts, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens);

    CREATE INDEX IF NOT EXISTS token_usage_rollup_session_idx ON token_usage_rollup(session_id);
    CREATE INDEX IF NOT EXISTS token_usage_rollup_day_idx ON token_usage_rollup(day);
  `);
}

/**
 * PTYs are owned by the Core process and are not restored across app
 * restarts, so on every launch any session the app left mid-session has a dead PTY
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
      "UPDATE sessions SET status = 'disconnected', updated_at = ? WHERE status IN ('running', 'needs-input')"
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
    CREATE TABLE IF NOT EXISTS sessions (${SESSIONS_COLUMNS});

    CREATE TABLE IF NOT EXISTS terminal_logs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      chunk TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS terminal_logs_session_idx ON terminal_logs(session_id);

    -- The Panel's only terminal table (issue 266). It arrived as the
    -- project-less "home" half beside user_terminals; the project-root half is
    -- gone and dropLegacyUserTerminals below removes what is left of it.
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

    CREATE TABLE IF NOT EXISTS token_usage (${TOKEN_USAGE_COLUMNS});

    -- Pre-aggregated token usage per (session, local day). Every summary read
    -- (totals, per-session, per-day) sums this instead of scanning all of
    -- token_usage, turning multi-second aggregates at ~1M rows into
    -- sub-millisecond ones. Kept in lockstep with token_usage by the ingest
    -- transaction (only newly-inserted rows are folded in) and by ON DELETE
    -- CASCADE, which drops rollup rows when a session is removed just as it
    -- drops the raw rows — so the rollup always equals the raw aggregate.
    CREATE TABLE IF NOT EXISTS token_usage_rollup (${TOKEN_USAGE_ROLLUP_COLUMNS});

    CREATE TABLE IF NOT EXISTS token_usage_session_offsets (${TOKEN_USAGE_OFFSETS_COLUMNS});

    -- Monotonic per-Core event log. See src/shared/event-log.ts for the
    -- read/append helpers; the table is created here (idempotently) so both the
    -- server process and the Core (PTY manager) process share the same shape.
    CREATE TABLE IF NOT EXISTS event_log (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      pty_id TEXT,
      session_id TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS event_log_kind_idx ON event_log(kind);
    CREATE INDEX IF NOT EXISTS event_log_session_idx ON event_log(session_id);
    CREATE INDEX IF NOT EXISTS event_log_pty_idx ON event_log(pty_id);
  `);
  createSessionIndexes(sqlite);

  // Columns added after their table first shipped; tolerate pre-existing
  // tables created without them.
  ensureColumn(sqlite, "sessions", "title_manually_set", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(sqlite, "sessions", "pinned", "INTEGER NOT NULL DEFAULT 0");
  sqlite.exec("CREATE INDEX IF NOT EXISTS sessions_pinned_idx ON sessions(pinned);");

  // Legacy builds briefly modeled "shell" as a session agent even though shell
  // terminals are not persisted sessions. Normalize stale rows before the narrowed
  // Harness union reaches UI code that indexes HARNESS_REGISTRY.
  sqlite.exec(`UPDATE sessions SET agent = 'claude-code' WHERE agent = 'shell';`);

  // Actana Control removed the Mission Pet subsystem. Every boot idempotently
  // drops the six pet_* rows from app_settings so a DB carried over from a
  // pre-cutover Mission Control install doesn't keep dead pet state around.
  // Stays in the tree for one release, then removed.
  dropLegacyPetSettings(sqlite);

  // Actana Control removed voice / Whisper. Every boot idempotently drops the
  // voice_command_aliases row from app_settings and any project_memories rows
  // tagged source='voice', so a DB carried over from a pre-cutover install
  // doesn't keep dead voice state around. Stays in the tree for one release,
  // then removed.
  dropLegacyVoiceSettings(sqlite);

  // Actana Control removed the Scratch Pad, Custom Scripts / Launch Commands,
  // and Prompt Search surfaces. Every boot idempotently drops the prompts +
  // scratch_pads tables plus the projects.launch_commands,
  // projects.custom_scripts, and user_terminals.start_command columns so a DB
  // carried over from a pre-cutover Mission Control install doesn't keep the
  // dead schema around. Stays in the tree for one release, then removed.
  dropLegacyConvenienceSurfaces(sqlite);

  // Actana Control removed Recall / project memory / code graph. Every boot
  // idempotently drops the project_memory table (+ its FTS5 shadow
  // tables/triggers), the three graph_* tables and their indexes, and the ten
  // recall_* rows (plus the stray code_graph_state legacy blob) from
  // app_settings, so a DB carried over from a pre-cutover install doesn't keep
  // dead recall state around. Stays in the tree for one release, then removed.
  dropLegacyRecallMemoryGraph(sqlite);

  // Actana Control removed bundled agent skills and the diagram HTTP API
  // (ADR 0006). Every boot idempotently drops the task_diagrams table (+ its
  // indexes and the 0012-rename dance leftover), and any diagram_* /
  // ship_skill_* / diagram_skill_* rows from app_settings, so a DB carried
  // over from a pre-cutover install doesn't keep the dead diagram state
  // around. Stays in the tree for one release, then removed.
  dropLegacyBundledSkillsSchema(sqlite);

  // Actana Control removed the IDE-adjacent file editor / finder / HTML
  // preview / markdown annotator surface. Every boot idempotently drops the
  // two annotation_* rows from app_settings and scrubs file.finder /
  // file.save entries from every keybindings:* blob, so a DB carried over
  // from a pre-cutover install doesn't keep dead annotation settings or
  // orphan hotkey overrides around. Stays in the tree for one release, then
  // removed.
  dropLegacyIdeAdjacentSettings(sqlite);

  // Actana Control removed the managed sandbox / remote VM subsystem
  // (ADR 0009). Every boot idempotently drops the sandboxes table, the
  // sandbox_id / scope_id columns and their indexes, and the sandbox.* /
  // multiSandbox.* app_settings rows, so a DB carried over from a pre-cutover
  // install doesn't keep the dead sandbox schema around. Stays in the tree
  // for one release, then removed.
  dropLegacySandboxSchema(sqlite);

  // Actana Control removed worktree management and git integration. Every boot
  // idempotently drops the worktrees table, the sessions/user_terminals
  // worktree_id columns and their indexes, the projects branch /
  // worktree_setup_command columns, and the worktree / git-diff app_settings
  // rows. Sessions previously bound to a non-default worktree collapse to the
  // project's single implicit path (rows are kept). Stays in the tree for one
  // release, then removed.
  dropLegacyWorktreeSchema(sqlite);

  // Actana Control adopted the Studio look as the sole Panel look. Every boot
  // idempotently drops the fourteen theming rows from app_settings — every
  // theming setting other than dark/light (which lives in localStorage as
  // mc:theme) collapsed to a fixed default. Stays in the tree for one release,
  // then removed.
  dropLegacyThemeSettings(sqlite);

  // Actana Control removed the project-root terminal (issue 266). The Panel
  // offers one terminal control, it opens a VM Shell Session on the Core, and
  // every row it makes lands in home_terminals — so user_terminals has no
  // writer, no reader and no route left. **Dropped, not orphaned**: a terminal
  // is ephemeral, there is nothing in those rows worth migrating, and a table
  // nothing can ever read again is a question every future reader of this
  // schema has to answer for themselves. Runs last so the worktree / sandbox /
  // convenience sweeps above still find the columns they expect on a DB old
  // enough to have them. Stays in the tree for one release, then removed.
  dropLegacyUserTerminals(sqlite);

  // Actana Control removed Projects (ADR 0041 D1, issue 560). Every boot
  // idempotently drops the projects, project_presentation and groups tables and
  // rebuilds the session family without `project_id`, keeping every row. Runs
  // after every sweep above, which may still look for project-era columns, and
  // before the rollup backfill, which reads the rebuilt shape. Stays in the tree
  // until #567 deletes this file with SQLite.
  dropLegacyProjects(sqlite);

  // One-time upgrade-path fill of the token-usage rollup from existing raw rows.
  // Fresh DBs have no token_usage yet (no-op); the ingest transaction keeps it
  // current from here on.
  backfillTokenUsageRollup(sqlite);
}

const LEGACY_PROJECT_SETTING_KEYS = [
  "projects_dashboard_view",
  "active_project_group",
  "collapsed_project_groups",
  "show_group_switcher",
  "show_project_header_group",
];

/**
 * Remove the Panel's Project model from its database (issue 560, ADR 0041 D1).
 *
 * - `projects`, `project_presentation` (and its indexes) and `groups` are dropped.
 * - `sessions`, `token_usage`, `token_usage_rollup` and `token_usage_session_offsets`
 *   named a project (a foreign key with `ON DELETE CASCADE` for the first), so they
 *   are rebuilt without the column and **every row is kept**: a Session belongs
 *   to a Core and nothing narrower. SQLite cannot drop a column that a foreign key
 *   and an index cover, hence the rebuild; the rollup's key becomes (session, day),
 *   which loses nothing because a session belonged to exactly one project.
 * - The project-era `app_settings` rows are deleted.
 *
 * Foreign keys are switched off for the rebuild (a `DROP TABLE` with them on
 * would cascade away the rows being moved) and checked before the commit.
 * Idempotent, and a no-op on a fresh DB, which never had any of it.
 */
export function dropLegacyProjects(sqlite: Database.Database): void {
  const hadProjectFamily =
    tableExists(sqlite, "projects") ||
    tableExists(sqlite, "project_presentation") ||
    tableExists(sqlite, "groups") ||
    columnExists(sqlite, "sessions", "project_id");

  if (hadProjectFamily) {
    const foreignKeys = sqlite.pragma("foreign_keys", { simple: true }) as number;
    let inTransaction = false;
    sqlite.pragma("foreign_keys = OFF");
    try {
      sqlite.exec("BEGIN IMMEDIATE");
      inTransaction = true;
      for (const [table, columns] of [
        ["sessions", SESSIONS_COLUMNS],
        ["token_usage", TOKEN_USAGE_COLUMNS],
        ["token_usage_rollup", TOKEN_USAGE_ROLLUP_COLUMNS],
        ["token_usage_session_offsets", TOKEN_USAGE_OFFSETS_COLUMNS],
      ] as const) {
        if (columnExists(sqlite, table, "project_id")) rebuildWithoutProjectId(sqlite, table, columns);
      }
      sqlite.exec(`
        DROP INDEX IF EXISTS project_presentation_core_idx;
        DROP INDEX IF EXISTS project_presentation_group_idx;
        DROP TABLE IF EXISTS project_presentation;
        DROP INDEX IF EXISTS projects_group_idx;
        DROP INDEX IF EXISTS projects_pinned_idx;
        DROP TABLE IF EXISTS projects;
        DROP TABLE IF EXISTS groups;
      `);
      const violations = sqlite.prepare("PRAGMA foreign_key_check").all();
      if (violations.length) throw new Error("Dropping the project family failed foreign key validation");
      sqlite.exec("COMMIT");
      inTransaction = false;
    } catch (error) {
      if (inTransaction) sqlite.exec("ROLLBACK");
      throw error;
    } finally {
      sqlite.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
    }
    // The rebuilt tables lost their indexes with the old ones.
    createSessionIndexes(sqlite);
  }

  const placeholders = LEGACY_PROJECT_SETTING_KEYS.map(() => "?").join(", ");
  sqlite
    .prepare(`DELETE FROM app_settings WHERE key IN (${placeholders})`)
    .run(...LEGACY_PROJECT_SETTING_KEYS);
  migrateProjectKeybindings(sqlite);
}

/**
 * The hotkeys that named a Project: the two that moved keep an operator's
 * override under their new id, the two that drove a Project's launch commands
 * are dropped. `json_type` is NULL when the key is absent, so this is a no-op on
 * a blob without them (and on a fresh DB).
 */
function migrateProjectKeybindings(sqlite: Database.Database): void {
  for (const [from, to] of [
    ["project.pinnedSlot", "core.slot"],
    ["project.ship", "session.ship"],
  ] as const) {
    sqlite
      .prepare(
        `UPDATE app_settings
            SET value = json_set(json_remove(value, '$."${from}"'), '$."${to}"', json(json_extract(value, '$."${from}"')))
          WHERE key LIKE 'keybindings:%' AND json_valid(value) AND json_type(value, '$."${from}"') IS NOT NULL`,
      )
      .run();
  }
  sqlite
    .prepare(
      `UPDATE app_settings
          SET value = json_remove(value, '$."project.runToggle"', '$."project.openBrowser"')
        WHERE key LIKE 'keybindings:%' AND json_valid(value)`,
    )
    .run();
}

/** Copy `table` into the project-free shape, keeping the columns both shapes have. */
function rebuildWithoutProjectId(sqlite: Database.Database, table: string, columns: string): void {
  const rebuilt = `${table}_rebuilt`;
  sqlite.exec(`DROP TABLE IF EXISTS ${rebuilt}; CREATE TABLE ${rebuilt} (${columns});`);
  const kept = (
    sqlite.prepare(`SELECT name FROM pragma_table_info('${rebuilt}')`).all() as { name: string }[]
  )
    .map((c) => c.name)
    .filter((name) => columnExists(sqlite, table, name));
  const list = kept.map((name) => `"${name}"`).join(", ");
  // The rollup's key shrinks from (project, session, day) to (session, day), so
  // two old rows can land on one new key: fold them with sums rather than abort
  // the boot on the primary key.
  const copy =
    table === "token_usage_rollup"
      ? `INSERT INTO ${rebuilt} (session_id, day, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, last_ts)
           SELECT session_id, day, SUM(input_tokens), SUM(output_tokens), SUM(cache_creation_tokens), SUM(cache_read_tokens), MAX(last_ts)
             FROM ${table} GROUP BY session_id, day;`
      : `INSERT INTO ${rebuilt} (${list}) SELECT ${list} FROM ${table};`;
  sqlite.exec(`
    ${copy}
    DROP TABLE ${table};
    ALTER TABLE ${rebuilt} RENAME TO ${table};
  `);
}

/**
 * Drop the `user_terminals` table and its index (issue 266).
 *
 * Idempotent and safe on a fresh DB, which never had the table: `ensureSchema`
 * stopped creating it in the same change.
 */
export function dropLegacyUserTerminals(sqlite: Database.Database): void {
  sqlite.exec(`
    DROP INDEX IF EXISTS user_terminals_project_idx;
    DROP TABLE IF EXISTS user_terminals;
  `);
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
    DROP INDEX IF EXISTS sessions_project_worktree_idx;
    DROP INDEX IF EXISTS sessions_worktree_idx;
    DROP INDEX IF EXISTS user_terminals_project_worktree_idx;
    DROP INDEX IF EXISTS user_terminals_worktree_idx;
  `);
  // No `DROP COLUMN IF EXISTS` in SQLite — guard on pragma_table_info so this
  // is a clean no-op on fresh DBs and on every boot after the first. Rows are
  // NOT deleted: a worktree-bound session collapses to the project path.
  if (columnExists(sqlite, "sessions", "worktree_id")) {
    sqlite.exec(`ALTER TABLE sessions DROP COLUMN worktree_id;`);
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
    DROP INDEX IF EXISTS sessions_project_worktree_scope_idx;
    DROP INDEX IF EXISTS sessions_scope_idx;
    DROP INDEX IF EXISTS sessions_project_scope_created_idx;
    DROP INDEX IF EXISTS user_terminals_project_worktree_scope_idx;
    DROP INDEX IF EXISTS user_terminals_scope_idx;
    DROP INDEX IF EXISTS home_terminals_scope_idx;
  `);
  // Forward-only cutover: sandbox-scoped rows go with their sandbox (no data
  // migration path — ADR 0009). Delete BEFORE the columns drop; project rows
  // cascade their sessions/worktrees/terminals via the FKs client.ts enables.
  // No `DROP COLUMN IF EXISTS` in SQLite — guard on pragma_table_info so this
  // is a clean no-op on fresh DBs and on every boot after the first.
  if (columnExists(sqlite, "projects", "sandbox_id")) {
    sqlite.exec(`DELETE FROM projects WHERE sandbox_id IS NOT NULL;`);
    sqlite.exec(`ALTER TABLE projects DROP COLUMN sandbox_id;`);
  }
  if (columnExists(sqlite, "sessions", "scope_id")) {
    sqlite.exec(`DELETE FROM sessions WHERE scope_id != 'local';`);
    sqlite.exec(`ALTER TABLE sessions DROP COLUMN scope_id;`);
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
          session_id, day,
          input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, last_ts
        )
        SELECT
          session_id,
          strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') AS day,
          SUM(input_tokens),
          SUM(output_tokens),
          SUM(cache_creation_tokens),
          SUM(cache_read_tokens),
          MAX(ts)
        FROM token_usage
        GROUP BY session_id, day;
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
