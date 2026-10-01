// Core-side DB bootstrap — issue 02 of the remote-core-write-path spec.
//
// On a core-only VM (ADR 0003 install) no sibling stateful server process
// runs, so the Core itself owns bringing up `missioncontrol.db` before the
// core-link server accepts any frames. Otherwise every `event-log` and
// `core-query` connection lands on a non-existent file (or an empty one the
// reporter shell-created), the stores degrade to empty, and `sessionRowsList`
// returns `[]` against no real schema — not because there are no rows, but
// because there is no table.
//
// This module opens the DB read-write (creating parent dir + file if missing),
// enables WAL + busy_timeout so the two-writer pattern in event-log-store.ts
// stays valid, chmods to 0600, and applies the same idempotent schema
// bootstrap in `@actana/shared/core-schema`, after refusing a database from
// before 0.5.0 (there is no migration). The connection is closed immediately
// after — downstream stores (event-log-store, core-query-store) open their own
// connections against the same file.
//
// Called only in remote mode (AC_CORE_REMOTE=1). In loopback mode the
// sibling server-runner owns bootstrap and this must be skipped: SQLite's WAL
// tolerates two writers, but there is no point running the DDL twice.

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import log from "@actana/shared/log";
import {
  ensureCoreSchema,
  refusePre050Database,
  restrictDbFilePermissions,
  tableExists,
} from "@actana/shared/core-schema";

export type CoreDbBootstrapResult = {
  dbPath: string;
  createdFile: boolean;
  freshSchema: boolean;
};

/**
 * Ensure `missioncontrol.db` exists at `<userDataDir>/missioncontrol.db` with
 * the full schema applied. Idempotent — a second call against an already-bootstrapped
 * DB is a no-op (every `CREATE TABLE` / `CREATE INDEX` uses `IF NOT EXISTS`).
 *
 * Throws on any failure — the Core must exit non-zero rather than degrade
 * into an `open-failed` spam loop that returns `[]` forever.
 */
export function bootstrapCoreDb(userDataDir: string): CoreDbBootstrapResult {
  if (!userDataDir) {
    throw new Error("bootstrapCoreDb: userDataDir is required");
  }
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  const dbPath = path.join(userDataDir, "missioncontrol.db");
  const createdFile = !fs.existsSync(dbPath);

  const db = new Database(dbPath);
  try {
    const journalMode = db.pragma("journal_mode = WAL", { simple: true });
    if (journalMode === "wal") {
      db.pragma("synchronous = NORMAL");
    }
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");

    // A database an earlier Core left behind is refused, not adopted: 0.5.0
    // Cores are installed fresh and nothing migrates (ADR 0041, #555).
    refusePre050Database(db);
    // A file the operator manually `touch`-ed shows up as size-0 with no
    // `sessions` table. Track that so callers/logs can distinguish "first boot
    // of a fresh VM" from "second boot against an already-bootstrapped DB", but
    // treat both the same way — `ensureCoreSchema` handles both.
    const freshSchema = !tableExists(db, "sessions");
    ensureCoreSchema(db);
    restrictDbFilePermissions(dbPath);

    log.info("core-db.bootstrap-ok", { dbPath, createdFile, freshSchema });
    return { dbPath, createdFile, freshSchema };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore — already closed or never opened */
    }
  }
}
