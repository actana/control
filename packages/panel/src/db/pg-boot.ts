import { PanelDatabaseError, closePanelDatabase, connectPanelDatabase } from "./pg";
import type { PanelPgConfig, PanelPoolLike } from "./pg";
import { PanelMigrationError, runMigrations, type Migration } from "./pg-migrate";
import { bundledPanelMigrations } from "./pg-migrations-bundle";

/**
 * Open the Panel's pool, check it, then run the pending migrations under an
 * advisory lock (#567, ADR 0041 D17). `bin/panel.mjs` calls this before it
 * listens, so a Panel whose database is unreachable or whose migration fails
 * exits with the reason instead of serving against a schema it does not have.
 * The pool is closed again when the migration fails.
 */
export async function bootPanelDatabase(
  env: NodeJS.ProcessEnv = process.env,
  createPool?: (config: PanelPgConfig) => PanelPoolLike,
  migrations: Migration[] = bundledPanelMigrations(),
): Promise<PanelPoolLike> {
  const pool = await connectPanelDatabase(env, createPool);
  try {
    const applied = await runMigrations(pool, migrations);
    if (applied.length > 0) {
      console.log(`[panel] database migrations applied: ${applied.join(", ")}`);
    }
  } catch (err) {
    await closePanelDatabase().catch(() => {});
    if (err instanceof PanelMigrationError) {
      throw new PanelDatabaseError(`${err.message}. The Panel will not start.`);
    }
    throw err;
  }
  return pool;
}
