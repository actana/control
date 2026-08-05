import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  archiveProject,
  createProject,
  createTask,
  pinProject,
  querySessions,
  renameProject,
  deleteTask,
  updateProjectAppearance,
  updateProjectSettings,
  updateTask,
  validateProjectPath,
  type CoreMutationSqlite,
  type ProjectPathProbe,
} from "../core-mutations";
import { queryProjects, queryTasks, type CoreQuerySqlite } from "../core-query";

// Pure SQL helpers that write to the Core's projects + tasks tables and
// read the derived sessions view for the write path (issue 04, ADR 0004).
// The tests use an in-memory better-sqlite3 with the same DDL the shared
// schema-bootstrap module applies — kept minimal here to what the mutation
// helpers touch, since query.test.ts already exercises the read shape.

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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      agent TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      branch TEXT NOT NULL DEFAULT 'main',
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      icon TEXT,
      title_manually_set INTEGER NOT NULL DEFAULT 0,
      claude_session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.pragma("foreign_keys = ON");
  return db;
}

function asWriter(db: Database.Database): CoreMutationSqlite {
  return db as unknown as CoreMutationSqlite;
}

function asReader(db: Database.Database): CoreQuerySqlite {
  return db as unknown as CoreQuerySqlite;
}

/** A trivial path probe that accepts anything absolute-ish and directory-shaped. */
const ALWAYS_OK_PROBE: ProjectPathProbe = {
  isAbsolute: () => true,
  statSync: () => ({ isDirectory: () => true }),
};

// ─── validateProjectPath ───────────────────────────────────────────────────

describe("validateProjectPath", () => {
  it("returns the trimmed path when absolute + directory", () => {
    const p = validateProjectPath("  /home/op/proj  ", ALWAYS_OK_PROBE);
    expect(p).toBe("/home/op/proj");
  });

  it("throws when the path is empty", () => {
    expect(() => validateProjectPath("  ", ALWAYS_OK_PROBE)).toThrow(/required/);
  });

  it("throws when the path is not absolute", () => {
    const probe: ProjectPathProbe = {
      isAbsolute: () => false,
      statSync: () => ({ isDirectory: () => true }),
    };
    expect(() => validateProjectPath("relative/dir", probe)).toThrow(/must be absolute/);
  });

  it("throws when the path does not exist", () => {
    const probe: ProjectPathProbe = { isAbsolute: () => true, statSync: () => null };
    expect(() => validateProjectPath("/nowhere", probe)).toThrow(/does not exist/);
  });

  it("throws when the path is a file rather than a directory", () => {
    const probe: ProjectPathProbe = {
      isAbsolute: () => true,
      statSync: () => ({ isDirectory: () => false }),
    };
    expect(() => validateProjectPath("/etc/hosts", probe)).toThrow(/file, not a directory/);
  });

  it("treats a statSync throw as missing (no phantom crashes)", () => {
    const probe: ProjectPathProbe = {
      isAbsolute: () => true,
      statSync: () => {
        throw new Error("EACCES");
      },
    };
    expect(() => validateProjectPath("/root/secret", probe)).toThrow(/does not exist/);
  });
});

// ─── createProject / renameProject / archiveProject ───────────────────────

