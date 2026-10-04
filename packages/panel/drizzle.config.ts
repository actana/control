import { defineConfig } from "drizzle-kit";

// The Panel's Postgres migrations (#567, ADR 0041 D17). They start from a clean
// baseline in `pg-migrations/`. The legacy SQLite files are gone with PR 5 of
// #567 (missioncontrol.db moved here); drizzle-kit only touches this folder.
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
