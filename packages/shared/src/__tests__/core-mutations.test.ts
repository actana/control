import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  createSession,
  querySessions,
  deleteSession,
  updateSession,
  type CoreMutationSqlite,
} from "../core-mutations";
import { querySessionRows, type CoreQuerySqlite } from "../core-query";

// Pure SQL helpers that write to the Core's sessions table and
// read the derived sessions view for the write path (issue 04, ADR 0004).
// The tests use an in-memory better-sqlite3 with the same DDL the shared
// core-schema module applies — kept minimal here to what the mutation
// helpers touch, since query.test.ts already exercises the read shape.

function openDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
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

// ─── createSession / updateSession / deleteSession ─────────────────────────────────

describe("createSession", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
  });

  it("inserts a row that querySessionRows reads back", () => {
    const snap = createSession(
      asWriter(db),
      { op: "create", title: "fix bug", agent: "claude-code" },
      2,
    );
    expect(snap.title).toBe("fix bug");
    expect(snap.agent).toBe("claude-code");
    expect(snap.status).toBe("ready");
    expect(snap.pinned).toBe(false);
    expect(snap.archived).toBe(false);
    expect(snap.icon).toBeNull();
    expect(querySessionRows(asReader(db))).toHaveLength(1);
    expect(querySessionRows(asReader(db))[0]!.icon).toBeNull();
  });

  it("stores a caller-supplied icon at creation time", () => {
    const snap = createSession(
      asWriter(db),
      {
        op: "create",
       
        title: "with icon",
        agent: "claude-code",
        icon: "bug",
      },
      2,
    );
    expect(snap.icon).toBe("bug");
    expect(querySessionRows(asReader(db))[0]!.icon).toBe("bug");
  });

  it("honors a caller-supplied sessionId + status", () => {
    const snap = createSession(
      asWriter(db),
      {
        op: "create",
        sessionId: "t-custom",
       
        title: "x",
        agent: "codex",
        status: "running",
      },
      2,
    );
    expect(snap.sessionId).toBe("t-custom");
    expect(snap.status).toBe("running");
  });

  it.each([
    ["title", { op: "create" as const, title: "  ", agent: "claude-code" }],
    ["agent", { op: "create" as const, title: "t", agent: "  " }],
  ])("throws when %s is empty", (_, input) => {
    expect(() => createSession(asWriter(db), input, 2)).toThrow();
  });
});

describe("updateSession", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
    createSession(
      asWriter(db),
      { op: "create", sessionId: "t1", title: "orig", agent: "claude-code" },
      1,
    );
  });

  it("patches only the fields the caller sends (partial update)", () => {
    const snap = updateSession(
      asWriter(db),
      { op: "update", sessionId: "t1", status: "running", pinned: true },
      5,
    );
    expect(snap?.status).toBe("running");
    expect(snap?.pinned).toBe(true);
    expect(snap?.title).toBe("orig");
    expect(snap?.updatedAt).toBe(5);
  });

  it("returns null when the sessionId is unknown", () => {
    expect(
      updateSession(asWriter(db), { op: "update", sessionId: "missing", status: "running" }, 5),
    ).toBeNull();
  });

  it("throws on empty title patch", () => {
    expect(() =>
      updateSession(asWriter(db), { op: "update", sessionId: "t1", title: "  " }, 5),
    ).toThrow(/title cannot be empty/);
  });

  it("no-op update returns the existing row unchanged", () => {
    const snap = updateSession(asWriter(db), { op: "update", sessionId: "t1" }, 5);
    expect(snap?.title).toBe("orig");
    expect(snap?.updatedAt).toBe(1); // unchanged: no SET clause
  });

  it("archived flag flows through to querySessionRows (row is filtered)", () => {
    updateSession(asWriter(db), { op: "update", sessionId: "t1", archived: true }, 5);
    expect(querySessionRows(asReader(db))).toEqual([]); // archived filtered out
  });

  it("sets the icon when the caller sends a string", () => {
    const snap = updateSession(
      asWriter(db),
      { op: "update", sessionId: "t1", icon: "wrench" },
      5,
    );
    expect(snap?.icon).toBe("wrench");
    expect(querySessionRows(asReader(db))[0]!.icon).toBe("wrench");
  });

  it("clears the icon when the caller sends null", () => {
    updateSession(asWriter(db), { op: "update", sessionId: "t1", icon: "wrench" }, 5);
    const snap = updateSession(
      asWriter(db),
      { op: "update", sessionId: "t1", icon: null },
      6,
    );
    expect(snap?.icon).toBeNull();
    expect(querySessionRows(asReader(db))[0]!.icon).toBeNull();
  });

  it("leaves the icon untouched when omitted (partial patch)", () => {
    updateSession(asWriter(db), { op: "update", sessionId: "t1", icon: "wrench" }, 5);
    updateSession(asWriter(db), { op: "update", sessionId: "t1", title: "renamed" }, 6);
    expect(querySessionRows(asReader(db))[0]!.icon).toBe("wrench");
  });
});