describe("createProject", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
  });

  it("inserts a row that queryProjects reads back", () => {
    const snap = createProject(
      asWriter(db),
      { op: "create", name: "  Mission Control  ", path: "/home/op/mc", pinned: true },
      "/home/op/mc",
      1_700_000_000_000,
    );
    expect(snap.name).toBe("Mission Control");
    expect(snap.path).toBe("/home/op/mc");
    expect(snap.pinned).toBe(true);
    expect(snap.icon).toBe("PR");
    expect(snap.iconColor).toBe("#7ce58a");

    const listed = queryProjects(asReader(db));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(snap);
  });

  it("accepts a caller-supplied projectId for optimistic-UI parity", () => {
    const snap = createProject(
      asWriter(db),
      { op: "create", projectId: "p-custom", name: "x", path: "/x" },
      "/x",
      1,
    );
    expect(snap.projectId).toBe("p-custom");
  });

  it("generates a projectId when the caller omits it", () => {
    const snap = createProject(
      asWriter(db),
      { op: "create", name: "y", path: "/y" },
      "/y",
      1,
    );
    expect(snap.projectId).toMatch(/^p-/);
  });

  it("throws when the name is empty", () => {
    expect(() =>
      createProject(asWriter(db), { op: "create", name: "  ", path: "/x" }, "/x", 1),
    ).toThrow(/name is required/);
  });

  it("defaults the remembered session settings when the frame omits them", () => {
    const snap = createProject(
      asWriter(db),
      { op: "create", name: "x", path: "/x" },
      "/x",
      1,
    );
    expect(snap).toMatchObject({
      rememberHarnessSettings: false,
      savedHarness: null,
      savedSkipPermissions: false,
      savedBareSession: false,
      defaultGridView: false,
    });
    expect(queryProjects(asReader(db))[0]).toEqual(snap);
  });

  it("persists the Create Project dialog's remembered settings", () => {
    const snap = createProject(
      asWriter(db),
      {
        op: "create",
        name: "x",
        path: "/x",
        rememberHarnessSettings: true,
        savedHarness: "codex",
        defaultGridView: true,
      },
      "/x",
      1,
    );
    expect(snap).toMatchObject({
      rememberHarnessSettings: true,
      savedHarness: "codex",
      defaultGridView: true,
    });
    // The snapshot the Panel gets back must be the row that was written, or
    // the next refetch silently contradicts it.
    expect(queryProjects(asReader(db))[0]).toEqual(snap);
  });

  it("stores a blank saved harness as no remembered harness", () => {
    const snap = createProject(
      asWriter(db),
      { op: "create", name: "x", path: "/x", savedHarness: "   " },
      "/x",
      1,
    );
    expect(snap.savedHarness).toBeNull();
  });
});

describe("updateProjectSettings", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
    createProject(
      asWriter(db),
      { op: "create", projectId: "p1", name: "x", path: "/p" },
      "/p",
      1,
    );
  });

  it("persists the remembered harness and survives a re-read", () => {
    const snap = updateProjectSettings(
      asWriter(db),
      {
        op: "settings",
        projectId: "p1",
        rememberHarnessSettings: true,
        savedHarness: "claude-code",
      },
      5,
    );
    expect(snap).toMatchObject({
      rememberHarnessSettings: true,
      savedHarness: "claude-code",
      updatedAt: 5,
    });
    expect(queryProjects(asReader(db))[0]).toMatchObject({
      rememberHarnessSettings: true,
      savedHarness: "claude-code",
    });
  });

  it("leaves omitted fields untouched", () => {
    updateProjectSettings(
      asWriter(db),
      { op: "settings", projectId: "p1", rememberHarnessSettings: true, savedHarness: "codex" },
      5,
    );
    const snap = updateProjectSettings(
      asWriter(db),
      { op: "settings", projectId: "p1", defaultGridView: true },
      6,
    );
    expect(snap).toMatchObject({
      rememberHarnessSettings: true,
      savedHarness: "codex",
      defaultGridView: true,
    });
  });

  it("clears the remembered harness on an explicit null", () => {
    updateProjectSettings(
      asWriter(db),
      { op: "settings", projectId: "p1", savedHarness: "codex" },
      5,
    );
    const snap = updateProjectSettings(
      asWriter(db),
      { op: "settings", projectId: "p1", savedHarness: null },
      6,
    );
    expect(snap?.savedHarness).toBeNull();
  });

  it("reads the row back for an empty patch without bumping updated_at", () => {
    const snap = updateProjectSettings(asWriter(db), { op: "settings", projectId: "p1" }, 9);
    expect(snap?.updatedAt).toBe(1);
  });

  it("returns null when the projectId is unknown", () => {
    expect(
      updateProjectSettings(
        asWriter(db),
        { op: "settings", projectId: "missing", defaultGridView: true },
        5,
      ),
    ).toBeNull();
  });
});

