import { createHash } from "node:crypto";

/**
 * The Panel's boot-time Postgres migrator (#567, ADR 0041 D17).
 *
 * It applies the SQL files drizzle-kit generates into `pg-migrations/`, and it
 * keeps drizzle's own bookkeeping — a `drizzle.__drizzle_migrations` table of
 * `(id, hash, created_at)`, a file's hash being the SHA-256 of its text and its
 * `created_at` the journal's `when` — so `drizzle-kit` and `drizzle-orm`'s own
 * migrator read the same database correctly. It does its own reading instead of
 * calling drizzle's because that one reads a folder from disk, and the Panel
 * ships as a bundle with the SQL compiled in (`pg-migrations-bundle.ts`).
 *
 * Kept free of `~/` imports, like `pg.ts`.
 */

/** Separates statements in a drizzle-kit SQL file. */
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

/**
 * The advisory lock every Panel takes while it migrates. An arbitrary constant
 * of this module's own; nothing else in the Panel takes advisory locks.
 */
export const MIGRATION_LOCK_KEY = "567000042";

const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";

export interface Migration {
  /** The file's name without `.sql`, e.g. `0000_baseline`. */
  tag: string;
  /** The journal's `when`: what orders migrations and what is stored as `created_at`. */
  folderMillis: number;
  hash: string;
  statements: string[];
}

export interface MigrationJournal {
  entries: { tag: string; when: number; breakpoints?: boolean }[];
}

/** The slice of a `pg` pooled client the migrator uses. */
export interface MigrateClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(err?: Error | boolean): void;
}

export interface MigrateSource {
  connect(): Promise<MigrateClient>;
}

/** Thrown when a migration fails; the message names the step and the cause. */
export class PanelMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanelMigrationError";
  }
}

/** Turn drizzle-kit's journal and SQL files into ordered {@link Migration}s. */
export function parseMigrations(
  journal: MigrationJournal,
  sqlByTag: Record<string, string>,
): Migration[] {
  return journal.entries
    .map((entry) => {
      const sql = sqlByTag[entry.tag];
      if (sql === undefined) {
        throw new PanelMigrationError(
          `the migration journal lists ${entry.tag} but ${entry.tag}.sql is missing`,
        );
      }
      return {
        tag: entry.tag,
        folderMillis: entry.when,
        hash: createHash("sha256").update(sql).digest("hex"),
        statements: sql
          .split(STATEMENT_BREAKPOINT)
          .map((statement) => statement.trim())
          .filter((statement) => statement.length > 0),
      };
    })
    .sort((a, b) => a.folderMillis - b.folderMillis);
}

/** True when `sql` is nothing but `--` comments and blank lines. */
function isCommentOnly(sql: string): boolean {
  return sql.split("\n").every((line) => line.trim() === "" || line.trim().startsWith("--"));
}

export interface AppliedMigration {
  hash: string;
  createdAt: number;
}

const short = (hash: string) => hash.slice(0, 12);

/**
 * Decide what is left to apply, or refuse. The Panel will not start when the
 * database and the migrations it ships disagree, because it would then run
 * against a schema it does not know:
 *  - a recorded migration this Panel does not ship (a newer Panel's, or a
 *    downgrade);
 *  - a shipped migration whose recorded hash differs (edited after it ran);
 *  - an unapplied migration that sorts before one already applied (generated
 *    earlier, merged later), which a max-timestamp rule would skip forever.
 * Migrations are matched by hash, never by the newest timestamp alone.
 */
export function selectPending(recorded: AppliedMigration[], migrations: Migration[]): Migration[] {
  const shippedHashes = new Set(migrations.map((m) => m.hash));
  for (const row of recorded) {
    if (shippedHashes.has(row.hash)) continue;
    const edited = migrations.find((m) => m.folderMillis === row.createdAt);
    if (edited) {
      throw new PanelMigrationError(
        `the applied migration ${edited.tag} differs from the file this Panel ships ` +
          `(database hash ${short(row.hash)}, Panel hash ${short(edited.hash)}); a migration must not be edited after it ran`,
      );
    }
    throw new PanelMigrationError(
      `the database holds a migration this Panel does not know (hash ${short(row.hash)}, created_at ${row.createdAt}); ` +
        "it was applied by a newer Panel, so run the newer Panel or restore a database that matches this one",
    );
  }
  const appliedHashes = new Set(recorded.map((row) => row.hash));
  const newestApplied = recorded.reduce((max, row) => Math.max(max, row.createdAt), -Infinity);
  const pending = migrations.filter((m) => !appliedHashes.has(m.hash));
  for (const migration of pending) {
    if (migration.folderMillis < newestApplied) {
      throw new PanelMigrationError(
        `the migration ${migration.tag} has not been applied but sorts before one that has; ` +
          "regenerate it so it sorts after the newest applied migration",
      );
    }
  }
  return pending;
}

/**
 * Apply every migration not yet recorded ({@link selectPending}), in one transaction
 * that first takes a transaction-scoped advisory lock. Two Panels starting at
 * once therefore queue on the lock: the second finds the first's rows and
 * applies nothing. The lock goes with the transaction, so a Panel that dies
 * mid-migration releases it by dropping its connection. A `lock_timeout` and a
 * log line before the wait mean a Panel stuck behind a holder fails loudly
 * rather than hanging silently (ADR 0041 D22(c)). Returns the tags it applied;
 * a rerun returns an empty list.
 */
export async function runMigrations(
  source: MigrateSource,
  migrations: Migration[],
): Promise<string[]> {
  const client = await source.connect();
  const applied: string[] = [];
  let current = "taking the migration lock";
  let failure: Error | undefined;
  try {
    await client.query("BEGIN");
    // Bound how long a second Panel waits on the advisory lock. Without this a
    // holder that never commits leaves every new Panel hung at boot.
    await client.query("SET LOCAL lock_timeout = '30s'");
    console.log("[panel] waiting for the migration lock");
    await client.query("select pg_advisory_xact_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
    current = "creating the migrations table";
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${MIGRATIONS_SCHEMA}"`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" (` +
        "id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)",
    );
    current = "checking the applied migrations";
    const recorded = await client.query(
      `select hash, created_at from "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" order by created_at`,
    );
    const pending = selectPending(
      recorded.rows.map((row) => ({ hash: String(row.hash), createdAt: Number(row.created_at) })),
      migrations,
    );
    for (const migration of pending) {
      current = `applying ${migration.tag}`;
      for (const statement of migration.statements) {
        if (isCommentOnly(statement)) continue;
        await client.query(statement);
      }
      await client.query(
        `insert into "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" (hash, created_at) values ($1, $2)`,
        [migration.hash, migration.folderMillis],
      );
      applied.push(migration.tag);
    }
    current = "committing";
    await client.query("COMMIT");
    return applied;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    failure = err instanceof Error ? err : new Error(String(err));
    throw new PanelMigrationError(`database migration failed while ${current}: ${failure.message}`);
  } finally {
    // Handing the error back makes the pool destroy the connection, not reuse it.
    client.release(failure);
  }
}
