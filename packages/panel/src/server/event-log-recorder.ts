// Event-log recorder — wires the stateful server's in-process AppEvent stream
// into the monotonic per-Harness event log (the `event_log` SQLite table).
//
// The server emits task/session/hook/project events via the `events` emitter
// (src/server/events.ts). This module subscribes for the life of the server
// process and appends each as a row in `event_log`, so a reconnecting Panel
// can replay the missed event/task timeline via the core-link's `subscribe`
// path (served by the Harness / PTY-manager process, which shares the same
// SQLite file).
//
// PTY lifecycle events (pty:spawn / pty:exit) are recorded by the Harness
// process itself (packages/harness/src/pty-core-link-server.ts); this recorder owns the
// task/session/hook half. Both append to the same append-only table — SQLite's
// WAL write lock serializes the commits and the kinds never overlap, so the
// two writers stay out of each other's way.

import { getSqlite } from "~/db/client";
import { appendEvent, type EventLogSqlite } from "@actana/shared/event-log";
import { events, type AppEvent } from "./events";

let registered = false;

/**
 * Subscribe the event-log recorder to `events.onAny` for the life of the server
 * process (idempotent). Real app runtime only — unit tests that import the
 * router directly opt in by calling this themselves.
 *
 * Each AppEvent is appended with its `type` as the event `kind` and the full
 * payload (minus `type`) as the JSON `payload`. The `taskId` column is filled
 * when the event carries one, so task-scoped replay queries stay cheap.
 */
export function registerEventLogRecorder(): void {
  if (registered) return;
  registered = true;
  events.onAny((e) => {
    try {
      const sqlite = getSqlite() as unknown as EventLogSqlite;
      const { type: kind, ...rest } = e;
      const payload = JSON.stringify(rest);
      appendEvent(sqlite, kind, payload, { taskId: taskIdOf(e) });
    } catch {
      // A failed append (e.g. the DB isn't open yet during early boot) must
      // never break the server's event emission — the event is best-effort
      // durability, not a write of record. The next event retries.
    }
  });
}

/**
 * Extract the taskId from an AppEvent when it carries one. Task lifecycle
 * events (`task:created`, `task:updated`, `task:archived`, `task:restored`,
 * `task:deleted`) carry the id as `id`; session/question/prompt/agent events
 * carry it as `taskId`. Both are surfaced so task-scoped replay queries
 * (event_log_task_idx) stay cheap for the common task-lifecycle path.
 */
function taskIdOf(e: AppEvent): string | null {
  if ("taskId" in e && typeof e.taskId === "string") return e.taskId;
  // Task lifecycle events use `id` for the task id.
  if ("id" in e && typeof (e as { id?: unknown }).id === "string" && e.type.startsWith("task:")) {
    return (e as { id: string }).id;
  }
  return null;
}
