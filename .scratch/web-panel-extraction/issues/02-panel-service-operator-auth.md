# 02 — Panel service boots standalone: Operator setup + login

**What to build:** The Panel runs as its own plain Node process (no Electron parent): it serves the SSR UI over HTTP, and on first boot walks the browser through creating the single Operator (password, modern KDF hash). Login issues an HTTP-only session cookie backed by server-side session records; logout and password change revoke sessions. Every API endpoint rejects unauthenticated requests. A fresh, logged-in Panel shows an empty fleet with "add your first Core." Panel state (Operator, sessions, settings) lives in one SQLite database inside a configurable data directory.

**Blocked by:** 01 — Workspace restructure.

**Status:** done — on branch `wt-e02` (533f82c, 2026-07-31), not merged

- [x] `node <panel entry>` (with a data-dir env) serves the UI; a browser completes first-boot setup → login → empty fleet
- [x] Unauthenticated requests to any API route get 401/redirect; the login page is the only anonymous surface
- [x] Session cookie is HTTP-only; logout and password change invalidate existing sessions
- [x] Operator is a first-class record owning (future) Cores — no tenancy, exactly one Operator enforced
- [x] The loopback-trust auth (host allow-lists, bearer token store) is removed from the served paths, not bypassed
- [x] Restarting the process preserves Operator, sessions policy, and settings from the data directory

**Notes:**
- Panel state lives in `panel.db` under `AC_PANEL_DATA_DIR`; the legacy app
  database (settings) follows the same directory, so one path is still the whole
  backup surface — but it is two files, not one. Collapsing them belongs with
  ticket 03, which moves the registry in and starts emptying the legacy DB.
- `/api/hooks/*` keeps the machine token (`server/hook-auth.ts`): it is an agent
  callback surface with no browser in it, so the Operator session can't gate it.
  It dies with the rest of the session path in 05/06. Every other route is
  behind the session cookie, and the loopback-trust auth (host allow-list,
  same-origin gate, SSE ticket, SSR bearer resolver) is deleted.
