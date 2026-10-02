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
        // A failed append must never break the server's event emission — the
        // event is best-effort durability. The next event retries.
      }
    })();
  });
}

function sessionIdOf(e: AppEvent): string | null {
  if ("sessionId" in e && typeof e.sessionId === "string") return e.sessionId;
  if ("id" in e && typeof (e as { id?: unknown }).id === "string" && e.type.startsWith("session:")) {
    return (e as { id: string }).id;
  }
  return null;
}