describe("updateProjectAppearance", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
    createProject(
      asWriter(db),
      { op: "create", projectId: "p1", name: "x", path: "/p", icon: "AB", iconColor: "#111111" },
      "/p",
      1,
    );
  });

  it("writes both icon fields and survives a re-read", () => {
    const snap = updateProjectAppearance(
      asWriter(db),
      { op: "appearance", projectId: "p1", icon: "ZZ", iconColor: "#abcdef" },
      5,
    );
    expect(snap).toMatchObject({ icon: "ZZ", iconColor: "#abcdef", updatedAt: 5 });
    expect(queryProjects(asReader(db))[0]).toMatchObject({
      icon: "ZZ",
      iconColor: "#abcdef",
    });
  });

  it("leaves an omitted field untouched", () => {
    const snap = updateProjectAppearance(
      asWriter(db),
      { op: "appearance", projectId: "p1", iconColor: "#abcdef" },
      5,
    );
    expect(snap).toMatchObject({ icon: "AB", iconColor: "#abcdef" });
  });

  it("trims what it writes", () => {
    const snap = updateProjectAppearance(
      asWriter(db),
      { op: "appearance", projectId: "p1", icon: "  ZZ  " },
      5,
    );
    expect(snap?.icon).toBe("ZZ");
  });

  // Both columns are NOT NULL: a blank icon box must not blank a row that has
  // one. Blank reads as "nothing to set", exactly as an omitted field does.
  it("ignores a blank value rather than erasing the column", () => {
    const snap = updateProjectAppearance(
      asWriter(db),
      { op: "appearance", projectId: "p1", icon: "   ", iconColor: "" },
      5,
    );
    expect(snap).toMatchObject({ icon: "AB", iconColor: "#111111", updatedAt: 1 });
  });

  it("reads the row back for an empty patch without bumping updated_at", () => {
    const snap = updateProjectAppearance(asWriter(db), { op: "appearance", projectId: "p1" }, 9);
    expect(snap?.updatedAt).toBe(1);
  });

  it("returns null when the projectId is unknown", () => {
    expect(
      updateProjectAppearance(
        asWriter(db),
        { op: "appearance", projectId: "missing", icon: "ZZ" },
        5,
      ),
    ).toBeNull();
  });
});

describe("renameProject", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
    createProject(
      asWriter(db),
      { op: "create", projectId: "p1", name: "old", path: "/p" },
      "/p",
      1,
    );
  });

  it("updates the name and returns the fresh snapshot", () => {
    const snap = renameProject(asWriter(db), "p1", "  new name  ", 5);
    expect(snap?.name).toBe("new name");
    expect(snap?.updatedAt).toBe(5);
    expect(queryProjects(asReader(db))[0]!.name).toBe("new name");
  });

  it("returns null when the projectId is unknown", () => {
    expect(renameProject(asWriter(db), "missing", "x", 5)).toBeNull();
  });

  it("throws on empty name", () => {
    expect(() => renameProject(asWriter(db), "p1", "  ", 5)).toThrow(/name is required/);
  });
});

describe("pinProject", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
    createProject(
      asWriter(db),
      { op: "create", projectId: "p1", name: "x", path: "/p" },
      "/p",
      1,
    );
  });

  it("sets pinned=true and bumps updated_at", () => {
    const snap = pinProject(asWriter(db), "p1", true, 5);
    expect(snap?.pinned).toBe(true);
    expect(snap?.updatedAt).toBe(5);
    expect(queryProjects(asReader(db))[0]!.pinned).toBe(true);
  });

  it("sets pinned=false", () => {
    pinProject(asWriter(db), "p1", true, 5);
    const snap = pinProject(asWriter(db), "p1", false, 6);
    expect(snap?.pinned).toBe(false);
    expect(queryProjects(asReader(db))[0]!.pinned).toBe(false);
  });

  it("returns null when the projectId is unknown", () => {
    expect(pinProject(asWriter(db), "missing", true, 5)).toBeNull();
  });
});

describe("archiveProject", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
    createProject(
      asWriter(db),
      { op: "create", projectId: "p1", name: "x", path: "/p" },
      "/p",
      1,
    );
    createTask(
      asWriter(db),
      { op: "create", taskId: "t1", projectId: "p1", title: "child", agent: "claude-code" },
      1,
    );
  });

  it("deletes the row, cascades child tasks, and returns the pre-delete snapshot", () => {
    const snap = archiveProject(asWriter(db), "p1");
    expect(snap?.projectId).toBe("p1");
    expect(snap?.path).toBe("/p");
    expect(queryProjects(asReader(db))).toEqual([]);
    expect(queryTasks(asReader(db))).toEqual([]);
  });

  it("returns null when the projectId is unknown", () => {
    expect(archiveProject(asWriter(db), "missing")).toBeNull();
    expect(queryProjects(asReader(db))).toHaveLength(1);
  });
});

