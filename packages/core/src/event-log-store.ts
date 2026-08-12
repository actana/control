// Core-side event-log store — a read-write handle to the shared SQLite
// `event_log` table, owned by the Core (PTY-manager) process.
//
// The Core appends PTY lifecycle events (pty:spawn / pty:exit) and serves
// the reconnect replay tail to the Panel. The stateful server process
// (server-runner.mjs) appends task/session/hook events to the same table via
// its own connection (src/server/event-log-recorder.ts). Both write to the
// same append-only table; SQLite's WAL write lock serializes the commits and
// `busy_timeout` absorbs the brief contention, so the two writers never
// corrupt each other's rows.
//
// This mirrors the connection pattern in project-roots.ts but opens
// read-write (the Core owns PTY events) instead of read-only. Runs only in
// the plain-Node Core process, so better-sqlite3 uses its standard binding.

import Database from "better-sqlite3";
import log from "./log";
import * as path from "node:path";
import * as fs from "node:fs";
import { makeOpenFailedThrottle } from "./log-throttle";
import {
  appendEvent as appendEventRow,
  ensureEventsTable,
  getLastEventId as readLastEventId,
  readEventTail as readTail,
  type EventLogSqlite,
} from "@actana/shared/event-log";
import type { CoreLinkEvent } from "@actana/sdk/core-link-frames";

export type { CoreLinkEvent };

let db: Database.Database | null = null;
let dbPath: string | null = null;
let tableEnsured = false;
// Throttle the db-missing log so a permanently-absent DB (e.g. a core-only
// VM where the server process never bootstrapped) doesn't fill the log on every
// event-log call. Logs the first occurrence verbatim then one summary line per
// 60s — mirrors project-roots.ts.
let lastDbMissingAt = 0;
const DB_MISSING_THROTTLE_MS = 60_000;
// A persistently-broken binding (missing native prebuild, WAL corruption)
// otherwise re-throws on every 500 ms live-event poll — one line per tick
// buries the actual error. Throttle mirrors the db-missing pattern above.
const logOpenFailed = makeOpenFailedThrottle("event-log.open-failed");

/**
 * Configure the event-log store to point at the shared SQLite file. Must be
 * called before any {@link getEventLog} / {@link getEventLogStore} use. The
 * connection is opened lazily on first access so a misconfigured path doesn't
 * crash boot — it logs and degrades to "no event recording" instead.
 */
export function configureEventLogStore(userDataDir: string): void {
  // Reset so a reconfigure (e.g. macOS `activate` re-runs main) reopens fresh.
  disposeEventLogStore();
  dbPath = path.join(userDataDir, "missioncontrol.db");
}

function ensureConnection(): Database.Database | null {
  if (!dbPath) {
    log.warn("event-log.unconfigured");
    return null;
  }
  if (db) return db;
  if (!fs.existsSync(dbPath)) {
    // The server process owns DB creation; if it hasn't bootstrapped yet the
    // event log is unavailable. PTY events recorded during this window are
    // dropped — they're best-effort lifecycle markers, not data of record.
    if (Date.now() - lastDbMissingAt > DB_MISSING_THROTTLE_MS) {
      log.info("event-log.db-missing", { dbPath });
      lastDbMissingAt = Date.now();
    }
    return null;
  }
  try {
    const conn = new Database(dbPath);
    try {
      conn.pragma("journal_mode = WAL");
      conn.pragma("busy_timeout = 5000");
      conn.pragma("synchronous = NORMAL");
    } catch (pragmaErr) {
      log.info("event-log.pragma-skipped", { error: String(pragmaErr) });
    }
    // Ensure the table exists on this connection even if the server bootstrap
    // hasn't run yet (idempotent). Both processes share the DDL.
    if (!tableEnsured) {
      ensureEventsTable(conn as unknown as EventLogSqlite);
      tableEnsured = true;
    }
    db = conn;
    return db;
  } catch (openErr) {
    logOpenFailed({ dbPath, error: String(openErr) });
    return null;
  }
}

/**
 * Append a domain event to the log and return its sequential `eventId`, or 0
 * when the store is unavailable (unconfigured / DB missing). 0 means "not
 * recorded" — callers must not treat it as a valid cursor.
 */
export function appendEvent(
  kind: string,
  payload: string,
  opts: { ptyId?: string | null; taskId?: string | null } = {},
): number {
  const conn = ensureConnection();
  if (!conn) return 0;
  try {
    return appendEventRow(conn as unknown as EventLogSqlite, kind, payload, opts);
  } catch (err) {
    log.warn("event-log.append-failed", { kind, error: String(err) });
    return 0;
  }
}

/** The highest `eventId` in the log, or 0 when empty/unavailable. */
export function getLastEventId(): number {
  const conn = ensureConnection();
  if (!conn) return 0;
  try {
    return readLastEventId(conn as unknown as EventLogSqlite);
  } catch (err) {
    log.warn("event-log.get-last-failed", { error: String(err) });
    return 0;
  }
}

/**
 * Read the replay tail — every event with `eventId > afterEventId`, in
 * ascending order. Returns an empty array when unavailable.
 */
export function readEventTail(afterEventId: number, limit = 1_000): CoreLinkEvent[] {
  const conn = ensureConnection();
  if (!conn) return [];
  try {
    return readTail(conn as unknown as EventLogSqlite, afterEventId, limit);
  } catch (err) {
    log.warn("event-log.read-tail-failed", { error: String(err) });
    return [];
  }
}

/** Close the connection. Called on Core shutdown. */
export function disposeEventLogStore(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    db = null;
  }
  tableEnsured = false;
}
