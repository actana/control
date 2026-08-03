import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as path from "node:path";
import * as fs from "node:fs";
import * as schema from "./schema";
import { resolvePanelDataDir } from "~/server/panel-data-dir";
import {
  ensureSchema,
  reconcileStaleSessionsOnBoot,
  restrictDbFilePermissions,
  tableExists,
} from "@actana/shared/schema-bootstrap";

export {
  backfillTokenUsageRollup,
  ensureColumn,
  repairProjectIndexes,
  reconcileStaleSessionsOnBoot,
  restrictDbFilePermissions,
} from "@actana/shared/schema-bootstrap";

const migrationFiles = import.meta.glob("./migrations/*.sql", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _sqlite: Database.Database | null = null;

/**
 * Where the legacy app database lives. `AC_USER_DATA_DIR` is what the
 * shell sets; everything else follows the Panel's data directory, so a
 * standalone Panel keeps all of its state under the one configured path.
 */
export function resolveUserDataDir(): string {
  if (process.env.AC_USER_DATA_DIR) return process.env.AC_USER_DATA_DIR;
  return resolvePanelDataDir();
}

export function resolveSkillsDir(): string {
  return path.join(resolveUserDataDir(), "skills");
}

export function getDb() {
  if (_db) return _db;
  const dir = resolveUserDataDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dbPath = path.join(dir, "missioncontrol.db");
  // Plain-Node process (server-runner child) — better-sqlite3 loads its
  // default standard-ABI binding.
  _sqlite = new Database(dbPath);
  const journalMode = _sqlite.pragma("journal_mode = WAL", { simple: true });
  // WAL + NORMAL is the durable-enough, low-fsync combo SQLite recommends for
  // app databases: writers only fsync on checkpoint, not per commit, which cuts
  // disk churn on our frequent small writes. But NORMAL is only crash-safe in
  // WAL mode — if the WAL pragma failed and SQLite fell back to a rollback
  // journal (e.g. a filesystem that can't support WAL), NORMAL leaves a small
  // power-loss corruption window. So only lower synchronous when WAL actually
  // took; otherwise keep the default (FULL).
  if (journalMode === "wal") {
    _sqlite.pragma("synchronous = NORMAL");
  }
  // busy_timeout lets a blocked writer wait (up to 5s) for a concurrent
  // checkpoint/writer instead of throwing SQLITE_BUSY immediately.
  _sqlite.pragma("busy_timeout = 5000");
  restrictDbFilePermissions(dbPath);
  _sqlite.pragma("foreign_keys = ON");
  _db = drizzle(_sqlite, { schema });
  const freshBootstrap = !tableExists(_sqlite, "projects");
  if (freshBootstrap) {
    ensureSchema(_sqlite);
    runMigrations(_sqlite, { markAllAppliedOnly: true });
  } else {
    runMigrations(_sqlite);
    ensureSchema(_sqlite);
  }
  reconcileStaleSessionsOnBoot(_sqlite);
  return _db;
}

/**
 * Apply versioned SQL migrations from ./migrations, tracking what's been
 * applied in the `schema_migrations` table. ensureSchema handles the initial
 * table layout; this runner is for incremental data/schema changes after that.
 */
function runMigrations(
  sqlite: Database.Database,
  opts: { markAllAppliedOnly?: boolean } = {}
) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set(
    sqlite
      .prepare("SELECT name FROM schema_migrations")
      .all()
      .map((r: any) => r.name as string)
  );
  const names = Object.keys(migrationFiles)
    .map((p) => p.split("/").pop()!)
    .sort();
  if (opts.markAllAppliedOnly) {
    const now = Date.now();
    for (const name of names) {
      if (applied.has(name)) continue;
      sqlite
        .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
        .run(name, now);
    }
    return;
  }
  for (const name of names) {
    if (applied.has(name)) continue;
    const sql = migrationFiles[`./migrations/${name}`];
    const tx = sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite
        .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
        .run(name, Date.now());
    });
    tx();
  }
}

export function getSqlite() {
  if (!_sqlite) getDb();
  return _sqlite!;
}

export { schema };
