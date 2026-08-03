// Project-roots reader — validates pty:spawn cwd against registered projects.
//
// Uses node:sqlite (not better-sqlite3) because this module runs in-process in
// the Panel service as well as in the Harness daemon; the
// built-in driver needs no per-ABI native binding in either host.
import { DatabaseSync } from "node:sqlite";
import log from "./log";
import * as path from "node:path";
import * as fs from "node:fs";
import { makeOpenFailedThrottle } from "./log-throttle";

let db: DatabaseSync | null = null;
let dbPath: string | null = null;
// Throttle repeated read failures so a permanently-broken DB doesn't fill the log
// at the rate of every spawn. Logs the first failure verbatim and one summary
// line every 60s after that.
let lastReadErrorAt = 0;
const READ_ERROR_THROTTLE_MS = 60_000;
// A persistently-broken binding otherwise re-throws on every pty:spawn — one
// line per spawn buries the actual error.
const logOpenFailed = makeOpenFailedThrottle("project-roots.open-failed");

export function configureProjectRootsDb(userDataDir: string): void {
  dbPath = path.join(userDataDir, "missioncontrol.db");
}

function ensureConnection(): DatabaseSync | null {
  if (!dbPath) {
    // pty:spawn arrived before main.ts called configureProjectRootsDb — every
    // spawn will be rejected as cwd-outside-project-roots until that fires.
    // Log once so the silent-cause bug class isn't reintroduced.
    if (lastReadErrorAt === 0) {
      log.warn("project-roots.unconfigured");
      lastReadErrorAt = Date.now();
    }
    return null;
  }
  if (db) return db;
  if (!fs.existsSync(dbPath)) {
    if (Date.now() - lastReadErrorAt > READ_ERROR_THROTTLE_MS) {
      log.warn("project-roots.db-missing", { dbPath });
      lastReadErrorAt = Date.now();
    }
    return null;
  }
  try {
    // Read-only handle; the server process owns writes. WAL mode allows concurrent readers.
    const conn = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // Let a reader wait (up to 5s) for a concurrent checkpoint instead of
      // throwing SQLITE_BUSY immediately.
      conn.exec("PRAGMA busy_timeout = 5000");
    } catch (pragmaErr) {
      // Read-only handles can reject pragmas on a fresh DB the server hasn't
      // initialized yet; that's expected. Anything else is worth a log line
      // because it can mask schema/permission issues.
      log.info("project-roots.pragma-skipped", { error: String(pragmaErr) });
    }
    db = conn;
    return db;
  } catch (openErr) {
    logOpenFailed({ dbPath, error: String(openErr) });
    return null;
  }
}

export function loadProjectRoots(): string[] {
  const conn = ensureConnection();
  if (!conn) return [];
  try {
    const rows = conn.prepare("SELECT path FROM projects").all() as Array<{ path: string }>;
    return rows.map((r) => r.path).filter((p): p is string => typeof p === "string" && p.length > 0);
  } catch (queryErr) {
    // Without this log, every subsequent pty:spawn fails with
    // cwd-outside-project-roots and there is no trace of *why* the root list is
    // empty — the original silent-failure class fix-bug Step 3 calls out.
    if (Date.now() - lastReadErrorAt > READ_ERROR_THROTTLE_MS) {
      log.error("project-roots.query-failed", { error: String(queryErr) });
      lastReadErrorAt = Date.now();
    }
    return [];
  }
}

export function disposeProjectRootsDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    db = null;
  }
}
