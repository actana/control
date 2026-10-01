import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  countArchivedSessions,
  queryActiveSessions,
  queryArchivedSessions,
  queryStrandedReadySessions,
  querySessionProvenNeverWorked,
  querySessionRows,
  type CoreQuerySqlite,
} from "../core-query";
import type { CoreSessionRow } from "../core-query";

// Pure SQL helpers that read the Core's sessions table and map it to
// core-link snapshots (issue 07). The Core is the single source of
// truth; the Panel holds none. These helpers operate on a minimal sqlite
// interface so tests pass an in-memory better-sqlite3 handle.

function openDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
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

function insertSession(
  db: Database.Database,
  t: Partial<CoreSessionRow> & Pick<CoreSessionRow, "sessionId">,
): void {
  db.prepare(
    "INSERT INTO sessions (id, title, agent, status, pinned, archived, icon, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    t.sessionId,
    t.title ?? "session",
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
      session_id TEXT,
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
  sessionId: string | null,
  shellSession = false,
): void {
  db.prepare(
    "INSERT INTO event_log (ts, kind, pty_id, session_id, payload) VALUES (?, ?, ?, ?, ?)",
  ).run(1, "pty:spawn", "pty-1", sessionId, JSON.stringify({ ptyId: "pty-1", sessionId, shellSession }));
}

/** A `session:updated` the way `CoreSessionWriter` writes it: status only when patched. */
function sessionUpdated(db: Database.Database, sessionId: string, status?: string): void {
  db.prepare(
    "INSERT INTO event_log (ts, kind, pty_id, session_id, payload) VALUES (?, ?, ?, ?, ?)",
  ).run(
    1,
    "session:updated",
    null,
    sessionId,
    JSON.stringify({ sessionId, ...(status === undefined ? {} : { status }) }),
  );
}

describe("querySessionRows", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
  });

  it("returns session snapshots from the sessions table", () => {
    insertSession(db, { sessionId: "t1", title: "fix bug", agent: "claude-code", status: "running", icon: "bug", updatedAt: 10 });
    insertSession(db, { sessionId: "t2", title: "ship", agent: "codex", status: "needs-input", pinned: true, updatedAt: 20 });
    const sessions = querySessionRows(asQuery(db));
    expect(sessions).toHaveLength(2);
    expect(sessions).toContainEqual({
      sessionId: "t2",
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
    expect(sessions.find((t) => t.sessionId === "t1")?.icon).toBe("bug");
  });

  it("omits archived sessions (the Fleet view is for active work)", () => {
    insertSession(db, { sessionId: "live", archived: false });
    insertSession(db, { sessionId: "done", archived: true });
    const sessions = querySessionRows(asQuery(db));
    expect(sessions.map((t) => t.sessionId)).toEqual(["live"]);
  });

  it("orders by updated_at descending (most recent first)", () => {
    insertSession(db, { sessionId: "old", updatedAt: 100 });
    insertSession(db, { sessionId: "new", updatedAt: 999 });
    insertSession(db, { sessionId: "mid", updatedAt: 500 });
    expect(querySessionRows(asQuery(db)).map((t) => t.sessionId)).toEqual(["new", "mid", "old"]);
  });

  it("returns empty when the sessions table does not exist", () => {
    const db2 = new Database(":memory:");
    expect(querySessionRows(asQuery(db2))).toEqual([]);
  });
});

// The Archived view's own read path (ADR 0019). The point of it being a
// separate helper rather than a flag on querySessionRows is that the two lists
// cannot bleed into each other, so that is what these assert.
describe("queryArchivedSessions", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
  });

  it("returns the archived rows, and only those", () => {
    insertSession(db, { sessionId: "live", archived: false });
    insertSession(db, { sessionId: "old", archived: true });
    const sessions = queryArchivedSessions(asQuery(db));
    expect(sessions.map((t) => t.sessionId)).toEqual(["old"]);
    expect(sessions[0]!.archived).toBe(true);
  });

  it("is the exact complement of querySessionRows — no row appears in both, none is lost", () => {
    insertSession(db, { sessionId: "a", archived: false });
    insertSession(db, { sessionId: "b", archived: true });
    insertSession(db, { sessionId: "c", archived: false });
    const active = querySessionRows(asQuery(db)).map((t) => t.sessionId);
    const archived = queryArchivedSessions(asQuery(db)).map((t) => t.sessionId);
    expect(active.filter((id) => archived.includes(id))).toEqual([]);
    expect([...active, ...archived].sort()).toEqual(["a", "b", "c"]);
  });

  it("orders by updated_at descending, like the active list", () => {
    insertSession(db, { sessionId: "old", archived: true, updatedAt: 100 });
    insertSession(db, { sessionId: "new", archived: true, updatedAt: 999 });
    insertSession(db, { sessionId: "mid", archived: true, updatedAt: 500 });
    expect(queryArchivedSessions(asQuery(db)).map((t) => t.sessionId)).toEqual(["new", "mid", "old"]);
  });

  it("returns empty when the sessions table does not exist", () => {
    expect(queryArchivedSessions(asQuery(new Database(":memory:")))).toEqual([]);
  });
});

