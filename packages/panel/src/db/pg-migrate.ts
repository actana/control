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

/**
 * Apply every migration newer than the last one recorded, in one transaction
 * that first takes a transaction-scoped advisory lock. Two Panels starting at
 * once therefore queue on the lock: the second finds the first's rows and
 * applies nothing. The lock goes with the transaction, so a Panel that dies
 * mid-migration releases it by dropping its connection. Returns the tags it
 * applied; a rerun returns an empty list.
 */
export async function runMigrations(
  source: MigrateSource,
  migrations: Migration[],
): Promise<string[]> {
  const client = await source.connect();
  const applied: string[] = [];
  let current = "taking the migration lock";
  try {
    await client.query("BEGIN");
    await client.query("select pg_advisory_xact_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
    current = "creating the migrations table";
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${MIGRATIONS_SCHEMA}"`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" (` +
        "id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)",
    );
    const last = await client.query(
      `select created_at from "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" ` +
        "order by created_at desc limit 1",
    );
    const lastMillis = last.rows[0] ? Number(last.rows[0].created_at) : -Infinity;
    for (const migration of migrations) {
      if (migration.folderMillis <= lastMillis) continue;
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
    const reason = err instanceof Error ? err.message : String(err);
    throw new PanelMigrationError(`database migration failed while ${current}: ${reason}`);
  } finally {
    client.release();
  }
}
