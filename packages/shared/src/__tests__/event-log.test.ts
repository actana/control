import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import {
  appendEvent,
  ensureEventsTable,
  getLastEventId,
  readEventTail,
  type EventLogSqlite,
} from "../event-log";

// Minimal slice that satisfies EventLogSqlite — a real better-sqlite3 handle
// works directly. Tests use an in-memory DB so the table must be created first.
function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  ensureEventsTable(db as unknown as EventLogSqlite);
  return db;
}

describe("event-log", () => {
  describe("ensureEventsTable", () => {
    it("creates the event_log table idempotently", () => {
      const db = new Database(":memory:");
      ensureEventsTable(db as unknown as EventLogSqlite);
      // Calling again must not throw (CREATE TABLE IF NOT EXISTS).
      ensureEventsTable(db as unknown as EventLogSqlite);
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_log'")
        .get() as { name: string } | undefined;
      expect(row?.name).toBe("event_log");
    });

    it("creates the supporting indexes", () => {
      const db = freshDb();
      const indexes = (
        db.prepare("PRAGMA index_list(event_log)").all() as { name: string }[]
      ).map((r) => r.name);
      expect(indexes).toContain("event_log_kind_idx");
      expect(indexes).toContain("event_log_task_idx");
      expect(indexes).toContain("event_log_pty_idx");
    });
  });

  describe("getLastEventId", () => {
    it("returns 0 on an empty log", () => {
      const db = freshDb();
      expect(getLastEventId(db as unknown as EventLogSqlite)).toBe(0);
    });

    it("returns the highest event_id after appends", () => {
      const db = freshDb();
      appendEvent(db as unknown as EventLogSqlite, "task:created", "{}");
      appendEvent(db as unknown as EventLogSqlite, "task:updated", "{}");
      expect(getLastEventId(db as unknown as EventLogSqlite)).toBe(2);
    });
  });

  describe("appendEvent", () => {
    it("assigns a sequential monotonic eventId", () => {
      const db = freshDb();
      const id1 = appendEvent(db as unknown as EventLogSqlite, "pty:spawn", '{"ptyId":"p1"}', {
        ptyId: "p1",
        taskId: "t1",
      });
      const id2 = appendEvent(db as unknown as EventLogSqlite, "pty:exit", '{"exitCode":0}', {
        ptyId: "p1",
      });
      expect(id2).toBe(id1 + 1);
      expect(id1).toBe(1);
    });

    it("persists kind, payload, ptyId, taskId, and a timestamp", () => {
      const db = freshDb();
      const before = Date.now();
      const id = appendEvent(db as unknown as EventLogSqlite, "task:updated", '{"status":"running"}', {
        taskId: "t9",
        ptyId: "p2",
      });
      const after = Date.now();
      const row = db
        .prepare("SELECT * FROM event_log WHERE event_id = ?")
        .get(id) as {
          event_id: number;
          ts: number;
          kind: string;
          pty_id: string | null;
          task_id: string | null;
          payload: string;
        };
      expect(row.kind).toBe("task:updated");
      expect(row.payload).toBe('{"status":"running"}');
      expect(row.pty_id).toBe("p2");
      expect(row.task_id).toBe("t9");
      expect(row.ts).toBeGreaterThanOrEqual(before);
      expect(row.ts).toBeLessThanOrEqual(after);
    });

    it("allows null ptyId and taskId (default)", () => {
      const db = freshDb();
      const id = appendEvent(db as unknown as EventLogSqlite, "project:created", "{}");
      const row = db
        .prepare("SELECT pty_id, task_id FROM event_log WHERE event_id = ?")
        .get(id) as { pty_id: string | null; task_id: string | null };
      expect(row.pty_id).toBeNull();
      expect(row.task_id).toBeNull();
    });
  });

  describe("readEventTail", () => {
    it("returns events strictly after the cursor in eventId order", () => {
      const db = freshDb();
      const ids = [1, 2, 3, 4, 5].map((i) =>
        appendEvent(db as unknown as EventLogSqlite, `kind-${i}`, `{}`),
      );
      const tail = readEventTail(db as unknown as EventLogSqlite, ids[1]!);
      expect(tail.map((e) => e.eventId)).toEqual([3, 4, 5]);
    });

    it("returns an empty array when the cursor is at or past the end", () => {
      const db = freshDb();
      appendEvent(db as unknown as EventLogSqlite, "task:created", "{}");
      appendEvent(db as unknown as EventLogSqlite, "task:updated", "{}");
      expect(readEventTail(db as unknown as EventLogSqlite, 2)).toEqual([]);
      expect(readEventTail(db as unknown as EventLogSqlite, 99)).toEqual([]);
    });

    it("returns all events when the cursor is 0", () => {
      const db = freshDb();
      appendEvent(db as unknown as EventLogSqlite, "task:created", "{}");
      appendEvent(db as unknown as EventLogSqlite, "task:updated", "{}");
      const tail = readEventTail(db as unknown as EventLogSqlite, 0);
      expect(tail).toHaveLength(2);
      expect(tail.map((e) => e.kind)).toEqual(["task:created", "task:updated"]);
    });

    it("respects the limit parameter", () => {
      const db = freshDb();
      for (let i = 0; i < 10; i++) {
        appendEvent(db as unknown as EventLogSqlite, `kind-${i}`, "{}");
      }
      const tail = readEventTail(db as unknown as EventLogSqlite, 0, 3);
      expect(tail).toHaveLength(3);
      expect(tail.map((e) => e.eventId)).toEqual([1, 2, 3]);
    });

    it("shapes each row as a CoreLinkEvent (eventId, ts, kind, ptyId, taskId, payload)", () => {
      const db = freshDb();
      appendEvent(db as unknown as EventLogSqlite, "pty:exit", '{"exitCode":0}', {
        ptyId: "p1",
        taskId: "t1",
      });
      const [event] = readEventTail(db as unknown as EventLogSqlite, 0);
      expect(event).toEqual({
        eventId: 1,
        ts: expect.any(Number),
        kind: "pty:exit",
        ptyId: "p1",
        taskId: "t1",
        payload: '{"exitCode":0}',
      });
    });
  });
});
