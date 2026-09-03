import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  countArchivedTasks,
  queryActiveTasks,
  queryArchivedTasks,
  queryProjects,
  queryStrandedReadyTasks,
  queryTaskProvenNeverWorked,
  queryTasks,
  type CoreQuerySqlite,
} from "../core-query";
import type {
  CoreLinkProjectSnapshot,
  CoreLinkTaskSnapshot,
} from "@actana/sdk/core-link-frames";

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
      remember_agent_settings INTEGER NOT NULL DEFAULT 0,
      saved_agent TEXT,
      saved_skip_permissions INTEGER NOT NULL DEFAULT 0,
      saved_bare_session INTEGER NOT NULL DEFAULT 0,
      default_grid_view INTEGER NOT NULL DEFAULT 0,
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
      title_manually_set INTEGER NOT NULL DEFAULT 0,
      claude_session_id TEXT,
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
    `INSERT INTO projects (
       id, name, path, icon, icon_color, pinned,
       remember_agent_settings, saved_agent, saved_skip_permissions,
       saved_bare_session, default_grid_view, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    p.projectId,
    p.name,
    p.path,
    p.icon ?? "MC",
    p.iconColor ?? "#7ce58a",
    p.pinned ? 1 : 0,
    p.rememberHarnessSettings ? 1 : 0,
    p.savedHarness ?? null,
    p.savedSkipPermissions ? 1 : 0,
    p.savedBareSession ? 1 : 0,
    p.defaultGridView ? 1 : 0,
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

/** The Core's event log, as far as the stranded-ready read needs it. */
function addEventLog(db: Database.Database): void {
  db.exec(`
    CREATE TABLE event_log (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      pty_id TEXT,
      task_id TEXT,
      payload TEXT NOT NULL
    );
  `);
}

/**
 * Record the `pty:spawn` the Core appends when it starts a PTY, in the shape
 * `recordPtySpawn` actually writes — `shellSession` is in the payload, and it
 * is `false` for an agent spawn and for a plain `shell: true` spawn alike.
 */
function spawnedPty(
  db: Database.Database,
  taskId: string | null,
  shellSession = false,
): void {
  db.prepare(
    "INSERT INTO event_log (ts, kind, pty_id, task_id, payload) VALUES (?, ?, ?, ?, ?)",
  ).run(1, "pty:spawn", "pty-1", taskId, JSON.stringify({ ptyId: "pty-1", taskId, shellSession }));
}

/** A `task:updated` the way `CoreTaskWriter` writes it: status only when patched. */
function taskUpdated(db: Database.Database, taskId: string, status?: string): void {
  db.prepare(
    "INSERT INTO event_log (ts, kind, pty_id, task_id, payload) VALUES (?, ?, ?, ?, ?)",
  ).run(
    1,
    "task:updated",
    null,
    taskId,
    JSON.stringify({ taskId, projectId: "p1", ...(status === undefined ? {} : { status }) }),
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
      rememberHarnessSettings: false,
      savedHarness: null,
      savedSkipPermissions: false,
      savedBareSession: false,
      defaultGridView: false,
      updatedAt: 100,
    });
    expect(projects).toContainEqual({
      projectId: "p2",
      name: "scratch",
      path: "/home/op/scratch",
      icon: "SC",
      iconColor: "#e5484d",
      pinned: false,
      rememberHarnessSettings: false,
      savedHarness: null,
      savedSkipPermissions: false,
      savedBareSession: false,
      defaultGridView: false,
      updatedAt: 200,
    });
  });

  it("carries the remembered session settings off the project row", () => {
    insertProject(db, {
      projectId: "p1",
      name: "mission-control",
      path: "/home/op/mc",
      rememberHarnessSettings: true,
      savedHarness: "codex",
      savedSkipPermissions: true,
      savedBareSession: true,
      defaultGridView: true,
    });
    const [project] = queryProjects(asQuery(db));
    expect(project).toMatchObject({
      rememberHarnessSettings: true,
      savedHarness: "codex",
      savedSkipPermissions: true,
      savedBareSession: true,
      defaultGridView: true,
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
      titleManuallySet: false,
      claudeSessionId: null,
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

// The Archived view's own read path (ADR 0019). The point of it being a
// separate helper rather than a flag on queryTasks is that the two lists
// cannot bleed into each other, so that is what these assert.
describe("queryArchivedTasks", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
  });

  it("returns the archived rows, and only those", () => {
    insertTask(db, { taskId: "live", projectId: "p1", archived: false });
    insertTask(db, { taskId: "old", projectId: "p1", archived: true });
    const tasks = queryArchivedTasks(asQuery(db));
    expect(tasks.map((t) => t.taskId)).toEqual(["old"]);
    expect(tasks[0]!.archived).toBe(true);
  });

  it("is the exact complement of queryTasks — no row appears in both, none is lost", () => {
    insertTask(db, { taskId: "a", projectId: "p1", archived: false });
    insertTask(db, { taskId: "b", projectId: "p1", archived: true });
    insertTask(db, { taskId: "c", projectId: "p1", archived: false });
    const active = queryTasks(asQuery(db)).map((t) => t.taskId);
    const archived = queryArchivedTasks(asQuery(db)).map((t) => t.taskId);
    expect(active.filter((id) => archived.includes(id))).toEqual([]);
    expect([...active, ...archived].sort()).toEqual(["a", "b", "c"]);
  });

  it("filters by projectId when given", () => {
    insertTask(db, { taskId: "t1", projectId: "p1", archived: true });
    insertTask(db, { taskId: "t2", projectId: "p2", archived: true });
    expect(queryArchivedTasks(asQuery(db), "p1").map((t) => t.taskId)).toEqual(["t1"]);
  });

  it("orders by updated_at descending, like the active list", () => {
    insertTask(db, { taskId: "old", projectId: "p1", archived: true, updatedAt: 100 });
    insertTask(db, { taskId: "new", projectId: "p1", archived: true, updatedAt: 999 });
    insertTask(db, { taskId: "mid", projectId: "p1", archived: true, updatedAt: 500 });
    expect(queryArchivedTasks(asQuery(db)).map((t) => t.taskId)).toEqual(["new", "mid", "old"]);
  });

  it("returns empty when the tasks table does not exist", () => {
    expect(queryArchivedTasks(asQuery(new Database(":memory:")))).toEqual([]);
  });
});

describe("queryActiveTasks (the Core's boot sweep read, issue 243)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
  });

  it("returns only the rows that still claim a live harness process", () => {
    insertTask(db, { taskId: "t-running", projectId: "p1", status: "running" });
    insertTask(db, { taskId: "t-waiting", projectId: "p1", status: "needs-input" });
    insertTask(db, { taskId: "t-ready", projectId: "p1", status: "ready" });
    insertTask(db, { taskId: "t-done", projectId: "p1", status: "finished" });
    insertTask(db, { taskId: "t-gone", projectId: "p1", status: "disconnected" });

    expect(queryActiveTasks(asQuery(db)).map((t) => t.taskId).sort()).toEqual([
      "t-running",
      "t-waiting",
    ]);
  });

  it("includes archived rows — an archived Session claiming to work is just as wrong", () => {
    insertTask(db, { taskId: "t-archived", projectId: "p1", status: "running", archived: true });
    expect(queryActiveTasks(asQuery(db)).map((t) => t.taskId)).toEqual(["t-archived"]);
  });

  it("spans every project: a dead process did not die for one Project only", () => {
    insertTask(db, { taskId: "t-a", projectId: "p1", status: "running" });
    insertTask(db, { taskId: "t-b", projectId: "p2", status: "needs-input" });
    expect(queryActiveTasks(asQuery(db))).toHaveLength(2);
  });

  it("returns empty when the tasks table does not exist", () => {
    const empty = new Database(":memory:");
    expect(queryActiveTasks(asQuery(empty))).toEqual([]);
    empty.close();
  });
});

describe("queryStrandedReadyTasks (the ready zombie, issue 387)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
    addEventLog(db);
  });

  it("finds a ready row a PTY was spawned for, and no other ready row", () => {
    // The bare Session: a PTY of some previous run, no hook ever fired, still
    // sitting on "Waiting for initial prompt…" hours after the process died.
    insertTask(db, { taskId: "t-zombie", projectId: "p1", status: "ready" });
    spawnedPty(db, "t-zombie");
    // The Session the operator created and has not started. It has no process
    // because it never had one — sweeping it would be the regression.
    insertTask(db, { taskId: "t-unstarted", projectId: "p1", status: "ready" });

    expect(queryStrandedReadyTasks(asQuery(db)).map((t) => t.taskId)).toEqual(["t-zombie"]);
  });

  it("leaves every other status to the query that owns it", () => {
    for (const status of ["running", "needs-input", "finished", "disconnected"]) {
      insertTask(db, { taskId: `t-${status}`, projectId: "p1", status });
      spawnedPty(db, `t-${status}`);
    }
    expect(queryStrandedReadyTasks(asQuery(db))).toEqual([]);
  });

  it("ignores a spawn recorded against some other Session", () => {
    insertTask(db, { taskId: "t-ready", projectId: "p1", status: "ready" });
    spawnedPty(db, "t-other");
    expect(queryStrandedReadyTasks(asQuery(db))).toEqual([]);
  });

  it("does not read a VM Shell Session spawn as harness evidence", () => {
    // `shellSession: true` carries a taskId for routing and is not harness
    // work — a shell opened against a Session must not settle its card.
    insertTask(db, { taskId: "t-ready", projectId: "p1", status: "ready" });
    spawnedPty(db, "t-ready", true);
    expect(queryStrandedReadyTasks(asQuery(db))).toEqual([]);

    // The agent spawn for the same row still is evidence.
    spawnedPty(db, "t-ready");
    expect(queryStrandedReadyTasks(asQuery(db)).map((t) => t.taskId)).toEqual(["t-ready"]);
  });

  it("does not read a plain shell spawn, whose task id names no row", () => {
    // A `shell: true` spawn records `shellSession: false`, the same as an
    // agent — it is separated by its id instead. The CLI addresses those with
    // a synthetic `cli_shell_<uuid>`, which no `tasks` row carries, so the
    // join drops it. Pinning the shape here is what keeps that true.
    insertTask(db, { taskId: "t-ready", projectId: "p1", status: "ready" });
    spawnedPty(db, "cli_shell_2f1c9a4e-0d3b-4c77-9f21-6b8e5a0d1c34");
    spawnedPty(db, "user-terminal-1");
    expect(queryStrandedReadyTasks(asQuery(db))).toEqual([]);
  });

  it("includes an archived row, and spans every project", () => {
    insertTask(db, { taskId: "t-arch", projectId: "p1", status: "ready", archived: true });
    spawnedPty(db, "t-arch");
    insertTask(db, { taskId: "t-p2", projectId: "p2", status: "ready" });
    spawnedPty(db, "t-p2");
    expect(queryStrandedReadyTasks(asQuery(db)).map((t) => t.taskId).sort()).toEqual([
      "t-arch",
      "t-p2",
    ]);
  });

  it("maps the row the way every other listing here does", () => {
    insertTask(db, {
      taskId: "t-zombie",
      projectId: "p1",
      status: "ready",
      title: "Waiting for initial prompt…",
      agent: "opencode",
      pinned: true,
      updatedAt: 42,
    });
    spawnedPty(db, "t-zombie");
    expect(queryStrandedReadyTasks(asQuery(db))[0]).toMatchObject({
      taskId: "t-zombie",
      projectId: "p1",
      title: "Waiting for initial prompt…",
      agent: "opencode",
      status: "ready",
      pinned: true,
      archived: false,
      claudeSessionId: null,
      updatedAt: 42,
    });
  });

  it("returns empty when there is no event log to read the evidence from", () => {
    // A Core whose log never bootstrapped sweeps nothing extra rather than
    // failing its whole boot read — and rather than sweeping every ready row.
    const noLog = openDb();
    insertTask(noLog, { taskId: "t-ready", projectId: "p1", status: "ready" });
    expect(queryStrandedReadyTasks(asQuery(noLog))).toEqual([]);
    noLog.close();
  });

  it("returns empty when the tasks table does not exist", () => {
    const empty = new Database(":memory:");
    expect(queryStrandedReadyTasks(asQuery(empty))).toEqual([]);
    empty.close();
  });
});

describe("queryTaskProvenNeverWorked (the relaunch reset's gate, issue 387)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
    addEventLog(db);
  });

  it("proves it for a row that only ever moved between ready and disconnected", () => {
    // The bare Session: born `ready`, settled `disconnected` by the sweep or
    // the PTY-exit path, and nothing in between. Nothing here is a turn — and
    // that `disconnected` is the positive evidence that this log can speak.
    taskUpdated(db, "t-bare", "disconnected");
    expect(queryTaskProvenNeverWorked(asQuery(db), "t-bare")).toBe(true);
  });

  it("refuses to prove it for a log that predates v0.4.0", () => {
    // `task:updated` only began carrying `status` in 2dd34a8 (v0.4.0), and
    // `event_log` is never pruned, so a Core upgraded from 0.3.x still holds
    // status-less rows for Sessions that worked for hours. Read as "did any
    // turn happen", their absence looks exactly like a Session that never ran
    // one — and answering "never worked" there overwrites a real card.
    taskUpdated(db, "t-legacy");
    taskUpdated(db, "t-legacy");
    expect(queryTaskProvenNeverWorked(asQuery(db), "t-legacy")).toBe(false);
  });

  it("refuses to prove it for a row with no history at all", () => {
    expect(queryTaskProvenNeverWorked(asQuery(db), "t-unknown")).toBe(false);
  });

  it("still proves it when a status-less update sits beside the evidence", () => {
    // A rename or a pin writes no status; on a current Core the settle beside
    // it does, and that is what makes the log readable.
    taskUpdated(db, "t-bare");
    taskUpdated(db, "t-bare", "disconnected");
    expect(queryTaskProvenNeverWorked(asQuery(db), "t-bare")).toBe(true);
  });

  it("is false for every status that only a turn produces", () => {
    for (const status of ["running", "needs-input", "interrupted", "finished", "terminated"]) {
      const taskId = `t-${status}`;
      taskUpdated(db, taskId, "disconnected");
      taskUpdated(db, taskId, status);
      expect(queryTaskProvenNeverWorked(asQuery(db), taskId)).toBe(false);
    }
  });

  it("is false for a harness that goes straight from ready to finished", () => {
    // Some harnesses never report `running`; the finish is the only patch.
    taskUpdated(db, "t-quiet", "finished");
    expect(queryTaskProvenNeverWorked(asQuery(db), "t-quiet")).toBe(false);
  });

  it("reads only this Session's own history", () => {
    taskUpdated(db, "t-other", "running");
    taskUpdated(db, "t-bare", "disconnected");
    expect(queryTaskProvenNeverWorked(asQuery(db), "t-bare")).toBe(true);
    expect(queryTaskProvenNeverWorked(asQuery(db), "t-other")).toBe(false);
  });

  it("takes no evidence from an event that is not task:updated", () => {
    // A `pty:spawn` says a process started, not that a turn did — and it is
    // not proof the log carries statuses either.
    spawnedPty(db, "t-bare");
    expect(queryTaskProvenNeverWorked(asQuery(db), "t-bare")).toBe(false);
  });

  it("is false when there is no event log to read", () => {
    expect(queryTaskProvenNeverWorked(asQuery(openDb()), "t-bare")).toBe(false);
  });
});

describe("countArchivedTasks", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
  });

  it("counts archived rows and ignores active ones", () => {
    insertTask(db, { taskId: "live", projectId: "p1", archived: false });
    insertTask(db, { taskId: "o1", projectId: "p1", archived: true });
    insertTask(db, { taskId: "o2", projectId: "p1", archived: true });
    expect(countArchivedTasks(asQuery(db))).toBe(2);
  });

  it("scopes to one project when given", () => {
    insertTask(db, { taskId: "o1", projectId: "p1", archived: true });
    insertTask(db, { taskId: "o2", projectId: "p2", archived: true });
    expect(countArchivedTasks(asQuery(db), "p1")).toBe(1);
  });

  it("is 0 when nothing is archived", () => {
    insertTask(db, { taskId: "live", projectId: "p1", archived: false });
    expect(countArchivedTasks(asQuery(db))).toBe(0);
  });

  it("is 0 when the tasks table does not exist", () => {
    expect(countArchivedTasks(asQuery(new Database(":memory:")))).toBe(0);
  });
});
