import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { dropLegacyProjects, ensureSchema } from "../schema-bootstrap";

// Issue 560 removed Projects from the Panel (ADR 0041 D1). The Panel's SQLite
// still held the whole family — projects, project_presentation, groups — and
// four tables that named a project: sessions, token_usage, token_usage_rollup
// and token_usage_session_offsets. These tests pin that the family goes, that the
// four tables lose the column and keep every row, and that the sweep is safe to
// run on every boot.

function tables(db: Database.Database): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as {
      name: string;
    }[]
  ).map((t) => t.name);
}

function columns(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]
  ).map((c) => c.name);
}

function indexes(db: Database.Database): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'`).all() as {
      name: string;
    }[]
  ).map((i) => i.name);
}

/** The 0.4.x shape of the project family and everything that named a project. */
function legacyDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, sort_order INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, icon TEXT NOT NULL, icon_color TEXT NOT NULL,
      group_id TEXT REFERENCES groups(id) ON DELETE SET NULL, pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX projects_group_idx ON projects(group_id);
    CREATE TABLE project_presentation (
      project_id TEXT PRIMARY KEY, core_id TEXT NOT NULL,
      group_id TEXT REFERENCES groups(id) ON DELETE SET NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX project_presentation_core_idx ON project_presentation(core_id);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, title_manually_set INTEGER NOT NULL DEFAULT 0, icon TEXT, agent TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready', branch TEXT NOT NULL DEFAULT 'main', preview TEXT NOT NULL DEFAULT '',
      lines INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
      claude_session_id TEXT, claude_skip_permissions INTEGER NOT NULL DEFAULT 0,
      claude_bare_session INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX sessions_project_idx ON sessions(project_id);
    CREATE INDEX sessions_active_project_status_idx ON sessions(project_id, status) WHERE archived = 0;
    CREATE TABLE terminal_logs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      chunk TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE token_usage (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      claude_session_id TEXT NOT NULL, message_uuid TEXT NOT NULL UNIQUE, model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      ts INTEGER NOT NULL
    );
    CREATE INDEX token_usage_project_idx ON token_usage(project_id);
    CREATE TABLE token_usage_rollup (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      last_ts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, session_id, day)
    );
    CREATE INDEX token_usage_rollup_project_idx ON token_usage_rollup(project_id);
    CREATE TABLE token_usage_session_offsets (
      claude_session_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      byte_offset INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    );

    INSERT INTO groups (id, name, color, created_at) VALUES ('g1', 'Work', '#111', 1);
    INSERT INTO projects (id, name, path, icon, icon_color, group_id, created_at, updated_at)
      VALUES ('p1', 'Web', '/home/core/web', 'WE', '#123', 'g1', 1, 1);
    INSERT INTO project_presentation (project_id, core_id, group_id, updated_at) VALUES ('p9', 'c1', 'g1', 1);
    INSERT INTO sessions (id, project_id, title, agent, claude_session_id, archived, pinned, created_at, updated_at)
      VALUES ('s1', 'p1', 'first', 'claude-code', 'claude-1', 0, 1, 10, 20),
             ('s2', 'p1', 'second', 'codex', NULL, 1, 0, 11, 21);
    INSERT INTO terminal_logs (id, session_id, chunk, created_at) VALUES ('l1', 's1', 'hello', 5);
    INSERT INTO token_usage (id, session_id, project_id, claude_session_id, message_uuid, input_tokens, output_tokens, ts)
      VALUES ('u1', 's1', 'p1', 'claude-1', 'm1', 10, 20, 1000);
    INSERT INTO token_usage_rollup (project_id, session_id, day, input_tokens, output_tokens, last_ts)
      VALUES ('p1', 's1', '2026-05-01', 10, 20, 1000);
    INSERT INTO token_usage_session_offsets (claude_session_id, session_id, project_id, byte_offset, updated_at)
      VALUES ('claude-1', 's1', 'p1', 42, 7);
    INSERT INTO app_settings (key, value) VALUES
      ('projects_dashboard_view', 'table'), ('active_project_group', 'g1'), ('collapsed_project_groups', '[]'),
      ('show_group_switcher', 'false'), ('show_project_header_group', 'false'), ('default_agent', 'codex');
  `);
  return db;
}

describe("dropLegacyProjects", () => {
  it("drops the project family and its indexes", () => {
    const db = legacyDb();

    dropLegacyProjects(db);

    expect(tables(db)).not.toContain("projects");
    expect(tables(db)).not.toContain("project_presentation");
    expect(tables(db)).not.toContain("groups");
    expect(indexes(db).filter((name) => name.includes("project"))).toEqual([]);
  });

  it("rebuilds the session family without project_id and keeps every row", () => {
    const db = legacyDb();

    dropLegacyProjects(db);

    for (const table of ["sessions", "token_usage", "token_usage_rollup", "token_usage_session_offsets"]) {
      expect(columns(db, table)).not.toContain("project_id");
    }
    expect(
      db.prepare(`SELECT id, title, agent, claude_session_id AS claudeSessionId, archived, pinned, created_at AS createdAt FROM sessions ORDER BY id`).all(),
    ).toEqual([
      { id: "s1", title: "first", agent: "claude-code", claudeSessionId: "claude-1", archived: 0, pinned: 1, createdAt: 10 },
      { id: "s2", title: "second", agent: "codex", claudeSessionId: null, archived: 1, pinned: 0, createdAt: 11 },
    ]);
    expect(db.prepare(`SELECT id, session_id AS sessionId, chunk FROM terminal_logs`).all()).toEqual([
      { id: "l1", sessionId: "s1", chunk: "hello" },
    ]);
    expect(db.prepare(`SELECT id, session_id AS sessionId, input_tokens AS i, output_tokens AS o FROM token_usage`).all()).toEqual([
      { id: "u1", sessionId: "s1", i: 10, o: 20 },
    ]);
    expect(db.prepare(`SELECT session_id AS sessionId, day, input_tokens AS i, last_ts AS lastTs FROM token_usage_rollup`).all()).toEqual([
      { sessionId: "s1", day: "2026-05-01", i: 10, lastTs: 1000 },
    ]);
    expect(db.prepare(`SELECT claude_session_id AS c, session_id AS s, byte_offset AS b FROM token_usage_session_offsets`).all()).toEqual([
      { c: "claude-1", s: "s1", b: 42 },
    ]);
  });

  it("keeps the cascade from sessions working on the rebuilt tables", () => {
    const db = legacyDb();
    dropLegacyProjects(db);

    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.prepare(`DELETE FROM sessions WHERE id = 's1'`).run();

    expect(db.prepare(`SELECT count(*) AS n FROM terminal_logs`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT count(*) AS n FROM token_usage`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT count(*) AS n FROM token_usage_rollup`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT count(*) AS n FROM token_usage_session_offsets`).get()).toEqual({ n: 0 });
  });

  it("deletes the project-era settings and leaves the rest", () => {
    const db = legacyDb();

    dropLegacyProjects(db);

    expect(db.prepare(`SELECT key FROM app_settings`).all()).toEqual([{ key: "default_agent" }]);
  });

  it("keeps an operator's hotkey override under the id the hotkey moved to", () => {
    const db = legacyDb();
    const slot = { mod: true, shift: false, alt: true, key: "1" };
    const ship = { mod: true, shift: true, alt: false, key: "s" };
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('keybindings:global', ?)`).run(
      JSON.stringify({
        "project.pinnedSlot": slot,
        "project.ship": ship,
        "project.runToggle": { mod: true, shift: false, alt: false, key: "r" },
        "project.openBrowser": { mod: true, shift: false, alt: false, key: "o" },
        "terminal.toggle": { mod: true, shift: false, alt: false, key: "j" },
      }),
    );

    dropLegacyProjects(db);

    const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'keybindings:global'`).get() as {
      value: string;
    };
    expect(JSON.parse(row.value)).toEqual({
      "core.slot": slot,
      "session.ship": ship,
      "terminal.toggle": { mod: true, shift: false, alt: false, key: "j" },
    });
  });

  it("is idempotent", () => {
    const db = legacyDb();

    dropLegacyProjects(db);
    const before = tables(db);
    dropLegacyProjects(db);

    expect(tables(db)).toEqual(before);
    expect(db.prepare(`SELECT count(*) AS n FROM sessions`).get()).toEqual({ n: 2 });
  });

  it("is a no-op on a fresh schema, which never had a project", () => {
    const db = new Database(":memory:");
    ensureSchema(db);
    const before = tables(db);

    dropLegacyProjects(db);

    expect(tables(db)).toEqual(before);
    expect(before).not.toContain("projects");
    expect(columns(db, "sessions")).not.toContain("project_id");
  });
});

describe("ensureSchema on a 0.4.x database", () => {
  it("converges on the project-free shape", () => {
    const db = legacyDb();
    // The rest of a real 0.4.x DB: what ensureSchema's CREATE IF NOT EXISTS would add.
    ensureSchema(db);

    expect(tables(db)).not.toContain("projects");
    expect(columns(db, "sessions")).not.toContain("project_id");
    expect(db.prepare(`SELECT count(*) AS n FROM sessions`).get()).toEqual({ n: 2 });
    expect(indexes(db)).toEqual(expect.arrayContaining(["sessions_status_idx", "token_usage_rollup_day_idx"]));
  });
});
