// Monotonic per-Core event log — pure SQL helpers shared by the server
// process (which records task/session/hook events) and the Core / PTY-manager
// process (which records PTY lifecycle events and serves the reconnect replay).
//
// Both processes open their own connection to the same SQLite file
// (missioncontrol.db, WAL mode). The `event_log` table is append-only, so the
// two writers never contend on a row — SQLite's WAL write lock serializes the
// commits and `busy_timeout = 5000` absorbs the brief contention. Readers see
// committed rows immediately (WAL readers never block writers).
//
// This file is self-contained (no `~/` imports) so it compiles under both the
// Vite (browser/server) and the Core's CommonJS tsconfigs. It operates on a
// minimal `EventLogSqlite` interface so tests can pass an in-memory
// better-sqlite3 handle without dragging in the full db/client bootstrap.

import type { CoreLinkEvent } from "@actana/sdk/core-link-frames";

// ─── SqliteLike interface ───────────────────────────────────────────────────

/**
 * Minimal slice of `better-sqlite3.Database` that the event-log helpers need.
 * Kept structural so both a real `Database` and a fake satisfy it.
 */
export interface EventLogSqlite {
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  exec(sql: string): void;
  pragma(input: string, opts?: { simple?: boolean }): unknown;
}

// ─── Schema ─────────────────────────────────────────────────────────────────

/**
 * Idempotently create the `event_log` table + supporting indexes. Safe to call
 * from both the server bootstrap (src/db/client.ts ensureSchema creates it too)
 * and the Core process, which opens its own connection. CREATE IF NOT EXISTS
 * makes the second call a no-op.
 */
export function ensureEventsTable(sqlite: EventLogSqlite): void {
  sqlite.exec(`
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
}

// ─── Write ──────────────────────────────────────────────────────────────────

export type AppendEventOptions = {
  /** The PTY this event belongs to, if any (PTY spawn/exit, pty:data). */
  ptyId?: string | null;
  /** The Task this event belongs to, if any (task status, session finish). */
  taskId?: string | null;
};

/**
 * Append a domain event to the log and return its sequential `eventId`.
 *
 * `payload` is the already-serialized JSON string of the event-specific body
 * (the caller owns the shape so this module stays shape-agnostic). The `kind`
 * is a stable string like `task:updated` / `pty:exit` / `session:finished` —
 * see {@link CoreLinkEvent} for how it's carried over the core-link.
 *
 * Returns the new monotonic `eventId` (starts at 1). Never returns 0.
 */
export function appendEvent(
  sqlite: EventLogSqlite,
  kind: string,
  payload: string,
  opts: AppendEventOptions = {},
): number {
  const result = sqlite.prepare(
    "INSERT INTO event_log (ts, kind, pty_id, task_id, payload) VALUES (?, ?, ?, ?, ?)",
  ).run(
    Date.now(),
    kind,
    opts.ptyId ?? null,
    opts.taskId ?? null,
    payload,
  );
  // lastInsertRowid is `number | bigint` depending on the id magnitude; coerce
  // to a plain number (safe until 2^53, far beyond any realistic event count).
  const rowid = result.lastInsertRowid;
  return typeof rowid === "bigint" ? Number(rowid) : rowid;
}

// ─── Read ───────────────────────────────────────────────────────────────────

/** The highest `eventId` in the log, or 0 when the log is empty. */
export function getLastEventId(sqlite: EventLogSqlite): number {
  const row = sqlite.prepare("SELECT MAX(event_id) AS id FROM event_log").get() as
    | { id: number | null }
    | undefined;
  return row?.id ?? 0;
}

type EventLogRow = {
  event_id: number;
  ts: number;
  kind: string;
  pty_id: string | null;
  task_id: string | null;
  payload: string;
};

/**
 * Read every event with `eventId > afterEventId`, in ascending `eventId` order.
 * This is the reconnect-replay tail: the Panel sends its `lastEventId`, the
 * Core reads the tail past it, streams each as a `CoreLinkEvent`, then
 * resumes live push. `limit` caps the batch so a very-stale cursor doesn't try
 * to materialize the entire log in one shot.
 */
export function readEventTail(
  sqlite: EventLogSqlite,
  afterEventId: number,
  limit = 1_000,
): CoreLinkEvent[] {
  const rows = sqlite.prepare(
    "SELECT event_id, ts, kind, pty_id, task_id, payload FROM event_log WHERE event_id > ? ORDER BY event_id ASC LIMIT ?",
  ).all(afterEventId, limit) as EventLogRow[];
  return rows.map((r) => ({
    eventId: r.event_id,
    ts: r.ts,
    kind: r.kind,
    ptyId: r.pty_id,
    taskId: r.task_id,
    payload: r.payload,
  }));
}

// Re-export the event envelope type so callers can import it from here or from
// the frames module — they're the same type.
export type { CoreLinkEvent };