describe("deleteSession", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
    createSession(
      asWriter(db),
      { op: "create", sessionId: "t1", title: "orig", agent: "claude-code" },
      1,
    );
    createSession(
      asWriter(db),
      { op: "create", sessionId: "t2", title: "keep", agent: "claude-code" },
      1,
    );
  });

  it("removes the row and returns the pre-delete snapshot", () => {
    const snap = deleteSession(asWriter(db), "t1");
    expect(snap?.sessionId).toBe("t1");
    expect(snap?.title).toBe("orig");
    expect(querySessionRows(asReader(db)).map((t) => t.sessionId)).toEqual(["t2"]);
  });

  it("deletes an archived row too — that is the only way one leaves the DB", () => {
    updateSession(asWriter(db), { op: "update", sessionId: "t1", archived: true }, 5);
    expect(deleteSession(asWriter(db), "t1")?.archived).toBe(true);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE id = 't1'`).get(),
    ).toEqual({ n: 0 });
  });

  it("returns null when the sessionId is unknown, leaving every row in place", () => {
    expect(deleteSession(asWriter(db), "missing")).toBeNull();
    expect(querySessionRows(asReader(db))).toHaveLength(2);
  });
});

// ─── querySessions ─────────────────────────────────────────────────────────

describe("querySessions", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
    createSession(
      asWriter(db),
      { op: "create", sessionId: "t1", title: "a", agent: "claude-code" },
      10,
    );
    createSession(
      asWriter(db),
      { op: "create", sessionId: "t2", title: "b", agent: "codex" },
      20,
    );
  });

  it("returns one session per active session, enriched with live ptyId when the probe answers", () => {
    const probe = (sessionId: string) => (sessionId === "t1" ? "pty-abc" : null);
    const sessions = querySessions(asWriter(db), probe);
    expect(sessions).toHaveLength(2);
    const s1 = sessions.find((s) => s.sessionId === "t1");
    const s2 = sessions.find((s) => s.sessionId === "t2");
    expect(s1?.ptyId).toBe("pty-abc");
    expect(s2?.ptyId).toBeNull();
  });

  it("omits archived sessions (same rule as sessionRowsList)", () => {
    updateSession(asWriter(db), { op: "update", sessionId: "t1", archived: true }, 30);
    const sessions = querySessions(asWriter(db), () => null);
    expect(sessions.map((s) => s.sessionId)).toEqual(["t2"]);
  });

  it("orders by updated_at DESC (most recent first)", () => {
    const sessions = querySessions(asWriter(db), () => null);
    expect(sessions.map((s) => s.sessionId)).toEqual(["t2", "t1"]);
  });

  it("returns empty when the sessions table is absent", () => {
    const empty = new Database(":memory:");
    expect(querySessions(asWriter(empty), () => null)).toEqual([]);
  });
});
