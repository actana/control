import pg from "pg";
import type { MigrateSource } from "./pg-migrate";

/**
 * The Panel's Postgres connection (#567, ADR 0041 D16 and D19).
 *
 * This only builds a pool and proves it can reach the server. Nothing in the
 * Panel reads or writes through it yet — the tables still live in SQLite until
 * the later pull requests of #567 move them. What this module guarantees is the
 * boot rule those pull requests depend on: a Panel with no database, or one it
 * cannot reach, refuses to start and says why, instead of serving a login page
 * that fails on the first query.
 *
 * Kept free of `~/` imports on purpose: `bin/panel.mjs` reaches it through the
 * built bundle, and the startup test loads this file directly under Node.
 */

/** The one setting: a `postgres://` connection URL, password included. */
export const DATABASE_URL_ENV = "AC_PANEL_DATABASE_URL";

const POOL_MAX = 10;
const CONNECT_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 30_000;

/** A boot-time database problem whose message is fit to print as it stands. */
export class PanelDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanelDatabaseError";
  }
}

export interface PanelPgConfig {
  connectionString: string;
  /** `host:port/database`, for messages. Never carries the user or password. */
  target: string;
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
}

/** The slice of `pg.Pool` this module uses, so a test can hand in a stand-in. */
export interface PanelPoolLike extends MigrateSource {
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: "error", listener: (err: Error) => void): unknown;
}

const EXAMPLE = "postgres://panel:<password>@postgres:5432/panel";

/**
 * Read the connection settings from the environment, or throw a
 * {@link PanelDatabaseError}. The URL itself is never echoed into an error: it
 * carries the password.
 */
export function readPanelPgConfig(env: NodeJS.ProcessEnv = process.env): PanelPgConfig {
  const raw = env[DATABASE_URL_ENV]?.trim();
  if (!raw) {
    throw new PanelDatabaseError(
      `${DATABASE_URL_ENV} is not set. The Panel keeps its state in Postgres and will not start ` +
        `without it. Set it to a connection URL such as ${EXAMPLE} (see DEPLOY.md).`,
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PanelDatabaseError(
      `${DATABASE_URL_ENV} is not a valid URL. Expected a connection URL such as ${EXAMPLE}.`,
    );
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new PanelDatabaseError(
      `${DATABASE_URL_ENV} must start with postgres:// or postgresql:// ` +
        `(it starts with ${url.protocol}//). Expected a connection URL such as ${EXAMPLE}.`,
    );
  }
  if (!url.hostname) {
    throw new PanelDatabaseError(
      `${DATABASE_URL_ENV} names no host (a unix-socket URL is not supported). ` +
        `Expected a connection URL such as ${EXAMPLE}.`,
    );
  }
  let database: string;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    throw new PanelDatabaseError(
      `${DATABASE_URL_ENV} has a malformed % escape in the database name. ` +
        `Expected a connection URL such as ${EXAMPLE}.`,
    );
  }
  return {
    connectionString: raw,
    target: `${url.hostname}:${url.port || "5432"}${database ? `/${database}` : ""}`,
    max: POOL_MAX,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
  };
}

/** Build the pool. It connects lazily: nothing is dialled until the first query. */
export function createPanelPool(config: PanelPgConfig): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    idleTimeoutMillis: config.idleTimeoutMillis,
  });
  // An idle client that Postgres drops emits `error` on the pool; with no
  // listener that is an uncaught exception that would take the Panel down.
  pool.on("error", (err) => {
    console.error(`[panel] postgres: idle connection error: ${err.message}`);
  });
  return pool;
}

let pool: PanelPoolLike | null = null;

/**
 * Build the pool and check it with `select 1`. Throws a
 * {@link PanelDatabaseError} — and leaves no pool open — when the URL is
 * missing or malformed or the server cannot be reached.
 */
export async function connectPanelDatabase(
  env: NodeJS.ProcessEnv = process.env,
  createPool: (config: PanelPgConfig) => PanelPoolLike = createPanelPool,
): Promise<PanelPoolLike> {
  if (pool) return pool;
  const config = readPanelPgConfig(env);
  const candidate = createPool(config);
  try {
    await candidate.query("select 1");
  } catch (err) {
    await candidate.end().catch(() => {});
    // An unreachable host can come back as an AggregateError with no message
    // of its own (one attempt per address), so fall back to the error code.
    const reason =
      (err instanceof Error && (err.message || (err as { code?: string }).code)) || String(err);
    throw new PanelDatabaseError(
      `cannot reach Postgres at ${config.target} (from ${DATABASE_URL_ENV}): ${reason}. ` +
        `The Panel will not start without its database.`,
    );
  }
  pool = candidate;
  return pool;
}

/** The pool `connectPanelDatabase` opened. Nothing calls this yet. */
export function getPanelPool(): PanelPoolLike {
  if (!pool) throw new PanelDatabaseError("the Panel's database pool is not connected yet");
  return pool;
}

/** Close the pool, e.g. on shutdown. Safe to call when it was never opened. */
export async function closePanelDatabase(): Promise<void> {
  const open = pool;
  pool = null;
  await open?.end();
}