describe("queryActiveSessions (the Core's boot sweep read, issue 243)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
  });

  it("returns only the rows that still claim a live harness process", () => {
    insertSession(db, { sessionId: "t-running", status: "running" });
    insertSession(db, { sessionId: "t-waiting", status: "needs-input" });
    insertSession(db, { sessionId: "t-ready", status: "ready" });
    insertSession(db, { sessionId: "t-done", status: "finished" });
    insertSession(db, { sessionId: "t-gone", status: "disconnected" });

    expect(queryActiveSessions(asQuery(db)).map((t) => t.sessionId).sort()).toEqual([
      "t-running",
      "t-waiting",
    ]);
  });

  it("includes archived rows — an archived Session claiming to work is just as wrong", () => {
    insertSession(db, { sessionId: "t-archived", status: "running", archived: true });
    expect(queryActiveSessions(asQuery(db)).map((t) => t.sessionId)).toEqual(["t-archived"]);
  });

  it("spans every Session: a dead process did not die for one group only", () => {
    insertSession(db, { sessionId: "t-a", status: "running" });
    insertSession(db, { sessionId: "t-b", status: "needs-input" });
    expect(queryActiveSessions(asQuery(db))).toHaveLength(2);
  });

  it("returns empty when the sessions table does not exist", () => {
    const empty = new Database(":memory:");
    expect(queryActiveSessions(asQuery(empty))).toEqual([]);
    empty.close();
  });
});

describe("queryStrandedReadySessions (the ready zombie, issue 387)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
    addEventLog(db);
  });

  it("finds a ready row a PTY was spawned for, and no other ready row", () => {
    // The bare Session: a PTY of some previous run, no hook ever fired, still
    // sitting on "Waiting for initial prompt…" hours after the process died.
    insertSession(db, { sessionId: "t-zombie", status: "ready" });
    spawnedPty(db, "t-zombie");
    // The Session the operator created and has not started. It has no process
    // because it never had one — sweeping it would be the regression.
    insertSession(db, { sessionId: "t-unstarted", status: "ready" });

    expect(queryStrandedReadySessions(asQuery(db)).map((t) => t.sessionId)).toEqual(["t-zombie"]);
  });

  it("leaves every other status to the query that owns it", () => {
    for (const status of ["running", "needs-input", "finished", "disconnected"]) {
      insertSession(db, { sessionId: `t-${status}`, status });
      spawnedPty(db, `t-${status}`);
    }
    expect(queryStrandedReadySessions(asQuery(db))).toEqual([]);
  });

  it("ignores a spawn recorded against some other Session", () => {
    insertSession(db, { sessionId: "t-ready", status: "ready" });
    spawnedPty(db, "t-other");
    expect(queryStrandedReadySessions(asQuery(db))).toEqual([]);
  });

  it("does not read a VM Shell Session spawn as harness evidence", () => {
    // `shellSession: true` carries a sessionId for routing and is not harness
    // work — a shell opened against a Session must not settle its card.
    insertSession(db, { sessionId: "t-ready", status: "ready" });
    spawnedPty(db, "t-ready", true);
    expect(queryStrandedReadySessions(asQuery(db))).toEqual([]);

    // The agent spawn for the same row still is evidence.
    spawnedPty(db, "t-ready");
    expect(queryStrandedReadySessions(asQuery(db)).map((t) => t.sessionId)).toEqual(["t-ready"]);
  });

  it("does not read a plain shell spawn, whose session id names no row", () => {
    // A `shell: true` spawn records `shellSession: false`, the same as an
    // agent — it is separated by its id instead. The CLI addresses those with
    // a synthetic `cli_shell_<uuid>`, which no `sessions` row carries, so the
    // join drops it. Pinning the shape here is what keeps that true.
    insertSession(db, { sessionId: "t-ready", status: "ready" });
    spawnedPty(db, "cli_shell_2f1c9a4e-0d3b-4c77-9f21-6b8e5a0d1c34");
    spawnedPty(db, "user-terminal-1");
    expect(queryStrandedReadySessions(asQuery(db))).toEqual([]);
  });

  it("includes an archived row, and spans every Session", () => {
    insertSession(db, { sessionId: "t-arch", status: "ready", archived: true });
    spawnedPty(db, "t-arch");
    insertSession(db, { sessionId: "t-p2", status: "ready" });
    spawnedPty(db, "t-p2");
    expect(queryStrandedReadySessions(asQuery(db)).map((t) => t.sessionId).sort()).toEqual([
      "t-arch",
      "t-p2",
    ]);
  });

  it("maps the row the way every other listing here does", () => {
    insertSession(db, {
      sessionId: "t-zombie",
      status: "ready",
      title: "Waiting for initial prompt…",
      agent: "opencode",
      pinned: true,
      updatedAt: 42,
    });
    spawnedPty(db, "t-zombie");
    expect(queryStrandedReadySessions(asQuery(db))[0]).toMatchObject({
      sessionId: "t-zombie",
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
    insertSession(noLog, { sessionId: "t-ready", status: "ready" });
    expect(queryStrandedReadySessions(asQuery(noLog))).toEqual([]);
    noLog.close();
  });

  it("returns empty when the sessions table does not exist", () => {
    const empty = new Database(":memory:");
    expect(queryStrandedReadySessions(asQuery(empty))).toEqual([]);
    empty.close();
  });
});

