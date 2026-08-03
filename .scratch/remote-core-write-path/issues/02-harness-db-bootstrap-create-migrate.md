# 02 — Harness-side DB bootstrap: create + migrate `missioncontrol.db` on harness-only VMs

**What to build:** On a machine where no sibling stateful server runs (the remote Harness case per ADR 0003 install), the Harness process itself must own bringing up the schema before serving any core-link queries or appending events. On start, the Harness opens `missioncontrol.db` read-write (creating the file and parent dirs if missing), then applies the same drizzle migrations `src/server/` uses today — idempotently, safe to re-run — before the core-link server begins accepting frames. Handle the "file exists, schema absent" case cleanly (a code path or the reporter's manual shell may have already touched the DB). Keep the event-log two-writer WAL pattern documented in `event-log-store.ts` intact. On the loopback (Panel + Harness on same host) case where the stateful server already migrates, this bootstrap must detect that ownership and not double-migrate — or must be safe if it does.

**Blocked by:** 01 — bootstrap can't run until the native binding actually loads on every target.

**Status:** ready-for-agent

- [ ] The Harness entry (`electron/harness-install-entry.ts` / `harness-entry.ts`) opens `missioncontrol.db` read-write, creating parent dirs and the file if missing, before `PtyCoreLinkServer` starts accepting frames.
- [ ] Drizzle migrations run to completion during Harness startup and are idempotent (re-running the Harness after a clean shutdown is a no-op).
- [ ] "File exists but schema absent" (empty file / missing `projects`/`tasks` tables) is handled: migrations run and the DB comes up healthy.
- [ ] On the loopback host where a sibling stateful server owns migrations, the Harness bootstrap either defers (detects ownership) or safely coexists with the server's migration runner.
- [ ] `event-log-store.ts` still uses WAL and the two-writer pattern; concurrent open by Harness + stateful server (loopback case) does not corrupt the DB.
- [ ] Fresh Linux VM + `harness install` → `projectsList` returns `[]` against a real schema (not `db-missing`, not `open-failed`).
- [ ] Startup fails loudly (exit non-zero, clear log line) if migrations fail — no silent degradation.
