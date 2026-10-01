import journal from "./pg-migrations/meta/_journal.json";
import { parseMigrations, type Migration } from "./pg-migrate";

const sqlFiles = import.meta.glob("./pg-migrations/*.sql", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

/**
 * The Panel's Postgres migrations, compiled into the bundle by Vite, so a
 * running Panel needs no migrations folder beside it.
 */
export function bundledPanelMigrations(): Migration[] {
  const sqlByTag: Record<string, string> = {};
  for (const [file, sql] of Object.entries(sqlFiles)) {
    sqlByTag[file.replace(/^.*\//, "").replace(/\.sql$/, "")] = sql;
  }
  return parseMigrations(journal, sqlByTag);
}