describe("querySessionProvenNeverWorked (the relaunch reset's gate, issue 387)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
    addEventLog(db);
  });

  it("proves it for a row that only ever moved between ready and disconnected", () => {
    // The bare Session: born `ready`, settled `disconnected` by the sweep or
    // the PTY-exit path, and nothing in between. Nothing here is a turn — and
    // that `disconnected` is the positive evidence that this log can speak.
    sessionUpdated(db, "t-bare", "disconnected");
    expect(querySessionProvenNeverWorked(asQuery(db), "t-bare")).toBe(true);
  });

  it("refuses to prove it for a log that predates v0.4.0", () => {
    // `session:updated` only began carrying `status` in 2dd34a8 (v0.4.0), and
    // `event_log` is never pruned, so a Core upgraded from 0.3.x still holds
    // status-less rows for Sessions that worked for hours. Read as "did any
    // turn happen", their absence looks exactly like a Session that never ran
    // one — and answering "never worked" there overwrites a real card.
    sessionUpdated(db, "t-legacy");
    sessionUpdated(db, "t-legacy");
    expect(querySessionProvenNeverWorked(asQuery(db), "t-legacy")).toBe(false);
  });

  it("refuses to prove it for a row with no history at all", () => {
    expect(querySessionProvenNeverWorked(asQuery(db), "t-unknown")).toBe(false);
  });

  it("still proves it when a status-less update sits beside the evidence", () => {
    // A rename or a pin writes no status; on a current Core the settle beside
    // it does, and that is what makes the log readable.
    sessionUpdated(db, "t-bare");
    sessionUpdated(db, "t-bare", "disconnected");
    expect(querySessionProvenNeverWorked(asQuery(db), "t-bare")).toBe(true);
  });

  it("is false for every status that only a turn produces", () => {
    for (const status of ["running", "needs-input", "interrupted", "finished", "terminated"]) {
      const sessionId = `t-${status}`;
      sessionUpdated(db, sessionId, "disconnected");
      sessionUpdated(db, sessionId, status);
      expect(querySessionProvenNeverWorked(asQuery(db), sessionId)).toBe(false);
    }
  });

  it("is false for a harness that goes straight from ready to finished", () => {
    // Some harnesses never report `running`; the finish is the only patch.
    sessionUpdated(db, "t-quiet", "finished");
    expect(querySessionProvenNeverWorked(asQuery(db), "t-quiet")).toBe(false);
  });

  it("reads only this Session's own history", () => {
    sessionUpdated(db, "t-other", "running");
    sessionUpdated(db, "t-bare", "disconnected");
    expect(querySessionProvenNeverWorked(asQuery(db), "t-bare")).toBe(true);
    expect(querySessionProvenNeverWorked(asQuery(db), "t-other")).toBe(false);
  });

  it("takes no evidence from an event that is not session:updated", () => {
    // A `pty:spawn` says a process started, not that a turn did — and it is
    // not proof the log carries statuses either.
    spawnedPty(db, "t-bare");
    expect(querySessionProvenNeverWorked(asQuery(db), "t-bare")).toBe(false);
  });

  it("is false when there is no event log to read", () => {
    expect(querySessionProvenNeverWorked(asQuery(openDb()), "t-bare")).toBe(false);
  });
});

describe("countArchivedSessions", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
  });

  it("counts archived rows and ignores active ones", () => {
    insertSession(db, { sessionId: "live", archived: false });
    insertSession(db, { sessionId: "o1", archived: true });
    insertSession(db, { sessionId: "o2", archived: true });
    expect(countArchivedSessions(asQuery(db))).toBe(2);
  });

  it("is 0 when nothing is archived", () => {
    insertSession(db, { sessionId: "live", archived: false });
    expect(countArchivedSessions(asQuery(db))).toBe(0);
  });

  it("is 0 when the sessions table does not exist", () => {
    expect(countArchivedSessions(asQuery(new Database(":memory:")))).toBe(0);
  });
});
