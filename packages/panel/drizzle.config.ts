import { defineConfig } from "drizzle-kit";

// The Panel's Postgres migrations (#567, ADR 0041 D17). They start from a clean
// baseline in `pg-migrations/`; the 25 SQLite files in `migrations/` are the
// legacy set that `client.ts` still applies until the later pull requests
// remove SQLite, and drizzle-kit never touches that folder.
export default defineConfig({
  schema: "./src/db/pg-schema.ts",
  out: "./src/db/pg-migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.AC_PANEL_DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
