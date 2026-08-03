import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { dropLegacyWorktreeSchema, ensureSchema } from "@actana/shared/schema-bootstrap";

function columns(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]
  ).map((c) => c.name);
}

function tableExists(db: Database.Database, table: string): boolean {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
}

/** A pre-cutover DB slice: the worktree-era shape of projects/tasks/user_terminals. */
function legacyDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT 'main',
      worktree_setup_command TEXT
    );
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      branch TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX worktrees_project_idx ON worktrees(project_id);
    CREATE UNIQUE INDEX worktrees_project_name_unique ON worktrees(project_id, name);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      worktree_id TEXT REFERENCES worktrees(id) ON DELETE CASCADE,
      title TEXT NOT NULL
    );
    CREATE INDEX tasks_project_worktree_idx ON tasks(project_id, worktree_id);
    CREATE INDEX tasks_worktree_idx ON tasks(worktree_id);
    CREATE TABLE user_terminals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      worktree_id TEXT REFERENCES worktrees(id) ON DELETE CASCADE,
      name TEXT NOT NULL
    );
    CREATE INDEX user_terminals_project_worktree_idx ON user_terminals(project_id, worktree_id);
    CREATE INDEX user_terminals_worktree_idx ON user_terminals(worktree_id);
  `);
  return db;
}

describe("dropLegacyWorktreeSchema", () => {
  it("drops the worktrees table, worktree columns, indexes, and settings rows", () => {
    const db = legacyDb();
    db.exec(`
      INSERT INTO projects (id, path, branch, worktree_setup_command)
        VALUES ('p1', '/tmp/p1', 'feature/x', 'pnpm i');
      INSERT INTO worktrees (id, project_id, name, path, branch, created_at, updated_at)
        VALUES ('wt1', 'p1', 'lunar', '/tmp/p1/.wt/lunar', 'feature/x', 0, 0);
      INSERT INTO tasks (id, project_id, worktree_id, title) VALUES ('t1', 'p1', 'wt1', 'A');
      INSERT INTO tasks (id, project_id, worktree_id, title) VALUES ('t2', 'p1', NULL, 'B');
      INSERT INTO user_terminals (id, project_id, worktree_id, name) VALUES ('ut1', 'p1', 'wt1', 'Terminal 1');
      INSERT INTO app_settings (key, value) VALUES
        ('selected_worktree_by_project', '{"p1":"wt1"}'),
        ('git_diff_changed_files_view', 'tree'),
        ('git_diff_changed_files_width', '420'),
        ('worktrees_enabled', 'true'),
        ('default_agent', 'claude-code');
    `);

    dropLegacyWorktreeSchema(db);

    expect(tableExists(db, "worktrees")).toBe(false);
    expect(columns(db, "tasks")).not.toContain("worktree_id");
    expect(columns(db, "user_terminals")).not.toContain("worktree_id");
    expect(columns(db, "projects")).not.toContain("branch");
    expect(columns(db, "projects")).not.toContain("worktree_setup_command");

    // Worktree-bound rows collapse to the project's single implicit path —
    // they are kept, not deleted.
    const taskIds = (db.prepare("SELECT id FROM tasks ORDER BY id").all() as { id: string }[]).map(
      (r) => r.id,
    );
    expect(taskIds).toEqual(["t1", "t2"]);
    expect(db.prepare("SELECT COUNT(*) AS c FROM user_terminals").get()).toMatchObject({ c: 1 });

    const settingKeys = (
      db.prepare("SELECT key FROM app_settings ORDER BY key").all() as { key: string }[]
    ).map((r) => r.key);
    expect(settingKeys).toEqual(["default_agent"]);
  });

  it("is idempotent and a no-op on the post-cutover shape", () => {
    const db = legacyDb();
    dropLegacyWorktreeSchema(db);
    expect(() => dropLegacyWorktreeSchema(db)).not.toThrow();

    const fresh = new Database(":memory:");
    ensureSchema(fresh);
    expect(tableExists(fresh, "worktrees")).toBe(false);
    expect(columns(fresh, "tasks")).not.toContain("worktree_id");
    expect(columns(fresh, "user_terminals")).not.toContain("worktree_id");
    expect(columns(fresh, "projects")).not.toContain("branch");
    expect(columns(fresh, "projects")).not.toContain("worktree_setup_command");
    expect(() => dropLegacyWorktreeSchema(fresh)).not.toThrow();
  });
});
