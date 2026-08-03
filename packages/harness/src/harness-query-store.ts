// Harness-side query store — a read-only handle to the shared SQLite's
// projects + tasks tables, owned by the Harness (PTY-manager) process.
//
// Backs the `HarnessQueryPort` consumed by `PtyCoreLinkServer` for the
// `projectsList` / `tasksList` core-link frames (issue 07). The Harness is the
// single source of truth for projects and tasks; the Panel holds none. This
// store reads the same `missioncontrol.db` the stateful server process writes
// (WAL mode lets a reader coexist with the writer without contention).
//
// Mirrors the connection pattern in event-log-store.ts: lazy open, degrade to
// empty results when the DB is missing (the server process may not have
// bootstrapped yet), `busy_timeout` absorbs brief write contention.

import Database from "better-sqlite3";
import log from "./log";
import * as path from "node:path";
import * as fs from "node:fs";
import { makeOpenFailedThrottle } from "./log-throttle";
import {
  queryProjects,
  queryTasks,
  type HarnessQuerySqlite,
} from "../../shared/src/harness-query";
import type {
  CoreLinkProjectSnapshot,
  CoreLinkTaskSnapshot,
} from "../../shared/src/core-link-frames";
import type { HarnessQueryPort } from "./pty-core-link-server";

export type { CoreLinkProjectSnapshot, CoreLinkTaskSnapshot, HarnessQueryPort };

let db: Database.Database | null = null;
let dbPath: string | null = null;
// Throttle the db-missing log so a permanently-absent DB (e.g. a harness-only
// VM where the server process never bootstrapped) doesn't fill the log on every
// query call. Mirrors project-roots.ts.
let lastDbMissingAt = 0;
const DB_MISSING_THROTTLE_MS = 60_000;
// See event-log-store.ts — the same poll-driven spam happens here whenever
// projectsList/tasksList repeatedly hit a broken binding.
const logOpenFailed = makeOpenFailedThrottle("harness-query.open-failed");

/**
 * Configure the query store to point at the shared SQLite file. Must be called
 * before any {@link getQueryStore} use. The connection is opened lazily on
 * first access so a misconfigured path doesn't crash boot — it logs and
 * degrades to empty results instead.
 */
export function configureHarnessQueryStore(userDataDir: string): void {
  // Reset so a reconfigure (e.g. macOS `activate` re-runs main) reopens fresh.
  disposeHarnessQueryStore();
  dbPath = path.join(userDataDir, "missioncontrol.db");
}

function ensureConnection(): Database.Database | null {
  if (!dbPath) {
    log.warn("harness-query.unconfigured");
    return null;
  }
  if (db) return db;
  if (!fs.existsSync(dbPath)) {
    // The server process owns DB creation; if it hasn't bootstrapped yet the
    // query port answers with empty results — the Fleet view shows no
    // projects/tasks for this Core rather than crashing.
    if (Date.now() - lastDbMissingAt > DB_MISSING_THROTTLE_MS) {
      log.info("harness-query.db-missing", { dbPath });
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
      log.info("harness-query.pragma-skipped", { error: String(pragmaErr) });
    }
    db = conn;
    return db;
  } catch (openErr) {
    logOpenFailed({ dbPath, error: String(openErr) });
    return null;
  }
}

/**
 * The read-only `HarnessQueryPort` backed by the shared SQLite. Returns empty
 * results when the DB is unavailable — the Fleet view shows a blank Core
 * rather than erroring. The Harness passes this to `PtyCoreLinkServer` so the
 * Panel's `projectsList` / `tasksList` frames resolve against live data with
 * no Panel-side persistence.
 */
export const harnessQueryStore: HarnessQueryPort = {
  listProjects(): CoreLinkProjectSnapshot[] {
    const conn = ensureConnection();
    if (!conn) return [];
    try {
      return queryProjects(conn as unknown as HarnessQuerySqlite);
    } catch (err) {
      log.warn("harness-query.list-projects-failed", { error: String(err) });
      return [];
    }
  },
  listTasks(projectId?: string): CoreLinkTaskSnapshot[] {
    const conn = ensureConnection();
    if (!conn) return [];
    try {
      return queryTasks(conn as unknown as HarnessQuerySqlite, projectId);
    } catch (err) {
      log.warn("harness-query.list-tasks-failed", { error: String(err) });
      return [];
    }
  },
};

/** Close the connection. Called on Harness shutdown. */
export function disposeHarnessQueryStore(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    db = null;
  }
}
