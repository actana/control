import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  ensureCoreSchema,
  Pre050DatabaseError,
  refusePre050Database,
} from "../core-schema";
import { createSession, recordPromptBlockVersion, type CoreMutationSqlite } from "../core-mutations";

// The Core's database is two tables, and a 0.5.0 Core refuses to open the one an
// earlier Core left behind (ADR 0041 D1; #555: a clean break, no migration, so a
// 0.5.0 Core is installed fresh). The old shapes are spelled out in this file
// because refusing them means recognising them.

describe("a fresh Core database", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
  });
  afterEach(() => db.close());

  it("holds the sessions table and the event log, and nothing else", () => {
    refusePre050Database(db);
    ensureCoreSchema(db);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
        name: string;
      }[]
    )
      .map((t) => t.name)
      .sort();
    expect(tables).toEqual(["event_log", "sessions"]);
  });

  it("gives a Session no column to say what it belongs to", () => {
    ensureCoreSchema(db);
    const columns = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
    expect(columns.filter((c) => /project|group|parent|owner/i.test(c))).toEqual([]);
  });

  it("takes a Session with no grouping, so a Session can be created without one", () => {
    ensureCoreSchema(db);
    db.prepare("INSERT INTO sessions (id, title, agent, created_at, updated_at) VALUES ('s1', 't', 'codex', 1, 1)").run();
    expect(db.prepare("SELECT status FROM sessions WHERE id = 's1'").get()).toEqual({ status: "ready" });
  });

  it("is idempotent: a second bootstrap is accepted by the check and changes nothing", () => {
    ensureCoreSchema(db);
    db.prepare("INSERT INTO sessions (id, title, agent, created_at, updated_at) VALUES ('s1', 't', 'codex', 1, 1)").run();
    expect(() => refusePre050Database(db)).not.toThrow();
    ensureCoreSchema(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
  });
});

describe("a database from before 0.5.0 is refused, not adopted", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
  });
  afterEach(() => db.close());

  it("refuses the 0.4.x shape: a projects table, and sessions rows under it", () => {
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL);
    `);
    expect(() => refusePre050Database(db)).toThrow(Pre050DatabaseError);
    expect(() => refusePre050Database(db)).toThrow(/before Core 0\.5\.0.*install a 0\.5\.0 Core fresh/);
  });

  it("refuses a sessions table that still carries a grouping column, even with no other table", () => {
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL)");
    expect(() => refusePre050Database(db)).toThrow(/its sessions table has a column named project_id/);
  });

  it("refuses the pre-rename shape: a tasks table", () => {
    db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL)");
    expect(() => refusePre050Database(db)).toThrow(/it has a table named tasks/);
  });

  it("says what it found, so the operator knows it is the database and not the Core", () => {
    db.exec("CREATE TABLE groups (id TEXT PRIMARY KEY)");
    try {
      refusePre050Database(db);
      expect.unreachable("a database with a table this Core does not define must be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(Pre050DatabaseError);
      expect((err as Pre050DatabaseError).evidence).toBe("it has a table named groups");
    }
  });

  it("does not touch the database it refuses", () => {
    db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO tasks (id) VALUES ('t1')").run();
    expect(() => refusePre050Database(db)).toThrow();
    expect(db.prepare("SELECT id FROM tasks").all()).toEqual([{ id: "t1" }]);
    expect(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name),
    ).toEqual(["tasks"]);
  });
});

describe("the prompt block version column (issue 563)", () => {
  it("is on a fresh sessions table, empty until the Core delivers a block, and accepted on a second boot", () => {
    const db = new Database(":memory:");
    ensureCoreSchema(db);
    const cols = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("prompt_block_version");
    db.prepare("INSERT INTO sessions (id, title, agent, created_at, updated_at) VALUES ('s1', 't', 'codex', 1, 1)").run();
    expect(db.prepare("SELECT prompt_block_version AS v FROM sessions WHERE id = 's1'").get()).toEqual({ v: null });
    expect(() => refusePre050Database(db)).not.toThrow();
    db.close();
  });

  it("records the version the Core hands a Session, on that Session's row only", () => {
    const db = new Database(":memory:");
    ensureCoreSchema(db);
    const w = db as unknown as CoreMutationSqlite;
    createSession(w, { op: "create", sessionId: "a", title: "A", agent: "codex" }, 1);
    createSession(w, { op: "create", sessionId: "b", title: "B", agent: "codex" }, 1);
    recordPromptBlockVersion(w, "a", 1);
    expect(db.prepare("SELECT id, prompt_block_version AS v FROM sessions ORDER BY id").all()).toEqual([
      { id: "a", v: 1 },
      { id: "b", v: null },
    ]);
    db.close();
  });
});
