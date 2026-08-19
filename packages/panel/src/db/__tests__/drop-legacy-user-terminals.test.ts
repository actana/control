import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { dropLegacyUserTerminals, ensureSchema } from "@actana/shared/schema-bootstrap";

// Issue 266 removed the project-root terminal, and with it the last writer,
// reader and route for `user_terminals`. The decision recorded here is
// **dropped, not orphaned**: a terminal is ephemeral, so there is nothing in
// those rows to preserve, and a table nothing can read again is a question
// every future reader of this schema would have to answer for themselves.

function tableExists(db: Database.Database, table: string): boolean {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
}

/** A pre-cutover DB slice: the project-root terminal's table, rows and index. */
function legacyDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL);
    CREATE TABLE user_terminals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      cwd TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX user_terminals_project_idx ON user_terminals(project_id);
    INSERT INTO projects (id, path) VALUES ('p1', '/tmp/p1');
    INSERT INTO user_terminals (id, project_id, name, created_at, updated_at)
      VALUES ('ut1', 'p1', 'Terminal 1', 1, 1);
  `);
  return db;
}

describe("dropLegacyUserTerminals (issue 266)", () => {
  it("drops the table and its index from a DB that has them", () => {
    const db = legacyDb();
    dropLegacyUserTerminals(db);
    expect(tableExists(db, "user_terminals")).toBe(false);
    const index = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get("user_terminals_project_idx");
    expect(index).toBeUndefined();
  });

  it("is idempotent — a second boot is a no-op, not an error", () => {
    const db = legacyDb();
    dropLegacyUserTerminals(db);
    expect(() => dropLegacyUserTerminals(db)).not.toThrow();
    expect(tableExists(db, "user_terminals")).toBe(false);
  });

  it("is a no-op on a fresh DB, which never had the table", () => {
    const db = new Database(":memory:");
    expect(() => dropLegacyUserTerminals(db)).not.toThrow();
    expect(tableExists(db, "user_terminals")).toBe(false);
  });

  it("leaves home_terminals alone — the VM shell's rows live there", () => {
    const db = new Database(":memory:");
    ensureSchema(db);
    expect(tableExists(db, "home_terminals")).toBe(true);
    expect(tableExists(db, "user_terminals")).toBe(false);
  });

  it("runs on every boot, so a carried-over DB loses the table without a migration", () => {
    // A DB that booted under the previous build: current schema, plus the
    // table that build still created.
    const db = new Database(":memory:");
    ensureSchema(db);
    db.exec(`
      CREATE TABLE user_terminals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        cwd TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX user_terminals_project_idx ON user_terminals(project_id);
    `);

    // The real entry point. ensureSchema no longer CREATEs the table and calls
    // the drop at the end of its legacy sweep, so the next boot is the whole
    // migration.
    ensureSchema(db);
    expect(tableExists(db, "user_terminals")).toBe(false);
    expect(tableExists(db, "home_terminals")).toBe(true);
  });
});
