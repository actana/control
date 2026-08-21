import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { restrictDbFilePermissions } from "@actana/shared/schema-bootstrap";
import { resolvePanelDataDir } from "./panel-data-dir";

/**
 * The Panel's own database: the Operator and their Panel sessions, the Core
 * registry, its sealed secrets, and the per-Core replay cursors.
 * Deliberately separate from the legacy app database (db/client.ts) — that one
 * holds Core-owned material that moves behind the core-link, while this one
 * is what the Panel service itself must survive a restart with.
 *
 * Schema is created in place rather than through the drizzle migration runner:
 * it is small, additive-only so far, and the service must be able to boot on a
 * cold data directory before anything else in the process has run.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS operator (
    -- Single-row table: exactly one Operator per Panel (ADR 0011). Tenancy is
    -- explicitly out of scope, and the CHECK is what enforces that at rest.
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    password_changed_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS panel_sessions (
    id TEXT PRIMARY KEY,
    operator_id INTEGER NOT NULL REFERENCES operator(id) ON DELETE CASCADE,
    -- Only the hash is stored: a copy of this database is not a set of usable
    -- session cookies.
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS panel_sessions_expires_at_idx ON panel_sessions(expires_at);

  CREATE TABLE IF NOT EXISTS cores (
    id TEXT PRIMARY KEY,
    -- The Operator owns their Cores (ADR 0011). There is one Operator today;
    -- modeling the ownership now is what keeps a later multi-account product
    -- from having to rewrite the registry.
    operator_id INTEGER NOT NULL REFERENCES operator(id) ON DELETE CASCADE,
    -- One registration per endpoint: pairing the same Core twice is a
    -- mistake to report, not a second Core to dial.
    endpoint TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    -- The Panel-owned replay cursor. Lives beside the registry row so removing
    -- a Core takes its cursor with it.
    last_event_id INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS core_secrets (
    core_id TEXT PRIMARY KEY REFERENCES cores(id) ON DELETE CASCADE,
    -- AES-256-GCM over the registration's secret half (see secrets-at-rest.ts).
    -- A copy of this file without the key file is inert.
    sealed BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

let db: Database.Database | null = null;
let openedPath: string | null = null;

function panelDbPath(): string {
  return path.join(resolvePanelDataDir(), "panel.db");
}

export function getPanelDb(): Database.Database {
  const dbPath = panelDbPath();
  // Reopening on a changed path keeps the data directory a real runtime input
  // (and lets a test point at a fresh directory) instead of a boot-time latch.
  if (db && openedPath === dbPath) return db;
  if (db) closePanelDb();

  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const opened = new Database(dbPath);
  const journalMode = opened.pragma("journal_mode = WAL", { simple: true });
  // NORMAL is only crash-safe under WAL; if WAL didn't take, keep the default.
  if (journalMode === "wal") opened.pragma("synchronous = NORMAL");
  opened.pragma("busy_timeout = 5000");
  opened.pragma("foreign_keys = ON");
  restrictDbFilePermissions(dbPath);
  opened.exec(SCHEMA);

  db = opened;
  openedPath = dbPath;
  return db;
}

export function closePanelDb(): void {
  db?.close();
  db = null;
  openedPath = null;
}
