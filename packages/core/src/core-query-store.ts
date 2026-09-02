// Core-side query store — a read-only handle to the shared SQLite's
// projects + tasks tables, owned by the Core (PTY-manager) process.
//
// Backs the `CoreQueryPort` consumed by `PtyCoreLinkServer` for the
// `projectsList` / `tasksList` core-link frames (issue 07). The Core is the
// single source of truth for projects and tasks; the Panel holds none. This
// store reads the same `missioncontrol.db` the stateful server process writes
// (WAL mode lets a reader coexist with the writer without contention).
//
// Mirrors the connection pattern in event-log-store.ts: lazy open, degrade to
// empty results when the DB is missing (the server process may not have
// bootstrapped yet), `busy_timeout` absorbs brief write contention.

import Database from "better-sqlite3";
import log from "@actana/shared/log";
import * as path from "node:path";
import * as fs from "node:fs";
import { makeOpenFailedThrottle } from "./log-throttle";
import {
  countArchivedTasks,
  queryActiveTasks,
  queryArchivedTasks,
  queryStrandedReadyTasks,
  queryProjects,
  queryTask,
  queryTasks,
  type CoreQuerySqlite,
} from "@actana/shared/core-query";
import type {
  CoreLinkProjectSnapshot,
  CoreLinkTaskSnapshot,
} from "@actana/sdk/core-link-frames";
import type { CoreQueryPort } from "./pty-core-link-server";

export type { CoreLinkProjectSnapshot, CoreLinkTaskSnapshot, CoreQueryPort };

let db: Database.Database | null = null;
let dbPath: string | null = null;
// Throttle the db-missing log so a permanently-absent DB (e.g. a core-only
// VM where the server process never bootstrapped) doesn't fill the log on every
// query call. Mirrors project-roots.ts.
let lastDbMissingAt = 0;
const DB_MISSING_THROTTLE_MS = 60_000;
// See event-log-store.ts — the same poll-driven spam happens here whenever
// projectsList/tasksList repeatedly hit a broken binding.
const logOpenFailed = makeOpenFailedThrottle("core-query.open-failed");

/**
 * Configure the query store to point at the shared SQLite file. Must be called
 * before any {@link getQueryStore} use. The connection is opened lazily on
 * first access so a misconfigured path doesn't crash boot — it logs and
 * degrades to empty results instead.
 */
export function configureCoreQueryStore(userDataDir: string): void {
  // Reset so a reconfigure (e.g. macOS `activate` re-runs main) reopens fresh.
  disposeCoreQueryStore();
  dbPath = path.join(userDataDir, "missioncontrol.db");
}

function ensureConnection(): Database.Database | null {
  if (!dbPath) {
    log.warn("core-query.unconfigured");
    return null;
  }
  if (db) return db;
  if (!fs.existsSync(dbPath)) {
    // The server process owns DB creation; if it hasn't bootstrapped yet the
    // query port answers with empty results — the Fleet view shows no
    // projects/tasks for this Core rather than crashing.
    if (Date.now() - lastDbMissingAt > DB_MISSING_THROTTLE_MS) {
      log.info("core-query.db-missing", { dbPath });
      lastDbMissingAt = Date.now();
    }
    return null;
  }
  try {
    const conn = new Database(dbPath, {
      readonly: true,
    });
    try {
      // `readOnly: true` already prevents writes, but set the pragma too so a
      // connection opened without the flag (e.g. a future caller) stays safe.
      conn.pragma("busy_timeout = 5000");
    } catch (pragmaErr) {
      log.info("core-query.pragma-skipped", { error: String(pragmaErr) });
    }
    db = conn;
    return db;
  } catch (openErr) {
    logOpenFailed({ dbPath, error: String(openErr) });
    return null;
  }
}

/**
 * The read-only `CoreQueryPort` backed by the shared SQLite. Returns empty
 * results when the DB is unavailable — the Fleet view shows a blank Core
 * rather than erroring. The Core passes this to `PtyCoreLinkServer` so the
 * Panel's `projectsList` / `tasksList` frames resolve against live data with
 * no Panel-side persistence.
 */
