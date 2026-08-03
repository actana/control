# 02 — Generalize the core-link frame protocol + add a monotonic event log with `lastEventId` replay

**What to build:** The core-link WebSocket frame schema is generalized beyond PTY to carry task, session, and hook operations (list, mutate, observe). A monotonic per-Harness event log is added to the server's SQLite — every task status change, hook fire, question menu, or run finish is an Event with a sequential `eventId`. On reconnect the Panel sends its last-seen `eventId` and the server streams the tail; live push resumes once caught up. This generalizes the existing `ptyReplay` byte-stream replay into an event-cursor replay that covers all domain events, not just PTY output.

**Blocked by:** 01 — needs the separated server process and loopback core-link to extend.

**Status:** ready-for-agent

- [ ] Frame schema carries task/session/hook ops alongside PTY ops, keyed by the same `ptyId`/`taskId` model.
- [ ] Every domain event is appended to a monotonic event log in the server's SQLite with a sequential `eventId`.
- [ ] On reconnect the Panel sends `lastEventId`; the server replays the tail then resumes live push.
- [ ] Killing the Panel and reopening it restores the full event/task timeline from the event log.
- [ ] PTY byte-stream replay still works (it is now one category of Event in the log).
