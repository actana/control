import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

// better-sqlite3 belongs to the Core (and its shared helpers); the Panel and the
// workspace root no longer depend on it (ADR 0041 D20). Resolve it the way the
// Core does, from packages/core, regardless of where the importing script lives.
const requireFromHere = createRequire(new URL("../../packages/core/package.json", import.meta.url));
const betterSqlitePackageJson = requireFromHere.resolve("better-sqlite3/package.json");

/** Root of the installed better-sqlite3 package. */
export const betterSqliteRoot = path.dirname(betterSqlitePackageJson);

/** Path to prebuild-install's CLI, resolved from better-sqlite3. */
export const prebuildInstallBin = createRequire(betterSqlitePackageJson).resolve(
  "prebuild-install/bin.js",
);

/** Smoke-test the Node-runtime better-sqlite3 binding by opening an in-memory db. */
export function canLoadNodeBetterSqlite() {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "const Database = require(process.argv[1]); const db = new Database(':memory:'); db.prepare('select 1').get(); db.close();",
      betterSqliteRoot,
    ],
    {
      cwd: betterSqliteRoot,
      encoding: "utf8",
      env: process.env,
    },
  );

  return result.status === 0;
}
