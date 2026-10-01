// The Core's database schema: the CREATE-IF-NOT-EXISTS DDL that owns the shape
// of `missioncontrol.db` on a Core, and the check that refuses a database from
// before 0.5.0.
//
// A Core is a workspace plus Sessions (ADR 0041 D1), so its database holds two
// things: the `sessions` table and the monotonic `event_log`. Nothing groups a
// Session under anything else and there is no migration from the 0.4.x shape —
// 0.5.0 Cores are installed fresh (#552, #555).
//
// Kept self-contained (relative imports only) so the Core's tsc build compiles
// it against its own tsconfig.

import type Database from "better-sqlite3";
import * as fs from "node:fs";
import { DEFAULT_BRANCH, DEFAULT_SESSION_STATUS } from "./domain";

// `missioncontrol.db` is created with default perms world-readable (~0644), so
// any other local user / backup / sync process could lift it straight off disk.
// Tighten the DB (plus its WAL/SHM sidecars) to 0600. Best-effort: on
// filesystems/platforms without POSIX modes (e.g. Windows) chmod is a harmless
// no-op.
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

/** A database from before 0.5.0 cannot be opened by this Core. See {@link refusePre050Database}. */
export class Pre050DatabaseError extends Error {
  constructor(readonly evidence: string) {
    super(
      `this database is from before Core 0.5.0 (${evidence}). ` +
        `There is no migration: install a 0.5.0 Core fresh, with an empty state directory.`,
    );
    this.name = "Pre050DatabaseError";
  }
}

/**
 * Throw {@link Pre050DatabaseError} when `sqlite` holds anything a 0.5.0 Core
 * does not define.
 *
 * A clean break means a Core does not read the old database *and does not
 * quietly adopt it either*: `CREATE TABLE IF NOT EXISTS sessions` would leave an
 * old `sessions` table, with a column this Core no longer writes and the rows
 * under it, in place, and a Core would boot against a shape it does not own. So
 * the check is an allow-list, run before any DDL: every table must be one of
 * {@link CORE_TABLES}, and `sessions` must have exactly {@link SESSION_COLUMNS}.
 * The 0.4.x tables (and the pre-rename `tasks`) are refused without this module
 * having to name any of them. A missing table is fine: that is a fresh database.
 */
export function refusePre050Database(sqlite: Database.Database): void {
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  for (const { name } of tables) {
    if (!CORE_TABLES.has(name)) throw new Pre050DatabaseError(`it has a table named ${name}`);
  }
  if (tableExists(sqlite, "sessions")) {
    const columns = sqlite.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    const stranger = columns.find((c) => !SESSION_COLUMNS.has(c.name));
    if (stranger) throw new Pre050DatabaseError(`its sessions table has a column named ${stranger.name}`);
  }
}

const CORE_TABLES: ReadonlySet<string> = new Set(["sessions", "event_log"]);

/** Every column of `sessions` in {@link ensureCoreSchema}. Keep the two together. */
const SESSION_COLUMNS: ReadonlySet<string> = new Set([
  "id",
  "title",
  "title_manually_set",
  "icon",
  "agent",
  "status",
  "branch",
  "preview",
  "lines",
  "archived",
  "pinned",
  "claude_session_id",
  "claude_skip_permissions",
  "claude_bare_session",
  "created_at",
  "updated_at",
]);

/**
 * Create the Core's tables and indexes. Idempotent: every statement is
 * `IF NOT EXISTS`, so a second call against a bootstrapped database is a no-op.
 * Call {@link refusePre050Database} first.
 */
export function ensureCoreSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
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
    );
    CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions(status);
    CREATE INDEX IF NOT EXISTS sessions_archived_idx ON sessions(archived);
    CREATE INDEX IF NOT EXISTS sessions_pinned_idx ON sessions(pinned);

    -- Monotonic per-Core event log. See event-log.ts for the read/append
    -- helpers; the Core (PTY manager) process owns the writes.
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
}
