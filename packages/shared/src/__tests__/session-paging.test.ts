import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  InvalidSessionPageError,
  SESSION_PAGE_MAX,
  decodeSessionCursor,
  encodeSessionCursor,
  querySessionPage,
  readSessionPageRequest,
} from "../session-paging";
import type { CoreQuerySqlite } from "../core-query";

function openDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      agent TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      icon TEXT,
      title_manually_set INTEGER NOT NULL DEFAULT 0,
      claude_session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

function insert(
  db: Database.Database,
  id: string,
  at: number,
  extra: Partial<{ title: string; agent: string; status: string; archived: number; pinned: number }> = {},
): void {
  db.prepare(
    `INSERT INTO sessions (id, title, agent, status, archived, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, extra.title ?? `title ${id}`, extra.agent ?? "claude-code", extra.status ?? "finished", extra.archived ?? 0, extra.pinned ?? 0, at, at);
}

const asReader = (db: Database.Database) => db as unknown as CoreQuerySqlite;

describe("readSessionPageRequest", () => {
  it("is null without a limit, so the frame answers as it always did", () => {
    expect(readSessionPageRequest({})).toBeNull();
    expect(readSessionPageRequest({ cursor: "x", status: "running" })).toBeNull();
  });

  it("reads limit, cursor and the filters", () => {
    expect(
      readSessionPageRequest({ limit: 25, cursor: "abc", status: "waiting", archived: true, harness: "codex", q: " fix " }),
    ).toEqual({ limit: 25, cursor: "abc", status: "waiting", archived: true, harness: "codex", q: "fix" });
  });

  it("defaults archived to false", () => {
    expect(readSessionPageRequest({ limit: 5 })?.archived).toBe(false);
  });

  it.each([0, -1, 1.5, SESSION_PAGE_MAX + 1, "10", Number.NaN])("rejects limit %s", (limit) => {
    expect(() => readSessionPageRequest({ limit })).toThrow(InvalidSessionPageError);
  });

  it("rejects an unknown status and a non-string cursor", () => {
    expect(() => readSessionPageRequest({ limit: 5, status: "bogus" })).toThrow(InvalidSessionPageError);
    expect(() => readSessionPageRequest({ limit: 5, cursor: 7 })).toThrow(InvalidSessionPageError);
  });
});

describe("session cursor", () => {
  it("round-trips", () => {
    const cursor = encodeSessionCursor({ rank: 1, updatedAt: 123, id: "s1" });
    expect(decodeSessionCursor(cursor)).toEqual({ rank: 1, updatedAt: 123, id: "s1" });
  });

  it.each(["", "not-base64!!", Buffer.from("{}").toString("base64url"), Buffer.from('[9,1,"x"]').toString("base64url")])(
    "rejects %j",
    (bad) => {
      expect(() => decodeSessionCursor(bad)).toThrow(InvalidSessionPageError);
    },
  );
});

describe("querySessionPage", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
  });

  it("pages newest activity first and ends with a null cursor and the true total", () => {
    for (let i = 1; i <= 5; i++) insert(db, `s${i}`, i * 10);
    const first = querySessionPage(asReader(db), { limit: 2, archived: false });
    expect(first.rows.map((r) => r.sessionId)).toEqual(["s5", "s4"]);
    expect(first.total).toBe(5);
    expect(first.nextCursor).not.toBeNull();
    const second = querySessionPage(asReader(db), { limit: 2, archived: false, cursor: first.nextCursor! });
    expect(second.rows.map((r) => r.sessionId)).toEqual(["s3", "s2"]);
    const third = querySessionPage(asReader(db), { limit: 2, archived: false, cursor: second.nextCursor! });
    expect(third.rows.map((r) => r.sessionId)).toEqual(["s1"]);
    expect(third.nextCursor).toBeNull();
    expect(third.total).toBe(5);
  });

  it("returns no cursor when the page holds everything", () => {
    insert(db, "a", 1);
    insert(db, "b", 2);
    const page = querySessionPage(asReader(db), { limit: 2, archived: false });
    expect(page.nextCursor).toBeNull();
  });

  it("puts running and waiting Sessions first, then the rest by last activity", () => {
    insert(db, "old-running", 1, { status: "running" });
    insert(db, "new-finished", 100, { status: "finished" });
    insert(db, "mid-waiting", 50, { status: "needs-input" });
    insert(db, "newer-finished", 200, { status: "finished" });
    const page = querySessionPage(asReader(db), { limit: 10, archived: false });
    expect(page.rows.map((r) => r.sessionId)).toEqual(["mid-waiting", "old-running", "newer-finished", "new-finished"]);
  });

  it("breaks ties on updated_at by id so the order is total", () => {
    insert(db, "a", 5);
    insert(db, "b", 5);
    insert(db, "c", 5);
    const first = querySessionPage(asReader(db), { limit: 2, archived: false });
    const second = querySessionPage(asReader(db), { limit: 2, archived: false, cursor: first.nextCursor! });
    expect([...first.rows, ...second.rows].map((r) => r.sessionId)).toEqual(["c", "b", "a"]);
  });

  it("never repeats or skips a row while new Sessions start between pages", () => {
    for (let i = 1; i <= 6; i++) insert(db, `s${i}`, i * 10);
    const first = querySessionPage(asReader(db), { limit: 3, archived: false });
    // Two Sessions start after the first page was served.
    insert(db, "new1", 1000, { status: "running" });
    insert(db, "new2", 1001);
    const second = querySessionPage(asReader(db), { limit: 3, archived: false, cursor: first.nextCursor! });
    expect(first.rows.map((r) => r.sessionId)).toEqual(["s6", "s5", "s4"]);
    expect(second.rows.map((r) => r.sessionId)).toEqual(["s3", "s2", "s1"]);
    expect(second.total).toBe(8);
  });

  it("filters by status", () => {
    insert(db, "r", 1, { status: "running" });
    insert(db, "w", 2, { status: "needs-input" });
    insert(db, "f", 3, { status: "finished" });
    insert(db, "t", 4, { status: "terminated" });
    const ids = (status: "running" | "waiting" | "finished") =>
      querySessionPage(asReader(db), { limit: 10, archived: false, status }).rows.map((r) => r.sessionId);
    expect(ids("running")).toEqual(["r"]);
    expect(ids("waiting")).toEqual(["w"]);
    expect(ids("finished")).toEqual(["t", "f"]);
    expect(querySessionPage(asReader(db), { limit: 10, archived: false, status: "finished" }).total).toBe(2);
  });

  it("hides archived Sessions unless asked, and only shows them when asked", () => {
    insert(db, "live", 1);
    insert(db, "gone", 2, { archived: 1 });
    expect(querySessionPage(asReader(db), { limit: 10, archived: false }).rows.map((r) => r.sessionId)).toEqual(["live"]);
    const archived = querySessionPage(asReader(db), { limit: 10, archived: true });
    expect(archived.rows.map((r) => r.sessionId)).toEqual(["gone"]);
    expect(archived.rows[0]?.archived).toBe(true);
    expect(archived.total).toBe(1);
  });

  it("filters by harness and by name, treating % and _ in q literally", () => {
    insert(db, "a", 1, { agent: "codex", title: "Fix the login" });
    insert(db, "b", 2, { agent: "claude-code", title: "Fix the logout" });
    insert(db, "c", 3, { agent: "codex", title: "100% done_ish" });
    const run = (extra: object) =>
      querySessionPage(asReader(db), { limit: 10, archived: false, ...extra }).rows.map((r) => r.sessionId);
    expect(run({ harness: "codex" })).toEqual(["c", "a"]);
    expect(run({ q: "FIX the log" })).toEqual(["b", "a"]);
    expect(run({ q: "%" })).toEqual(["c"]);
    expect(run({ q: "_ish" })).toEqual(["c"]);
    expect(run({ harness: "codex", q: "login" })).toEqual(["a"]);
  });

  it("fetches only the named Sessions, whichever page they would be on", () => {
    for (let i = 1; i <= 5; i++) insert(db, `s${i}`, i * 10);
    const page = querySessionPage(asReader(db), { limit: 10, archived: false, ids: ["s1", "s4", "nope"] });
    expect(page.rows.map((r) => r.sessionId)).toEqual(["s4", "s1"]);
    expect(page.total).toBe(2);
  });

  it("filters to the pinned Sessions, wherever they sit in the order", () => {
    for (let i = 1; i <= 5; i++) insert(db, `s${i}`, i * 10, { pinned: i === 1 || i === 2 ? 1 : 0 });
    const page = querySessionPage(asReader(db), { limit: 1, archived: false, pinned: true });
    expect(page.rows.map((r) => r.sessionId)).toEqual(["s2"]);
    expect(page.total).toBe(2);
    expect(page.nextCursor).not.toBeNull();
    expect(readSessionPageRequest({ limit: 5, pinned: true })?.pinned).toBe(true);
    expect(readSessionPageRequest({ limit: 5 })?.pinned).toBeUndefined();
    expect(readSessionPageRequest({ limit: 5, pinned: "yes" })?.pinned).toBeUndefined();
  });

  it("rejects ids that are not a list of ids", () => {
    expect(() => readSessionPageRequest({ limit: 5, ids: "s1" })).toThrow(InvalidSessionPageError);
    expect(() => readSessionPageRequest({ limit: 5, ids: [""] })).toThrow(InvalidSessionPageError);
    expect(readSessionPageRequest({ limit: 5, ids: ["a"] })?.ids).toEqual(["a"]);
  });

  it("answers an empty page when the table is absent", () => {
    const empty = new Database(":memory:");
    expect(querySessionPage(asReader(empty), { limit: 5, archived: false })).toEqual({ rows: [], nextCursor: null, total: 0 });
  });
});
