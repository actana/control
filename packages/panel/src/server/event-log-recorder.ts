// Event-log recorder — wires the stateful server's in-process AppEvent stream
// into the monotonic per-owner event log (Postgres `event_log`, #567 PR 5).
//
// The server emits session/hook events via the `events` emitter
// (src/server/events.ts). This module subscribes for the life of the server
// process and appends each as a row, so a reconnecting client can replay the
// missed event/session timeline.
//
// PTY lifecycle events (pty:spawn / pty:exit) are recorded by the Core
// process itself against the Core's own database; this recorder owns the
// Panel's session/hook half.

import { appendEventLogRow } from "./repositories/event-log.repo";
import { OPERATOR_ID } from "./services/operator";
import { events, type AppEvent } from "./events";

let registered = false;

/**
 * Subscribe the event-log recorder to `events.onAny` for the life of the server
 * process (idempotent). Real app runtime only — unit tests that import the
 * router directly opt in by calling this themselves.
 *
 * Each AppEvent is appended with its `type` as the event `kind` and the full
 * payload (minus `type`) as the JSON `payload`. The `sessionId` column is filled
 * when the event carries one, so session-scoped replay queries stay cheap.
 */
export function registerEventLogRecorder(): void {
  if (registered) return;
  registered = true;
  events.onAny((e) => {
    void (async () => {
      try {
        const { type: kind, ...rest } = e;
        const payload = JSON.stringify(rest);
        await appendEventLogRow(OPERATOR_ID, kind, payload, { sessionId: sessionIdOf(e) });
      } catch {
        // A failed append (e.g. the DB isn't open yet during early boot) must
        // never break the server's event emission — the event is best-effort
        // durability, not a write of record. The next event retries.
      }
    })();
  });
}

/**
 * Extract the sessionId from an AppEvent when it carries one. Session lifecycle
 * events (`session:created`, `session:updated`, `session:archived`, `session:restored`,
 * `session:deleted`) carry the id as `id`; session/question/prompt/agent events
 * carry it as `sessionId`. Both are surfaced so session-scoped replay queries
 * (event_log_session_idx) stay cheap for the common session-lifecycle path.
 */
function sessionIdOf(e: AppEvent): string | null {
  if ("sessionId" in e && typeof e.sessionId === "string") return e.sessionId;
  // Session lifecycle events use `id` for the session id.
  if ("id" in e && typeof (e as { id?: unknown }).id === "string" && e.type.startsWith("session:")) {
    return (e as { id: string }).id;
  }
  return null;
}