// ─── createTask / updateTask / deleteTask ─────────────────────────────────

describe("createTask", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
    createProject(
      asWriter(db),
      { op: "create", projectId: "p1", name: "x", path: "/p" },
      "/p",
      1,
    );
  });

  it("inserts a row that queryTasks reads back", () => {
    const snap = createTask(
      asWriter(db),
      { op: "create", projectId: "p1", title: "fix bug", agent: "claude-code" },
      2,
    );
    expect(snap.projectId).toBe("p1");
    expect(snap.title).toBe("fix bug");
    expect(snap.agent).toBe("claude-code");
    expect(snap.status).toBe("ready");
    expect(snap.pinned).toBe(false);
    expect(snap.archived).toBe(false);
    expect(snap.icon).toBeNull();
    expect(queryTasks(asReader(db))).toHaveLength(1);
    expect(queryTasks(asReader(db))[0]!.icon).toBeNull();
  });

  it("stores a caller-supplied icon at creation time", () => {
    const snap = createTask(
      asWriter(db),
      {
        op: "create",
        projectId: "p1",
        title: "with icon",
        agent: "claude-code",
        icon: "bug",
      },
      2,
    );
    expect(snap.icon).toBe("bug");
    expect(queryTasks(asReader(db))[0]!.icon).toBe("bug");
  });

  it("honors a caller-supplied taskId + status", () => {
    const snap = createTask(
      asWriter(db),
      {
        op: "create",
        taskId: "t-custom",
        projectId: "p1",
        title: "x",
        agent: "codex",
        status: "running",
      },
      2,
    );
    expect(snap.taskId).toBe("t-custom");
    expect(snap.status).toBe("running");
  });

  it.each([
    ["projectId", { op: "create" as const, projectId: "  ", title: "t", agent: "claude-code" }],
    ["title", { op: "create" as const, projectId: "p1", title: "  ", agent: "claude-code" }],
    ["agent", { op: "create" as const, projectId: "p1", title: "t", agent: "  " }],
  ])("throws when %s is empty", (_, input) => {
    expect(() => createTask(asWriter(db), input, 2)).toThrow();
  });
});

describe("updateTask", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
    createProject(
      asWriter(db),
      { op: "create", projectId: "p1", name: "x", path: "/p" },
      "/p",
      1,
    );
    createTask(
      asWriter(db),
      { op: "create", taskId: "t1", projectId: "p1", title: "orig", agent: "claude-code" },
      1,
    );
  });

  it("patches only the fields the caller sends (partial update)", () => {
    const snap = updateTask(
      asWriter(db),
      { op: "update", taskId: "t1", status: "running", pinned: true },
      5,
    );
    expect(snap?.status).toBe("running");
    expect(snap?.pinned).toBe(true);
    expect(snap?.title).toBe("orig");
    expect(snap?.updatedAt).toBe(5);
  });

  it("returns null when the taskId is unknown", () => {
    expect(
      updateTask(asWriter(db), { op: "update", taskId: "missing", status: "running" }, 5),
    ).toBeNull();
  });

  it("throws on empty title patch", () => {
    expect(() =>
      updateTask(asWriter(db), { op: "update", taskId: "t1", title: "  " }, 5),
    ).toThrow(/title cannot be empty/);
  });

  it("no-op update returns the existing row unchanged", () => {
    const snap = updateTask(asWriter(db), { op: "update", taskId: "t1" }, 5);
    expect(snap?.title).toBe("orig");
    expect(snap?.updatedAt).toBe(1); // unchanged: no SET clause
  });

  it("archived flag flows through to queryTasks (row is filtered)", () => {
    updateTask(asWriter(db), { op: "update", taskId: "t1", archived: true }, 5);
    expect(queryTasks(asReader(db))).toEqual([]); // archived filtered out
  });

  it("sets the icon when the caller sends a string", () => {
    const snap = updateTask(
      asWriter(db),
      { op: "update", taskId: "t1", icon: "wrench" },
      5,
    );
    expect(snap?.icon).toBe("wrench");
    expect(queryTasks(asReader(db))[0]!.icon).toBe("wrench");
  });

  it("clears the icon when the caller sends null", () => {
    updateTask(asWriter(db), { op: "update", taskId: "t1", icon: "wrench" }, 5);
    const snap = updateTask(
      asWriter(db),
      { op: "update", taskId: "t1", icon: null },
      6,
    );
    expect(snap?.icon).toBeNull();
    expect(queryTasks(asReader(db))[0]!.icon).toBeNull();
  });

  it("leaves the icon untouched when omitted (partial patch)", () => {
    updateTask(asWriter(db), { op: "update", taskId: "t1", icon: "wrench" }, 5);
    updateTask(asWriter(db), { op: "update", taskId: "t1", title: "renamed" }, 6);
    expect(queryTasks(asReader(db))[0]!.icon).toBe("wrench");
  });
});

