import { randomBytes } from "node:crypto";
import pg from "pg";
import { bundledPanelMigrations } from "./pg-migrations-bundle";
import { runMigrations, type MigrateClient, type MigrateSource, type Migration } from "./pg-migrate";

/**
 * A database for one test (#567, ADR 0041 D19): the Panel's Postgres migrations
 * applied to a database nothing else touches.
 *
 * By default that is PGlite, Postgres compiled to WebAssembly and run in this
 * process, so `pnpm test` needs no server and no Docker. Set
 * `AC_TEST_DATABASE_URL` to a real server's URL and each call instead creates
 * a fresh database on that server and drops it again on `close()`, which is how
 * the real-Postgres CI job runs the same tests.
 */

/** The environment variable that switches {@link createTestDb} to a real server. */
export const TEST_DATABASE_URL_ENV = "AC_TEST_DATABASE_URL";

interface TestPool extends MigrateSource {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export interface TestDb {
  pool: TestPool;
  kind: "pglite" | "postgres";
  /** Close the pool and, on a real server, drop the database. Safe to call twice. */
  close(): Promise<void>;
}

export interface CreateTestDbOptions {
  /** Migrations to apply instead of the Panel's own, for a test that needs a schema. */
  migrations?: Migration[];
  env?: NodeJS.ProcessEnv;
}

/**
 * PGlite is one connection, so a "client" holds it exclusively until released:
 * a pool of one. Two callers that both want a client queue, which keeps one
 * caller's `BEGIN … COMMIT` from being interleaved with another's statements.
 */
function pglitePool(db: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; close(): Promise<void> }): TestPool {
  let tail: Promise<void> = Promise.resolve();
  const run = async (text: string, params?: unknown[]) => {
    const result = await db.query(text, params);
    return { rows: result.rows as Record<string, unknown>[] };
  };
  return {
    query: (text, params) => {
      const next = tail.then(() => run(text, params));
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    async connect(): Promise<MigrateClient> {
      const turn = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => (release = resolve));
      await turn;
      let released = false;
      return {
        query: (text, params) => run(text, params),
        release: () => {
          if (released) return;
          released = true;
          release();
        },
      };
    },
    end: () => db.close(),
  };
}

function urlForDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

async function createRealDb(baseUrl: string): Promise<{ pool: pg.Pool; close(): Promise<void> }> {
  const name = `actana_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: baseUrl, max: 1, connectionTimeoutMillis: 5_000 });
  admin.on("error", () => {});
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } catch (err) {
    await admin.end().catch(() => {});
    const url = new URL(baseUrl);
    const reason = err instanceof Error ? err.message || (err as { code?: string }).code : String(err);
    throw new Error(
      `${TEST_DATABASE_URL_ENV} is set but the server at ${url.hostname}:${url.port || "5432"} ` +
        `could not create a test database: ${reason}`,
    );
  }
  const pool = new pg.Pool({ connectionString: urlForDatabase(baseUrl, name), max: 4 });
  pool.on("error", () => {});
  let closed = false;
  return {
    pool,
    async close() {
      if (closed) return;
      closed = true;
      await pool.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
      await admin.end().catch(() => {});
    },
  };
}

/** Make an isolated, migrated database for one test. Call `close()` in `afterEach`. */
export async function createTestDb(options: CreateTestDbOptions = {}): Promise<TestDb> {
  const env = options.env ?? process.env;
  const migrations = options.migrations ?? bundledPanelMigrations();
  const realUrl = env[TEST_DATABASE_URL_ENV]?.trim();

  if (realUrl) {
    const real = await createRealDb(realUrl);
    try {
      await runMigrations(real.pool, migrations);
    } catch (err) {
      await real.close();
      throw err;
    }
    return { pool: real.pool, kind: "postgres", close: real.close };
  }

  // Loaded here so a run against a real server never pays for the WebAssembly.
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  const pool = pglitePool(db);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await db.close().catch(() => {});
  };
  try {
    await db.waitReady;
    await runMigrations(pool, migrations);
  } catch (err) {
    await close();
    throw err;
  }
  return { pool, kind: "pglite", close };
}
