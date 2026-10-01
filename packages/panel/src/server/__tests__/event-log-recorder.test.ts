import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { events } from "../events";
import {
  ensureEventsTable,
  readEventTail,
  type EventLogSqlite,
} from "@actana/shared/event-log";

// The recorder calls `getSqlite()` (the process-wide drizzle handle). We mock
// ~/db/client so the recorder writes to a per-test in-memory DB. vi.hoisted
// runs before the mock factory, giving it a holder the test can swap per test.
const holder = vi.hoisted(() => ({ db: null as Database.Database | null }));

vi.mock("~/db/client", () => ({
  getSqlite: () => holder.db,
}));

// Import AFTER the mock is registered so the recorder sees the stubbed getSqlite.
const { registerEventLogRecorder } = await import("../event-log-recorder");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("busy_timeout = 5000");
  ensureEventsTable(db as unknown as EventLogSqlite);
  return db;
}

describe("registerEventLogRecorder", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
    holder.db = db;
  });

  afterEach(() => {
    holder.db = null;
    db.close();
  });

  it("appends session:created with session_id filled from the `id` field", () => {
    registerEventLogRecorder();
    events.emit("session:created", { id: "t1" });

    const tail = readEventTail(db as unknown as EventLogSqlite, 0);
    expect(tail).toHaveLength(1);
    expect(tail[0]!.kind).toBe("session:created");
    expect(tail[0]!.sessionId).toBe("t1");
    expect(tail[0]!.ptyId).toBeNull();
    expect(JSON.parse(tail[0]!.payload)).toEqual({ id: "t1" });
  });

  it("appends session:updated with session_id filled from the `id` field", () => {
    registerEventLogRecorder();
    events.emit("session:updated", { id: "t2" });

    const tail = readEventTail(db as unknown as EventLogSqlite, 0);
    expect(tail[0]!.kind).toBe("session:updated");
    expect(tail[0]!.sessionId).toBe("t2");
  });

  it("appends session:question with session_id filled from the `sessionId` field", () => {
    registerEventLogRecorder();
    events.emit("session:question", {
      sessionId: "t9",
      questionId: "q1",
      questions: [],
    });

    const tail = readEventTail(db as unknown as EventLogSqlite, 0);
    expect(tail[0]!.kind).toBe("session:question");
    expect(tail[0]!.sessionId).toBe("t9");
  });

  it("assigns sequential monotonic eventIds across emits", () => {
    registerEventLogRecorder();
    events.emit("session:created", { id: "t1" });
    events.emit("session:updated", { id: "t1" });

    const tail = readEventTail(db as unknown as EventLogSqlite, 0);
    expect(tail.map((e) => e.eventId)).toEqual([1, 2]);
  });

  it("is idempotent — registering twice does not double-record", () => {
    registerEventLogRecorder();
    registerEventLogRecorder();
    events.emit("session:created", { id: "t1" });

    const tail = readEventTail(db as unknown as EventLogSqlite, 0);
    expect(tail).toHaveLength(1);
  });

  it("does not throw when getSqlite fails (best-effort durability)", () => {
    registerEventLogRecorder();
    holder.db = null; // simulate getSqlite blowing up
    expect(() => events.emit("session:created", { id: "t1" })).not.toThrow();
  });
});
