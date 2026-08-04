import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  queryProjects,
  queryTasks,
  type CoreQuerySqlite,
} from "../core-query";
import type {
  CoreLinkProjectSnapshot,
  CoreLinkTaskSnapshot,
} from "../core-link-frames";

// Pure SQL helpers that read the Core's projects + tasks tables and map
// them to core-link snapshots (issue 07). The Core is the single source of
// truth; the Panel holds none. These helpers operate on a minimal sqlite
// interface so tests pass an in-memory better-sqlite3 handle.

function openDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      icon TEXT NOT NULL,
      icon_color TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      agent TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      icon TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

/** Narrow a real better-sqlite3 handle to the minimal interface the helpers
 *  consume — mirrors how the Core's store passes its connection. */
function asQuery(db: Database.Database): CoreQuerySqlite {
  return db as unknown as CoreQuerySqlite;
}

function insertProject(
  db: Database.Database,
  p: Partial<CoreLinkProjectSnapshot> & Pick<CoreLinkProjectSnapshot, "projectId" | "name" | "path">,
): void {
  db.prepare(
    "INSERT INTO projects (id, name, path, icon, icon_color, pinned, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    p.projectId,
    p.name,
    p.path,
    p.icon ?? "MC",
    p.iconColor ?? "#7ce58a",
    p.pinned ? 1 : 0,
    p.updatedAt ?? 1,
  );
}

function insertTask(
  db: Database.Database,
  t: Partial<CoreLinkTaskSnapshot> & Pick<CoreLinkTaskSnapshot, "taskId" | "projectId">,
): void {
  db.prepare(
    "INSERT INTO tasks (id, project_id, title, agent, status, pinned, archived, icon, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    t.taskId,
    t.projectId,
    t.title ?? "task",
    t.agent ?? "claude-code",
    t.status ?? "running",
    t.pinned ? 1 : 0,
    t.archived ? 1 : 0,
    t.icon ?? null,
    t.updatedAt ?? 1,
  );
}

describe("queryProjects", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
  });

  it("returns project snapshots from the projects table", () => {
    insertProject(db, { projectId: "p1", name: "mission-control", path: "/home/op/mc", icon: "MC", iconColor: "#7ce58a", pinned: true, updatedAt: 100 });
    insertProject(db, { projectId: "p2", name: "scratch", path: "/home/op/scratch", icon: "SC", iconColor: "#e5484d", pinned: false, updatedAt: 200 });
    const projects = queryProjects(asQuery(db));
    expect(projects).toHaveLength(2);
    expect(projects).toContainEqual({
      projectId: "p1",
      name: "mission-control",
      path: "/home/op/mc",
      icon: "MC",
      iconColor: "#7ce58a",
      pinned: true,
      updatedAt: 100,
    });
    expect(projects).toContainEqual({
      projectId: "p2",
      name: "scratch",
      path: "/home/op/scratch",
      icon: "SC",
      iconColor: "#e5484d",
      pinned: false,
      updatedAt: 200,
    });
  });

  it("maps pinned 1/0 to boolean true/false", () => {
    insertProject(db, { projectId: "p1", name: "a", path: "/a", pinned: true });
    insertProject(db, { projectId: "p2", name: "b", path: "/b", pinned: false });
    const projects = queryProjects(asQuery(db));
    expect(projects.find((p) => p.projectId === "p1")?.pinned).toBe(true);
    expect(projects.find((p) => p.projectId === "p2")?.pinned).toBe(false);
  });

  it("returns empty when there are no projects", () => {
    expect(queryProjects(asQuery(db))).toEqual([]);
  });

  it("returns empty when the projects table does not exist", () => {
    const db2 = new Database(":memory:");
    expect(queryProjects(asQuery(db2))).toEqual([]);
  });
});

describe("queryTasks", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
  });

  it("returns task snapshots from the tasks table", () => {
    insertTask(db, { taskId: "t1", projectId: "p1", title: "fix bug", agent: "claude-code", status: "running", icon: "bug", updatedAt: 10 });
    insertTask(db, { taskId: "t2", projectId: "p1", title: "ship", agent: "codex", status: "needs-input", pinned: true, updatedAt: 20 });
    const tasks = queryTasks(asQuery(db));
    expect(tasks).toHaveLength(2);
    expect(tasks).toContainEqual({
      taskId: "t2",
      projectId: "p1",
      title: "ship",
      agent: "codex",
      status: "needs-input",
      pinned: true,
      archived: false,
      icon: null,
      updatedAt: 20,
    });
    expect(tasks.find((t) => t.taskId === "t1")?.icon).toBe("bug");
  });

  it("omits archived tasks (the Fleet view is for active work)", () => {
    insertTask(db, { taskId: "live", projectId: "p1", archived: false });
    insertTask(db, { taskId: "done", projectId: "p1", archived: true });
    const tasks = queryTasks(asQuery(db));
    expect(tasks.map((t) => t.taskId)).toEqual(["live"]);
  });

  it("filters by projectId when given", () => {
    insertTask(db, { taskId: "t1", projectId: "p1" });
    insertTask(db, { taskId: "t2", projectId: "p2" });
    insertTask(db, { taskId: "t3", projectId: "p1" });
    const tasks = queryTasks(asQuery(db), "p1");
    expect(tasks.map((t) => t.taskId).sort()).toEqual(["t1", "t3"]);
  });

  it("returns every active task when no projectId is given", () => {
    insertTask(db, { taskId: "t1", projectId: "p1" });
    insertTask(db, { taskId: "t2", projectId: "p2" });
    expect(queryTasks(asQuery(db))).toHaveLength(2);
  });

  it("orders by updated_at descending (most recent first)", () => {
    insertTask(db, { taskId: "old", projectId: "p1", updatedAt: 100 });
    insertTask(db, { taskId: "new", projectId: "p1", updatedAt: 999 });
    insertTask(db, { taskId: "mid", projectId: "p1", updatedAt: 500 });
    expect(queryTasks(asQuery(db)).map((t) => t.taskId)).toEqual(["new", "mid", "old"]);
  });

  it("returns empty when the tasks table does not exist", () => {
    const db2 = new Database(":memory:");
    expect(queryTasks(asQuery(db2))).toEqual([]);
  });
});