export const coreQueryStore: CoreQueryPort = {
  listProjects(): CoreLinkProjectSnapshot[] {
    const conn = ensureConnection();
    if (!conn) return [];
    try {
      return queryProjects(conn as unknown as CoreQuerySqlite);
    } catch (err) {
      log.warn("core-query.list-projects-failed", { error: String(err) });
      return [];
    }
  },
  listTasks(projectId?: string): CoreLinkTaskSnapshot[] {
    const conn = ensureConnection();
    if (!conn) return [];
    try {
      return queryTasks(conn as unknown as CoreQuerySqlite, projectId);
    } catch (err) {
      log.warn("core-query.list-tasks-failed", { error: String(err) });
      return [];
    }
  },
  listArchivedTasks(projectId?: string): CoreLinkTaskSnapshot[] {
    const conn = ensureConnection();
    if (!conn) return [];
    try {
      return queryArchivedTasks(conn as unknown as CoreQuerySqlite, projectId);
    } catch (err) {
      log.warn("core-query.list-archived-tasks-failed", { error: String(err) });
      return [];
    }
  },
  countArchivedTasks(projectId?: string): number {
    const conn = ensureConnection();
    if (!conn) return 0;
    try {
      return countArchivedTasks(conn as unknown as CoreQuerySqlite, projectId);
    } catch (err) {
      log.warn("core-query.count-archived-tasks-failed", { error: String(err) });
      return 0;
    }
  },
  getTask(taskId: string): CoreLinkTaskSnapshot | null {
    const conn = ensureConnection();
    if (!conn) return null;
    try {
      return queryTask(conn as unknown as CoreQuerySqlite, taskId);
    } catch (err) {
      log.warn("core-query.get-task-failed", { error: String(err) });
      return null;
    }
  },
};

/**
 * Every task this Core's database still claims is working — `running` or
 * `needs-input` (issue 243).
 *
 * Deliberately NOT a method on {@link CoreQueryPort}: that port is the surface
 * the core-link server answers Panel frames from, and no frame asks this. The
 * one caller is the Core's own boot sweep, in this process, so the read is a
 * plain exported function against the same connection rather than a widening
 * of a wire contract.
 *
 * Degrades to `[]` on an unavailable DB, like every read here — a Core that
 * cannot read its rows sweeps nothing rather than crashing its own boot.
 */
export function listActiveTasks(): CoreLinkTaskSnapshot[] {
  const conn = ensureConnection();
  if (!conn) return [];
  try {
    return queryActiveTasks(conn as unknown as CoreQuerySqlite);
  } catch (err) {
    log.warn("core-query.list-active-tasks-failed", { error: String(err) });
    return [];
  }
}

/**
 * Every `ready` task this Core once spawned a PTY for (issue 387).
 *
 * The companion to {@link listActiveTasks}, kept as its own read for the same
 * reason the SQL is its own query: `ready` needs the event-log evidence that a
 * process ever existed, and a Core whose event log is unreadable must still
 * sweep the rows that need no such evidence. Degrades to `[]` on its own.
 */
export function listStrandedReadyTasks(): CoreLinkTaskSnapshot[] {
  const conn = ensureConnection();
  if (!conn) return [];
  try {
    return queryStrandedReadyTasks(conn as unknown as CoreQuerySqlite);
  } catch (err) {
    log.warn("core-query.list-stranded-ready-tasks-failed", { error: String(err) });
    return [];
  }
}

/**
 * Everything the boot sweep settles: the rows that claim a live process, plus
 * the `ready` rows a dead PTY left behind (issue 387).
 *
 * The union lives here, next to the two reads, rather than in the sweep — the
 * sweep's job is to settle what it is handed, and the backstop, which shares
 * {@link listActiveTasks}, must NOT see the `ready` rows: a bare Session
 * waiting on its first prompt is allowed to sit silent for as long as the
 * operator likes, and settling it for being quiet would be a bug.
 */
export function listBootSweepTasks(): CoreLinkTaskSnapshot[] {
  return [...listActiveTasks(), ...listStrandedReadyTasks()];
}

/** Close the connection. Called on Core shutdown. */
export function disposeCoreQueryStore(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    db = null;
  }
}