describe("deleteTask", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
    createProject(
      asWriter(db),
      { op: "create", projectId: "p1", name: "x", path: "/p" },
      "/p",
      1,
    );
    createTask(
      asWriter(db),
      { op: "create", taskId: "t1", projectId: "p1", title: "orig", agent: "claude-code" },
      1,
    );
    createTask(
      asWriter(db),
      { op: "create", taskId: "t2", projectId: "p1", title: "keep", agent: "claude-code" },
      1,
    );
  });

  it("removes the row and returns the pre-delete snapshot", () => {
    const snap = deleteTask(asWriter(db), "t1");
    expect(snap?.taskId).toBe("t1");
    expect(snap?.title).toBe("orig");
    expect(queryTasks(asReader(db)).map((t) => t.taskId)).toEqual(["t2"]);
  });

  it("deletes an archived row too — that is the only way one leaves the DB", () => {
    updateTask(asWriter(db), { op: "update", taskId: "t1", archived: true }, 5);
    expect(deleteTask(asWriter(db), "t1")?.archived).toBe(true);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE id = 't1'`).get(),
    ).toEqual({ n: 0 });
  });

  it("returns null when the taskId is unknown, leaving every row in place", () => {
    expect(deleteTask(asWriter(db), "missing")).toBeNull();
    expect(queryTasks(asReader(db))).toHaveLength(2);
  });
});

// ─── querySessions ─────────────────────────────────────────────────────────

describe("querySessions", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
    createProject(
      asWriter(db),
      { op: "create", projectId: "p1", name: "x", path: "/p" },
      "/p",
      1,
    );
    createProject(
      asWriter(db),
      { op: "create", projectId: "p2", name: "y", path: "/q" },
      "/q",
      1,
    );
    createTask(
      asWriter(db),
      { op: "create", taskId: "t1", projectId: "p1", title: "a", agent: "claude-code" },
      10,
    );
    createTask(
      asWriter(db),
      { op: "create", taskId: "t2", projectId: "p2", title: "b", agent: "codex" },
      20,
    );
  });

  it("returns one session per active task, enriched with live ptyId when the probe answers", () => {
    const probe = (taskId: string) => (taskId === "t1" ? "pty-abc" : null);
    const sessions = querySessions(asWriter(db), probe);
    expect(sessions).toHaveLength(2);
    const s1 = sessions.find((s) => s.taskId === "t1");
    const s2 = sessions.find((s) => s.taskId === "t2");
    expect(s1?.ptyId).toBe("pty-abc");
    expect(s2?.ptyId).toBeNull();
  });

  it("filters by projectId", () => {
    const sessions = querySessions(asWriter(db), () => null, "p1");
    expect(sessions.map((s) => s.taskId)).toEqual(["t1"]);
  });

  it("omits archived tasks (same rule as tasksList)", () => {
    updateTask(asWriter(db), { op: "update", taskId: "t1", archived: true }, 30);
    const sessions = querySessions(asWriter(db), () => null);
    expect(sessions.map((s) => s.taskId)).toEqual(["t2"]);
  });

  it("orders by updated_at DESC (most recent first)", () => {
    const sessions = querySessions(asWriter(db), () => null);
    expect(sessions.map((s) => s.taskId)).toEqual(["t2", "t1"]);
  });

  it("returns empty when the tasks table is absent", () => {
    const empty = new Database(":memory:");
    expect(querySessions(asWriter(empty), () => null)).toEqual([]);
  });
});
