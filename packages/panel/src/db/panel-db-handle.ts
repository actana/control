import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type pg from "pg";
import { getPanelPool } from "./pg";

/**
 * The Panel's drizzle handle on its Postgres pool (#567, ADR 0041 D14).
 *
 * Built without the schema on purpose: only `server/repositories/` may import
 * `pg-schema.ts`, so that the ownership guard scans every query, and this file
 * is outside it. The type is the driver-agnostic `PgDatabase`, which is what
 * lets a test hand in a PGlite database for the same repositories.
 */
export type PanelDb = PgDatabase<PgQueryResultHKT>;

let installed: PanelDb | null = null;
let cached: { pool: unknown; db: PanelDb } | null = null;

/** The handle every repository queries through. Throws until the pool is connected. */
export function panelDb(): PanelDb {
  if (installed) return installed;
  const pool = getPanelPool();
  if (cached?.pool !== pool) cached = { pool, db: drizzle(pool as unknown as pg.Pool) };
  return cached.db;
}

/** Test seam: route every repository through `db` (a `createTestDb()` handle), or back with `null`. */
export function installPanelDb(db: PanelDb | null): void {
  installed = db;
}
